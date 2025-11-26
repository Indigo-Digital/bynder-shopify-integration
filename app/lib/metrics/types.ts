/**
 * Type definitions for metrics collection
 */

export type MetricType =
	| "api_call"
	| "sync_duration"
	| "throughput"
	| "error_rate"
	| "rate_limit_hit";

export type MetricName =
	| "bynder_api_calls"
	| "shopify_api_calls"
	| "bynder_getMediaList"
	| "bynder_getMediaInfo"
	| "bynder_getMediaDownloadUrl"
	| "shopify_stagedUploadsCreate"
	| "shopify_fileCreate"
	| "sync_duration_seconds"
	| "assets_per_second"
	| "error_rate_percent"
	| "rate_limit_hits";

export interface MetricMetadata {
	operation?: string;
	assetId?: string;
	errorType?: string;
	[key: string]: unknown;
}

export interface MetricRecord {
	shopId: string;
	syncJobId?: string;
	metricType: MetricType;
	metricName: MetricName;
	value: number;
	metadata?: MetricMetadata;
}
