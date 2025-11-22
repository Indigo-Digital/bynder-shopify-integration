import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { syncBynderAssets } from "../lib/sync/auto-sync.js";
import { authenticate } from "../shopify.server.js";

/**
 * Webhook endpoint for Bynder asset events
 * Handles asset tagging events and triggers sync
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const body = await request.json();
		const { session } = await authenticate.admin(request);
		const shop = session.shop;

		// Get shop configuration
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return Response.json({ error: "Shop not configured" }, { status: 400 });
		}

		// Verify webhook signature if Bynder provides it
		// TODO: Implement webhook signature verification when available

		// Parse webhook event
		const eventType = body.eventType || body.type;
		const assetId = body.assetId || body.asset?.id;

		if (!assetId) {
			return Response.json({ error: "Missing asset ID" }, { status: 400 });
		}

		// Check if event is relevant (asset tagged)
		if (eventType === "asset.tagged" || eventType === "media.tagged") {
			const tags = body.tags || body.asset?.tags || [];
			const syncTags = shopConfig.syncTags
				.split(",")
				.map((tag: string) => tag.trim())
				.filter((tag: string) => tag.length > 0);

			// Check if any of the tags match sync tags
			const shouldSync = tags.some((tag: string) => syncTags.includes(tag));

			if (shouldSync) {
				// Initialize Bynder client with permanent token from env
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

				// Get admin API
				const { admin } = await authenticate.admin(request);

				// Sync the specific asset
				// For now, trigger full sync - could be optimized to sync single asset
				await syncBynderAssets({
					shopId: shopConfig.id,
					admin,
					bynderClient,
				});
			}
		}

		return Response.json({ success: true });
	} catch (error) {
		console.error("Bynder webhook error:", error);
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Internal server error",
			},
			{ status: 500 }
		);
	}
};
