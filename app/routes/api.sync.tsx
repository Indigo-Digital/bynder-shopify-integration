import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { uploadBynderAsset } from "../lib/shopify/files.js";
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
		let assetId: string | null = url.searchParams.get("assetId");

		// Decode the asset ID if it was URL encoded
		if (assetId) {
			assetId = decodeURIComponent(assetId);

			// If the asset ID looks like base64, try to decode it
			// Bynder asset IDs are typically UUIDs, so if we get a long base64 string,
			// it might need decoding
			if (assetId.length > 30 && /^[A-Za-z0-9+/=]+$/.test(assetId)) {
				try {
					const decoded = Buffer.from(assetId, "base64").toString("utf-8");
					// Check if decoded value looks like a Bynder ID (UUID pattern or alphanumeric)
					// Bynder IDs are typically UUIDs like: 4BFD3C8F-7ACC-4D1E-98A2-7BFDDC6C511E
					if (decoded.match(/^[A-Za-z0-9_-]+$/) && decoded.length < 100) {
						// Extract UUID if it's wrapped in text like "(Asset_id UUID)"
						const uuidMatch = decoded.match(
							/([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i
						);
						if (uuidMatch && uuidMatch[1]) {
							assetId = uuidMatch[1];
						} else if (
							decoded.match(
								/^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i
							)
						) {
							// Already a UUID
							assetId = decoded;
						}
					}
				} catch {
					// Not base64 or decode failed, use original ID
				}
			}
		}

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
			// Log the asset ID for debugging
			console.log("Syncing asset with ID:", assetId);

			// Sync single asset - keep synchronous for quick operations
			let fileId: string;
			let fileUrl: string;

			try {
				const result = await uploadBynderAsset(
					admin,
					bynderClient,
					assetId,
					shopConfig.id,
					"manual",
					{
						fileFolderTemplate: shopConfig.fileFolderTemplate,
						filenamePrefix: shopConfig.filenamePrefix,
						filenameSuffix: shopConfig.filenameSuffix,
						altTextPrefix: shopConfig.altTextPrefix,
						syncTags: shopConfig.syncTags,
					}
				);
				fileId = result.fileId;
				fileUrl = result.fileUrl;
			} catch (error) {
				console.error("Error uploading asset:", error);
				// Provide more detailed error message
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				if (
					errorMessage.includes("404") ||
					errorMessage.includes("Not Found")
				) {
					return Response.json(
						{
							error: `Asset not found. The asset ID "${assetId}" may be invalid or in an incorrect format. Please try selecting the asset again.`,
						},
						{ status: 404 }
					);
				}
				throw error;
			}

			// Update or create synced asset record
			let assetInfo: Awaited<
				ReturnType<typeof bynderClient.getMediaInfo>
			> | null = null;
			try {
				assetInfo = await bynderClient.getMediaInfo({ id: assetId });
			} catch (error) {
				console.error("Error fetching asset info:", error);
				// Continue without asset info - we already have the file uploaded
				assetInfo = null;
			}
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
			// Sync all assets - create background job and return immediately
			const syncJob = await prisma.syncJob.create({
				data: {
					shopId: shopConfig.id,
					status: "pending",
					assetsProcessed: 0,
				},
			});

			return Response.json({
				success: true,
				jobId: syncJob.id,
				message: "Sync job created. Processing in background.",
			});
		}
	} catch (error) {
		console.error("Sync error:", error);
		return Response.json(
			{ error: error instanceof Error ? error.message : "Sync failed" },
			{ status: 500 }
		);
	}
};
