// @vitest-environment node

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * Security contract for POST /api/sync/retry.
 *
 * A staff session may retry assets that failed for that shop. One request
 * must not download more than MAX_RETRY_DOWNLOADS assets, must ignore ids
 * that are not in that shop's recent failed jobs, and must refuse a body
 * larger than MAX_RETRY_BODY_BYTES before any Bynder or Shopify call.
 */
const MAX_RETRY_DOWNLOADS = 48;
const MAX_RETRY_BODY_BYTES = 16 * 1024;

const SHOP_DOMAIN = "installed-shop.myshopify.com";
const SHOP_ID = "shop-installed";
const OTHER_SHOP_ID = "shop-other";
const OWN_JOB_ID = "job-own";
const OTHER_JOB_ID = "job-other";
const FILE_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

process.env.BYNDER_RATE_LIMIT_RPS = "1000000";
process.env.BYNDER_RATE_LIMIT_BURST = "1000000";
process.env.ENABLE_METRICS = "false";

vi.mock("../../db.server.js", () => ({
	default: {
		shop: { findUnique: vi.fn() },
		syncedAsset: { findUnique: vi.fn(), upsert: vi.fn() },
		syncJob: { findMany: vi.fn(), findUnique: vi.fn() },
	},
}));

vi.mock("../../shopify.server.js", () => ({
	authenticate: { admin: vi.fn() },
}));

import prisma from "../../db.server.js";
import { authenticate } from "../../shopify.server.js";
import { action } from "../api.sync.retry.js";

const mockPrisma = prisma as unknown as {
	shop: { findUnique: ReturnType<typeof vi.fn> };
	syncedAsset: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	syncJob: {
		findMany: ReturnType<typeof vi.fn>;
		findUnique: ReturnType<typeof vi.fn>;
	};
};

const mockAuthenticate = authenticate as unknown as {
	admin: ReturnType<typeof vi.fn>;
};

const realFetch = globalThis.fetch;
const mediaInfoIds: string[] = [];
const downloads: Array<{ assetId: string; byteLength: number }> = [];
const shopifyPuts: number[] = [];

let bynderServer: Server;
let bynderOrigin = "";

function mediaIdFromPath(pathname: string): string | null {
	const match = pathname.match(/\/v4\/media\/([^/]+)/);
	if (!match?.[1]) {
		return null;
	}
	return decodeURIComponent(match[1]);
}

