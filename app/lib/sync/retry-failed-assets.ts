import prisma from "../../db.server.js";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import {
	type CategorizedError,
	categorizeErrors,
} from "./error-categorization.js";
import { syncSingleBynderAsset } from "./single-asset-sync.js";

/**
 * Each retried asset is downloaded into memory and re-uploaded, and the
 * Bynder quota is shared by every shop on the deployment, so one retry call
 * must stay bounded.
 */
export const MAX_RETRY_ASSETS = 48;

const RECENT_JOBS_TO_SEARCH = 10;

/**
 * A retry request that was refused before any asset was downloaded.
 */
export class RetryRequestError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404
	) {
		super(message);
		this.name = "RetryRequestError";
	}
}

type FailedAsset = { assetId: string; error: string };

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

function parseJobErrors(jobId: string, errors: string | null): FailedAsset[] {
	if (!errors) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(errors);
	} catch (error) {
		console.warn(`Failed to parse errors from job ${jobId}:`, error);
		return [];
	}
	if (Array.isArray(parsed)) {
		return parsed
			.filter(
				(entry): entry is { assetId: string; error?: unknown } =>
					typeof entry?.assetId === "string" && entry.assetId.length > 0
			)
			.map((entry) => ({ assetId: entry.assetId, error: String(entry.error) }));
	}
	if (typeof parsed === "object" && parsed !== null) {
		return Object.entries(parsed).map(([assetId, error]) => ({
			assetId,
			error: String(error),
		}));
	}
	return [];
}

function dedupeByAssetId(assets: FailedAsset[]): FailedAsset[] {
	const byId = new Map<string, FailedAsset>();
	for (const asset of assets) {
		if (!byId.has(asset.assetId)) {
			byId.set(asset.assetId, asset);
		}
	}
	return [...byId.values()];
}

async function loadJobFailures(
	shopId: string,
	jobId: string
): Promise<FailedAsset[]> {
	const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
	if (!job || job.shopId !== shopId) {
		throw new RetryRequestError(`Job ${jobId} not found`, 404);
	}
	return dedupeByAssetId(parseJobErrors(job.id, job.errors));
}

/**
 * Only ids recorded as failed on this shop's recent jobs are retried, so a
 * caller cannot use the retry path to sync arbitrary Bynder assets.
 */
async function loadRequestedFailures(
	shopId: string,
	assetIds: string[]
): Promise<FailedAsset[]> {
	const requested = new Set(assetIds);
	if (requested.size > MAX_RETRY_ASSETS) {
		throw new RetryRequestError(
			`At most ${MAX_RETRY_ASSETS} assets can be retried at once`,
			400
		);
	}

	const recentJobs = await prisma.syncJob.findMany({
		where: {
			shopId,
			status: { in: ["completed", "failed"] },
		},
		orderBy: { createdAt: "desc" },
		take: RECENT_JOBS_TO_SEARCH,
	});

	const matches = recentJobs
		.flatMap((job) => parseJobErrors(job.id, job.errors))
		.filter((failure) => requested.has(failure.assetId));
	const failedAssets = dedupeByAssetId(matches);

	if (failedAssets.length === 0) {
		throw new RetryRequestError(
			"None of the requested assets failed in this shop's recent sync jobs",
			404
		);
	}
	return failedAssets;
}

async function loadFailedAssets(options: RetryOptions): Promise<FailedAsset[]> {
	if (options.jobId) {
		return loadJobFailures(options.shopId, options.jobId);
	}
	if (options.assetIds && options.assetIds.length > 0) {
		return loadRequestedFailures(options.shopId, options.assetIds);
	}
	throw new RetryRequestError("Either jobId or assetIds must be provided", 400);
}

/**
 * Retry failed assets from a sync job or specific asset IDs
 *
 * @throws {RetryRequestError} When the job is not this shop's, no requested id
 * failed for this shop, or more than MAX_RETRY_ASSETS would be retried. No
 * asset is downloaded in these cases.
 */
export async function retryFailedAssets(
	options: RetryOptions
): Promise<RetryResult> {
	const { shopId, admin, bynderClient, onlyTransient = false } = options;

	const failedAssets = await loadFailedAssets(options);

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

	if (assetsToRetry.length > MAX_RETRY_ASSETS) {
		throw new RetryRequestError(
			`${assetsToRetry.length} assets would be retried; at most ${MAX_RETRY_ASSETS} can be retried at once`,
			400
		);
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
