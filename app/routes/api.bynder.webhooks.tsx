import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { syncSingleBynderAsset } from "../lib/sync/single-asset-sync.js";
import { authenticate } from "../shopify.server.js";

/**
 * Webhook endpoint for Bynder asset events
 * Handles asset tagging events and triggers single asset sync
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	let webhookEventId: string | null = null;

	try {
		const body = await request.json();
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

		// Check if webhook subscription is active
		if (
			!shopConfig.webhookSubscriptions ||
			shopConfig.webhookSubscriptions.length === 0
		) {
			// Webhook is deactivated, log but don't process
			const eventType = body.eventType || body.type || "unknown";
			const assetId = body.assetId || body.asset?.id || null;

			// Try to log event, but don't fail if table doesn't exist yet
			try {
				await prisma.webhookEvent.create({
					data: {
						shopId: shopConfig.id,
						eventType,
						assetId,
						status: "failed",
						payload: JSON.stringify(body),
						error: "Webhook subscription is not active",
						processedAt: new Date(),
					},
				});
			} catch (error) {
				console.warn(
					"Failed to log webhook event (table may not exist yet):",
					error
				);
			}

			// Return 200 to prevent Bynder from retrying
			return Response.json({
				success: false,
				message: "Webhook subscription is not active",
			});
		}

		// Verify webhook signature if Bynder provides it
		// TODO: Implement webhook signature verification when available

		// Parse webhook event
		const eventType = body.eventType || body.type || "unknown";
		const assetId = body.assetId || body.asset?.id || null;

		// Log webhook event BEFORE processing (handle case where table doesn't exist)
		try {
			const webhookEvent = await prisma.webhookEvent.create({
				data: {
					shopId: shopConfig.id,
					eventType,
					assetId,
					status: "success", // Will update if processing fails
					payload: JSON.stringify(body),
				},
			});
			webhookEventId = webhookEvent.id;
		} catch (error) {
			console.warn(
				"Failed to create webhook event (table may not exist yet):",
				error
			);
			// Continue processing even if logging fails
		}

		if (!assetId) {
			// Update event with error (if event was created)
			if (webhookEventId) {
				try {
					await prisma.webhookEvent.update({
						where: { id: webhookEventId },
						data: {
							status: "failed",
							error: "Missing asset ID",
							processedAt: new Date(),
						},
					});
				} catch (error) {
					console.warn("Failed to update webhook event:", error);
				}
			}
			return Response.json({ error: "Missing asset ID" }, { status: 400 });
		}

		// Check if event is relevant (asset tagged)
		if (eventType === "asset.tagged" || eventType === "media.tagged") {
			// Initialize Bynder client with permanent token from env
			let bynderClient: BynderClient;
			try {
				bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Bynder configuration error";
				// Update event with error
				if (webhookEventId) {
					await prisma.webhookEvent.update({
						where: { id: webhookEventId },
						data: {
							status: "failed",
							error: errorMessage,
							processedAt: new Date(),
						},
					});
				}
				return Response.json({ error: errorMessage }, { status: 500 });
			}

			// Get admin API
			const { admin } = await authenticate.admin(request);

			// Sync the specific asset using single asset sync
			const syncResult = await syncSingleBynderAsset({
				shopId: shopConfig.id,
				admin,
				bynderClient,
				assetId,
			});

			// Update event with processing result (if event was created)
			if (webhookEventId) {
				try {
					await prisma.webhookEvent.update({
						where: { id: webhookEventId },
						data: {
							status: syncResult.error ? "failed" : "success",
							error: syncResult.error || null,
							processedAt: new Date(),
						},
					});
				} catch (error) {
					console.warn("Failed to update webhook event:", error);
				}
			}

			if (syncResult.error) {
				// Log error but return 200 to prevent Bynder retries
				console.error(
					`[Webhook] Failed to sync asset ${assetId}:`,
					syncResult.error
				);
				return Response.json({
					success: false,
					error: syncResult.error,
				});
			}

			return Response.json({
				success: true,
				created: syncResult.created,
				updated: syncResult.updated,
				skipped: syncResult.skipped,
			});
		}

		// Event type not relevant, mark as processed (if event was created)
		if (webhookEventId) {
			try {
				await prisma.webhookEvent.update({
					where: { id: webhookEventId },
					data: {
						status: "success",
						error: "Event type not relevant for sync",
						processedAt: new Date(),
					},
				});
			} catch (error) {
				console.warn("Failed to update webhook event:", error);
			}
		}

		return Response.json({ success: true, skipped: true });
	} catch (error) {
		console.error("Bynder webhook error:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Internal server error";

		// Update event with error if we have the ID
		if (webhookEventId) {
			try {
				await prisma.webhookEvent.update({
					where: { id: webhookEventId },
					data: {
						status: "failed",
						error: errorMessage,
						processedAt: new Date(),
					},
				});
			} catch (updateError) {
				console.error("Failed to update webhook event:", updateError);
			}
		}

		// Return 200 to prevent Bynder from retrying on transient errors
		// But log the error for debugging
		return Response.json({
			success: false,
			error: errorMessage,
		});
	}
};
