// @vitest-environment node
/**
 * Spec for the manual full-sync queue.
 *
 * These tests fail while POST /api/sync (no asset id) inserts a SyncJob on
 * every authenticated request. They pass once a shop cannot enqueue another
 * full sync while one is already pending or running, concurrent requests
 * cannot sneak a second job through a check-then-create gap, and a shop
 * cannot enqueue another full sync until 15 minutes after its previous one.
 *
 * A full sync is POST /api/sync with no assetId, including ?forceImportAll=true.
 *
 * Untested on purpose, because they do not insert a shared-queue SyncJob:
 * - POST /api/sync?assetId=... uploads one asset in the request.
 * - POST /api/sync/retry retries assets already listed on a job.
 * - syncBynderAssets creates a job only when called without a jobId. The
 *   worker always passes the job id it already claimed.
 */
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const FULL_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;
const SHOP_A = "staff-shop-a.myshopify.com";
const SHOP_B = "staff-shop-b.myshopify.com";
const PORTAL_A = "https://portal-a.bynder.test";
const PORTAL_B = "https://portal-b.bynder.test";
const ASSET_ID = "4BFD3C8F-7ACC-4D1E-98A2-7BFDDC6C511E";
const PNG_PATH = fileURLToPath(
	new URL("../../../tests/fixtures/test-image.png", import.meta.url)
);

const databaseDir = mkdtempSync(path.join(tmpdir(), "manual-sync-limit-"));
process.env.DATABASE_URL = `file:${path.join(databaseDir, "test.sqlite")}`;
process.env.GEMINI_API_KEY = "placeholder-not-a-real-secret";

const bynderHarness = vi.hoisted(() => {
	const constructed: Array<Record<string, unknown>> = [];
	let mediaList: (params: unknown) => Promise<unknown> = async () => ({
		media: [],
		total: 0,
	});
	const mediaInfo = async () => ({
		id: "4BFD3C8F-7ACC-4D1E-98A2-7BFDDC6C511E",
		name: "mug.png",
		description: "mug",
		type: "image",
		tags: ["shopify-sync"],
		version: 1,
		dateModified: "2026-01-01T00:00:00.000Z",
		dateCreated: "2026-01-01T00:00:00.000Z",
		derivatives: {},
		thumbnails: {},
		files: [],
	});
	const downloadUrl = async () => "https://download.bynder.test/mug.png";
	return {
		constructed,
		setMediaList(fn: (params: unknown) => Promise<unknown>) {
			mediaList = fn;
		},
		mediaList: (params: unknown) => mediaList(params),
		mediaInfo,
		downloadUrl,
	};
});

const geminiHarness = vi.hoisted(() => {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		reset() {
			calls.length = 0;
		},
	};
});

vi.mock("../../db.server.js", async () =>
	vi.importActual("../../db.server.js")
);

vi.mock("@bynder/bynder-js-sdk", () => ({
	default: class Bynder {
		config: Record<string, unknown>;
		constructor(config: Record<string, unknown>) {
			this.config = config;
			bynderHarness.constructed.push(config);
		}
		getMediaList(params: unknown) {
			return bynderHarness.mediaList(params);
		}
		getMediaInfo() {
			return bynderHarness.mediaInfo();
		}
		getMediaDownloadUrl() {
			return bynderHarness.downloadUrl();
		}
	},
}));

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		models = {
			generateContent: async (request: Record<string, unknown>) => {
				geminiHarness.calls.push(request);
				return { text: "Red ceramic mug on a white table" };
			},
		};
	},
}));

type SyncAction = (args: ActionFunctionArgs) => Promise<Response>;

let prisma: PrismaClient;
let action: SyncAction;
let successfulCreates = 0;
let successfulDeletes = 0;

class ReadGate {
	private arrived = 0;
	private opened = false;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly needed: number) {}

	enter(): Promise<void> {
		this.arrived += 1;
		if (this.arrived >= this.needed) {
			this.release();
		}
		if (this.opened) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	release(): void {
		if (this.opened) {
			return;
		}
		this.opened = true;
		for (const resolve of this.waiters) {
			resolve();
		}
		this.waiters.length = 0;
	}
}

let activeGate: ReadGate | null = null;

function hmacKey(secret: string): Uint8Array {
	const bytes = new Uint8Array(secret.length);
	for (let index = 0; index < secret.length; index++) {
		bytes[index] = secret.charCodeAt(index);
	}
	return bytes;
}

