import prisma from "../../db.server.js";
import type { BynderClient } from "../bynder/client.js";
import { uploadBynderAsset } from "../shopify/files.js";
import type { AdminApi } from "../types.js";
import { categorizeErrors } from "./error-categorization.js";
import { retryFailedAssets } from "./retry-failed-assets.js";

interface SyncOptions {
	shopId: string;
	admin: AdminApi;
	bynderClient: BynderClient;
	forceImportAll?: boolean; // If true, import all assets even if they already exist
	jobId?: string; // Optional job ID - if provided, will check for cancellation
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

	// Get or create sync job
	let syncJob: { id: string; status: string } | null = null;
	if (options.jobId) {
		// Job already exists (created by API endpoint)
		syncJob = await prisma.syncJob.findUnique({
			where: { id: options.jobId },
		});
		if (!syncJob) {
			throw new Error(`Job ${options.jobId} not found`);
		}
		// Update status to running if it was pending
		if (syncJob.status === "pending") {
			await prisma.syncJob.update({
				where: { id: options.jobId },
				data: {
					status: "running",
					startedAt: new Date(),
				},
			});
		}
	} else {
		// Create sync job (backward compatibility for direct calls)
		syncJob = await prisma.syncJob.create({
			data: {
				shopId,
				status: "running",
				startedAt: new Date(),
				assetsProcessed: 0,
			},
		});
	}

	// Helper function to check if job was cancelled
	const checkCancellation = async (): Promise<boolean> => {
		if (!options.jobId) return false;
		const job = await prisma.syncJob.findUnique({
			where: { id: options.jobId },
			select: { status: true },
		});
		return job?.status === "cancelled";
	};

	let errors: Array<{ assetId: string; error: string }> = [];
	let created = 0;
	let updated = 0;

