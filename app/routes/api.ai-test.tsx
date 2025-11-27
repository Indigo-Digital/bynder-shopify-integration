/**
 * API endpoint to test the Google Gemini Vision connection
 * Used by the settings page to verify AI alt text credentials
 */
import type { LoaderFunctionArgs } from "react-router";
import {
	isAiAltTextAvailable,
	testGeminiConnection,
} from "../lib/ai/gemini-vision.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	// Require authentication
	await authenticate.admin(request);

	// Check if credentials are configured
	if (!isAiAltTextAvailable()) {
		return Response.json({
			success: false,
			available: false,
			error:
				"AI alt text is not configured. Set GEMINI_API_KEY or GOOGLE_SERVICE_ACCOUNT_JSON environment variable.",
		});
	}

	// Test the connection
	const result = await testGeminiConnection();

	return Response.json({
		...result,
		available: true,
	});
};

