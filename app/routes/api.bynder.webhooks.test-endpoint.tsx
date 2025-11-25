import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { syncSingleBynderAsset } from "../lib/sync/single-asset-sync.js";
import { authenticate, unauthenticated } from "../shopify.server.js";

/**
 * Test webhook endpoint
 * Simulates a Bynder webhook event for testing purposes
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const { session } = await authenticate.admin(request);
		const shop = session.shop;

		// Get shop configuration
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
			include: {
				webhookSubscriptions: {
					where: { active: true },
					take: 1,
				},
			},
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return Response.json({ error: "Shop not configured" }, { status: 400 });
		}

		if (
			!shopConfig.webhookSubscriptions ||
			shopConfig.webhookSubscriptions.length === 0
		) {
			return Response.json(
				{ error: "No active webhook subscription found" },
				{ status: 400 }
			);
		}

		// Initialize Bynder client
		const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);

		// Get a real asset ID from Bynder for testing (or use a test ID)
		// For now, we'll use a test asset ID and let the sync handle it
		const testAssetId = "test-asset-id";

		const startTime = Date.now();

		try {
			// Get admin API using offline session for background processing
			const { admin } = await unauthenticated.admin(shop);

			// Try to sync the test asset
			// This will fail if the asset doesn't exist, but that's okay for testing
			const syncResult = await syncSingleBynderAsset({
				shopId: shopConfig.id,
				admin,
				bynderClient,
				assetId: testAssetId,
			});

			const responseTime = Date.now() - startTime;

			// Log test event
			try {
				await prisma.webhookEvent.create({
					data: {
						shopId: shopConfig.id,
						eventType: "asset.tagged",
						assetId: testAssetId,
						status: syncResult.error ? "failed" : "success",
						payload: JSON.stringify({
							eventType: "asset.tagged",
							assetId: testAssetId,
							test: true,
						}),
						error: syncResult.error || null,
						processedAt: new Date(),
					},
				});
			} catch (error) {
				console.warn("Failed to log test webhook event:", error);
			}

			return Response.json({
				success: true,
				message: syncResult.error
					? `Test completed with error: ${syncResult.error}`
					: "Webhook test completed successfully",
				responseTime: `${responseTime}ms`,
				syncResult,
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			const responseTime = Date.now() - startTime;

			// Log test event with error
			try {
				await prisma.webhookEvent.create({
					data: {
						shopId: shopConfig.id,
						eventType: "asset.tagged",
						assetId: testAssetId,
						status: "failed",
						payload: JSON.stringify({
							eventType: "asset.tagged",
							assetId: testAssetId,
							test: true,
						}),
						error: errorMessage,
						processedAt: new Date(),
					},
				});
			} catch (logError) {
				console.warn("Failed to log test webhook event:", logError);
			}

			return Response.json({
				success: false,
				error: errorMessage,
				responseTime: `${responseTime}ms`,
			});
		}
	} catch (error) {
		console.error("Webhook test error:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Internal server error";

		return Response.json(
			{ success: false, error: errorMessage },
			{ status: 500 }
		);
	}
};
