/**
 * @vitest-environment node
 *
 * Spec for the decode-uri-component denial of service reached through
 * BynderClient. These tests fail while @bynder/bynder-js-sdk 2.5.2 builds
 * request URLs with proper-url-join 1.2.0 and query-string 5.1.1, which
 * decode the query with decode-uri-component 0.2.2. They pass once that
 * decode no longer blocks the event loop.
 *
 * Callers that share the base-URL path: the sync worker, asset listing,
 * connection test, manual sync, webhook sync, and retry. getAllMediaItems
 * calls getMediaList, so it is the same path. getMediaDownloadUrl is not
 * covered: this SDK build has no getMediaDownloadUrl, and the client
 * fallback concatenates the URL without decoding the query.
 */
import { describe, expect, it } from "vitest";
import { BynderClient } from "./client.js";

const CLOSED_PORT = "http://127.0.0.1:9";
const TOKEN_COUNT = 500;
const BUDGET_MS = 400;
const TEST_TIMEOUT_MS = 20_000;

function invalidPercentQuery(tokenCount: number): string {
	return "%ab".repeat(tokenCount);
}

interface CallTiming {
	elapsedMs: number;
	maxTickGapMs: number;
}

async function timeCall(run: () => Promise<unknown>): Promise<CallTiming> {
	const started = performance.now();
	const ticks = [started];
	const interval = setInterval(() => {
		ticks.push(performance.now());
	}, 20);

	try {
		await run();
	} catch {
		// A closed local port rejects after the URL is built. The cost
		// under test is the decode that runs before that rejection.
	} finally {
		clearInterval(interval);
	}

	const finished = performance.now();
	ticks.push(finished);
	let maxTickGapMs = 0;
	for (let index = 1; index < ticks.length; index++) {
		const gap = (ticks[index] ?? 0) - (ticks[index - 1] ?? 0);
		maxTickGapMs = Math.max(maxTickGapMs, gap);
	}

	return { elapsedMs: finished - started, maxTickGapMs };
}

function expectEventLoopNotBlocked(timing: CallTiming): void {
	expect(timing.maxTickGapMs).toBeLessThan(BUDGET_MS);
	expect(timing.elapsedMs).toBeLessThan(BUDGET_MS);
}

describe("BynderClient percent-encoding", () => {
	it(
		"finishes a media list call quickly when the base URL has no query",
		async () => {
			const client = BynderClient.createFromEnv(`${CLOSED_PORT}/api`);

			const timing = await timeCall(() =>
				client.getMediaList({ limit: 1, page: 1 })
			);

			expectEventLoopNotBlocked(timing);
		},
		TEST_TIMEOUT_MS
	);

	it(
		"does not block the event loop when the saved base URL query contains many invalid percent-encodings",
		async () => {
			const savedByMerchant = `${CLOSED_PORT}/?${invalidPercentQuery(TOKEN_COUNT)}`;
			const client = BynderClient.createFromEnv(savedByMerchant);

			const timing = await timeCall(() =>
				client.getMediaList({ limit: 1, page: 1 })
			);

			expectEventLoopNotBlocked(timing);
		},
		TEST_TIMEOUT_MS
	);

	it(
		"does not block the event loop when an asset id embeds a query of many invalid percent-encodings",
		async () => {
			const client = BynderClient.createFromEnv(`${CLOSED_PORT}/api`);
			const assetId = `asset?x=${invalidPercentQuery(TOKEN_COUNT)}`;

			const timing = await timeCall(() => client.getMediaInfo({ id: assetId }));

			expectEventLoopNotBlocked(timing);
		},
		TEST_TIMEOUT_MS
	);
});
