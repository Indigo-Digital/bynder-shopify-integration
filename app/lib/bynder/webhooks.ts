import { createHmac } from "node:crypto";
import axios from "axios";
import type { BynderClient } from "./client.js";
import { normalizePortalApiUrl } from "./url-policy.js";

export interface WebhookSubscription {
	id: string;
	url: string;
	events: string[];
	active?: boolean;
}

export interface CreateWebhookResponse {
	id: string;
	url: string;
	events: string[];
	active: boolean;
}

const SUBSCRIPTIONS_PATH = "/v7/webhooks/public/api/subscriptions";

interface WebhookRequestContext {
	subscriptionsUrl: string;
	requestConfig: {
		headers: Record<string, string>;
		maxRedirects: number;
	};
}

/**
 * Builds the endpoint and auth headers for Bynder webhook API calls.
 * The permanent token is only attached when the client's baseURL is an
 * approved Bynder portal, and redirects are not followed so the token and
 * request never reach another host.
 *
 * @throws {UnapprovedBynderUrlError} When baseURL is not an approved portal
 */
function getWebhookRequestContext(
	bynderClient: BynderClient
): WebhookRequestContext {
	const apiBaseUrl = normalizePortalApiUrl(bynderClient.config.baseURL);

	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;

	if (!permanentToken) {
		throw new Error("Permanent token is required for webhook operations");
	}

	return {
		subscriptionsUrl: `${apiBaseUrl}${SUBSCRIPTIONS_PATH}`,
		requestConfig: {
			headers: { Authorization: `Bearer ${permanentToken}` },
			maxRedirects: 0,
		},
	};
}

function subscriptionUrl(context: WebhookRequestContext, id: string): string {
	return `${context.subscriptionsUrl}/${encodeURIComponent(id)}`;
}

/**
 * Create a webhook subscription in Bynder
 * POST /api/v7/webhooks/public/api/subscriptions
 */
export async function createWebhookSubscription(
	bynderClient: BynderClient,
	url: string,
	events: string[] = ["asset.tagged", "media.tagged"]
): Promise<CreateWebhookResponse> {
	const context = getWebhookRequestContext(bynderClient);
	const response = await axios.post(
		context.subscriptionsUrl,
		{ url, events },
		{
			...context.requestConfig,
			headers: {
				...context.requestConfig.headers,
				"Content-Type": "application/json",
			},
		}
	);
	return response.data as CreateWebhookResponse;
}

/**
 * Update a webhook subscription in Bynder
 * PUT /api/v7/webhooks/public/api/subscriptions/{id}
 */
export async function updateWebhookSubscription(
	bynderClient: BynderClient,
	id: string,
	url: string,
	events: string[] = ["asset.tagged", "media.tagged"]
): Promise<CreateWebhookResponse> {
	const context = getWebhookRequestContext(bynderClient);
	const response = await axios.put(
		subscriptionUrl(context, id),
		{ url, events },
		{
			...context.requestConfig,
			headers: {
				...context.requestConfig.headers,
				"Content-Type": "application/json",
			},
		}
	);
	return response.data as CreateWebhookResponse;
}

/**
 * Delete a webhook subscription from Bynder
 * DELETE /api/v7/webhooks/public/api/subscriptions/{id}
 */
export async function deleteWebhookSubscription(
	bynderClient: BynderClient,
	id: string
): Promise<void> {
	const context = getWebhookRequestContext(bynderClient);
	await axios.delete(subscriptionUrl(context, id), context.requestConfig);
}

/**
 * Get a webhook subscription from Bynder
 * GET /api/v7/webhooks/public/api/subscriptions/{id}
 */
export async function getWebhookSubscription(
	bynderClient: BynderClient,
	id: string
): Promise<CreateWebhookResponse> {
	const context = getWebhookRequestContext(bynderClient);
	const response = await axios.get(
		subscriptionUrl(context, id),
		context.requestConfig
	);
	return response.data as CreateWebhookResponse;
}

/**
 * Verify webhook signature
 * Supports HMAC-SHA256 algorithm (common for webhooks)
 *
 * @param payload - The raw request body as string
 * @param signature - The signature from the webhook header
 * @param secret - The webhook secret for verification
 * @returns true if signature is valid, false otherwise
 */
export function verifyWebhookSignature(
	payload: string,
	signature: string,
	secret: string
): boolean {
	if (!secret || !signature) {
		return false;
	}

	try {
		// Common signature formats:
		// 1. Direct HMAC: signature = hmac(payload, secret)
		// 2. With prefix: "sha256=..." or "hmac-sha256=..."
		// 3. Base64 encoded

		// Try HMAC-SHA256 (most common)
		const hmac = createHmac("sha256", secret);
		hmac.update(payload);
		const expectedSignature = hmac.digest("hex");

		// Handle different signature formats
		const normalizedSignature = signature
			.replace(/^sha256=/, "")
			.replace(/^hmac-sha256=/, "")
			.toLowerCase()
			.trim();

		const normalizedExpected = expectedSignature.toLowerCase().trim();

		// Constant-time comparison to prevent timing attacks
		if (normalizedSignature.length !== normalizedExpected.length) {
			return false;
		}

		let result = 0;
		for (let i = 0; i < normalizedSignature.length; i++) {
			result |=
				normalizedSignature.charCodeAt(i) ^ normalizedExpected.charCodeAt(i);
		}

		return result === 0;
	} catch (error) {
		console.error("Error verifying webhook signature:", error);
		return false;
	}
}

/**
 * Extract signature from request headers
 * Checks common header names used by webhook providers
 *
 * @param headers - Request headers
 * @returns The signature value or null if not found
 */
export function extractWebhookSignature(
	headers: Headers | Record<string, string | string[] | undefined>
): string | null {
	// Common header names for webhook signatures
	const signatureHeaders = [
		"x-bynder-signature",
		"x-webhook-signature",
		"x-signature",
		"bynder-signature",
		"webhook-signature",
		"signature",
	];

	// Handle Headers object
	if (headers instanceof Headers) {
		for (const headerName of signatureHeaders) {
			const value = headers.get(headerName);
			if (value) {
				return value;
			}
		}
		return null;
	}

	// Handle plain object
	for (const headerName of signatureHeaders) {
		const value = headers[headerName] || headers[headerName.toLowerCase()];
		if (value) {
			if (Array.isArray(value)) {
				return value[0] || null;
			}
			return value as string;
		}
	}

	return null;
}
