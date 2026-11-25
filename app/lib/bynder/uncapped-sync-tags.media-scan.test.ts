import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAGES_PER_TAG } from "../sync/sync-tag-security-limits.js";

const { mediaList } = vi.hoisted(() => ({
	mediaList: vi.fn(),
}));

vi.mock("../env.server.js", () => ({
	env: {
		BYNDER_PERMANENT_TOKEN: "placeholder-bynder-token",
		BYNDER_CLIENT_ID: "placeholder-bynder-client-id",
		BYNDER_CLIENT_SECRET: "placeholder-bynder-client-secret",
		SHOPIFY_API_KEY: "placeholder-shopify-api-key",
		SHOPIFY_API_SECRET: "placeholder-shopify-api-secret",
		SHOPIFY_APP_URL: "https://placeholder.example",
	},
}));

vi.mock("../../db.server.js", () => ({
	default: {
		syncMetrics: { create: vi.fn() },
	},
}));

vi.mock("@bynder/bynder-js-sdk", () => {
	class BynderSdkStub {
		getMediaList(params: unknown) {
			return mediaList(params);
		}
	}
	return { default: BynderSdkStub };
});

const PAGE_SIZE = 50;
const SAFETY_PAGES = MAX_PAGES_PER_TAG * 2;

describe("BynderClient.getAllMediaItems scan bound", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.BYNDER_RATE_LIMIT_RPS = "0";
		process.env.BYNDER_RATE_LIMIT_BURST = "1000";
		mediaList.mockImplementation(async () => {
			const page = mediaList.mock.calls.length;
			if (page >= SAFETY_PAGES) {
				return [
					{
						id: `tail-${page}`,
						tags: ["campaign"],
						version: 1,
					},
				];
			}
			return Array.from({ length: PAGE_SIZE }, (_, index) => ({
				id: `asset-${page}-${index}`,
				tags: ["campaign"],
				version: 1,
			}));
		});
	});

	it("stops a full tag scan within the page cap and spends one shared token per page", async () => {
		const { BynderClient } = await import("./client.js");
		const { getRateLimiter } = await import("./rate-limiter.js");
		const client = BynderClient.createPermanentTokenClient({
			baseURL: "https://portal.example/api",
			permanentToken: "placeholder-bynder-token",
			clientId: "placeholder-bynder-client-id",
			clientSecret: "placeholder-bynder-client-secret",
		});
		const limiter = getRateLimiter();
		const tokensBefore = limiter.getAvailableTokens();

		await client.getAllMediaItems({ tags: "campaign" }).catch(() => undefined);

		const pagesRequested = mediaList.mock.calls.length;
		expect(pagesRequested).toBeGreaterThan(0);
		expect(pagesRequested).toBeLessThanOrEqual(MAX_PAGES_PER_TAG);
		expect(tokensBefore - limiter.getAvailableTokens()).toBe(pagesRequested);
	});
});
