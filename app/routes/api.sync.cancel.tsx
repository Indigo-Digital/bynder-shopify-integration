import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";

/**
 * Cancel a running sync job
 * POST /api/sync/cancel - Cancel a sync job
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const { session } = await authenticate.admin(request);
		const shop = session.shop;

		// Get shop configuration to verify ownership
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
		});

		if (!shopConfig) {
			return Response.json({ error: "Shop not found" }, { status: 404 });
		}

		// Get job ID from request body
		const body = await request.json().catch(() => ({}));
		const jobId = body.jobId;

		if (!jobId || typeof jobId !== "string") {
			return Response.json({ error: "jobId is required" }, { status: 400 });
		}

		// Find the job and verify it belongs to this shop
		const job = await prisma.syncJob.findUnique({
			where: { id: jobId },
			include: { shop: true },
		});

		if (!job) {
			return Response.json({ error: "Job not found" }, { status: 404 });
		}

		if (job.shopId !== shopConfig.id) {
			return Response.json(
				{ error: "Job does not belong to this shop" },
				{ status: 403 }
			);
		}

		// Only allow cancelling pending or running jobs
		if (job.status !== "pending" && job.status !== "running") {
			return Response.json(
				{ error: `Cannot cancel job with status: ${job.status}` },
				{ status: 400 }
			);
		}

		// Update job status to cancelled
		await prisma.syncJob.update({
			where: { id: jobId },
			data: {
				status: "cancelled",
				completedAt: new Date(),
			},
		});

		return Response.json({
			success: true,
			message: "Job cancelled successfully",
		});
	} catch (error) {
		console.error("Cancel job error:", error);
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Failed to cancel job",
			},
			{ status: 500 }
		);
	}
};
