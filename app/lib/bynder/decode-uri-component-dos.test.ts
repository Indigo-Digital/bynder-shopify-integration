/**
 * @vitest-environment node
 *
 * Spec for DHI-3stc-eye7-a7el-4lqe. This test fails while decode-uri-component
 * 0.2.2 is installed, and passes once that decode no longer does quadratic
 * work on the asset-id path the app actually runs.
 *
 * POST /api/sync/retry and the Bynder webhook pass a JSON asset id through
 * to BynderClient.getMediaInfo without rewriting it. The SDK inserts that
 * id into the request path, and proper-url-join 1.2.0 parses the query
 * portion with query-string 5.1.1, which calls decode-uri-component.
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface BynderSdk {
	new (options: {
		baseURL: string;
		clientId: string;
		clientSecret: string;
		permanentToken: string;
	}): {
		getMediaInfo(params: { id: string }): Promise<unknown>;
	};
}

const Bynder = require("@bynder/bynder-js-sdk") as BynderSdk;

/** Distinct runs that make decode-uri-component 0.2.2 take multiple seconds. */
const DISTINCT_RUNS = 16_000;
/** Fixed 0.5.1 decode of this payload is a few milliseconds. */
const MAX_EVENT_LOOP_BLOCK_MS = 1_000;

function buildMaliciousAssetId(distinctRuns: number): string {
	let value = "";
	for (let index = 0; index < distinctRuns; index++) {
		const character = String.fromCodePoint(0x100 + (index % 0x8000));
		value += `${encodeURIComponent(character)}x`;
	}
	// A trailing invalid UTF-8 byte forces the slow fallback. The "?" makes
	// proper-url-join treat the rest of the id as a query string.
	return `asset?q=${value}%80`;
}

function isOutboundRequest(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const candidate = error as { code?: unknown; message?: unknown };
	const code = typeof candidate.code === "string" ? candidate.code : "";
	const message =
		typeof candidate.message === "string" ? candidate.message : "";
	return (
		code === "ENOTFOUND" ||
		code === "ECONNREFUSED" ||
		code === "EAI_AGAIN" ||
		message.includes("ENOTFOUND") ||
		message.includes("ECONNREFUSED") ||
		message.includes("getaddrinfo")
	);
}

function requestUrl(error: unknown): string {
	if (typeof error !== "object" || error === null || !("config" in error)) {
		return "";
	}
	const config = (error as { config?: { url?: unknown } }).config;
	return typeof config?.url === "string" ? config.url : "";
}

describe("decode-uri-component reachability via Bynder getMediaInfo", () => {
	it("finishes URL decoding for a large malformed asset id without blocking the event loop", async () => {
		const assetId = buildMaliciousAssetId(DISTINCT_RUNS);
		const client = new Bynder({
			baseURL: "https://bynder-decode-test.invalid/api",
			clientId: "placeholder-client-id",
			clientSecret: "placeholder-client-secret",
			permanentToken: "placeholder-token",
		});

		const startedAt = performance.now();
		const pending = client.getMediaInfo({ id: assetId });
		const blockedForMs = performance.now() - startedAt;
		// Attach the rejection handler before asserting so a slow decode does
		// not leave the outbound request as an unhandled rejection.
		const settled = pending.then(
			() => ({ attempted: false, url: "" }),
			(error: unknown) => ({
				attempted: isOutboundRequest(error),
				url: requestUrl(error),
			})
		);

		expect(blockedForMs).toBeLessThan(MAX_EVENT_LOOP_BLOCK_MS);

		const outcome = await Promise.race([
			settled,
			new Promise<{ attempted: boolean; url: string }>((resolve) => {
				setTimeout(() => resolve({ attempted: false, url: "" }), 5_000);
			}),
		]);

		expect(outcome.attempted).toBe(true);
		expect(outcome.url.length).toBeGreaterThan(10_000);
		expect(outcome.url).toContain("q=");
	}, 20_000);
});
