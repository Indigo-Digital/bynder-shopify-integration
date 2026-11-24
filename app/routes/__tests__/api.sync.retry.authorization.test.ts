/**
 * @vitest-environment node
 *
 * Shop B must not be able to retry the failed asset ids stored on shop A's
 * sync job. These assertions fail until the retry path rejects a job whose
 * shopId is not the authenticated shop, using the same row it authorizes.
 */
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
import {
	getRetryAuthHarness,
	resetRetryAuthHarness,
	SWAPPED_ASSET_ID,
} from "./retry-auth-harness.js";

vi.mock("../../db.server.js", async () => {
	const { createRetryAuthPrisma } = await import("./retry-auth-harness.js");
	return { default: await createRetryAuthPrisma() };
});

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

vi.mock("@bynder/bynder-js-sdk", async () => {
	const { readCatalogAsset } = await import("./retry-auth-harness.js");

	class Bynder {
		config: { baseURL: string };

		constructor(config: { baseURL: string }) {
			this.config = config;
		}

		getMediaInfo(params: { id?: string } = {}) {
			return readCatalogAsset(params.id);
		}
	}

	return { default: Bynder };
});

import prisma from "../../db.server.js";
import { authenticate } from "../../shopify.server.js";
import { action } from "../api.sync.retry.js";

const CALLER_SHOP_DOMAIN = "caller.myshopify.com";
const CALLER_SHOP_ID = "shop-caller";
const OTHER_SHOP_ID = "shop-other";
const OTHER_JOB_ID = "job-other-shop";
const CALLER_JOB_ID = "job-caller";
const OTHER_ASSET_ID = "other-shop-failed-asset";
const CALLER_ASSET_ID = "caller-failed-asset";
const SHARED_TAG = "shared-campaign";
const SHOPIFY_FILE_ID = "gid://shopify/MediaImage/retry-auth";

const mockAuthenticate = authenticate.admin as ReturnType<typeof vi.fn>;

function catalogAsset(id: string) {
	return {
		id,
		name: `${id}.jpg`,
		tags: [SHARED_TAG],
		version: 2,
	};
}

