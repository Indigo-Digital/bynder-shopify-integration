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
		const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);

		// Test connection by making a simple API call
		const testResponse = await bynderClient.getMediaList({
			limit: 1,
			page: 1,
		});

		// If we get a response (even if empty), connection is working
		return Response.json({
			connected: true,
			baseURL: shopConfig.bynderBaseUrl,
			message: "Connection successful",
			testResponse: testResponse ? "Received response" : "No response",
		});
	} catch (error) {
		return Response.json(
			{
				connected: false,
				baseURL: shopConfig.bynderBaseUrl,
				error:
					error instanceof Error
						? error.message
						: "Connection test failed",
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