function staffToken(shop: string): string {
	const secret = process.env.SHOPIFY_API_SECRET;
	const apiKey = process.env.SHOPIFY_API_KEY;
	if (!secret || !apiKey) {
		throw new Error("Shopify app credentials are not set");
	}
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "HS256", typ: "JWT" })
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			dest: `https://${shop}`,
			aud: apiKey,
			sub: "staff-user-9001",
			iat: now,
			exp: now + 120,
		})
	).toString("base64url");
	const signature = createHmac("sha256", hmacKey(secret))
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${signature}`;
}

async function provisionShop(options: {
	shop: string;
	portal: string;
	enableAutoAltText?: boolean;
}): Promise<{ id: string }> {
	const shop = await prisma.shop.create({
		data: {
			shop: options.shop,
			bynderBaseUrl: options.portal,
			syncTags: "shopify-sync",
			enableAutoAltText: options.enableAutoAltText ?? false,
		},
	});
	await prisma.session.create({
		data: {
			id: `offline_${options.shop}`,
			shop: options.shop,
			state: "",
			isOnline: false,
			accessToken: "placeholder-offline-access-token",
			accountOwner: false,
		},
	});
	return shop;
}

async function resetData(): Promise<void> {
	await prisma.syncMetrics.deleteMany();
	await prisma.syncedAsset.deleteMany();
	await prisma.syncJob.deleteMany();
	await prisma.session.deleteMany();
	await prisma.shop.deleteMany();
	successfulCreates = 0;
	successfulDeletes = 0;
	bynderHarness.constructed.length = 0;
	geminiHarness.reset();
}

async function postFullSync(
	token: string,
	url = "https://test.example.com/api/sync",
	body: unknown = {}
): Promise<{ status: number; data: Record<string, unknown> }> {
	const request = new Request(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0 (staff)",
		},
		body: JSON.stringify(body),
	});
	const response = await action({ request } as ActionFunctionArgs);
	const data = (await response.json()) as Record<string, unknown>;
	return { status: response.status, data };
}

function installClientInstrumentation(client: PrismaClient): void {
	const findFirst = client.syncJob.findFirst.bind(client.syncJob);
	const findMany = client.syncJob.findMany.bind(client.syncJob);
	const count = client.syncJob.count.bind(client.syncJob);
	const create = client.syncJob.create.bind(client.syncJob);
	const del = client.syncJob.delete.bind(client.syncJob);
	const deleteMany = client.syncJob.deleteMany.bind(client.syncJob);
	const transaction = client.$transaction.bind(client);

	const gateRead = async <T>(run: () => Promise<T>): Promise<T> => {
		if (activeGate) {
			await activeGate.enter();
		}
		return run();
	};

	const countCreate = async <T>(run: () => Promise<T>): Promise<T> => {
		const row = await run();
		successfulCreates += 1;
		return row;
	};

	client.syncJob.findFirst = ((args) =>
		gateRead(() => findFirst(args))) as typeof client.syncJob.findFirst;
	client.syncJob.findMany = ((args) =>
		gateRead(() => findMany(args))) as typeof client.syncJob.findMany;
	client.syncJob.count = ((args) =>
		gateRead(() => count(args))) as typeof client.syncJob.count;
	client.syncJob.create = ((args) =>
		countCreate(() => create(args))) as typeof client.syncJob.create;
	client.syncJob.delete = (async (args) => {
		const row = await del(args);
		successfulDeletes += 1;
		return row;
	}) as typeof client.syncJob.delete;
	client.syncJob.deleteMany = (async (args) => {
		const row = await deleteMany(args);
		successfulDeletes += 1;
		return row;
	}) as typeof client.syncJob.deleteMany;

	client.$transaction = (async (fn: unknown, options?: unknown) => {
		if (typeof fn !== "function") {
			return transaction(fn as never, options as never);
		}
		return transaction(async (tx) => {
			const txCreate = tx.syncJob.create.bind(tx.syncJob);
			const txDelete = tx.syncJob.delete.bind(tx.syncJob);
			tx.syncJob.create = ((args) =>
				countCreate(() => txCreate(args))) as typeof tx.syncJob.create;
			tx.syncJob.delete = (async (args) => {
				const row = await txDelete(args);
				successfulDeletes += 1;
				return row;
			}) as typeof tx.syncJob.delete;
			return fn(tx);
		}, options as never);
	}) as typeof client.$transaction;
}

function graphqlPayload(query: string): { data: Record<string, unknown> } {
	if (query.includes("stagedUploadsCreate")) {
		return {
			data: {
				stagedUploadsCreate: {
					stagedTargets: [
						{
							url: "https://uploads.test/object?X-Goog-Algorithm=GOOG4-RSA-SHA256",
							resourceUrl: "https://cdn.test/files/mug.png",
							parameters: [],
						},
					],
					userErrors: [],
				},
			},
		};
	}
	if (query.includes("fileCreate")) {
		return {
			data: {
				fileCreate: {
					files: [
						{
							id: "gid://shopify/MediaImage/1",
							fileStatus: "READY",
							image: { url: "https://cdn.test/files/mug.png" },
						},
					],
					userErrors: [],
				},
			},
		};
	}
	if (query.includes("metafieldsSet")) {
		return {
			data: {
				metafieldsSet: {
					metafields: [{ id: "gid://shopify/Metafield/1" }],
					userErrors: [],
				},
			},
		};
	}
	throw new Error(
		`Unexpected Shopify GraphQL operation: ${query.slice(0, 80)}`
	);
}

describe("manual full sync job limit", () => {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../.."
	);
	let restoreFetch: (() => void) | undefined;

	beforeAll(async () => {
		execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
			cwd: repoRoot,
			env: process.env,
			stdio: "pipe",
		});
		const realFetch = globalThis.fetch.bind(globalThis);
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("/admin/api/") && url.endsWith("/graphql.json")) {
				const raw = typeof init?.body === "string" ? init.body : "{}";
				const body = JSON.parse(raw) as { query?: string };
				return Response.json(graphqlPayload(body.query ?? ""));
			}
			if (url.startsWith("https://download.bynder.test/")) {
				return new Response(readFileSync(PNG_PATH), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			if (url.startsWith("https://uploads.test/")) {
				return new Response("ok", { status: 200 });
			}
			if (url.startsWith("http://") || url.startsWith("https://")) {
				throw new Error(`Unexpected outbound request to ${url}`);
			}
			return realFetch(input, init);
		};
		restoreFetch = () => {
			globalThis.fetch = realFetch;
		};

		const database = await import("../../db.server.js");
		prisma = database.default;
		installClientInstrumentation(prisma);
		const route = await import("../api.sync.js");
		action = route.action as SyncAction;
	}, 60_000);

	beforeEach(async () => {
		await resetData();
	});

	afterAll(async () => {
		restoreFetch?.();
		await prisma?.$disconnect();
		rmSync(databaseDir, { recursive: true, force: true });
	});

	it("rejects a second full sync while one job is pending and does not insert it", async () => {
		const shop = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		const token = await staffToken(SHOP_A);
		const createsBefore = successfulCreates;

		const first = await postFullSync(token);
		const second = await postFullSync(token);
		const jobs = await prisma.syncJob.findMany({ where: { shopId: shop.id } });

		expect(first.status).toBe(200);
		expect(first.data.success).toBe(true);
		expect(second.status).toBe(409);
		expect(second.data.success).not.toBe(true);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.status).toBe("pending");
		expect(successfulCreates - createsBefore).toBe(1);
		expect(successfulDeletes).toBe(0);
	});

	it("rejects a full sync while that shop has a running job", async () => {
		const shop = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		await prisma.syncJob.create({
			data: {
				shopId: shop.id,
				status: "running",
				startedAt: new Date(),
				assetsProcessed: 0,
			},
		});
		const createsBefore = successfulCreates;
		const token = await staffToken(SHOP_A);

		const result = await postFullSync(token);
		const jobs = await prisma.syncJob.findMany({ where: { shopId: shop.id } });

		expect(result.status).toBe(409);
		expect(jobs).toHaveLength(1);
		expect(successfulCreates - createsBefore).toBe(0);
		expect(successfulDeletes).toBe(0);
	});

	it("treats forceImportAll as the same full sync and still rejects a duplicate", async () => {
		const shop = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		const token = await staffToken(SHOP_A);

		const first = await postFullSync(
			token,
			"https://test.example.com/api/sync?forceImportAll=true"
		);
		const second = await postFullSync(
			token,
			"https://test.example.com/api/sync?forceImportAll=true"
		);
		const jobs = await prisma.syncJob.findMany({ where: { shopId: shop.id } });

		expect(first.status).toBe(200);
		expect(second.status).toBe(409);
		expect(jobs).toHaveLength(1);
	});

	it("keeps a single job when concurrent full syncs pass a stale existence check", async () => {
		const shop = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		const token = await staffToken(SHOP_A);
		const burst = 8;
		activeGate = new ReadGate(burst);
		const release = setTimeout(() => activeGate?.release(), 5_000);
		const createsBefore = successfulCreates;

		let results: Array<{ status: number; data: Record<string, unknown> }>;
		try {
			results = await Promise.all(
				Array.from({ length: burst }, () => postFullSync(token))
			);
		} finally {
			clearTimeout(release);
			activeGate?.release();
			activeGate = null;
		}

		const jobs = await prisma.syncJob.findMany({ where: { shopId: shop.id } });
		const accepted = results.filter((result) => result.data.success === true);
		const rejected = results.filter((result) => result.status >= 400);

		expect(jobs).toHaveLength(1);
		expect(accepted).toHaveLength(1);
		expect(rejected).toHaveLength(burst - 1);
		expect(successfulCreates - createsBefore).toBe(1);
		expect(successfulDeletes).toBe(0);
	});

	it("rejects another full sync until 15 minutes after the previous job was created", async () => {
		const shop = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		await prisma.syncJob.create({
			data: {
				shopId: shop.id,
				status: "completed",
				completedAt: new Date(),
				createdAt: new Date(Date.now() - (FULL_SYNC_MIN_INTERVAL_MS - 1_000)),
				assetsProcessed: 1,
			},
		});
		const createsBefore = successfulCreates;
		const token = await staffToken(SHOP_A);

		const result = await postFullSync(token);
		const jobs = await prisma.syncJob.findMany({ where: { shopId: shop.id } });

		expect(result.status).toBe(429);
		expect(result.data.success).not.toBe(true);
		expect(jobs).toHaveLength(1);
		expect(successfulCreates - createsBefore).toBe(0);
		expect(successfulDeletes).toBe(0);
	});

	it("allows a full sync once the previous job is at least 15 minutes old and idle", async () => {
		const shop = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		await prisma.syncJob.create({
			data: {
				shopId: shop.id,
				status: "completed",
				completedAt: new Date(Date.now() - FULL_SYNC_MIN_INTERVAL_MS - 5_000),
				createdAt: new Date(Date.now() - FULL_SYNC_MIN_INTERVAL_MS - 5_000),
				assetsProcessed: 1,
			},
		});
		const token = await staffToken(SHOP_A);

		const result = await postFullSync(token);
		const jobs = await prisma.syncJob.findMany({ where: { shopId: shop.id } });

		expect(result.status).toBe(200);
		expect(result.data.success).toBe(true);
		expect(jobs).toHaveLength(2);
		expect(jobs.filter((job) => job.status === "pending")).toHaveLength(1);
	});

	it("does not apply one shop's queue or interval to another shop", async () => {
		const shopA = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		const shopB = await provisionShop({ shop: SHOP_B, portal: PORTAL_B });
		await prisma.syncJob.create({
			data: { shopId: shopA.id, status: "pending", assetsProcessed: 0 },
		});
		const tokenB = await staffToken(SHOP_B);

		const result = await postFullSync(tokenB);
		const jobsB = await prisma.syncJob.findMany({
			where: { shopId: shopB.id },
		});

		expect(result.status).toBe(200);
		expect(jobsB).toHaveLength(1);
	});

	it("does not insert a job when the staff session token is missing or for another shop's body", async () => {
		const shopA = await provisionShop({ shop: SHOP_A, portal: PORTAL_A });
		const shopB = await provisionShop({ shop: SHOP_B, portal: PORTAL_B });
		const anonymous = new Request("https://test.example.com/api/sync", {
			method: "POST",
			headers: { "User-Agent": "Mozilla/5.0 (staff)" },
		});
		const anonymousResponse = await action({
			request: anonymous,
		} as ActionFunctionArgs);
		const jobsAfterAnonymous = await prisma.syncJob.count();

		const tokenA = await staffToken(SHOP_A);
		const crossShop = await postFullSync(tokenA, undefined, {
			shop: SHOP_B,
			shopId: shopB.id,
		});
		const jobsA = await prisma.syncJob.findMany({
			where: { shopId: shopA.id },
		});
		const jobsB = await prisma.syncJob.findMany({
			where: { shopId: shopB.id },
		});

		expect(anonymousResponse.status).toBeGreaterThanOrEqual(400);
		expect(jobsAfterAnonymous).toBe(0);
		expect(crossShop.status).toBe(200);
		expect(jobsA).toHaveLength(1);
		expect(jobsB).toHaveLength(0);
		expect(jobsA[0]?.shopId).toBe(shopA.id);
	});

	it("runs one shop's full sync to the shared Bynder token and Gemini before the next shop's job", async () => {
		const shopA = await provisionShop({
			shop: SHOP_A,
			portal: PORTAL_A,
			enableAutoAltText: true,
		});
		const shopB = await provisionShop({
			shop: SHOP_B,
			portal: PORTAL_B,
			enableAutoAltText: false,
		});
		const tokenA = await staffToken(SHOP_A);
		const tokenB = await staffToken(SHOP_B);
		const flood = 5;
		for (let attempt = 0; attempt < flood; attempt++) {
			await postFullSync(tokenA);
		}
		await postFullSync(tokenB);

		let releaseList: (value: unknown) => void = () => undefined;
		let listCalls = 0;
		const listEntered = deferred<void>();
		bynderHarness.setMediaList(() => {
			listCalls += 1;
			if (listCalls === 1) {
				listEntered.resolve();
				return new Promise((resolve) => {
					releaseList = resolve;
				});
			}
			// Hold every later library listing so the worker stays inside that
			// job instead of polling after the test disconnects the database.
			return new Promise(() => undefined);
		});

		const { getRateLimiter } = await import("../../lib/bynder/rate-limiter.js");
		const tokensBefore = getRateLimiter().getAvailableTokens();
		await import("../../lib/sync/worker.js");

		await vi.waitFor(async () => {
			expect(listEntered.settled).toBe(true);
		});
		const running = await prisma.syncJob.findMany({
			where: { status: "running" },
		});
		const pendingB = await prisma.syncJob.findMany({
			where: { shopId: shopB.id, status: "pending" },
		});

		expect(running).toHaveLength(1);
		expect(running[0]?.shopId).toBe(shopA.id);
		expect(pendingB).toHaveLength(1);
		expect(getRateLimiter().getAvailableTokens()).toBeLessThan(tokensBefore);
		expect(bynderHarness.constructed.length).toBeGreaterThan(0);
		for (const config of bynderHarness.constructed) {
			expect(config.permanentToken).toBe(process.env.BYNDER_PERMANENT_TOKEN);
		}
		expect(
			bynderHarness.constructed.some(
				(config) =>
					typeof config.baseURL === "string" &&
					config.baseURL.includes("portal-a.bynder.test")
			)
		).toBe(true);

		releaseList({
			media: [
				{
					id: ASSET_ID,
					tags: ["shopify-sync"],
					version: 1,
					name: "mug.png",
				},
			],
			total: 1,
		});

		await vi.waitFor(
			async () => {
				expect(geminiHarness.calls.length).toBeGreaterThan(0);
			},
			{ timeout: 20_000 }
		);
		const geminiCall = geminiHarness.calls[0];
		expect(geminiCall?.model).toBe("gemini-2.0-flash");
		expect(JSON.stringify(geminiCall?.contents)).toContain("inlineData");

		await vi.waitFor(
			async () => {
				const finished = await prisma.syncJob.findFirst({
					where: { shopId: shopA.id, status: { in: ["completed", "failed"] } },
				});
				expect(finished).not.toBeNull();
				expect(listCalls).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 20_000 }
		);
		const queuedForA = await prisma.syncJob.count({
			where: { shopId: shopA.id },
		});
		const queuedForB = await prisma.syncJob.count({
			where: { shopId: shopB.id },
		});
		expect(queuedForA).toBe(1);
		expect(queuedForB).toBe(1);
	}, 40_000);
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	settled: boolean;
} {
	let resolve: (value: T) => void = () => undefined;
	let settled = false;
	const promise = new Promise<T>((done) => {
		resolve = (value) => {
			settled = true;
			done(value);
		};
	});
	return {
		promise,
		resolve,
		get settled() {
			return settled;
		},
	};
}
