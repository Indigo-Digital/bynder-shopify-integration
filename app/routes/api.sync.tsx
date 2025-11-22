import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { env } from "../lib/env.server.js";
import { uploadBynderAsset } from "../lib/shopify/files.js";
import { syncBynderAssets } from "../lib/sync/auto-sync.js";
import { authenticate } from "../shopify.server.js";

/**
 * Manual sync endpoint
 * POST /api/sync - Sync all assets
 * POST /api/sync?assetId=xxx - Sync specific asset
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const { session, admin } = await authenticate.admin(request);
		const shop = session.shop;
		const url = new URL(request.url);
		const assetId = url.searchParams.get("assetId");

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

		if (assetId) {
			// Sync single asset
			const { fileId, fileUrl } = await uploadBynderAsset(
				admin,
				bynderClient,
				assetId,
				shopConfig.id,
				"manual"
			);

			// Update or create synced asset record
			const assetInfo = await bynderClient.getMediaInfo({ id: assetId });
			const bynderAsset =
				assetInfo && typeof assetInfo === "object" && "id" in assetInfo
					? (assetInfo as { tags?: string[]; version?: number })
					: { tags: [], version: 1 };
			await prisma.syncedAsset.upsert({
				where: {
					shopId_bynderAssetId: {
						shopId: shopConfig.id,
						bynderAssetId: assetId,
					},
				},
				create: {
					shopId: shopConfig.id,
					bynderAssetId: assetId,
					shopifyFileId: fileId,
					syncType: "manual",
					bynderTags: JSON.stringify(bynderAsset.tags || []),
					bynderVersion: bynderAsset.version || 1,
				},
				update: {
					shopifyFileId: fileId,
					bynderTags: JSON.stringify(bynderAsset.tags || []),
					bynderVersion: bynderAsset.version || 1,
					updatedAt: new Date(),
				},
			});

			return Response.json({ success: true, fileId, fileUrl });
		} else {
			// Sync all assets
			const result = await syncBynderAssets({
				shopId: shopConfig.id,
				admin,
				bynderClient,
			});

			return Response.json({ success: true, ...result });
		}
	} catch (error) {
		console.error("Sync error:", error);
		return Response.json(
			{ error: error instanceof Error ? error.message : "Sync failed" },
			{ status: 500 }
		);
	}
};
