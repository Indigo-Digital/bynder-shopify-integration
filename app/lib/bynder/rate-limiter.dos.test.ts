import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

/**
 * Spec for the shared Bynder token bucket.
 *
 * These tests fail while acquire() still grants every waiter and then
 * subtracts a token. They pass once a waiter takes a token only when the
 * balance is at least one, and the balance never falls below zero.
 */

const REQUESTS_PER_SECOND = 10;
const BURST_CAPACITY = 1;
const PARALLEL_ACQUIRES = 30;
const TOKEN_SLACK = 2;
const MAX_FOLLOWER_WAIT_MS = 700;

describe("RateLimiter.acquire", () => {
	it("does not let concurrent waiters drive the balance negative or stall the next caller", async () => {
		const limiter = new RateLimiter({
			requestsPerSecond: REQUESTS_PER_SECOND,
			burstCapacity: BURST_CAPACITY,
		});

		const started = performance.now();
		const results = await Promise.all(
			Array.from({ length: PARALLEL_ACQUIRES }, () => limiter.acquire())
		);
		const elapsedSec = (performance.now() - started) / 1000;
		const granted = results.filter(Boolean).length;
		const tokensAfterBurst = limiter.getAvailableTokens();
		const budget =
			BURST_CAPACITY + REQUESTS_PER_SECOND * elapsedSec + TOKEN_SLACK;

		const followerStarted = performance.now();
		await limiter.acquire();
		const followerWaitMs = performance.now() - followerStarted;

		expect.soft(granted).toBeLessThanOrEqual(budget);
		expect.soft(tokensAfterBurst).toBeGreaterThanOrEqual(0);
		expect.soft(followerWaitMs).toBeLessThan(MAX_FOLLOWER_WAIT_MS);
	}, 15_000);
});
