import prisma from "../../db.server.js";
import type { BynderClient } from "../bynder/client.js";
import { uploadBynderAsset } from "../shopify/files.js";
import type { AdminApi } from "../types.js";

interface SingleAssetSyncOptions {
	shopId: string;
	admin: AdminApi;
	bynderClient: BynderClient;
	assetId: string;
}

interface SingleAssetSyncResult {
	created: boolean;
	updated: boolean;
	skipped: boolean;
	error?: string;
}

/**
 * Sync a single Bynder asset to Shopify
 * Checks if asset matches sync tags and if update is needed based on version
 * Uses the same logic as background sync to ensure consistency
 */
export async function syncSingleBynderAsset(
	options: SingleAssetSyncOptions
): Promise<SingleAssetSyncResult> {
	const { shopId, admin, bynderClient, assetId } = options;

	try {
		// Get shop configuration
		const shop = await prisma.shop.findUnique({
			where: { id: shopId },
		});

		if (!shop) {
			throw new Error(`Shop ${shopId} not found`);
		}

		// Parse sync tags (comma-separated)
		const syncTags = shop.syncTags
			.split(",")
			.map((tag: string) => tag.trim())
			.filter((tag: string) => tag.length > 0);

		if (syncTags.length === 0) {
			return { created: false, updated: false, skipped: true };
		}

		// Get asset info from Bynder
		const assetInfoRaw = await bynderClient.getMediaInfo({ id: assetId });

		if (!assetInfoRaw) {
			throw new Error(`Asset ${assetId} not found in Bynder`);
		}

		// Type guard for asset info
		const assetInfo =
			assetInfoRaw && typeof assetInfoRaw === "object" && "id" in assetInfoRaw
				? (assetInfoRaw as {
						id: string;
						tags?: string[];
						version?: number;
						[key: string]: unknown;
					})
				: {
						id: assetId,
						tags: [],
						version: 1,
					};

		// Check if asset has any of the sync tags
		const assetTags = assetInfo.tags || [];
		const hasSyncTag = assetTags.some((tag: string) => syncTags.includes(tag));

		if (!hasSyncTag) {
			// Asset doesn't match sync tags, skip it
			return { created: false, updated: false, skipped: true };
		}

		// Check if asset already exists
		const existing = await prisma.syncedAsset.findUnique({
			where: {
				shopId_bynderAssetId: {
					shopId,
					bynderAssetId: assetId,
				},
			},
		});

		// Check if update is needed (version changed)
		const currentVersion = assetInfo.version || 1;
		const needsUpdate =
			!existing || (existing.bynderVersion || 0) < currentVersion;

		if (!needsUpdate) {
			// Asset is up to date, skip it
			return { created: false, updated: false, skipped: true };
		}

		// Upload to Shopify
		const { fileId } = await uploadBynderAsset(
			admin,
			bynderClient,
			assetId,
			shopId,
			"auto",
			{
				fileFolderTemplate: shop.fileFolderTemplate,
				filenamePrefix: shop.filenamePrefix,
				filenameSuffix: shop.filenameSuffix,
				altTextPrefix: shop.altTextPrefix,
				syncTags: shop.syncTags,
			}
		);

		// Update or create synced asset record
		await prisma.syncedAsset.upsert({
			where: {
				shopId_bynderAssetId: {
					shopId,
					bynderAssetId: assetId,
				},
			},
			create: {
				shopId,
				bynderAssetId: assetId,
				shopifyFileId: fileId,
				syncType: "auto",
				bynderTags: JSON.stringify(assetTags),
				bynderVersion: currentVersion,
			},
			update: {
				shopifyFileId: fileId,
				bynderTags: JSON.stringify(assetTags),
				bynderVersion: currentVersion,
				updatedAt: new Date(),
			},
		});

		return {
			created: !existing,
			updated: !!existing,
			skipped: false,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			created: false,
			updated: false,
			skipped: false,
			error: errorMessage,
		};
	}
}