function failedJob(input: { id: string; shopId: string; assetIds: string[] }) {
	return {
		id: input.id,
		shopId: input.shopId,
		status: "failed",
		errors: JSON.stringify(
			input.assetIds.map((assetId) => ({
				assetId,
				error: "timeout talking to upstream",
			}))
		),
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function installShopState(ownFailedIds: string[]) {
	const jobs = [
		failedJob({ id: OWN_JOB_ID, shopId: SHOP_ID, assetIds: ownFailedIds }),
		failedJob({
			id: OTHER_JOB_ID,
			shopId: OTHER_SHOP_ID,
			assetIds: ["foreign-asset"],
		}),
	];
	mockPrisma.shop.findUnique.mockImplementation(
		async (args: { where?: { shop?: string; id?: string } }) => {
			const where = args?.where;
			if (where?.shop === SHOP_DOMAIN || where?.id === SHOP_ID) {
				return {
					id: SHOP_ID,
					shop: SHOP_DOMAIN,
					bynderBaseUrl: bynderOrigin,
					syncTags: "shopify-sync",
					fileFolderTemplate: null,
					filenamePrefix: null,
					filenameSuffix: null,
					altTextPrefix: null,
					enableAutoAltText: false,
				};
			}
			return null;
		}
	);
	mockPrisma.syncJob.findMany.mockImplementation(
		async (args: { where?: { shopId?: string } }) => {
			const shopId = args?.where?.shopId;
			const visible = shopId
				? jobs.filter((job) => job.shopId === shopId)
				: jobs;
			return visible.filter((job) =>
				["completed", "failed"].includes(job.status)
			);
		}
	);
	mockPrisma.syncJob.findUnique.mockImplementation(
		async (args: { where?: { id?: string } }) =>
			jobs.find((job) => job.id === args?.where?.id) ?? null
	);
	mockPrisma.syncedAsset.findUnique.mockResolvedValue(null);
	mockPrisma.syncedAsset.upsert.mockResolvedValue({ id: "synced-row" });
}

function installAdmin() {
	const graphql = vi.fn(async (query: string) => {
		if (query.includes("stagedUploadsCreate")) {
			return {
				json: async () => ({
					data: {
						stagedUploadsCreate: {
							stagedTargets: [
								{
									resourceUrl: "https://cdn.example/staged-resource",
									url: "https://storage.example/upload?X-Goog-Algorithm=GOOG4-RSA-SHA256",
									parameters: [
										{ name: "key", value: "staged-key" },
										{ name: "policy", value: "staged-policy" },
									],
								},
							],
							userErrors: [],
						},
					},
				}),
			};
		}
		if (query.includes("fileCreate")) {
			return {
				json: async () => ({
					data: {
						fileCreate: {
							files: [
								{
									id: "gid://shopify/MediaImage/1",
									fileStatus: "READY",
									url: "https://cdn.example/file.jpg",
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
				data: { metafieldsSet: { metafields: [], userErrors: [] } },
			}),
		};
	});
	mockAuthenticate.admin.mockResolvedValue({
		session: { shop: SHOP_DOMAIN },
		admin: { graphql },
	});
}

function installFetch() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith(bynderOrigin)) {
			return realFetch(input, init);
		}
		const rawBody = init?.body;
		const byteLength = rawBody instanceof Uint8Array ? rawBody.byteLength : 0;
		shopifyPuts.push(byteLength);
		return new Response("", { status: 200 });
	}) as typeof fetch;
}

async function postRetry(body: BodyInit, headers: HeadersInit) {
	const request = new Request("https://app.example/api/sync/retry", {
		method: "POST",
		headers,
		body,
	});
	return action({ request } as ActionFunctionArgs);
}

function jsonRequest(payload: unknown) {
	return postRetry(JSON.stringify(payload), {
		"content-type": "application/json",
		authorization: "Bearer staff-session",
	});
}

function unique<T>(values: T[]) {
	return [...new Set(values)];
}

beforeAll(async () => {
	bynderServer = createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		const assetId = mediaIdFromPath(pathname);
		if (assetId && pathname.includes("/download")) {
			downloads.push({ assetId, byteLength: FILE_BYTES.byteLength });
			res.writeHead(200, {
				"content-type": "image/jpeg",
				"content-length": String(FILE_BYTES.byteLength),
			});
			res.end(Buffer.from(FILE_BYTES));
			return;
		}
		if (assetId) {
			mediaInfoIds.push(assetId);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: assetId,
					name: `${assetId}.jpg`,
					tags: ["shopify-sync"],
					version: 2,
					description: "syncable asset",
					type: "image",
				})
			);
			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	});
	await new Promise<void>((resolve) => {
		bynderServer.listen(0, "127.0.0.1", () => resolve());
	});
	const address = bynderServer.address() as AddressInfo;
	bynderOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		bynderServer.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
});

