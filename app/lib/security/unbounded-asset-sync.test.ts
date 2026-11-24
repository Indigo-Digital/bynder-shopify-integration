// @vitest-environment node
/**
 * Spec for the asset-sync memory caps.
 *
 * These tests fail while a single download or a full-library page loop can
 * grow without a hard stop. They pass once each operation enforces the
 * ceilings below. The Fly machine that runs sync is 2048 MB and is shared
 * by every installed shop (fly.toml), so one response must not be able to
 * hold the process open while it buffers the rest of an unbounded body.
 *
 * Required failure text (the decimal ceiling must appear in the message):
 * - downloads: "maximum download size of <MAX_ASSET_BYTES> bytes"
 * - page loop: "maximum page count of <MAX_BYNDER_PAGES>"
 * - asset loop: "maximum asset count of <MAX_BYNDER_ASSETS>"
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BynderClient } from "../bynder/client.js";
import { uploadBynderAsset } from "../shopify/files.js";
import type { AdminApi } from "../types.js";

process.env.BYNDER_RATE_LIMIT_RPS = "100000";
process.env.BYNDER_RATE_LIMIT_BURST = "100000";
process.env.ENABLE_METRICS = "false";

/** Largest asset body a download may accept. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Largest page index getAllMediaItems may request. Page numbers start at 1. */
const MAX_BYNDER_PAGES = 40;

/** Largest number of assets getAllMediaItems may retain. */
const MAX_BYNDER_ASSETS = 1000;

/** Bytes delivered before an oversized body deliberately stops and stays open. */
const PAUSE_AFTER_BYTES = MAX_ASSET_BYTES + 64 * 1024;

/** Declared Content-Length for the header case. Larger than the bytes sent. */
const DECLARED_OVERSIZE_BYTES = MAX_ASSET_BYTES + 32 * 1024 * 1024;

const ASSET_ID = "asset1";
const SIZE_LIMIT_WAIT_MS = 3000;

vi.mock("../shopify/metafields.js", () => ({
	setBynderMetafields: vi.fn().mockResolvedValue(undefined),
}));

type DownloadBehavior =
	| { kind: "exact"; size: number }
	| { kind: "paused-binary"; declareLength: boolean }
	| { kind: "paused-json" }
	| { kind: "paused-error" }
	| { kind: "paused-s3" };

type ListBehavior =
	| "valid-array"
	| "valid-media"
	| "invalid-array"
	| "invalid-media";

interface ListStats {
	pagesServed: number;
	highestPage: number;
	limit: number;
}

let server: http.Server;
let baseUrl = "";
let downloadBehavior: DownloadBehavior = { kind: "exact", size: 32 };
let listBehavior: ListBehavior = "valid-array";
let listStats: ListStats = { pagesServed: 0, highestPage: 0, limit: 50 };
const openSockets = new Set<http.ServerResponse>();

function mediaInfoBody(): string {
	return JSON.stringify({
		id: ASSET_ID,
		name: "photo.jpg",
		type: "image",
		tags: ["shopify-sync"],
		description: "catalog photo",
		dateModified: "2024-01-02T00:00:00.000Z",
		dateCreated: "2024-01-01T00:00:00.000Z",
		version: 1,
	});
}

function jpegBuffer(size: number): Buffer {
	const buffer = Buffer.alloc(size, 0x11);
	buffer[0] = 0xff;
	buffer[1] = 0xd8;
	buffer[2] = 0xff;
	return buffer;
}

function writeAll(
	res: http.ServerResponse,
	payload: Buffer,
	status = 200
): void {
	res.writeHead(status, {
		"Content-Type": status === 200 ? "image/jpeg" : "text/plain",
		"Content-Length": String(payload.length),
	});
	res.end(payload);
}

/**
 * Send `byteCount` bytes and leave the response open so a consumer that
 * waits for the end of the body cannot finish.
 */
function writeThenPause(
	res: http.ServerResponse,
	byteCount: number,
	headers: Record<string, string>,
	status = 200
): void {
	openSockets.add(res);
	res.on("close", () => {
		openSockets.delete(res);
	});
	res.writeHead(status, headers);
	let sent = 0;
	const chunk = Buffer.alloc(16 * 1024, 0x61);
	const pump = (): void => {
		if (res.destroyed || sent >= byteCount) {
			return;
		}
		while (sent < byteCount) {
			const n = Math.min(chunk.length, byteCount - sent);
			const ok = res.write(chunk.subarray(0, n));
			sent += n;
			if (!ok) {
				res.once("drain", pump);
				return;
			}
		}
	};
	pump();
}

function pausedHeaders(
	contentType: string,
	declareLength: boolean
): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": contentType };
	if (declareLength) {
		headers["Content-Length"] = String(DECLARED_OVERSIZE_BYTES);
	}
	return headers;
}

