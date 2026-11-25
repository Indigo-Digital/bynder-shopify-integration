import type { LoaderFunctionArgs } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A signed-in shop can open many parallel asset-list requests. Each one
 * acquires the process-wide Bynder limiter. These tests fail while that
 * burst still grants more calls than the configured rate and leaves the
 * next shop's Bynder call waiting on a negative balance.
 *
 * authenticate.admin is stubbed at the point a valid admin session has
 * already been accepted. The JWT check it stands in for does not limit
 * concurrency. The Bynder SDK is stubbed at the HTTP send, which runs
 * only after acquire().
 */

const REQUESTS_PER_SECOND = 10;
const BURST_CAPACITY = 1;
const TOKEN_SLACK = 2;
const MAX_PAGE_SIZE = 100;
const ATTACKER_REQUESTS = 20;
const MAX_VICTIM_WAIT_MS = 700;

process.env.BYNDER_RATE_LIMIT_RPS = String(REQUESTS_PER_SECOND);
process.env.BYNDER_RATE_LIMIT_BURST = String(BURST_CAPACITY);

interface SdkCallLog {
	limits: number[];
	mediaListCalls: number;
	mediaInfoCalls: number;
	downloadCalls: number;
}

vi.mock("@bynder/bynder-js-sdk", () => {
	const log: SdkCallLog = {
		limits: [],
		mediaListCalls: 0,
		mediaInfoCalls: 0,
		downloadCalls: 0,
	};
	(
		globalThis as unknown as { __bynderSdkCallLog?: SdkCallLog }
	).__bynderSdkCallLog = log;

	class BynderSdk {
		getMediaList(params?: { limit?: number }) {
			log.mediaListCalls += 1;
			if (typeof params?.limit === "number") {
				log.limits.push(params.limit);
			}
			return Promise.resolve({ media: [], total: 0, count: 0 });
		}

		getMediaInfo() {
			log.mediaInfoCalls += 1;
			return Promise.resolve({ id: "asset-1", tags: [], version: 1 });
		}

		getMediaDownloadUrl() {
			log.downloadCalls += 1;
			return Promise.resolve("https://cdn.example/asset");
		}
	}

	return { default: BynderSdk };
});

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(async () => ({
			session: { shop: "attacker.myshopify.com" },
		})),
	},
}));

import prisma from "../../db.server.js";
import { loader } from "../../routes/api.bynder.assets.js";
import { BynderClient } from "./client.js";
import { getRateLimiter } from "./rate-limiter.js";

function sdkLog(): SdkCallLog {
	const log = (globalThis as unknown as { __bynderSdkCallLog?: SdkCallLog })
		.__bynderSdkCallLog;
	if (!log) {
		throw new Error("Bynder SDK call log was not installed");
	}
	return log;
}

describe("shared Bynder rate limit", () => {
	beforeAll(() => {
		const shopLookup = prisma.shop.findUnique as unknown as {
			mockResolvedValue: (value: {
				shop: string;
				bynderBaseUrl: string;
			}) => void;
		};
		shopLookup.mockResolvedValue({
			shop: "attacker.myshopify.com",
			bynderBaseUrl: "https://attacker.example",
		});
	});

	it("keeps one shop's asset-list burst from stalling another shop's Bynder calls", async () => {
		const log = sdkLog();
		const attacker = BynderClient.createFromEnv("https://attacker.example");
		const victim = BynderClient.createFromEnv("https://victim.example");
		const assetListRequests = Array.from({ length: ATTACKER_REQUESTS }, () =>
			loader({
				request: new Request(
					"http://localhost/api/bynder/assets?limit=100000&page=1"
				),
			} as LoaderFunctionArgs)
		);

		const started = performance.now();
		const [loaderResults] = await Promise.all([
			Promise.all(assetListRequests),
			attacker.getMediaInfo({ id: "asset-1" }),
			attacker.getMediaInfo({ id: "asset-2" }),
			attacker.getMediaDownloadUrl({ id: "asset-1" }),
			attacker.getMediaDownloadUrl({ id: "asset-2" }),
			attacker.getAllMediaItems({ keyword: "campaign" }),
			attacker.getAllMediaItems({ type: "image" }),
		]);
		const elapsedSec = (performance.now() - started) / 1000;

		for (const response of loaderResults) {
			expect(response.status).toBe(200);
		}
		// One acquire per asset-list request, plus one per getAllMediaItems page.
		expect(log.mediaListCalls).toBe(ATTACKER_REQUESTS + 2);
		expect(log.mediaInfoCalls).toBe(2);
		expect(log.downloadCalls).toBe(2);

		const granted = log.mediaListCalls + log.mediaInfoCalls + log.downloadCalls;
		const budget =
			BURST_CAPACITY + REQUESTS_PER_SECOND * elapsedSec + TOKEN_SLACK;
		const tokensAfterBurst = getRateLimiter().getAvailableTokens();

		const victimStarted = performance.now();
		await victim.getMediaInfo({ id: "other-shop-asset" });
		const victimWaitMs = performance.now() - victimStarted;

		expect.soft(victimWaitMs).toBeLessThan(MAX_VICTIM_WAIT_MS);
		expect.soft(tokensAfterBurst).toBeGreaterThanOrEqual(0);
		expect.soft(granted).toBeLessThanOrEqual(budget);
		expect(log.limits.length).toBeGreaterThan(0);
		expect.soft(Math.max(...log.limits)).toBeLessThanOrEqual(MAX_PAGE_SIZE);
	}, 20_000);
});
