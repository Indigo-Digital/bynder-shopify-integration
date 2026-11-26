/**
 * @vitest-environment node
 *
 * Spec for the cancel race in asset sync. These tests fail while a running
 * job can still be saved as completed or failed after a staff user has
 * cancelled it, and while the transient-error retry keeps downloading and
 * uploading after that cancellation.
 */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BynderClient } from "../bynder/client.js";
import { uploadBynderAsset } from "../shopify/files.js";
import type { AdminApi } from "../types.js";

vi.unmock("../../db.server.js");
vi.unmock("../../db.server");
vi.unmock("./app/db.server");

vi.mock("../shopify/files.js", () => ({
	uploadBynderAsset: vi.fn(),
}));

type Asset = { id: string; tags: string[]; version: number };
type UploadCall = { assetId: string; enableAutoAltText: boolean | undefined };

const databaseDir = mkdtempSync(join(tmpdir(), "bynder-cancel-race-"));
process.env.DATABASE_URL = `file:${join(databaseDir, "test.sqlite")}`;

let prisma: PrismaClient;
let syncBynderAssets: typeof import("./auto-sync.js")["syncBynderAssets"];
const restorers: Array<() => void> = [];

const admin = {
	graphql: vi.fn(),
} as unknown as AdminApi;

beforeAll(async () => {
	execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
		cwd: process.cwd(),
		env: process.env,
		stdio: "pipe",
	});
	const database = await import("../../db.server.js");
	prisma = database.default;
	if (typeof prisma.$connect !== "function") {
		throw new Error("Expected the real Prisma client from db.server");
	}
	const sync = await import("./auto-sync.js");
	syncBynderAssets = sync.syncBynderAssets;
});

afterEach(() => {
	while (restorers.length > 0) {
		const restore = restorers.pop();
		restore?.();
	}
	vi.restoreAllMocks();
});

describe("cancelled sync jobs", () => {
	it("does not retry or complete a job cancelled during the transient retry delay", async () => {
		const { shop, job } = await createShopAndJob();
		const assets = [asset("asset-timeout")];
		const { client, mediaInfoIds } = createBynderClient(assets);
		const uploads = recordUploads((assetId, callNumber) => {
			if (callNumber === 1) {
				throw new Error("network timeout while downloading the file");
			}
			return {
				fileId: `gid://shopify/File/${assetId}`,
				fileUrl: "https://cdn.shopify.com/files/test.jpg",
			};
		});
		const originalSetTimeout = globalThis.setTimeout;
		const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: TimerHandler,
			timeout?: number,
			...args: unknown[]
		) => {
			if (timeout !== 5000) {
				return originalSetTimeout(
					handler as TimerHandler,
					timeout,
					...(args as [])
				);
			}
			return originalSetTimeout(() => {
				void (async () => {
					const current = await prisma.syncJob.findUnique({
						where: { id: job.id },
						select: { status: true },
					});
					expect(current?.status).toBe("running");
					await cancelLikeStaffUser(job.id);
					if (typeof handler === "function") {
						handler(...(args as []));
					}
				})();
			}, 0);
		}) as typeof setTimeout);
		restorers.push(() => timer.mockRestore());

		await syncBynderAssets({
			shopId: shop.id,
			admin,
			bynderClient: client,
			jobId: job.id,
		});

		const saved = await prisma.syncJob.findUnique({ where: { id: job.id } });
		const copied = await prisma.syncedAsset.findMany({
			where: { shopId: shop.id },
		});
		expect(mediaInfoIds).toEqual([]);
		expect(uploads).toEqual([
			{ assetId: "asset-timeout", enableAutoAltText: true },
		]);
		expect(copied).toEqual([]);
		expect(saved?.status).toBe("cancelled");
	}, 15000);

	it("keeps a cancellation that commits after the status read and before the completion write", async () => {
		const { shop, job } = await createShopAndJob();
		const assets = [asset("asset-ok")];
		const { client, mediaInfoIds } = createBynderClient(assets);
		recordUploads(() => ({
			fileId: "gid://shopify/File/asset-ok",
			fileUrl: "https://cdn.shopify.com/files/test.jpg",
		}));
		armTerminalWriteRace(job.id);

		await syncBynderAssets({
			shopId: shop.id,
			admin,
			bynderClient: client,
			jobId: job.id,
		});

		const saved = await prisma.syncJob.findUnique({ where: { id: job.id } });
		expect(saved?.status).toBe("cancelled");
		expect(mediaInfoIds).toEqual([]);
	});

	it("keeps a cancellation that commits after the status read and before the failure write", async () => {
		const { shop, job } = await createShopAndJob();
		const client = {
			...createBynderClient([]).client,
			getAllMediaItems: vi.fn(async () => {
				throw new Error("Bynder connection reset");
			}),
		} as unknown as BynderClient;
		armTerminalWriteRace(job.id);

		await expect(
			syncBynderAssets({
				shopId: shop.id,
				admin,
				bynderClient: client,
				jobId: job.id,
			})
		).rejects.toThrow("Bynder connection reset");

		const saved = await prisma.syncJob.findUnique({ where: { id: job.id } });
		expect(saved?.status).toBe("cancelled");
		expect(uploadBynderAsset).not.toHaveBeenCalled();
	});

	it("keeps a cancellation when the legacy completion statement writes by job id", async () => {
		const { shop, job } = await createShopAndJob();
		const assets = [asset("asset-legacy")];
		const { client } = createBynderClient(assets);
		recordUploads(() => ({
			fileId: "gid://shopify/File/asset-legacy",
			fileUrl: "https://cdn.shopify.com/files/test.jpg",
		}));
		throwUnknownArgumentOnTerminalUpdate();
		const statements = armRawStatusWriteRace(job.id);

		await syncBynderAssets({
			shopId: shop.id,
			admin,
			bynderClient: client,
			jobId: job.id,
		});

		const saved = await prisma.syncJob.findUnique({ where: { id: job.id } });
		expect(statements.length).toBeGreaterThan(0);
		expect(saved?.status).toBe("cancelled");
	});

	it("keeps a cancellation when the worker records a failure", async () => {
		const shop = await prisma.shop.create({
			data: {
				shop: `cancel-race-worker-${Date.now()}.myshopify.com`,
				syncTags: "campaign",
				bynderBaseUrl: null,
			},
		});
		const job = await prisma.syncJob.create({
			data: { shopId: shop.id, status: "pending" },
		});
		stallAfterNextJobPoll();
		armTerminalWriteRace(job.id);

		await import("./worker.js");

		await vi.waitFor(
			async () => {
				const current = await prisma.syncJob.findUnique({
					where: { id: job.id },
					select: { status: true },
				});
				expect(
					current?.status === "failed" || current?.status === "cancelled"
				).toBe(true);
			},
			{ timeout: 5000, interval: 20 }
		);

		const saved = await prisma.syncJob.findUnique({ where: { id: job.id } });
		expect(saved?.status).toBe("cancelled");
	});
});