function servePausedDownload(
	res: http.ServerResponse,
	behavior: DownloadBehavior
): void {
	if (behavior.kind === "paused-binary") {
		writeThenPause(
			res,
			PAUSE_AFTER_BYTES,
			pausedHeaders("image/jpeg", behavior.declareLength)
		);
		return;
	}
	if (behavior.kind === "paused-json") {
		writeThenPause(
			res,
			PAUSE_AFTER_BYTES,
			pausedHeaders("application/json", false)
		);
		return;
	}
	if (behavior.kind === "paused-error") {
		writeThenPause(
			res,
			PAUSE_AFTER_BYTES,
			{ "Content-Type": "text/plain" },
			500
		);
		return;
	}
	const s3Url = `${baseUrl}/s3-object`;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ s3_file: s3Url }));
}

function listItem(
	page: number,
	index: number,
	valid: boolean
): Record<string, unknown> {
	if (!valid) {
		return { name: `untitled-${page}-${index}` };
	}
	return {
		id: `asset-${page}-${index}`,
		tags: ["shopify-sync"],
		version: 1,
	};
}

function listPayload(
	page: number,
	limit: number,
	behavior: ListBehavior
): unknown {
	const valid = behavior === "valid-array" || behavior === "valid-media";
	const stopAfter = behavior.startsWith("valid")
		? Math.ceil(MAX_BYNDER_ASSETS / limit) + 5
		: MAX_BYNDER_PAGES + 5;
	const count = page > stopAfter ? 1 : limit;
	const items = Array.from({ length: count }, (_, index) =>
		listItem(page, index, valid)
	);
	if (behavior.endsWith("media")) {
		return { media: items, total: 50_000_000 };
	}
	return items;
}

function serveList(res: http.ServerResponse, url: URL): void {
	const page = Number(url.searchParams.get("page") ?? "1");
	const limit = Number(url.searchParams.get("limit") ?? "50");
	listStats = {
		pagesServed: listStats.pagesServed + 1,
		highestPage: Math.max(listStats.highestPage, page),
		limit,
	};
	const body = JSON.stringify(listPayload(page, limit, listBehavior));
	res.writeHead(200, {
		"Content-Type": "application/json",
		"Content-Length": String(Buffer.byteLength(body)),
	});
	res.end(body);
}

function createMockAdmin(): AdminApi {
	const graphql = vi.fn(async (query: string) => {
		if (query.includes("stagedUploadsCreate")) {
			return {
				json: async () => ({
					data: {
						stagedUploadsCreate: {
							stagedTargets: [
								{
									resourceUrl: `${baseUrl}/staged-resource`,
									url: `${baseUrl}/staged?X-Goog-Algorithm=GOOG4-RSA-SHA256`,
									parameters: [],
								},
							],
							userErrors: [],
						},
					},
				}),
			};
		}
		return {
			json: async () => ({
				data: {
					fileCreate: {
						files: [
							{
								id: "gid://shopify/MediaImage/1",
								fileStatus: "READY",
								image: { url: `${baseUrl}/cdn/photo.jpg` },
							},
						],
						userErrors: [],
					},
				},
			}),
		};
	});
	return {
		graphql,
		rest: { resources: {} },
	} as unknown as AdminApi;
}

function createClient(): BynderClient {
	return BynderClient.createFromEnv(baseUrl);
}

async function runDownload(
	admin: AdminApi
): Promise<
	| { kind: "resolved" }
	| { kind: "rejected"; error: unknown }
	| { kind: "pending" }
> {
	const client = createClient();
	const result = uploadBynderAsset(
		admin,
		client,
		ASSET_ID,
		"shop-1",
		"manual",
		{
			syncTags: "shopify-sync",
		}
	).then(
		() => ({ kind: "resolved" as const }),
		(error: unknown) => ({ kind: "rejected" as const, error })
	);
	return Promise.race([
		result,
		new Promise<{ kind: "pending" }>((resolve) => {
			setTimeout(() => resolve({ kind: "pending" }), SIZE_LIMIT_WAIT_MS);
		}),
	]);
}

function expectSizeRejection(
	outcome: Awaited<ReturnType<typeof runDownload>>,
	admin: AdminApi
): void {
	expect(
		outcome.kind,
		"the download kept waiting for the rest of the body"
	).toBe("rejected");
	if (outcome.kind !== "rejected") {
		return;
	}
	const message =
		outcome.error instanceof Error
			? outcome.error.message
			: String(outcome.error);
	expect(message).toContain(
		`maximum download size of ${MAX_ASSET_BYTES} bytes`
	);
	expect(admin.graphql).not.toHaveBeenCalled();
}

