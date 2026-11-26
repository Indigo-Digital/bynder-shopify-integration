import prisma from "../../db.server.js";
import { BynderClient } from "../bynder/client.js";
import { deleteWebhookSubscription } from "../bynder/webhooks.js";

/**
 * Removes everything stored for a shop so a later install on the same domain
 * starts from an empty record.
 *
 * `shop` must be the domain authenticated by the Shopify webhook HMAC, never a
 * value read from the webhook body. The shop row is deleted by its id, so
 * related assets, jobs, events, metrics and subscriptions cascade with it.
 * Safe to call repeatedly: Shopify may deliver the same webhook more than once.
 */
export async function deleteShopData(shop: string): Promise<void> {
	const shopRecord = await prisma.shop.findUnique({
		where: { shop },
		include: { webhookSubscriptions: true },
	});

	if (shopRecord) {
		await deleteRemoteWebhookSubscriptions(
			shopRecord.bynderBaseUrl,
			shopRecord.webhookSubscriptions.map((sub) => sub.bynderWebhookId)
		);
	}

	await prisma.$transaction([
		prisma.session.deleteMany({ where: { shop } }),
		prisma.shop.deleteMany({
			where: shopRecord ? { id: shopRecord.id } : { shop },
		}),
	]);
}

/**
 * Best effort: a Bynder failure must not keep the local data around, and any
 * event Bynder still sends is rejected once the shop row is gone.
 */
async function deleteRemoteWebhookSubscriptions(
	bynderBaseUrl: string | null,
	bynderWebhookIds: string[]
): Promise<void> {
	if (!bynderBaseUrl || bynderWebhookIds.length === 0) {
		return;
	}

	let bynderClient: BynderClient;
	try {
		bynderClient = BynderClient.createFromEnv(bynderBaseUrl);
	} catch (error) {
		console.error("Cannot create Bynder client for webhook cleanup:", error);
		return;
	}

	for (const bynderWebhookId of bynderWebhookIds) {
		try {
			await deleteWebhookSubscription(bynderClient, bynderWebhookId);
		} catch (error) {
			console.error(
				`Failed to delete Bynder webhook subscription ${bynderWebhookId}:`,
				error
			);
		}
	}
}
