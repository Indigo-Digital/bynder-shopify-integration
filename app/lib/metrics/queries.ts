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
	// Get recent completed jobs
	const recentJobs = await prisma.syncJob.findMany({
		where: {
			shopId,
			status: "completed",
		},
		orderBy: { completedAt: "desc" },
		take: lastNJobs,
		select: { id: true },
	});

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
	const durationMetrics = await prisma.syncMetrics.findMany({
		where: {
			shopId,
			syncJobId: { in: jobIds },
			metricType: "sync_duration",
			metricName: "sync_duration_seconds",
		},
		select: { value: true },
	});

	// Get throughput metrics
	const throughputMetrics = await prisma.syncMetrics.findMany({
		where: {
			shopId,
			syncJobId: { in: jobIds },
			metricType: "throughput",
			metricName: "assets_per_second",
		},
		select: { value: true },
	});

	// Get API call counts
	const apiCallMetrics = await prisma.syncMetrics.findMany({
		where: {
			shopId,
			syncJobId: { in: jobIds },
			metricType: "api_call",
		},
		select: { value: true },
	});

	// Get error rate metrics
	const errorRateMetrics = await prisma.syncMetrics.findMany({
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

	// Get rate limit hits
	const rateLimitMetrics = await prisma.syncMetrics.findMany({
		where: {
			shopId,
			syncJobId: { in: jobIds },
			metricType: "rate_limit_hit",
			metricName: "rate_limit_hits",
		},
		select: { value: true },
	});

	// Calculate averages
	const averageSyncDuration =
		durationMetrics.length > 0
			? durationMetrics.reduce((sum, m) => sum + m.value, 0) /
				durationMetrics.length
			: 0;

	const averageThroughput =
		throughputMetrics.length > 0
			? throughputMetrics.reduce((sum, m) => sum + m.value, 0) /
				throughputMetrics.length
			: 0;

	const totalApiCalls = apiCallMetrics.reduce((sum, m) => sum + m.value, 0);

	// Calculate error rate trend (difference between last 2 error rates)
	let errorRateTrend = 0;
	if (errorRateMetrics.length >= 2) {
		errorRateTrend = errorRateMetrics[0].value - errorRateMetrics[1].value;
	} else if (errorRateMetrics.length === 1) {
		errorRateTrend = errorRateMetrics[0].value;
	}

	const rateLimitHits = rateLimitMetrics.reduce((sum, m) => sum + m.value, 0);

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
	const metrics = await prisma.syncMetrics.findMany({
		where: {
			shopId,
			syncJobId,
		},
	});

	if (metrics.length === 0) {
		return null;
	}

	const durationMetric = metrics.find(
		(m) => m.metricName === "sync_duration_seconds"
	);
	const throughputMetric = metrics.find(
		(m) => m.metricName === "assets_per_second"
	);
	const apiCallMetrics = metrics.filter((m) => m.metricType === "api_call");
	const errorRateMetric = metrics.find(
		(m) => m.metricName === "error_rate_percent"
	);

	return {
		duration: durationMetric?.value || 0,
		throughput: throughputMetric?.value || 0,
		apiCalls: apiCallMetrics.reduce((sum, m) => sum + m.value, 0),
		errorRate: errorRateMetric?.value || 0,
	};
}