function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse
): void {
	const host = req.headers.host ?? "127.0.0.1";
	const url = new URL(req.url ?? "/", `http://${host}`);
	if (req.method === "PUT" && url.pathname === "/staged") {
		res.writeHead(200);
		res.end();
		return;
	}
	if (url.pathname === "/s3-object") {
		writeThenPause(res, PAUSE_AFTER_BYTES, pausedHeaders("image/jpeg", false));
		return;
	}
	if (url.searchParams.has("page")) {
		serveList(res, url);
		return;
	}
	if (url.pathname.endsWith("/download")) {
		if (downloadBehavior.kind === "exact") {
			writeAll(res, jpegBuffer(downloadBehavior.size));
			return;
		}
		servePausedDownload(res, downloadBehavior);
		return;
	}
	if (url.pathname.includes("/v4/media/")) {
		const body = mediaInfoBody();
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(body)),
		});
		res.end(body);
		return;
	}
	res.writeHead(404);
	res.end();
}

beforeAll(async () => {
	server = http.createServer(handleRequest);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	for (const res of openSockets) {
		res.destroy();
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

describe("asset download size cap", () => {
	beforeEach(() => {
		for (const res of openSockets) {
			res.destroy();
		}
		openSockets.clear();
		downloadBehavior = { kind: "exact", size: 32 };
		listStats = { pagesServed: 0, highestPage: 0, limit: 50 };
	});

	it("accepts a download that is exactly the maximum size", async () => {
		downloadBehavior = { kind: "exact", size: MAX_ASSET_BYTES };
		const admin = createMockAdmin();
		const client = createClient();
		const result = await uploadBynderAsset(
			admin,
			client,
			ASSET_ID,
			"shop-1",
			"manual",
			{
				syncTags: "shopify-sync",
			}
		);
		expect(result.fileId).toBe("gid://shopify/MediaImage/1");
		expect(admin.graphql).toHaveBeenCalled();
	}, 20_000);

	it("stops a binary download once the body exceeds the cap", async () => {
		downloadBehavior = { kind: "paused-binary", declareLength: false };
		const admin = createMockAdmin();
		const outcome = await runDownload(admin);
		expectSizeRejection(outcome, admin);
	});

	it("stops a binary download when Content-Length is above the cap", async () => {
		downloadBehavior = { kind: "paused-binary", declareLength: true };
		const admin = createMockAdmin();
		const outcome = await runDownload(admin);
		expectSizeRejection(outcome, admin);
	});

	it("stops following an s3_file URL when that body exceeds the cap", async () => {
		downloadBehavior = { kind: "paused-s3" };
		const admin = createMockAdmin();
		const outcome = await runDownload(admin);
		expectSizeRejection(outcome, admin);
	});

	it("stops reading a JSON download body that exceeds the cap", async () => {
		downloadBehavior = { kind: "paused-json" };
		const admin = createMockAdmin();
		const outcome = await runDownload(admin);
		expectSizeRejection(outcome, admin);
	});

	it("stops reading an error response body that exceeds the cap", async () => {
		downloadBehavior = { kind: "paused-error" };
		const admin = createMockAdmin();
		const outcome = await runDownload(admin);
		expectSizeRejection(outcome, admin);
	});
});

describe("Bynder pagination caps", () => {
	function resetList(behavior: ListBehavior): void {
		listBehavior = behavior;
		listStats = { pagesServed: 0, highestPage: 0, limit: 50 };
	}

	async function collectPages(): Promise<unknown> {
		const client = createClient();
		return client.getAllMediaItems({
			tags: "shopify-sync",
			shopId: "shop-1",
		});
	}

	async function expectPaginationStop(
		message: string,
		maxPage: number | "assets"
	): Promise<void> {
		let thrown: unknown;
		try {
			await collectPages();
		} catch (error) {
			thrown = error;
		}
		const text = thrown instanceof Error ? thrown.message : "";
		const limit = Math.max(listStats.limit, 1);
		const ceiling =
			maxPage === "assets" ? Math.ceil(MAX_BYNDER_ASSETS / limit) + 1 : maxPage;
		expect(
			text,
			`highest page requested was ${listStats.highestPage}`
		).toContain(message);
		expect(listStats.highestPage).toBeLessThanOrEqual(ceiling);
	}

	it("stops requesting pages when items have no id and every page is full", async () => {
		resetList("invalid-array");
		await expectPaginationStop(
			`maximum page count of ${MAX_BYNDER_PAGES}`,
			MAX_BYNDER_PAGES
		);
	});

	it("stops requesting pages when the media-object page never shrinks", async () => {
		resetList("invalid-media");
		await expectPaginationStop(
			`maximum page count of ${MAX_BYNDER_PAGES}`,
			MAX_BYNDER_PAGES
		);
	});

	it("stops retaining assets from a raw array of full pages", async () => {
		resetList("valid-array");
		await expectPaginationStop(
			`maximum asset count of ${MAX_BYNDER_ASSETS}`,
			"assets"
		);
	});

	it("stops retaining assets when each page reports a huge total", async () => {
		resetList("valid-media");
		await expectPaginationStop(
			`maximum asset count of ${MAX_BYNDER_ASSETS}`,
			"assets"
		);
	});
});
