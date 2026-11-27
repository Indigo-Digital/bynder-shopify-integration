import { createHmac } from "node:crypto";
import axios from "axios";
import type { BynderClient } from "./client.js";
import { parseHttpsPortalUrl } from "./portal-url.js";

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

/**
 * The portal address is chosen by shop staff and every shop shares this
 * process, so each call has a hard deadline and a response size cap.
 * axios' `timeout` stops applying once response headers arrive, so the
 * per-request abort signal is what bounds a slowly dribbled body.
 */
export const PORTAL_REQUEST_TIMEOUT_MS = 3_000;
export const PORTAL_MAX_RESPONSE_BYTES = 64 * 1024;

const portalHttp = axios.create({
	timeout: PORTAL_REQUEST_TIMEOUT_MS,
	maxContentLength: PORTAL_MAX_RESPONSE_BYTES,
	maxRedirects: 0,
});

interface PortalRequest {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	data?: { url: string; events: string[] };
}

function resolvePortalEndpoint(bynderClient: BynderClient, path: string): URL {
	const configuredBaseURL = bynderClient.config.baseURL;
	const apiBaseURL = configuredBaseURL.endsWith("/api")
		? configuredBaseURL
		: `${configuredBaseURL.replace(/\/api$/, "")}/api`;
	return parseHttpsPortalUrl(`${apiBaseURL}${path}`);
}

function getPermanentToken(bynderClient: BynderClient): string {
	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;
	if (!permanentToken) {
		throw new Error("Permanent token is required for webhook operations");
	}
	return permanentToken;
}

async function sendPortalRequest<T>(
	bynderClient: BynderClient,
	request: PortalRequest
): Promise<T> {
	const endpoint = resolvePortalEndpoint(bynderClient, request.path);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${getPermanentToken(bynderClient)}`,
	};
	if (request.data) {
		headers["Content-Type"] = "application/json";
	}

	const response = await portalHttp.request<T>({
		url: endpoint.href,
		method: request.method,
		data: request.data,
		headers,
		signal: AbortSignal.timeout(PORTAL_REQUEST_TIMEOUT_MS),
	});
	return response.data;
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
	return sendPortalRequest<CreateWebhookResponse>(bynderClient, {
		method: "POST",
		path: SUBSCRIPTIONS_PATH,
		data: { url, events },
	});
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
	return sendPortalRequest<CreateWebhookResponse>(bynderClient, {
		method: "PUT",
		path: `${SUBSCRIPTIONS_PATH}/${id}`,
		data: { url, events },
	});
}

/**
 * Delete a webhook subscription from Bynder
 * DELETE /api/v7/webhooks/public/api/subscriptions/{id}
 */
export async function deleteWebhookSubscription(
	bynderClient: BynderClient,
	id: string
): Promise<void> {
	await sendPortalRequest<unknown>(bynderClient, {
		method: "DELETE",
		path: `${SUBSCRIPTIONS_PATH}/${id}`,
	});
}

/**
 * Get a webhook subscription from Bynder
 * GET /api/v7/webhooks/public/api/subscriptions/{id}
 */
export async function getWebhookSubscription(
	bynderClient: BynderClient,
	id: string
): Promise<CreateWebhookResponse> {
	return sendPortalRequest<CreateWebhookResponse>(bynderClient, {
		method: "GET",
		path: `${SUBSCRIPTIONS_PATH}/${id}`,
	});
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