	try {
		// Query Bynder for assets with any of the configured tags
		console.log(
			`[Sync Job ${syncJob.id}] Starting to fetch assets from Bynder...`
		);
		const allAssets: Array<{ id: string; tags: string[]; version: number }> =
			[];

		for (const tag of syncTags) {
			console.log(`[Sync Job ${syncJob.id}] Fetching assets with tag: ${tag}`);
			const response = await bynderClient.getAllMediaItems({ tags: tag });
			console.log(
				`[Sync Job ${syncJob.id}] Found ${response.length} assets with tag: ${tag}`
			);
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

		console.log(
			`[Sync Job ${syncJob.id}] Total assets to process: ${allAssets.length}`
		);

		// Update job with total found
		await prisma.syncJob.update({
			where: { id: syncJob.id },
			data: {
				assetsProcessed: 0, // Reset counter
			},
		});

		// Process each asset
		for (const [index, asset] of allAssets.entries()) {
			if (index % 10 === 0) {
				console.log(
					`[Sync Job ${syncJob.id}] Processing asset ${index + 1}/${allAssets.length}: ${asset.id}`
				);
			}
			// Check for cancellation before processing each asset
			if (await checkCancellation()) {
				console.log(
					`[Sync Job] Job ${syncJob.id} was cancelled, stopping processing`
				);
				await prisma.syncJob.update({
					where: { id: syncJob.id },
					data: {
						status: "cancelled",
						completedAt: new Date(),
					},
				});
				return {
					processed: allAssets.length,
					created,
					updated,
					errors,
				};
			}

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
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				console.error(
					`[Sync Error] Failed to sync asset ${asset.id}:`,
					errorMessage,
					error instanceof Error ? error.stack : undefined
				);
				errors.push({
					assetId: asset.id,
					error: errorMessage,
				});
			}
		}

		// Log summary
		if (errors.length > 0) {
			console.error(
				`[Sync Job] Job ${syncJob.id} completed with ${errors.length} error(s):`,
				errors
			);
		} else {
			console.log(
				`[Sync Job] Job ${syncJob.id} completed successfully: ${created} created, ${updated} updated`
			);
		}

		// Check for cancellation one final time before marking as completed
		if (await checkCancellation()) {
			console.log(
				`[Sync Job] Job ${syncJob.id} was cancelled during final check`
			);
			await prisma.syncJob.update({
				where: { id: syncJob.id },
				data: {
					status: "cancelled",
					completedAt: new Date(),
					assetsProcessed: allAssets.length,
					assetsCreated: created,
					assetsUpdated: updated,
					errors: errors.length > 0 ? JSON.stringify(errors) : null,
				},
			});
			return {
				processed: allAssets.length,
				created,
				updated,
				errors,
			};
		}

		// Automatic retry for transient errors (if enabled and errors exist)
		if (errors.length > 0) {
			const categorized = categorizeErrors(errors);
			if (categorized.stats.transient > 0) {
				console.log(
					`[Sync Job ${syncJob.id}] Found ${categorized.stats.transient} transient errors, attempting automatic retry...`
				);
				try {
					// Wait 5 seconds before retrying (exponential backoff: first retry)
					await new Promise((resolve) => setTimeout(resolve, 5000));

					const retryResult = await retryFailedAssets({
						shopId,
						admin,
						bynderClient,
						jobId: syncJob.id,
						onlyTransient: true, // Only retry transient errors automatically
					});

					console.log(
						`[Sync Job ${syncJob.id}] Automatic retry completed: ${retryResult.successful} successful, ${retryResult.failed} failed`
					);

					// Update error counts: remove successfully retried transient errors
					// Keep permanent errors and failed retries
					const successfulRetries = retryResult.results
						.filter((r) => r.success)
						.map((r) => r.assetId);
					const remainingErrors = errors.filter(
						(err) => !successfulRetries.includes(err.assetId)
					);

					// Update created/updated counts if retries were successful
					if (retryResult.successful > 0) {
						const retryCreated = retryResult.results.filter(
							(r) => r.success && r.created
						).length;
						const retryUpdated = retryResult.results.filter(
							(r) => r.success && r.updated
						).length;
						created += retryCreated;
						updated += retryUpdated;
					}

					// Update errors array with remaining errors
					errors = remainingErrors;
				} catch (retryError) {
					console.error(
						`[Sync Job ${syncJob.id}] Automatic retry failed:`,
						retryError instanceof Error
							? retryError.message
							: String(retryError)
					);
					// Continue with original errors if retry fails
				}
			}
		}

		// Update sync job with results
		// Try to update with new fields first (after migration)
		// If migration hasn't been applied, fall back to basic update
		try {
			await prisma.syncJob.update({
				where: { id: syncJob.id },
				data: {
					status: "completed",
					completedAt: new Date(),
					assetsProcessed: allAssets.length,
					assetsCreated: created,
					assetsUpdated: updated,
					errors: errors.length > 0 ? JSON.stringify(errors) : null,
				},
			});
		} catch (error) {
			// If migration hasn't been run yet, try to apply it automatically
			if (
				error instanceof Error &&
				error.message.includes("Unknown argument")
			) {
				console.log(
					"Detected missing database columns. Attempting to apply migration automatically..."
				);
				try {
					// Detect database type from connection string
					const dbUrl = process.env.DATABASE_URL || "";
					const isPostgreSQL =
						dbUrl.includes("postgres") || dbUrl.includes("postgresql");
					const intType = isPostgreSQL ? "INT" : "INTEGER";

					// Try to add columns - handle both PostgreSQL (IF NOT EXISTS) and SQLite
					const addColumn = async (columnDef: string, columnName: string) => {
						try {
							if (isPostgreSQL) {
								// PostgreSQL supports IF NOT EXISTS
								await prisma.$executeRawUnsafe(
									`ALTER TABLE "SyncJob" ADD COLUMN IF NOT EXISTS ${columnDef}`
								);
							} else {
								// SQLite doesn't support IF NOT EXISTS, so catch duplicate errors
								await prisma.$executeRawUnsafe(
									`ALTER TABLE "SyncJob" ADD COLUMN ${columnDef}`
								);
							}
							console.log(`Added column: ${columnName}`);
						} catch (err) {
							// Column might already exist (race condition or already added)
							if (
								err instanceof Error &&
								(err.message.includes("duplicate column") ||
									err.message.includes("already exists") ||
									(err.message.includes("column") &&
										err.message.includes("already exists")))
							) {
								console.log(`Column ${columnName} already exists, skipping`);
								return;
							}
							throw err;
						}
					};

					await addColumn(`"errors" TEXT`, "errors");
					await addColumn(
						`"assetsCreated" ${intType} NOT NULL DEFAULT 0`,
						"assetsCreated"
					);
					await addColumn(
						`"assetsUpdated" ${intType} NOT NULL DEFAULT 0`,
						"assetsUpdated"
					);
					console.log("Migration applied successfully! Retrying update...");
					// Retry the update with new fields using raw SQL
					// Prisma Client hasn't been regenerated yet, so use raw SQL
					// Reuse the dbUrl and isPostgreSQL variables from above
					if (isPostgreSQL) {
						// PostgreSQL: Use parameterized query
						await prisma.$executeRawUnsafe(
							`UPDATE "SyncJob" SET 
								status = $1,
								"completedAt" = $2,
								"assetsProcessed" = $3,
								"assetsCreated" = $4,
								"assetsUpdated" = $5,
								errors = $6
							WHERE id = $7`,
							"completed",
							new Date(),
							allAssets.length,
							created,
							updated,
							errors.length > 0 ? JSON.stringify(errors) : null,
							syncJob.id
						);
					} else {
						// SQLite: Use parameterized query
						await prisma.$executeRawUnsafe(
							`UPDATE SyncJob SET 
								status = ?,
								completedAt = ?,
								assetsProcessed = ?,
								assetsCreated = ?,
								assetsUpdated = ?,
								errors = ?
							WHERE id = ?`,
							"completed",
							new Date(),
							allAssets.length,
							created,
							updated,
							errors.length > 0 ? JSON.stringify(errors) : null,
							syncJob.id
						);
					}
				} catch (migrationError) {
					// Migration failed, fall back to basic update
					console.warn(
						"Failed to apply migration automatically. Using fallback update.",
						migrationError instanceof Error
							? migrationError.message
							: String(migrationError)
					);
					// Store detailed errors in the error field (fallback when migration fails)
					// Try to store at least the first few errors with details
					let errorMessage: string | null = null;
					if (errors.length > 0) {
						// Store first 3 errors with details, then summary
						const errorDetails = errors
							.slice(0, 3)
							.map((err) => `Asset ${err.assetId}: ${err.error}`)
							.join("; ");
						const remaining = errors.length - 3;
						errorMessage =
							remaining > 0
								? `${errors.length} errors: ${errorDetails} (+ ${remaining} more)`
								: `${errors.length} error${errors.length !== 1 ? "s" : ""}: ${errorDetails}`;
					}

					await prisma.syncJob.update({
						where: { id: syncJob.id },
						data: {
							status: "completed",
							completedAt: new Date(),
							assetsProcessed: allAssets.length,
							error: errorMessage,
						},
					});
				}
			} else {
				throw error;
			}
		}

		return {
			processed: allAssets.length,
			created,
			updated,
			errors,
		};
	} catch (error) {
		// Mark job as failed
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(
			`[Sync Job Failed] Job ${syncJob.id} failed:`,
			errorMessage,
			error instanceof Error ? error.stack : undefined
		);
		await prisma.syncJob.update({
			where: { id: syncJob.id },
			data: {
				status: "failed",
				completedAt: new Date(),
				error: errorMessage,
			},
		});
		throw error;
	}
}
