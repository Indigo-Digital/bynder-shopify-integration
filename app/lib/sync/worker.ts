import prisma from "../../db.server.js";
import { unauthenticated } from "../../shopify.server.js";
import { BynderClient } from "../bynder/client.js";
import { syncBynderAssets } from "./auto-sync.js";

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

/**
 * Worker process that polls for pending sync jobs and processes them
 */
async function processJobs() {
	while (true) {
		try {
			// Find pending jobs (oldest first)
			const pendingJob = await prisma.syncJob.findFirst({
				where: {
					status: "pending",
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
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				continue;
			}

			// Mark job as running
			await prisma.syncJob.update({
				where: { id: pendingJob.id },
				data: {
					status: "running",
					startedAt: new Date(),
				},
			});

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
				const { admin } = await unauthenticated.admin(shopConfig.shop);

				// Process the sync job
				// Note: syncBynderAssets will update the job status internally
				await syncBynderAssets({
					shopId: shopConfig.id,
					admin,
					bynderClient,
					forceImportAll: false, // TODO: Could store this in job data if needed
					jobId: pendingJob.id, // Pass job ID so sync function can check for cancellation
				});

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
