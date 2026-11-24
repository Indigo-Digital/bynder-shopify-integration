import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { authenticate } from "../shopify.server.js";

/**
 * Test Bynder connection
 * GET /api/bynder/test - Test connection with current shop configuration
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;

	// Get shop configuration
	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	if (!shopConfig || !shopConfig.bynderBaseUrl) {
		return Response.json(
			{
				connected: false,
				error: "Bynder base URL not configured for this shop",
			},
			{ status: 400 }
		);
	}

	try {
		// Create client with permanent token from env
		// createFromEnv will automatically append /api if needed
		const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);

		// Test connection by making a simple API call
		// Try getMediaList first (most common endpoint)
		const testResponse = await bynderClient.getMediaList({
			limit: 1,
			page: 1,
		});

		// If we get a response (even if empty), connection is working
		// Get the normalized baseURL from the client
		const normalizedBaseURL = bynderClient.config.baseURL;
		return Response.json({
			connected: true,
			baseURL: normalizedBaseURL,
			message: "Connection successful",
			testResponse: testResponse ? "Received response" : "No response",
		});
	} catch (error) {
		// Stacks and raw exception messages expose server paths and dependency
		// internals, so they stay in server logs and the client gets a summary.
		console.error(`[Bynder Test] Connection test failed for ${shop}:`, error);

		return Response.json(
			{
				connected: false,
				baseURL: shopConfig.bynderBaseUrl,
				error: describeConnectionFailure(error, shopConfig.bynderBaseUrl),
			},
			{ status: 500 }
		);
	}
};

function getHttpStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const response = (error as { response?: { status?: unknown } }).response;
	return typeof response?.status === "number" ? response.status : undefined;
}

function getNetworkErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && /^E[A-Z_]+$/.test(code) ? code : undefined;
}

function isNotFound(error: unknown): boolean {
	if (getHttpStatus(error) === 404) return true;
	const message = error instanceof Error ? error.message : "";
	return message.includes("status code 404") || message.includes("Not Found");
}

function describeNotFound(bynderBaseUrl: string): string {
	let normalizedUrl = bynderBaseUrl.trim().replace(/\/$/, "");
	if (!normalizedUrl.endsWith("/api")) {
		normalizedUrl = `${normalizedUrl}/api`;
	}

	return `404 Not Found - The Bynder API endpoint was not found.

Troubleshooting steps:
1. Verify your Bynder portal URL is correct: ${bynderBaseUrl}
2. The URL should include /api at the end (e.g., https://portal.getbynder.com/api)
3. Try accessing ${normalizedUrl}/v4/media in your browser to verify the API is accessible
4. Some Bynder instances use different API versions (v6 instead of v4) or custom paths
5. Ensure your BYNDER_PERMANENT_TOKEN has access to the API

Current baseURL: ${normalizedUrl}
Expected API endpoint: ${normalizedUrl}/v4/media`;
}

/**
 * Builds the client-facing failure message from structured error fields only,
 * never from error.message or error.stack.
 */
function describeConnectionFailure(
	error: unknown,
	bynderBaseUrl: string
): string {
	if (isNotFound(error)) return describeNotFound(bynderBaseUrl);

	const status = getHttpStatus(error);
	if (status !== undefined) {
		return `Connection test failed: Bynder responded with HTTP ${status}`;
	}

	const code = getNetworkErrorCode(error);
	if (code !== undefined) {
		return `Connection test failed: could not reach Bynder (${code})`;
	}

	return "Connection test failed";
}

/**
 * POST handler for test connection (same as GET)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	return loader({ request } as LoaderFunctionArgs);
};
