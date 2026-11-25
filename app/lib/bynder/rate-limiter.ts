/**
 * Token bucket rate limiter for Bynder API calls
 * Implements a token bucket algorithm to control request rate
 */

export interface RateLimiterConfig {
	requestsPerSecond: number;
	burstCapacity: number;
	/**
	 * Maximum number of calls a single key may have waiting for a token.
	 * Calls beyond this are refused instead of queued. Defaults to unlimited.
	 */
	maxPendingPerKey?: number;
}

/**
 * Key used when the caller does not identify which shop a call belongs to
 */
export const DEFAULT_RATE_LIMIT_KEY = "__default__";

/**
 * Thrown when a shop already has the maximum number of Bynder calls waiting
 */
export class BynderRateLimitError extends Error {
	constructor(message = "Too many concurrent Bynder requests for this shop") {
		super(message);
		this.name = "BynderRateLimitError";
	}
}

type Waiter = () => void;

export class RateLimiter {
	private tokens: number;
	private readonly maxTokens: number;
	private readonly refillRate: number; // tokens per second
	private readonly maxPendingPerKey: number;
	private lastRefill: number;
	private rateLimitHits = 0;
	// Map iteration order is the round-robin order: a key is moved to the back
	// each time one of its waiters is served, so no key can starve another.
	private readonly waiters = new Map<string, Waiter[]>();
	private pendingCount = 0;
	private drainTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: RateLimiterConfig) {
		this.maxTokens = Math.max(1, config.burstCapacity);
		this.tokens = this.maxTokens;
		this.refillRate = config.requestsPerSecond;
		this.maxPendingPerKey = config.maxPendingPerKey ?? Number.POSITIVE_INFINITY;
		this.lastRefill = Date.now();
	}

	/**
	 * Acquire a token from the bucket on behalf of `key` (typically the shop).
	 *
	 * Waiting callers are served one token at a time, round-robin across keys,
	 * and a token is only handed out while the balance is at least one, so the
	 * balance never goes negative and one key's backlog cannot delay others by
	 * more than one token per active key.
	 *
	 * Resolves true once a token was acquired, or false without waiting if
	 * `key` already has `maxPendingPerKey` calls waiting.
	 */
	async acquire(key: string = DEFAULT_RATE_LIMIT_KEY): Promise<boolean> {
		this.refill();

		if (this.pendingCount === 0 && this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}

		this.rateLimitHits++;
		const queue = this.waiters.get(key) ?? [];
		if (queue.length >= this.maxPendingPerKey) {
			return false;
		}

		return new Promise<boolean>((resolve) => {
			queue.push(() => resolve(true));
			this.waiters.set(key, queue);
			this.pendingCount++;
			this.scheduleDrain();
		});
	}

	/**
	 * Hand out available tokens to waiting callers, one per key in turn
	 */
	private drain(): void {
		this.drainTimer = null;
		this.refill();

		while (this.tokens >= 1) {
			const waiter = this.nextWaiter();
			if (!waiter) {
				break;
			}
			this.tokens -= 1;
			waiter();
		}

		this.scheduleDrain();
	}

	private nextWaiter(): Waiter | undefined {
		const next = this.waiters.entries().next();
		if (next.done) {
			return undefined;
		}
		const [key, queue] = next.value;
		const waiter = queue.shift();
		this.waiters.delete(key);
		if (queue.length > 0) {
			this.waiters.set(key, queue);
		}
		this.pendingCount--;
		return waiter;
	}

	private scheduleDrain(): void {
		if (this.drainTimer || this.pendingCount === 0) {
			return;
		}
		this.drainTimer = setTimeout(() => this.drain(), this.calculateWaitTime());
	}

	/**
	 * Refill tokens based on elapsed time
	 */
	private refill(): void {
		const now = Date.now();
		const elapsed = (now - this.lastRefill) / 1000; // Convert to seconds
		const tokensToAdd = elapsed * this.refillRate;
		this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
		this.lastRefill = now;
	}

	/**
	 * Calculate wait time until next token is available
	 */
	private calculateWaitTime(): number {
		const tokensNeeded = Math.max(0, 1 - this.tokens);
		const waitSeconds = tokensNeeded / this.refillRate;
		return Math.ceil(waitSeconds * 1000); // Convert to milliseconds
	}

	/**
	 * Get current number of available tokens
	 */
	getAvailableTokens(): number {
		this.refill();
		return Math.floor(this.tokens);
	}

	/**
	 * Get number of calls currently waiting for a token
	 */
	getPendingCount(key?: string): number {
		if (key === undefined) {
			return this.pendingCount;
		}
		return this.waiters.get(key)?.length ?? 0;
	}

	/**
	 * Get number of rate limit hits
	 */
	getRateLimitHits(): number {
		return this.rateLimitHits;
	}

	/**
	 * Reset rate limit hit counter
	 */
	resetRateLimitHits(): void {
		this.rateLimitHits = 0;
	}
}

function readPositiveIntEnv(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] || "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Create a rate limiter instance from environment variables
 */
export function createRateLimiter(): RateLimiter {
	return new RateLimiter({
		requestsPerSecond: readPositiveIntEnv("BYNDER_RATE_LIMIT_RPS", 10),
		burstCapacity: readPositiveIntEnv("BYNDER_RATE_LIMIT_BURST", 20),
		maxPendingPerKey: readPositiveIntEnv(
			"BYNDER_RATE_LIMIT_MAX_PENDING_PER_SHOP",
			50
		),
	});
}

/**
 * Global rate limiter instance (shared across all Bynder clients).
 * This is the process-wide ceiling; callers pass their shop as the key so
 * that waiting is shared fairly between shops.
 */
let globalRateLimiter: RateLimiter | null = null;

/**
 * Get or create the global rate limiter instance
 */
export function getRateLimiter(): RateLimiter {
	if (!globalRateLimiter) {
		globalRateLimiter = createRateLimiter();
	}
	return globalRateLimiter;
}
