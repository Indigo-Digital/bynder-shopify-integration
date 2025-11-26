/**
 * Token bucket rate limiter for Bynder API calls
 * Implements a token bucket algorithm to control request rate
 */

export interface RateLimiterConfig {
	requestsPerSecond: number;
	burstCapacity: number;
}

export class RateLimiter {
	private tokens: number;
	private readonly maxTokens: number;
	private readonly refillRate: number; // tokens per second
	private lastRefill: number;
	private readonly burstCapacity: number;
	private rateLimitHits = 0;

	constructor(config: RateLimiterConfig) {
		this.burstCapacity = config.burstCapacity;
		this.maxTokens = config.burstCapacity;
		this.tokens = config.burstCapacity;
		this.refillRate = config.requestsPerSecond;
		this.lastRefill = Date.now();
	}

	/**
	 * Acquire a token from the bucket
	 * Returns true if token was acquired, false if rate limited
	 */
	async acquire(): Promise<boolean> {
		this.refill();

		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}

		// Rate limited - need to wait
		this.rateLimitHits++;
		const waitTime = this.calculateWaitTime();
		await new Promise((resolve) => setTimeout(resolve, waitTime));
		this.refill();
		this.tokens -= 1;
		return true;
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
		const tokensNeeded = 1 - this.tokens;
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

/**
 * Create a rate limiter instance from environment variables
 */
export function createRateLimiter(): RateLimiter {
	const rps = parseInt(
		process.env.BYNDER_RATE_LIMIT_RPS || "10",
		10
	);
	const burst = parseInt(
		process.env.BYNDER_RATE_LIMIT_BURST || "20",
		10
	);

	return new RateLimiter({
		requestsPerSecond: rps,
		burstCapacity: burst,
	});
}

/**
 * Global rate limiter instance (shared across all Bynder clients)
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