describe("POST /api/sync/retry limits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mediaInfoIds.length = 0;
		downloads.length = 0;
		shopifyPuts.length = 0;
		installAdmin();
		installFetch();
	});

	it("retries an asset that failed for the authenticated shop", async () => {
		installShopState(["known-asset"]);

		const response = await jsonRequest({ assetIds: ["known-asset"] });
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.successful).toBe(1);
		expect(unique(mediaInfoIds)).toEqual(["known-asset"]);
		expect(downloads.map((item) => item.assetId)).toEqual(["known-asset"]);
		expect(downloads[0]?.byteLength).toBe(FILE_BYTES.byteLength);
		expect(shopifyPuts).toEqual([FILE_BYTES.byteLength]);
	});

	it("downloads only ids recorded on that shop's recent failed jobs", async () => {
		installShopState(["known-asset"]);

		const response = await jsonRequest({
			assetIds: ["known-asset", "not-in-any-failed-job"],
		});

		expect(response.status).toBeLessThan(500);
		expect(unique(mediaInfoIds)).toEqual(["known-asset"]);
		expect(downloads.map((item) => item.assetId)).toEqual(["known-asset"]);
		expect(shopifyPuts).toEqual([FILE_BYTES.byteLength]);
	});

	it("does not download ids that failed only for a different shop", async () => {
		installShopState(["known-asset"]);

		const response = await jsonRequest({ assetIds: ["foreign-asset"] });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(mediaInfoIds).toEqual([]);
		expect(downloads).toEqual([]);
		expect(shopifyPuts).toEqual([]);
	});

	it("applies the same membership rule to form-encoded asset ids", async () => {
		installShopState(["known-asset"]);
		const form = new URLSearchParams();
		form.set(
			"assetIds",
			JSON.stringify(["known-asset", "not-in-any-failed-job"])
		);
		form.set("onlyTransient", "true");

		const response = await postRetry(form.toString(), {
			"content-type": "application/x-www-form-urlencoded",
			authorization: "Bearer staff-session",
		});

		expect(response.status).toBeLessThan(500);
		expect(unique(mediaInfoIds)).toEqual(["known-asset"]);
		expect(downloads.map((item) => item.assetId)).toEqual(["known-asset"]);
	});

	it("refuses a list that would download more than a few dozen assets and starts none", async () => {
		const assetIds = Array.from(
			{ length: MAX_RETRY_DOWNLOADS + 1 },
			(_, index) => `failed-asset-${index}`
		);
		installShopState(assetIds);

		const response = await jsonRequest({ assetIds });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(mediaInfoIds).toEqual([]);
		expect(downloads).toEqual([]);
		expect(shopifyPuts).toEqual([]);
	});

	it("still downloads a full batch at the cap when every id failed for this shop", async () => {
		const assetIds = Array.from(
			{ length: MAX_RETRY_DOWNLOADS },
			(_, index) => `failed-asset-${index}`
		);
		installShopState(assetIds);

		const response = await jsonRequest({ assetIds });

		expect(response.status).toBe(200);
		expect(unique(mediaInfoIds).sort()).toEqual([...assetIds].sort());
		expect(downloads).toHaveLength(MAX_RETRY_DOWNLOADS);
		expect(shopifyPuts).toEqual(
			Array.from({ length: MAX_RETRY_DOWNLOADS }, () => FILE_BYTES.byteLength)
		);
	}, 30_000);

	it("refuses a job id that would retry more than the cap and starts none", async () => {
		const assetIds = Array.from(
			{ length: MAX_RETRY_DOWNLOADS + 1 },
			(_, index) => `failed-asset-${index}`
		);
		installShopState(assetIds);

		const response = await jsonRequest({ jobId: OWN_JOB_ID });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(mediaInfoIds).toEqual([]);
		expect(downloads).toEqual([]);
		expect(shopifyPuts).toEqual([]);
	});

	it("does not retry a job that belongs to another shop", async () => {
		installShopState(["known-asset"]);

		const response = await jsonRequest({ jobId: OTHER_JOB_ID });

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(mediaInfoIds).toEqual([]);
		expect(downloads).toEqual([]);
		expect(shopifyPuts).toEqual([]);
	});

	it("refuses an oversized body before any Bynder or Shopify call", async () => {
		installShopState(["known-asset"]);
		const payload = {
			assetIds: ["known-asset"],
			padding: "x".repeat(MAX_RETRY_BODY_BYTES),
		};
		const body = JSON.stringify(payload);
		expect(body.length).toBeGreaterThan(MAX_RETRY_BODY_BYTES);

		const response = await jsonRequest(payload);

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(mediaInfoIds).toEqual([]);
		expect(downloads).toEqual([]);
		expect(shopifyPuts).toEqual([]);
	});
});
