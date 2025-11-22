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
		// Provide more detailed error information
		let errorMessage = "Connection test failed";
		let errorDetails = "";

		if (error instanceof Error) {
			errorMessage = error.message;
			errorDetails = error.stack || "";

			// If it's a 404, provide helpful guidance
			if (
				errorMessage.includes("404") ||
				errorMessage.includes("Not Found") ||
				errorMessage.includes("status code 404")
			) {
				// Normalize URL for display
				let normalizedUrl = shopConfig.bynderBaseUrl.trim().replace(/\/$/, "");
				if (!normalizedUrl.endsWith("/api")) {
					normalizedUrl = `${normalizedUrl}/api`;
				}

				errorMessage = `404 Not Found - The Bynder API endpoint was not found.

Troubleshooting steps:
1. Verify your Bynder portal URL is correct: ${shopConfig.bynderBaseUrl}
2. The URL should include /api at the end (e.g., https://portal.getbynder.com/api)
3. Try accessing ${normalizedUrl}/v4/media in your browser to verify the API is accessible
4. Some Bynder instances use different API versions (v6 instead of v4) or custom paths
5. Ensure your BYNDER_PERMANENT_TOKEN has access to the API

Current baseURL: ${normalizedUrl}
Expected API endpoint: ${normalizedUrl}/v4/media`;
			}
		}

		return Response.json(
			{
				connected: false,
				baseURL: shopConfig.bynderBaseUrl,
				error: errorMessage,
				...(errorDetails && { details: errorDetails }),
			},
			{ status: 500 }
		);
	}
};

/**
 * POST handler for test connection (same as GET)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	return loader({ request } as LoaderFunctionArgs);
};
