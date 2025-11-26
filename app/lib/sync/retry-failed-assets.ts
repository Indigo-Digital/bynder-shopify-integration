import prisma from "../../db.server.js";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import {
	type CategorizedError,
	categorizeErrors,
} from "./error-categorization.js";
import { syncSingleBynderAsset } from "./single-asset-sync.js";

export interface RetryOptions {
	shopId: string;
	admin: AdminApi;
	bynderClient: BynderClient;
	jobId?: string; // If provided, retry all failed assets from this job
	assetIds?: string[]; // If provided, retry only these specific assets
	onlyTransient?: boolean; // If true, only retry transient errors (default: false for manual retries)
}

export interface RetryResult {
	processed: number;
	successful: number;
	failed: number;
	skipped: number;
	errors: Array<{
		assetId: string;
		error: string;
		categorized: CategorizedError;
	}>;
	results: Array<{
		assetId: string;
		success: boolean;
		created?: boolean;
		updated?: boolean;
		skipped?: boolean;
		error?: string;
		categorized?: CategorizedError;
	}>;
}

/**
 * Retry failed assets from a sync job or specific asset IDs
 */
export async function retryFailedAssets(
	options: RetryOptions
): Promise<RetryResult> {
	const { shopId, admin, bynderClient, onlyTransient = false } = options;

	// Get failed assets to retry
	let failedAssets: Array<{ assetId: string; error: string }> = [];

	if (options.jobId) {
		// Get failed assets from the job
		const job = await prisma.syncJob.findUnique({
			where: { id: options.jobId },
		});

		if (!job) {
			throw new Error(`Job ${options.jobId} not found`);
		}

		// Parse errors from job
		if (job.errors) {
			try {
				const parsed = JSON.parse(job.errors);
				if (Array.isArray(parsed)) {
					failedAssets = parsed;
				} else if (typeof parsed === "object" && parsed !== null) {
					// Convert object format to array
					failedAssets = Object.entries(parsed).map(([assetId, error]) => ({
						assetId,
						error: String(error),
					}));
				}
			} catch (error) {
				console.warn(
					`Failed to parse errors from job ${options.jobId}:`,
					error
				);
			}
		}
	} else if (options.assetIds && options.assetIds.length > 0) {
		// Get errors for specific assets from recent jobs
		// We'll need to find which job(s) these assets failed in
		const recentJobs = await prisma.syncJob.findMany({
			where: {
				shopId,
				status: { in: ["completed", "failed"] },
			},
			orderBy: { createdAt: "desc" },
			take: 10, // Check last 10 jobs
		});

		for (const job of recentJobs) {
			if (job.errors) {
				try {
					const parsed = JSON.parse(job.errors);
					let jobErrors: Array<{ assetId: string; error: string }> = [];
					if (Array.isArray(parsed)) {
						jobErrors = parsed;
					} else if (typeof parsed === "object" && parsed !== null) {
						jobErrors = Object.entries(parsed).map(([assetId, error]) => ({
							assetId,
							error: String(error),
						}));
					}

					// Filter to only include requested asset IDs
					for (const err of jobErrors) {
						if (
							options.assetIds.includes(err.assetId) &&
							!failedAssets.find((a) => a.assetId === err.assetId)
						) {
							failedAssets.push(err);
						}
					}
				} catch (error) {
					console.warn(`Failed to parse errors from job ${job.id}:`, error);
				}
			}
		}

		// If we couldn't find errors for some assets, still try to retry them
		// (they might have been skipped or had other issues)
		for (const assetId of options.assetIds) {
			if (!failedAssets.find((a) => a.assetId === assetId)) {
				failedAssets.push({
					assetId,
					error: "Previous error not found, retrying anyway",
				});
			}
		}
	} else {
		throw new Error("Either jobId or assetIds must be provided");
	}

	if (failedAssets.length === 0) {
		return {
			processed: 0,
			successful: 0,
			failed: 0,
			skipped: 0,
			errors: [],
			results: [],
		};
	}

	// Categorize errors
	const categorized = categorizeErrors(failedAssets);

	// Filter by error category if requested
	let assetsToRetry = failedAssets;
	if (onlyTransient) {
		assetsToRetry = categorized.transient.map((t) => ({
			assetId: t.assetId,
			error: t.error,
		}));
	}

	if (assetsToRetry.length === 0) {
		return {
			processed: 0,
			successful: 0,
			failed: 0,
			skipped: categorized.permanent.length + categorized.unknown.length,
			errors: [
				...categorized.permanent.map((p) => ({
					assetId: p.assetId,
					error: p.error,
					categorized: p.categorized,
				})),
				...categorized.unknown.map((u) => ({
					assetId: u.assetId,
					error: u.error,
					categorized: u.categorized,
				})),
			],
			results: [],
		};
	}

	// Retry each asset
	const results: RetryResult["results"] = [];
	let successful = 0;
	let failed = 0;
	let skipped = 0;

	for (const asset of assetsToRetry) {
		try {
			const result = await syncSingleBynderAsset({
				shopId,
				admin,
				bynderClient,
				assetId: asset.assetId,
			});

			const categorizedError = result.error
				? categorizeErrors([{ assetId: asset.assetId, error: result.error }])
						.transient[0]?.categorized ||
					categorizeErrors([{ assetId: asset.assetId, error: result.error }])
						.permanent[0]?.categorized ||
					categorizeErrors([{ assetId: asset.assetId, error: result.error }])
						.unknown[0]?.categorized
				: undefined;

			results.push({
				assetId: asset.assetId,
				success: !result.error && !result.skipped,
				...(result.created !== undefined && { created: result.created }),
				...(result.updated !== undefined && { updated: result.updated }),
				...(result.skipped !== undefined && { skipped: result.skipped }),
				...(result.error && { error: result.error }),
				...(categorizedError && { categorized: categorizedError }),
			});

			if (result.error) {
				failed++;
			} else if (result.skipped) {
				skipped++;
			} else {
				successful++;
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const categorizedError =
				categorizeErrors([{ assetId: asset.assetId, error: errorMessage }])
					.transient[0]?.categorized ||
				categorizeErrors([{ assetId: asset.assetId, error: errorMessage }])
					.permanent[0]?.categorized ||
				categorizeErrors([{ assetId: asset.assetId, error: errorMessage }])
					.unknown[0]?.categorized;

			results.push({
				assetId: asset.assetId,
				success: false,
				error: errorMessage,
				...(categorizedError && { categorized: categorizedError }),
			});
			failed++;
		}
	}

	// Collect errors from failed retries
	const retryErrors = results
		.filter((r) => r.error && r.categorized)
		.map((r) => ({
			assetId: r.assetId,
			error: r.error as string,
			categorized: r.categorized as CategorizedError,
		}));

	return {
		processed: assetsToRetry.length,
		successful,
		failed,
		skipped,
		errors: retryErrors,
		results,
	};
}
