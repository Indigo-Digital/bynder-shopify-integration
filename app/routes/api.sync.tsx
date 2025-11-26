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
					// But sometimes they come wrapped like: (Asset_id 4BFD3C8F-7ACC-4D1E-98A27BFDDC6C511E)
					if (decoded.match(/^[A-Za-z0-9_()\s-]+$/) && decoded.length < 100) {
						// First try standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
						let uuidMatch = decoded.match(
							/([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i
						);

						// If not found, try UUID with missing hyphens in last segment: xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxxxxxx
						if (!uuidMatch) {
							uuidMatch = decoded.match(
								/([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{16})/i
							);
							// If found, normalize to standard UUID format by adding hyphens
							if (uuidMatch?.[1]) {
								const uuid = uuidMatch[1];
								// Split the last 16-char segment into 4-12 format
								const parts = uuid.split("-");
								if (parts.length === 4 && parts[3]?.length === 16) {
									assetId = `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3].slice(0, 4)}-${parts[3].slice(4)}`;
								} else {
									assetId = uuidMatch[1] ?? null;
								}
							}
						} else {
							assetId = uuidMatch[1] ?? null;
						}

						// If still no match, try extracting just the hex digits (32 hex chars = UUID without hyphens)
						if (!uuidMatch) {
							const hexOnly = decoded.replace(/[^A-F0-9]/gi, "");
							if (hexOnly.length === 32) {
								// Format as standard UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
								assetId = `${hexOnly.slice(0, 8)}-${hexOnly.slice(8, 12)}-${hexOnly.slice(12, 16)}-${hexOnly.slice(16, 20)}-${hexOnly.slice(20)}`;
							}
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
