export interface WebhookRegistrationLimits {
	maxAttempts: number;
	attemptWindowMs: number;
	maxFailures: number;
	failureWindowMs: number;
}

export class WebhookRegistrationLimitError extends Error {
	constructor() {
		super(
			"Too many webhook changes for this shop. Please wait a few seconds and try again."
		);
		this.name = "WebhookRegistrationLimitError";
	}
}

interface AttemptRecord {
	startedAt: number;
}

const DEFAULT_LIMITS: WebhookRegistrationLimits = {
	maxAttempts: 3,
	attemptWindowMs: 10_000,
	maxFailures: 10,
	failureWindowMs: 60_000,
};

/**
 * Per-shop limiter for portal webhook create/update/delete calls.
 *
 * An attempt holds a slot from the moment it starts, so in-flight requests
 * count against `maxAttempts` and a shop never has more than that many
 * portal requests open at once. A failed attempt gives its slot back (the
 * portal client already bounds its duration and size) but is recorded
 * against the separate `maxFailures` budget, so a portal that always stalls
 * or overflows cannot be retried without limit. Attempts still in the
 * attempt window also count toward that budget, so concurrent attempts
 * cannot overshoot it.
 */
export class WebhookRegistrationLimiter {
	private readonly attempts = new Map<string, AttemptRecord[]>();
	private readonly failures = new Map<string, number[]>();

	constructor(
		private readonly limits: WebhookRegistrationLimits = DEFAULT_LIMITS,
		private readonly now: () => number = Date.now
	) {}

	/**
	 * @throws {WebhookRegistrationLimitError} Before `call` runs, when the
	 * shop has used its attempt or failure budget
	 */
	async run<T>(shop: string, call: () => Promise<T>): Promise<T> {
		const attempt = this.acquire(shop);
		try {
			return await call();
		} catch (error) {
			this.recordFailure(shop, attempt);
			throw error;
		}
	}

	private acquire(shop: string): AttemptRecord {
		const currentTime = this.now();
		const attempts = this.liveAttempts(shop, currentTime);
		const failures = this.liveFailures(shop, currentTime);
		if (
			attempts.length >= this.limits.maxAttempts ||
			failures.length + attempts.length >= this.limits.maxFailures
		) {
			throw new WebhookRegistrationLimitError();
		}

		const attempt: AttemptRecord = { startedAt: currentTime };
		this.attempts.set(shop, [...attempts, attempt]);
		return attempt;
	}

	private recordFailure(shop: string, attempt: AttemptRecord): void {
		const currentTime = this.now();
		const remaining = this.liveAttempts(shop, currentTime).filter(
			(record) => record !== attempt
		);
		this.storeOrDelete(this.attempts, shop, remaining);
		this.failures.set(shop, [
			...this.liveFailures(shop, currentTime),
			currentTime,
		]);
	}

	private liveAttempts(shop: string, currentTime: number): AttemptRecord[] {
		const cutoff = currentTime - this.limits.attemptWindowMs;
		const live = (this.attempts.get(shop) ?? []).filter(
			(record) => record.startedAt > cutoff
		);
		this.storeOrDelete(this.attempts, shop, live);
		return live;
	}

	private liveFailures(shop: string, currentTime: number): number[] {
		const cutoff = currentTime - this.limits.failureWindowMs;
		const live = (this.failures.get(shop) ?? []).filter(
			(failedAt) => failedAt > cutoff
		);
		this.storeOrDelete(this.failures, shop, live);
		return live;
	}

	private storeOrDelete<T>(
		store: Map<string, T[]>,
		shop: string,
		entries: T[]
	): void {
		if (entries.length === 0) {
			store.delete(shop);
		} else {
			store.set(shop, entries);
		}
	}
}

export const webhookRegistrationLimiter = new WebhookRegistrationLimiter();
