import axios from "axios";
import type { BynderClient } from "./client.js";

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

/**
 * Create a webhook subscription in Bynder
 * POST /api/v7/webhooks/public/api/subscriptions
 */
export async function createWebhookSubscription(
	bynderClient: BynderClient,
	url: string,
	events: string[] = ["asset.tagged", "media.tagged"]
): Promise<CreateWebhookResponse> {
	const baseURL = bynderClient.config.baseURL.endsWith("/api")
		? bynderClient.config.baseURL
		: `${bynderClient.config.baseURL.replace(/\/api$/, "")}/api`;

	const endpoint = `${baseURL}/v7/webhooks/public/api/subscriptions`;

	// Get permanent token for authentication
	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;

	if (!permanentToken) {
		throw new Error("Permanent token is required for webhook operations");
	}

	const response = await axios.post(
		endpoint,
		{
			url,
			events,
		},
		{
			headers: {
				Authorization: `Bearer ${permanentToken}`,
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
	const baseURL = bynderClient.config.baseURL.endsWith("/api")
		? bynderClient.config.baseURL
		: `${bynderClient.config.baseURL.replace(/\/api$/, "")}/api`;

	const endpoint = `${baseURL}/v7/webhooks/public/api/subscriptions/${id}`;

	// Get permanent token for authentication
	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;

	if (!permanentToken) {
		throw new Error("Permanent token is required for webhook operations");
	}

	const response = await axios.put(
		endpoint,
		{
			url,
			events,
		},
		{
			headers: {
				Authorization: `Bearer ${permanentToken}`,
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
	const baseURL = bynderClient.config.baseURL.endsWith("/api")
		? bynderClient.config.baseURL
		: `${bynderClient.config.baseURL.replace(/\/api$/, "")}/api`;

	const endpoint = `${baseURL}/v7/webhooks/public/api/subscriptions/${id}`;

	// Get permanent token for authentication
	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;

	if (!permanentToken) {
		throw new Error("Permanent token is required for webhook operations");
	}

	await axios.delete(endpoint, {
		headers: {
			Authorization: `Bearer ${permanentToken}`,
		},
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
	const baseURL = bynderClient.config.baseURL.endsWith("/api")
		? bynderClient.config.baseURL
		: `${bynderClient.config.baseURL.replace(/\/api$/, "")}/api`;

	const endpoint = `${baseURL}/v7/webhooks/public/api/subscriptions/${id}`;

	// Get permanent token for authentication
	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;

	if (!permanentToken) {
		throw new Error("Permanent token is required for webhook operations");
	}

	const response = await axios.get(endpoint, {
		headers: {
			Authorization: `Bearer ${permanentToken}`,
		},
	});

	return response.data as CreateWebhookResponse;
}
