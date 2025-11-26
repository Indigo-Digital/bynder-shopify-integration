/**
 * Alert type definitions
 */

export type AlertSeverity = "info" | "warning" | "error";

export interface Alert {
	id: string;
	severity: AlertSeverity;
	message: string;
	timestamp: Date;
	jobId?: string;
	shopId: string;
}

export interface AlertConditions {
	highErrorRateThreshold?: number; // Percentage (default: 10)
	slowPerformanceThreshold?: number; // Assets per second (default: 1)
	rateLimitHitThreshold?: number; // Number of hits (default: 5)
}
