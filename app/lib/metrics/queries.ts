/**
 * Query functions for metrics data
 */

import prisma from "../../db.server.js";

export interface MetricsSummary {
	averageSyncDuration: number;
	averageThroughput: number;
	totalApiCalls: number;
	errorRateTrend: number;
	rateLimitHits: number;
}

/**
 * Get metrics summary for a shop (last N jobs)
 */
export async function getMetricsSummary(
	shopId: string,
	lastNJobs = 10
): Promise<MetricsSummary> {
	// Safety check: ensure prisma is initialized
	if (!prisma) {
		console.error("Prisma client is undefined in getMetricsSummary");
		return {
			averageSyncDuration: 0,
			averageThroughput: 0,
			totalApiCalls: 0,
			errorRateTrend: 0,
			rateLimitHits: 0,
		};
	}

	// Get recent completed jobs
	let recentJobs: Array<{ id: string }> = [];
	try {
		if (!prisma.syncJob) {
			console.error("prisma.syncJob is undefined in getMetricsSummary");
			return {
				averageSyncDuration: 0,
				averageThroughput: 0,
				totalApiCalls: 0,
				errorRateTrend: 0,
				rateLimitHits: 0,
			};
		}
		recentJobs = await prisma.syncJob.findMany({
			where: {
				shopId,
				status: "completed",
			},
			orderBy: { completedAt: "desc" },
			take: lastNJobs,
			select: { id: true },
		});
	} catch (error) {
		console.error("Error fetching recent jobs in getMetricsSummary:", error);
		return {
			averageSyncDuration: 0,
			averageThroughput: 0,
			totalApiCalls: 0,
			errorRateTrend: 0,
			rateLimitHits: 0,
		};
	}

	const jobIds = recentJobs.map((job) => job.id);

	if (jobIds.length === 0) {
		return {
			averageSyncDuration: 0,
			averageThroughput: 0,
			totalApiCalls: 0,
			errorRateTrend: 0,
			rateLimitHits: 0,
		};
	}

	// Get sync duration metrics
	let durationMetrics: Array<{ value: number }> = [];
	try {
		if (!prisma.syncMetrics) {
			console.error("prisma.syncMetrics is undefined in getMetricsSummary");
		} else {
			durationMetrics = await prisma.syncMetrics.findMany({
				where: {
					shopId,
					syncJobId: { in: jobIds },
					metricType: "sync_duration",
					metricName: "sync_duration_seconds",
				},
				select: { value: true },
			});
		}
	} catch (error) {
		console.error("Error fetching duration metrics:", error);
	}

	// Get throughput metrics
	let throughputMetrics: Array<{ value: number }> = [];
	try {
		if (prisma.syncMetrics) {
			throughputMetrics = await prisma.syncMetrics.findMany({
				where: {
					shopId,
					syncJobId: { in: jobIds },
					metricType: "throughput",
					metricName: "assets_per_second",
				},
				select: { value: true },
			});
		}
	} catch (error) {
		console.error("Error fetching throughput metrics:", error);
	}

	// Get API call counts
	let apiCallMetrics: Array<{ value: number }> = [];
	try {
		if (prisma.syncMetrics) {
			apiCallMetrics = await prisma.syncMetrics.findMany({
				where: {
					shopId,
					syncJobId: { in: jobIds },
					metricType: "api_call",
				},
				select: { value: true },
			});
		}
	} catch (error) {
		console.error("Error fetching API call metrics:", error);
	}

	// Get error rate metrics
	let errorRateMetrics: Array<{ value: number }> = [];
	try {
		if (prisma.syncMetrics) {
			errorRateMetrics = await prisma.syncMetrics.findMany({
				where: {
					shopId,
					syncJobId: { in: jobIds },
					metricType: "error_rate",
					metricName: "error_rate_percent",
				},
				orderBy: { recordedAt: "desc" },
				take: 2,
				select: { value: true },
			});
		}
	} catch (error) {
		console.error("Error fetching error rate metrics:", error);
	}

	// Get rate limit hits
	let rateLimitMetrics: Array<{ value: number }> = [];
	try {
		if (prisma.syncMetrics) {
			rateLimitMetrics = await prisma.syncMetrics.findMany({
				where: {
					shopId,
					syncJobId: { in: jobIds },
					metricType: "rate_limit_hit",
					metricName: "rate_limit_hits",
				},
				select: { value: true },
			});
		}
	} catch (error) {
		console.error("Error fetching rate limit metrics:", error);
	}

	// Calculate averages
	const averageSyncDuration =
		durationMetrics.length > 0
			? durationMetrics.reduce(
					(sum: number, m: { value: number }) => sum + m.value,
					0
				) / durationMetrics.length
			: 0;

	const averageThroughput =
		throughputMetrics.length > 0
			? throughputMetrics.reduce(
					(sum: number, m: { value: number }) => sum + m.value,
					0
				) / throughputMetrics.length
			: 0;

	const totalApiCalls = apiCallMetrics.reduce(
		(sum: number, m: { value: number }) => sum + m.value,
		0
	);

	// Calculate error rate trend (difference between last 2 error rates)
	let errorRateTrend = 0;
	if (errorRateMetrics.length >= 2) {
		const first = errorRateMetrics[0];
		const second = errorRateMetrics[1];
		if (first && second) {
			errorRateTrend = first.value - second.value;
		}
	} else if (errorRateMetrics.length === 1) {
		const first = errorRateMetrics[0];
		if (first) {
			errorRateTrend = first.value;
		}
	}

	const rateLimitHits = rateLimitMetrics.reduce(
		(sum: number, m: { value: number }) => sum + m.value,
		0
	);

	return {
		averageSyncDuration: Math.round(averageSyncDuration * 10) / 10,
		averageThroughput: Math.round(averageThroughput * 10) / 10,
		totalApiCalls: Math.round(totalApiCalls),
		errorRateTrend: Math.round(errorRateTrend * 10) / 10,
		rateLimitHits: Math.round(rateLimitHits),
	};
}

/**
 * Get real-time metrics for a running job
 */
export async function getJobMetrics(
	shopId: string,
	syncJobId: string
): Promise<{
	duration: number;
	throughput: number;
	apiCalls: number;
	errorRate: number;
} | null> {
	// Safety check: ensure prisma is initialized
	if (!prisma || !prisma.syncMetrics) {
		console.error("Prisma client not initialized in getJobMetrics");
		return null;
	}

	let metrics: Array<{
		metricName: string;
		metricType: string;
		value: number;
	}> = [];
	try {
		if (!prisma.syncMetrics) {
			console.error("prisma.syncMetrics is undefined in getJobMetrics");
			return null;
		}
		metrics = await prisma.syncMetrics.findMany({
			where: {
				shopId,
				syncJobId,
			},
		});
	} catch (error) {
		console.error("Error fetching job metrics:", error);
		return null;
	}

	if (metrics.length === 0) {
		return null;
	}

	const durationMetric = metrics.find(
		(m: { metricName: string }) => m.metricName === "sync_duration_seconds"
	);
	const throughputMetric = metrics.find(
		(m: { metricName: string }) => m.metricName === "assets_per_second"
	);
	const apiCallMetrics = metrics.filter(
		(m: { metricType: string }) => m.metricType === "api_call"
	);
	const errorRateMetric = metrics.find(
		(m: { metricName: string }) => m.metricName === "error_rate_percent"
	);

	return {
		duration: durationMetric?.value || 0,
		throughput: throughputMetric?.value || 0,
		apiCalls: apiCallMetrics.reduce((sum, m) => sum + m.value, 0),
		errorRate: errorRateMetric?.value || 0,
	};
}
