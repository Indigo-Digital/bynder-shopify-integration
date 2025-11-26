import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { retryFailedAssets } from "../lib/sync/retry-failed-assets.js";
import { authenticate } from "../shopify.server.js";

/**
 * Retry failed assets endpoint
 * POST /api/sync/retry
 * Body: { jobId?: string, assetIds?: string[], onlyTransient?: boolean }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const { session, admin } = await authenticate.admin(request);
		const shop = session.shop;

		// Get shop configuration
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return Response.json(
				{ error: "Bynder not configured for this shop" },
				{ status: 400 }
			);
		}

		// Parse request body
		let body: {
			jobId?: string;
			assetIds?: string[];
			onlyTransient?: boolean;
		} = {};

		try {
			const contentType = request.headers.get("content-type");
			if (contentType?.includes("application/json")) {
				body = await request.json();
			} else {
				// Handle form data
				const formData = await request.formData();
				const jobIdValue = formData.get("jobId")?.toString();
				const assetIdsValue = formData.get("assetIds")?.toString();
				body = {
					...(jobIdValue && { jobId: jobIdValue }),
					...(assetIdsValue && {
						assetIds: JSON.parse(assetIdsValue) as string[],
					}),
					onlyTransient: formData.get("onlyTransient") === "true",
				};
			}
		} catch (_error) {
			return Response.json({ error: "Invalid request body" }, { status: 400 });
		}

		if (!body.jobId && (!body.assetIds || body.assetIds.length === 0)) {
			return Response.json(
				{ error: "Either jobId or assetIds must be provided" },
				{ status: 400 }
			);
		}

		// Initialize Bynder client
		let bynderClient: BynderClient;
		try {
			bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Bynder configuration error",
				},
				{ status: 500 }
			);
		}

		// Retry failed assets
		const retryOptions: {
			shopId: string;
			admin: typeof admin;
			bynderClient: typeof bynderClient;
			jobId?: string;
			assetIds?: string[];
			onlyTransient?: boolean;
		} = {
			shopId: shopConfig.id,
			admin,
			bynderClient,
			onlyTransient: body.onlyTransient || false,
		};

		if (body.jobId) {
			retryOptions.jobId = body.jobId;
		}
		if (body.assetIds) {
			retryOptions.assetIds = body.assetIds;
		}

		const result = await retryFailedAssets(retryOptions);

		return Response.json({
			success: true,
			processed: result.processed,
			successful: result.successful,
			failed: result.failed,
			skipped: result.skipped,
			errors: result.errors,
			message: `Retry completed: ${result.successful} successful, ${result.failed} failed, ${result.skipped} skipped`,
		});
	} catch (error) {
		console.error("Retry error:", error);
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Retry failed",
			},
			{ status: 500 }
		);
	}
};