function asset(id: string): Asset {
	return { id, tags: ["campaign"], version: 1 };
}

async function createShopAndJob() {
	const shop = await prisma.shop.create({
		data: {
			shop: `cancel-race-${Date.now()}-${Math.random().toString(16).slice(2)}.myshopify.com`,
			syncTags: "campaign",
			enableAutoAltText: true,
			bynderBaseUrl: "https://assets.example.test/api",
		},
	});
	const job = await prisma.syncJob.create({
		data: { shopId: shop.id, status: "pending" },
	});
	return { shop, job };
}

function createBynderClient(assets: Asset[]) {
	const mediaInfoIds: string[] = [];
	const client = {
		config: { baseURL: "https://assets.example.test/api" },
		getAllMediaItems: vi.fn(async () => assets),
		getMediaInfo: vi.fn(async ({ id }: { id: string }) => {
			mediaInfoIds.push(id);
			return {
				id,
				tags: ["campaign"],
				version: 1,
				name: `${id}.jpg`,
			};
		}),
		getMediaDownloadUrl: vi.fn(async ({ id }: { id: string }) => {
			return `https://assets.example.test/api/v4/media/${id}/download`;
		}),
	} as unknown as BynderClient;
	return { client, mediaInfoIds };
}

function recordUploads(
	onCall: (
		assetId: string,
		callNumber: number
	) => { fileId: string; fileUrl: string } | never
): UploadCall[] {
	const calls: UploadCall[] = [];
	vi.mocked(uploadBynderAsset).mockImplementation(
		async (_admin, _bynderClient, assetId, _shopId, _syncType, shopConfig) => {
			calls.push({
				assetId,
				enableAutoAltText: shopConfig?.enableAutoAltText,
			});
			const result = onCall(assetId, calls.length);
			if (result instanceof Promise) {
				return result;
			}
			return result;
		}
	);
	return calls;
}

function stallAfterNextJobPoll() {
	const original = prisma.syncJob.findFirst.bind(prisma.syncJob);
	let polls = 0;
	prisma.syncJob.findFirst = (async (args: Prisma.SyncJobFindFirstArgs) => {
		polls += 1;
		if (polls > 1) {
			return new Promise(() => undefined);
		}
		return original(args);
	}) as unknown as typeof prisma.syncJob.findFirst;
	restorers.push(() => {
		prisma.syncJob.findFirst = original;
	});
}

async function cancelLikeStaffUser(jobId: string) {
	await prisma.syncJob.update({
		where: { id: jobId },
		data: { status: "cancelled", completedAt: new Date() },
	});
}

function statusValue(data: unknown): unknown {
	if (!data || typeof data !== "object" || !("status" in data)) {
		return undefined;
	}
	const status = (data as { status: unknown }).status;
	if (status && typeof status === "object" && "set" in status) {
		return (status as { set: unknown }).set;
	}
	return status;
}

