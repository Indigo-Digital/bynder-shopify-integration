/**
 * Alert condition checking
 */

import prisma from "../../db.server.js";
import type { AlertConditions, AlertSeverity } from "./types.js";

const DEFAULT_CONDITIONS: Required<AlertConditions> = {
	highErrorRateThreshold: 10,
	slowPerformanceThreshold: 1,
	rateLimitHitThreshold: 5,
};

export interface AlertCheckResult {
	hasAlert: boolean;
	severity: AlertSeverity;
	message: string;
}

/**
 * Check for alerts based on sync job results
 */
export async function checkSyncJobAlerts(
	shopId: string,
	syncJobId: string,
	conditions?: AlertConditions
): Promise<AlertCheckResult[]> {
	const alerts: AlertCheckResult[] = [];
	const cond = { ...DEFAULT_CONDITIONS, ...conditions };

	// Get job details
	const job = await prisma.syncJob.findUnique({
		where: { id: syncJobId },
		select: {
			status: true,
			assetsProcessed: true,
			errors: true,
			startedAt: true,
			completedAt: true,
		},
	});

	if (!job) {
		return [];
	}

	// Check for job failure
	if (job.status === "failed") {
		alerts.push({
			hasAlert: true,
			severity: "critical",
			message: "Sync job failed. Please check the error details.",
		});
		return alerts;
	}

	if (job.status !== "completed") {
		return alerts; // Only check completed jobs
	}

	// Get metrics for this job
	const metrics = await prisma.syncMetrics.findMany({
		where: {
			shopId,
			syncJobId,
		},
	});

	const errorRateMetric = metrics.find(
		(m: { metricName: string }) => m.metricName === "error_rate_percent"
	);
	const throughputMetric = metrics.find(
		(m: { metricName: string }) => m.metricName === "assets_per_second"
	);
	const rateLimitMetrics = metrics.filter(
		(m: { metricName: string }) => m.metricName === "rate_limit_hits"
	);

	// Check error rate
	if (errorRateMetric && errorRateMetric.value > cond.highErrorRateThreshold) {
		alerts.push({
			hasAlert: true,
			severity: "warning",
			message: `High error rate detected: ${errorRateMetric.value.toFixed(1)}% of assets failed to sync.`,
		});
	}

	// Check throughput
	if (
		throughputMetric &&
		throughputMetric.value < cond.slowPerformanceThreshold
	) {
		alerts.push({
			hasAlert: true,
			severity: "warning",
			message: `Slow sync performance: ${throughputMetric.value.toFixed(1)} assets/second. Consider checking network or API limits.`,
		});
	}

	// Check rate limit hits
	const totalRateLimitHits = rateLimitMetrics.reduce(
		(sum: number, m: { value: number }) => sum + m.value,
		0
	);
	if (totalRateLimitHits >= cond.rateLimitHitThreshold) {
		alerts.push({
			hasAlert: true,
			severity: "warning",
			message: `Rate limit exceeded ${totalRateLimitHits} time(s). Consider reducing sync concurrency or increasing rate limit settings.`,
		});
	}

	return alerts;
}

/**
 * Get alerts for a shop (recent jobs)
 */
export async function getShopAlerts(
	shopId: string,
	conditions?: AlertConditions
): Promise<AlertCheckResult[]> {
	const recentJobs = await prisma.syncJob.findMany({
		where: {
			shopId,
			status: { in: ["completed", "failed"] },
		},
		orderBy: { completedAt: "desc" },
		take: 5,
		select: { id: true },
	});

	const allAlerts: AlertCheckResult[] = [];

	for (const job of recentJobs) {
		const jobAlerts = await checkSyncJobAlerts(shopId, job.id, conditions);
		allAlerts.push(...jobAlerts);
	}

	// Return unique alerts (by message)
	const uniqueAlerts = new Map<string, AlertCheckResult>();
	for (const alert of allAlerts) {
		if (alert.hasAlert && !uniqueAlerts.has(alert.message)) {
			uniqueAlerts.set(alert.message, alert);
		}
	}

	return Array.from(uniqueAlerts.values());
}
