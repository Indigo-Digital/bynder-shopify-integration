/**
 * Metrics collection and storage
 */

import prisma from "../../db.server.js";
import type { MetricMetadata, MetricName, MetricRecord } from "./types.js";

// Flag to track if we've logged the missing model warning (log once per session)
let hasLoggedSyncMetricsWarning = false;

/**
 * Check if metrics collection is enabled
 */
function isMetricsEnabled(): boolean {
	return process.env.ENABLE_METRICS !== "false";
}

/**
 * Record a metric
 */
export async function recordMetric(record: MetricRecord): Promise<void> {
	if (!isMetricsEnabled()) {
		return;
	}

	try {
		await prisma.syncMetrics.create({
			data: {
				shopId: record.shopId,
				syncJobId: record.syncJobId || null,
				metricType: record.metricType,
				metricName: record.metricName,
				value: record.value,
				metadata: record.metadata ? JSON.stringify(record.metadata) : null,
			},
		});
	} catch (error) {
		// Don't throw - metrics collection should not break the main flow
		// Only log once per session to avoid spam
		if (!hasLoggedSyncMetricsWarning) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			// Check for common "model doesn't exist" scenarios
			if (
				errorMessage.includes("does not exist") ||
				errorMessage.includes("undefined") ||
				errorMessage.includes("no such table")
			) {
				console.log(
					"[Metrics] syncMetrics table not available - metrics collection disabled"
				);
				hasLoggedSyncMetricsWarning = true;
			} else {
				console.warn(
					`[Metrics] Failed to record metric ${record.metricName}:`,
					errorMessage
				);
			}
		}
	}
}

/**
 * Record an API call metric
 */
export async function recordApiCall(
	shopId: string,
	apiName: MetricName,
	syncJobId?: string,
	metadata?: MetricMetadata
): Promise<void> {
	await recordMetric({
		shopId,
		syncJobId: syncJobId ?? undefined,
		metricType: "api_call",
		metricName: apiName,
		value: 1,
		metadata: metadata ?? undefined,
	});
}

/**
 * Record sync duration
 */
export async function recordSyncDuration(
	shopId: string,
	durationSeconds: number,
	syncJobId?: string,
	metadata?: MetricMetadata
): Promise<void> {
	await recordMetric({
		shopId,
		syncJobId: syncJobId ?? undefined,
		metricType: "sync_duration",
		metricName: "sync_duration_seconds",
		value: durationSeconds,
		metadata: metadata ?? undefined,
	});
}

/**
 * Record throughput (assets per second)
 */
export async function recordThroughput(
	shopId: string,
	assetsPerSecond: number,
	syncJobId?: string,
	metadata?: MetricMetadata
): Promise<void> {
	await recordMetric({
		shopId,
		syncJobId: syncJobId ?? undefined,
		metricType: "throughput",
		metricName: "assets_per_second",
		value: assetsPerSecond,
		metadata: metadata ?? undefined,
	});
}

/**
 * Record error rate
 */
export async function recordErrorRate(
	shopId: string,
	errorRatePercent: number,
	syncJobId?: string,
	metadata?: MetricMetadata
): Promise<void> {
	await recordMetric({
		shopId,
		syncJobId: syncJobId ?? undefined,
		metricType: "error_rate",
		metricName: "error_rate_percent",
		value: errorRatePercent,
		metadata: metadata ?? undefined,
	});
}

/**
 * Record rate limit hit
 */
export async function recordRateLimitHit(
	shopId: string,
	syncJobId?: string,
	metadata?: MetricMetadata
): Promise<void> {
	await recordMetric({
		shopId,
		syncJobId: syncJobId ?? undefined,
		metricType: "rate_limit_hit",
		metricName: "rate_limit_hits",
		value: 1,
		metadata: metadata ?? undefined,
	});
}

/**
 * Clean up old metrics (based on retention days)
 */
export async function cleanupOldMetrics(shopId?: string): Promise<number> {
	const retentionDays = Number.parseInt(
		process.env.METRICS_RETENTION_DAYS || "30",
		10
	);
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

	try {
		const where = shopId
			? {
					shopId,
					recordedAt: { lt: cutoffDate },
				}
			: {
					recordedAt: { lt: cutoffDate },
				};

		const result = await prisma.syncMetrics.deleteMany({
			where,
		});

		return result.count;
	} catch {
		// Silently fail - metrics cleanup is not critical
		return 0;
	}
}