function isTerminalStatus(status: unknown): boolean {
	return status === "completed" || status === "failed";
}

function armTerminalWriteRace(jobId: string) {
	const originalUpdate = prisma.syncJob.update.bind(prisma.syncJob);
	const originalUpdateMany = prisma.syncJob.updateMany.bind(prisma.syncJob);
	const originalExecuteUnsafe = prisma.$executeRawUnsafe.bind(prisma);
	const originalExecute = prisma.$executeRaw.bind(prisma);

	const cancelFirst = async () => {
		await originalUpdate({
			where: { id: jobId },
			data: { status: "cancelled", completedAt: new Date() },
		});
	};

	prisma.syncJob.update = (async (args: Prisma.SyncJobUpdateArgs) => {
		if (isTerminalStatus(statusValue(args.data))) {
			await cancelFirst();
		}
		return originalUpdate(args);
	}) as unknown as typeof prisma.syncJob.update;

	prisma.syncJob.updateMany = (async (args: Prisma.SyncJobUpdateManyArgs) => {
		if (isTerminalStatus(statusValue(args.data))) {
			await cancelFirst();
		}
		return originalUpdateMany(args);
	}) as unknown as typeof prisma.syncJob.updateMany;

	prisma.$executeRawUnsafe = (async (query: string, ...values: unknown[]) => {
		if (writesTerminalStatus(query, values)) {
			await cancelFirst();
		}
		return originalExecuteUnsafe(query, ...values);
	}) as typeof prisma.$executeRawUnsafe;

	prisma.$executeRaw = (async (
		query: TemplateStringsArray | Prisma.Sql,
		...values: unknown[]
	) => {
		if (writesTerminalStatus(String(query), values)) {
			await cancelFirst();
		}
		return originalExecute(query as never, ...values);
	}) as typeof prisma.$executeRaw;

	restorers.push(() => {
		prisma.syncJob.update = originalUpdate;
		prisma.syncJob.updateMany = originalUpdateMany;
		prisma.$executeRawUnsafe = originalExecuteUnsafe;
		prisma.$executeRaw = originalExecute;
	});
}

function throwUnknownArgumentOnTerminalUpdate() {
	const originalUpdate = prisma.syncJob.update.bind(prisma.syncJob);
	const originalUpdateMany = prisma.syncJob.updateMany.bind(prisma.syncJob);
	const reject = async (data: unknown) => {
		if (isTerminalStatus(statusValue(data))) {
			throw new Error(
				"Unknown argument `assetsCreated`. Available options are marked with ?."
			);
		}
	};
	prisma.syncJob.update = (async (args: Prisma.SyncJobUpdateArgs) => {
		await reject(args.data);
		return originalUpdate(args);
	}) as unknown as typeof prisma.syncJob.update;
	prisma.syncJob.updateMany = (async (args: Prisma.SyncJobUpdateManyArgs) => {
		await reject(args.data);
		return originalUpdateMany(args);
	}) as unknown as typeof prisma.syncJob.updateMany;
	restorers.push(() => {
		prisma.syncJob.update = originalUpdate;
		prisma.syncJob.updateMany = originalUpdateMany;
	});
}

function armRawStatusWriteRace(jobId: string) {
	const originalUpdate = prisma.syncJob.update.bind(prisma.syncJob);
	const originalExecuteUnsafe = prisma.$executeRawUnsafe.bind(prisma);
	const originalExecute = prisma.$executeRaw.bind(prisma);
	const statements: string[] = [];

	const cancelFirst = async () => {
		await originalUpdate({
			where: { id: jobId },
			data: { status: "cancelled", completedAt: new Date() },
		});
	};

	prisma.$executeRawUnsafe = (async (query: string, ...values: unknown[]) => {
		if (writesTerminalStatus(query, values)) {
			statements.push(String(query));
			await cancelFirst();
		}
		return originalExecuteUnsafe(query, ...values);
	}) as typeof prisma.$executeRawUnsafe;

	prisma.$executeRaw = (async (
		query: TemplateStringsArray | Prisma.Sql,
		...values: unknown[]
	) => {
		const text = String(query);
		if (writesTerminalStatus(text, values)) {
			statements.push(text);
			await cancelFirst();
		}
		return originalExecute(query as never, ...values);
	}) as typeof prisma.$executeRaw;

	restorers.push(() => {
		prisma.$executeRawUnsafe = originalExecuteUnsafe;
		prisma.$executeRaw = originalExecute;
	});
	return statements;
}

function writesTerminalStatus(query: string, values: unknown[]): boolean {
	const sql = query.toLowerCase();
	if (!sql.includes("status")) {
		return false;
	}
	return (
		values.includes("completed") ||
		values.includes("failed") ||
		sql.includes("'completed'") ||
		sql.includes("'failed'")
	);
}
