import prisma from "../../db.server.js";
import { unauthenticated } from "../../shopify.server.js";
import { BynderClient } from "../bynder/client.js";
import { syncBynderAssets } from "./auto-sync.js";

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

/**
 * Worker process that polls for pending sync jobs and processes them
 */
async function processJobs() {
	console.log("[Worker] Job processing loop started");
	while (true) {
		try {
			// Find pending jobs (oldest first)
			// Also check for stuck running jobs (running but no progress for > 5 minutes)
			const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
			const pendingJob = await prisma.syncJob.findFirst({
				where: {
					OR: [
						{ status: "pending" },
						{
							status: "running",
							startedAt: {
								lt: fiveMinutesAgo, // Started more than 5 minutes ago
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
			});

			if (!pendingJob) {
				// No pending jobs, wait and check again
				// Log every 10th check to avoid spam (every ~50 seconds)
				if (Math.random() < 0.1) {
					console.log("[Worker] No pending jobs found, continuing to poll...");
				}
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				continue;
			}

			console.log(`[Worker] Found job: ${pendingJob.id} (status: ${pendingJob.status})`);

			// Mark job as running (if it wasn't already)
			if (pendingJob.status !== "running") {
				await prisma.syncJob.update({
					where: { id: pendingJob.id },
					data: {
						status: "running",
						startedAt: new Date(),
					},
				});
			} else {
				console.log(`[Worker] Job ${pendingJob.id} was already running, resuming...`);
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
				await prisma.syncJob.update({
					where: { id: pendingJob.id },
					data: {
						status: "failed",
						completedAt: new Date(),
						error: errorMessage,
					},
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
console.log("[Worker] Starting sync job worker...");
processJobs().catch((error) => {
	console.error("[Worker] Fatal error:", error);
	process.exit(1);
});
