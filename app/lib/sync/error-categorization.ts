/**
 * Error categorization utilities
 * Classifies errors as transient (retryable) or permanent (not retryable)
 */

export type ErrorCategory = "transient" | "permanent" | "unknown";

export interface CategorizedError {
	category: ErrorCategory;
	retryable: boolean;
	message: string;
	originalError: string;
}

/**
 * Patterns that indicate transient (retryable) errors
 */
const TRANSIENT_ERROR_PATTERNS = [
	/timeout/i,
	/rate limit/i,
	/rate.?limit/i,
	/temporary/i,
	/503/i,
	/502/i,
	/504/i,
	/429/i,
	/network/i,
	/connection/i,
	/ECONNRESET/i,
	/ETIMEDOUT/i,
	/ENOTFOUND/i,
	/ECONNREFUSED/i,
	/service unavailable/i,
	/bad gateway/i,
	/gateway timeout/i,
	/too many requests/i,
	/request timeout/i,
	/temporarily unavailable/i,
	/retry/i,
	/retry after/i,
];

/**
 * Patterns that indicate permanent (not retryable) errors
 */
const PERMANENT_ERROR_PATTERNS = [
	/not found/i,
	/404/i,
	/unauthorized/i,
	/401/i,
	/forbidden/i,
	/403/i,
	/invalid format/i,
	/400/i,
	/bad request/i,
	/malformed/i,
	/invalid/i,
	/unsupported/i,
	/not allowed/i,
	/405/i,
	/permission denied/i,
	/access denied/i,
	/authentication failed/i,
	/invalid token/i,
	/expired token/i,
	/invalid credentials/i,
	/not supported/i,
	/unsupported format/i,
	/invalid file/i,
	/corrupt/i,
];

/**
 * Categorize an error message as transient or permanent
 */
export function categorizeError(error: string | Error): CategorizedError {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const normalizedError = errorMessage.toLowerCase().trim();

	// Check for transient patterns first
	for (const pattern of TRANSIENT_ERROR_PATTERNS) {
		if (pattern.test(normalizedError)) {
			return {
				category: "transient",
				retryable: true,
				message: errorMessage,
				originalError: errorMessage,
			};
		}
	}

	// Check for permanent patterns
	for (const pattern of PERMANENT_ERROR_PATTERNS) {
		if (pattern.test(normalizedError)) {
			return {
				category: "permanent",
				retryable: false,
				message: errorMessage,
				originalError: errorMessage,
			};
		}
	}

	// Default to unknown (treat as non-retryable for safety)
	return {
		category: "unknown",
		retryable: false,
		message: errorMessage,
		originalError: errorMessage,
	};
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: string | Error): boolean {
	return categorizeError(error).retryable;
}

/**
 * Categorize multiple errors and return statistics
 */
export function categorizeErrors(
	errors: Array<{ assetId: string; error: string }>
): {
	transient: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}>;
	permanent: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}>;
	unknown: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}>;
	stats: {
		total: number;
		transient: number;
		permanent: number;
		unknown: number;
		retryable: number;
	};
} {
	const transient: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}> = [];
	const permanent: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}> = [];
	const unknown: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}> = [];

	for (const err of errors) {
		const categorized = categorizeError(err.error);
		const entry = {
			assetId: err.assetId,
			error: err.error,
			categorized,
		};

		if (categorized.category === "transient") {
			transient.push(entry);
		} else if (categorized.category === "permanent") {
			permanent.push(entry);
		} else {
			unknown.push(entry);
		}
	}

	return {
		transient,
		permanent,
		unknown,
		stats: {
			total: errors.length,
			transient: transient.length,
			permanent: permanent.length,
			unknown: unknown.length,
			retryable: transient.length,
		},
	};
}
