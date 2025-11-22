import prisma from "../../db.server.js";
import type { BynderClient } from "../bynder/client.js";
import { uploadBynderAsset } from "../shopify/files.js";
import type { AdminApi } from "../types.js";

interface SyncOptions {
	shopId: string;
	admin: AdminApi;
	bynderClient: BynderClient;
	forceImportAll?: boolean; // If true, import all assets even if they already exist
}

/**
 * Sync assets from Bynder to Shopify based on configured tags
 */
export async function syncBynderAssets(options: SyncOptions): Promise<{
	processed: number;
	created: number;
	updated: number;
	errors: Array<{ assetId: string; error: string }>;
}> {
	const { shopId, admin, bynderClient } = options;

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
		return { processed: 0, created: 0, updated: 0, errors: [] };
	}

	// Create sync job
	const syncJob = await prisma.syncJob.create({
		data: {
			shopId,
			status: "running",
			startedAt: new Date(),
			assetsProcessed: 0,
		},
	});

	const errors: Array<{ assetId: string; error: string }> = [];
	let created = 0;
	let updated = 0;

	try {
		// Query Bynder for assets with any of the configured tags
		const allAssets: Array<{ id: string; tags: string[]; version: number }> =
			[];

		for (const tag of syncTags) {
			const response = await bynderClient.getAllMediaItems({ tags: tag });
			// Response is now properly typed from getAllMediaItems
			for (const asset of response) {
				// Check if asset has at least one of the sync tags
				const assetTags = asset.tags || [];
				const hasSyncTag = assetTags.some((assetTag: string) =>
					syncTags.includes(assetTag)
				);
				if (hasSyncTag && !allAssets.find((a) => a.id === asset.id)) {
					allAssets.push({
						id: asset.id,
						tags: assetTags,
						version: asset.version || 1,
					});
				}
			}
		}

		// Process each asset
		for (const asset of allAssets) {
			try {
				// Check if asset already exists
				const existing = await prisma.syncedAsset.findUnique({
					where: {
						shopId_bynderAssetId: {
							shopId,
							bynderAssetId: asset.id,
						},
					},
				});

				// Check if update is needed (version changed or force import all)
				const needsUpdate =
					options.forceImportAll ||
					!existing ||
					(existing.bynderVersion || 0) < asset.version;

				if (needsUpdate) {
					// Upload to Shopify
					const { fileId } = await uploadBynderAsset(
						admin,
						bynderClient,
						asset.id,
						shopId,
						"auto"
					);

					// Update or create synced asset record
					await prisma.syncedAsset.upsert({
						where: {
							shopId_bynderAssetId: {
								shopId,
								bynderAssetId: asset.id,
							},
						},
						create: {
							shopId,
							bynderAssetId: asset.id,
							shopifyFileId: fileId,
							syncType: "auto",
							bynderTags: JSON.stringify(asset.tags),
							bynderVersion: asset.version,
						},
						update: {
							shopifyFileId: fileId,
							bynderTags: JSON.stringify(asset.tags),
							bynderVersion: asset.version,
							updatedAt: new Date(),
						},
					});

					if (existing) {
						updated++;
					} else {
						created++;
					}
				}
			} catch (error) {
				errors.push({
					assetId: asset.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Update sync job
		await prisma.syncJob.update({
			where: { id: syncJob.id },
			data: {
				status: "completed",
				completedAt: new Date(),
				assetsProcessed: allAssets.length,
			},
		});

		return {
			processed: allAssets.length,
			created,
			updated,
			errors,
		};
	} catch (error) {
		// Mark job as failed
		await prisma.syncJob.update({
			where: { id: syncJob.id },
			data: {
				status: "failed",
				completedAt: new Date(),
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error;
	}
}
