// Log immediately before any imports to confirm script is executing
console.log("[Worker] Worker script starting...");
console.log("[Worker] Node version:", process.version);
console.log("[Worker] Current directory:", process.cwd());
console.log("[Worker] Loading imports...");

import prisma from "../../db.server.js";
import { unauthenticated } from "../../shopify.server.js";
import { BynderClient } from "../bynder/client.js";
import { syncBynderAssets } from "./auto-sync.js";

console.log("[Worker] Imports loaded successfully");

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

/**
 * Helper function to execute a Prisma query with automatic reconnection on connection errors
 */
async function withPrismaRetry<T>(
	operation: () => Promise<T>,
	maxRetries = 3
): Promise<T> {
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if it's a connection error (P1017 or similar)
			// Prisma error codes: P1017 = Server has closed the connection
			const isConnectionError =
				(error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "P1017") ||
				(error instanceof Error &&
					(error.message.includes("Server has closed the connection") ||
						error.message.includes("P1017") ||
						error.message.includes("connection closed") ||
						error.message.includes("Connection closed")));

			if (isConnectionError && attempt < maxRetries) {
				console.warn(
					`[Worker] Database connection error (attempt ${attempt}/${maxRetries}): ${lastError.message}. Reconnecting...`
				);
				try {
					// Disconnect and reconnect
					await prisma.$disconnect().catch(() => {
						// Ignore disconnect errors
					});
					await prisma.$connect();
					console.log("[Worker] Database reconnected successfully");
					// Wait a bit before retrying
					await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
					continue;
				} catch (reconnectError) {
					console.error(
						`[Worker] Failed to reconnect to database: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`
					);
					// Continue to next retry attempt
					await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
					continue;
				}
			}

			// If not a connection error or out of retries, throw
			throw lastError;
		}
	}
	throw lastError || new Error("Unknown error in withPrismaRetry");
}

/**
 * Worker process that polls for pending sync jobs and processes them
 */
async function processJobs() {
	console.log("[Worker] Job processing loop started");
	while (true) {
		try {
			// Find pending jobs (oldest first)
			// Also check for stuck running jobs:
			// - Running jobs without startedAt (shouldn't happen, but handle it)
			// - Running jobs that started more than 5 minutes ago
			const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
			const pendingJob = await withPrismaRetry(() =>
				prisma.syncJob.findFirst({
					where: {
						OR: [
							{ status: "pending" },
							{
								status: "running",
								startedAt: null, // Running but never had startedAt set (stuck)
							},
							{
								status: "running",
								startedAt: {
									lt: fiveMinutesAgo, // Started more than 5 minutes ago (stuck)
								},
							},
						],
					},
					orderBy: {
						createdAt: "asc",
					},
					include: {
						shop: true,
					},
				})
			);

			if (!pendingJob) {
				// No pending jobs, wait and check again
				// Log every 10th check to avoid spam (every ~50 seconds)
				if (Math.random() < 0.1) {
					console.log("[Worker] No pending jobs found, continuing to poll...");
				}
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				continue;
			}

			console.log(
				`[Worker] Found job: ${pendingJob.id} (status: ${pendingJob.status})`
			);

			// Mark job as running (if it wasn't already)
			if (pendingJob.status !== "running") {
				await withPrismaRetry(() =>
					prisma.syncJob.update({
						where: { id: pendingJob.id },
						data: {
							status: "running",
							startedAt: new Date(),
						},
					})
				);
			} else {
				console.log(
					`[Worker] Job ${pendingJob.id} was already running, resuming...`
				);
			}

			console.log(
				`[Worker] Processing job ${pendingJob.id} for shop ${pendingJob.shop.shop}`
			);

			try {
				// Get shop configuration
				const shopConfig = pendingJob.shop;
				if (!shopConfig.bynderBaseUrl) {
					throw new Error("Bynder not configured for this shop");
				}

				// Initialize Bynder client
				const bynderClient = BynderClient.createFromEnv(
					shopConfig.bynderBaseUrl
				);

				// Get admin API using offline session (persists regardless of user browser)
				console.log(`[Worker] Getting admin API for shop: ${shopConfig.shop}`);
				const { admin } = await unauthenticated.admin(shopConfig.shop);
				console.log(`[Worker] Admin API obtained successfully`);

				// Process the sync job
				// Note: syncBynderAssets will update the job status internally
				console.log(`[Worker] Starting sync for job ${pendingJob.id}`);
				await syncBynderAssets({
					shopId: shopConfig.id,
					admin,
					bynderClient,
					forceImportAll: false, // TODO: Could store this in job data if needed
					jobId: pendingJob.id, // Pass job ID so sync function can check for cancellation
				});
				console.log(`[Worker] Sync completed for job ${pendingJob.id}`);

				console.log(`[Worker] Job ${pendingJob.id} completed successfully`);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				console.error(`[Worker] Job ${pendingJob.id} failed:`, errorMessage);

				// Mark job as failed
				await withPrismaRetry(() =>
					prisma.syncJob.update({
						where: { id: pendingJob.id },
						data: {
							status: "failed",
							completedAt: new Date(),
							error: errorMessage,
						},
					})
				).catch((updateError) => {
					// Log but don't throw - we've already logged the original error
					console.error(
						`[Worker] Failed to update job status to failed: ${updateError instanceof Error ? updateError.message : String(updateError)}`
					);
				});
			}
		} catch (error) {
			console.error("[Worker] Error in job processing loop:", error);
			// Wait before retrying
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}
}

// Start the worker
async function startWorker() {
	console.log("[Worker] Starting sync job worker...");
	console.log("[Worker] Testing database connection...");
	try {
		// Test database connection
		await prisma.$connect();
		console.log("[Worker] Database connected successfully");
	} catch (dbError) {
		console.error("[Worker] Database connection failed:", dbError);
		console.error(
			"[Worker] Error details:",
			dbError instanceof Error ? dbError.stack : String(dbError)
		);
		process.exit(1);
	}

	console.log("[Worker] Starting job processing loop...");
	processJobs().catch((error) => {
		console.error("[Worker] Fatal error in processJobs:", error);
		console.error(
			"[Worker] Error stack:",
			error instanceof Error ? error.stack : "No stack"
		);
		process.exit(1);
	});
}

startWorker().catch((error) => {
	console.error("[Worker] Fatal error starting worker:", error);
	console.error(
		"[Worker] Error stack:",
		error instanceof Error ? error.stack : "No stack"
	);
	process.exit(1);
});