function createAdmin() {
	const graphql = vi.fn(async (query: string) => {
		if (query.includes("stagedUploadsCreate")) {
			return {
				json: async () => ({
					data: {
						stagedUploadsCreate: {
							stagedTargets: [
								{
									resourceUrl: "https://cdn.shopify.test/files/resource",
									url: "https://uploads.shopify.test/staged",
									parameters: [
										{ name: "key", value: "staged-key" },
										{ name: "policy", value: "staged-policy" },
										{ name: "algorithm", value: "staged-algorithm" },
										{ name: "signature", value: "staged-signature" },
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
									id: SHOPIFY_FILE_ID,
									fileStatus: "READY",
									image: { url: "https://cdn.shopify.test/files/campaign.jpg" },
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
	return { graphql };
}

async function seedShops() {
	await prisma.shop.create({
		data: {
			id: OTHER_SHOP_ID,
			shop: "other.myshopify.com",
			bynderBaseUrl: "https://brand.example",
			syncTags: SHARED_TAG,
			enableAutoAltText: false,
		},
	});
	await prisma.shop.create({
		data: {
			id: CALLER_SHOP_ID,
			shop: CALLER_SHOP_DOMAIN,
			bynderBaseUrl: "https://brand.example",
			syncTags: SHARED_TAG,
			enableAutoAltText: false,
		},
	});
}

async function seedJob(
	id: string,
	shopId: string,
	assetId: string,
	error: string
) {
	await prisma.syncJob.create({
		data: {
			id,
			shopId,
			status: "failed",
			errors: JSON.stringify([{ assetId, error }]),
		},
	});
}

function retryRequest(body: FormData | string) {
	const init: RequestInit = { method: "POST", body };
	if (typeof body === "string") {
		init.headers = { "Content-Type": "application/json" };
	}
	return new Request("http://localhost/api/sync/retry", init);
}

async function retryJob(jobId: string, onlyTransient = false) {
	const request = retryRequest(
		JSON.stringify({
			jobId,
			onlyTransient,
		})
	);
	const response = await action({ request } as ActionFunctionArgs);
	const payload: unknown = await response.json();
	return { response, payload };
}

async function storedAsset(shopId: string, assetId: string) {
	return prisma.syncedAsset.findUnique({
		where: {
			shopId_bynderAssetId: {
				shopId,
				bynderAssetId: assetId,
			},
		},
	});
}

function assertNoForeignAssetActivity(assetIds: string[], payload: unknown) {
	const harness = getRetryAuthHarness();
	const serialized = JSON.stringify(payload);
	for (const assetId of assetIds) {
		expect(serialized).not.toContain(assetId);
		expect(harness.mediaCalls).not.toContain(assetId);
	}
}

describe("api.sync.retry shop authorization", () => {
	let admin: ReturnType<typeof createAdmin>;

	beforeAll(async () => {
		await prisma.$connect();
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	beforeEach(async () => {
		resetRetryAuthHarness();
		vi.clearAllMocks();
		admin = createAdmin();
		mockAuthenticate.mockResolvedValue({
			session: { shop: CALLER_SHOP_DOMAIN },
			admin,
		});
		vi.stubGlobal("fetch", async (input: string | URL) => {
			const href = String(input);
			if (href.includes("/download") || href.includes("brand.example")) {
				const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
				return new Response(jpeg, {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			return new Response("", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});
		await prisma.syncedAsset.deleteMany();
		await prisma.syncMetrics.deleteMany();
		await prisma.syncJob.deleteMany();
		await prisma.shop.deleteMany();
		await seedShops();
		getRetryAuthHarness().catalog.set(
			SWAPPED_ASSET_ID,
			catalogAsset(SWAPPED_ASSET_ID)
		);
	});

	it("rejects another shop's job id from a JSON body before fetching or storing its assets", async () => {
		await seedJob(
			OTHER_JOB_ID,
			OTHER_SHOP_ID,
			OTHER_ASSET_ID,
			"timeout while uploading"
		);
		getRetryAuthHarness().catalog.set(
			OTHER_ASSET_ID,
			catalogAsset(OTHER_ASSET_ID)
		);

		const { response, payload } = await retryJob(OTHER_JOB_ID);

		expect(response.ok).toBe(false);
		expect(response.status).toBe(403);
		assertNoForeignAssetActivity([OTHER_ASSET_ID, SWAPPED_ASSET_ID], payload);
		expect(admin.graphql).not.toHaveBeenCalled();
		expect(await storedAsset(CALLER_SHOP_ID, OTHER_ASSET_ID)).toBeNull();
		expect(await storedAsset(CALLER_SHOP_ID, SWAPPED_ASSET_ID)).toBeNull();
		expect(await storedAsset(OTHER_SHOP_ID, OTHER_ASSET_ID)).toBeNull();
	});

	it("rejects another shop's job id from the form body the sync page submits", async () => {
		await seedJob(
			OTHER_JOB_ID,
			OTHER_SHOP_ID,
			OTHER_ASSET_ID,
			"timeout while uploading"
		);
		getRetryAuthHarness().catalog.set(
			OTHER_ASSET_ID,
			catalogAsset(OTHER_ASSET_ID)
		);
		const form = new FormData();
		form.set("jobId", OTHER_JOB_ID);
		form.set("onlyTransient", "false");

		const response = await action({
			request: retryRequest(form),
		} as ActionFunctionArgs);
		const payload: unknown = await response.json();

		expect(response.ok).toBe(false);
		expect(response.status).toBe(403);
		assertNoForeignAssetActivity([OTHER_ASSET_ID, SWAPPED_ASSET_ID], payload);
		expect(admin.graphql).not.toHaveBeenCalled();
		expect(await storedAsset(CALLER_SHOP_ID, OTHER_ASSET_ID)).toBeNull();
	});

	it("rejects another shop's transient failures when onlyTransient is set", async () => {
		await seedJob(
			OTHER_JOB_ID,
			OTHER_SHOP_ID,
			OTHER_ASSET_ID,
			"timeout while uploading"
		);
		getRetryAuthHarness().catalog.set(
			OTHER_ASSET_ID,
			catalogAsset(OTHER_ASSET_ID)
		);

		const { response, payload } = await retryJob(OTHER_JOB_ID, true);

		expect(response.ok).toBe(false);
		expect(response.status).toBe(403);
		assertNoForeignAssetActivity([OTHER_ASSET_ID, SWAPPED_ASSET_ID], payload);
		expect(await storedAsset(CALLER_SHOP_ID, OTHER_ASSET_ID)).toBeNull();
	});

	it("does not return another shop's asset id when that asset cannot be retried", async () => {
		await seedJob(
			OTHER_JOB_ID,
			OTHER_SHOP_ID,
			OTHER_ASSET_ID,
			"timeout while uploading"
		);

		const { response, payload } = await retryJob(OTHER_JOB_ID);

		expect(response.ok).toBe(false);
		expect(response.status).toBe(403);
		assertNoForeignAssetActivity([OTHER_ASSET_ID, SWAPPED_ASSET_ID], payload);
		expect(admin.graphql).not.toHaveBeenCalled();
	});

	it("retries the caller's own job from the authorized row", async () => {
		await seedJob(
			CALLER_JOB_ID,
			CALLER_SHOP_ID,
			CALLER_ASSET_ID,
			"timeout while uploading"
		);
		getRetryAuthHarness().catalog.set(
			CALLER_ASSET_ID,
			catalogAsset(CALLER_ASSET_ID)
		);

		const { response, payload } = await retryJob(CALLER_JOB_ID);

		expect(response.ok).toBe(true);
		expect(payload).toMatchObject({ success: true, successful: 1 });
		expect(getRetryAuthHarness().mediaCalls).toContain(CALLER_ASSET_ID);
		expect(getRetryAuthHarness().mediaCalls).not.toContain(SWAPPED_ASSET_ID);
		expect(JSON.stringify(payload)).not.toContain(SWAPPED_ASSET_ID);
		const stored = await storedAsset(CALLER_SHOP_ID, CALLER_ASSET_ID);
		expect(stored?.shopifyFileId).toBe(SHOPIFY_FILE_ID);
		expect(await storedAsset(CALLER_SHOP_ID, SWAPPED_ASSET_ID)).toBeNull();
		expect(await storedAsset(OTHER_SHOP_ID, CALLER_ASSET_ID)).toBeNull();
	});
});
