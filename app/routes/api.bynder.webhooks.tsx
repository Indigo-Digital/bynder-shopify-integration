import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import {
	extractWebhookSignature,
	verifyWebhookSignature,
} from "../lib/bynder/webhooks.js";
import { env } from "../lib/env.server.js";
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
		// Get raw body for signature verification
		const rawBody = await request.text();
		let body: {
			eventType?: string;
			type?: string;
			assetId?: string;
			asset?: { id?: string };
		};
		try {
			body = JSON.parse(rawBody) as {
				eventType?: string;
				type?: string;
				assetId?: string;
				asset?: { id?: string };
			};
		} catch {
			return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
		}

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
						payload: rawBody,
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

		// Verify webhook signature if enabled and secret is configured
		const verifySignatures =
			env.BYNDER_WEBHOOK_VERIFY_SIGNATURES === "true" ||
			env.BYNDER_WEBHOOK_VERIFY_SIGNATURES === "1";
		const webhookSecret = env.BYNDER_WEBHOOK_SECRET;

		if (verifySignatures && webhookSecret) {
			const signature = extractWebhookSignature(request.headers);
			if (!signature) {
				console.warn(
					"[Webhook] Signature verification enabled but no signature header found"
				);
				// Log but don't reject - Bynder may not support signatures yet
			} else {
				const isValid = verifyWebhookSignature(
					rawBody,
					signature,
					webhookSecret
				);
				if (!isValid) {
					console.error("[Webhook] Invalid signature - rejecting webhook");
					return Response.json(
						{ error: "Invalid webhook signature" },
						{ status: 401 }
					);
				}
				console.log("[Webhook] Signature verified successfully");
			}
		} else if (verifySignatures && !webhookSecret) {
			console.warn(
				"[Webhook] Signature verification enabled but BYNDER_WEBHOOK_SECRET not configured"
			);
		}

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
					payload: rawBody,
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
