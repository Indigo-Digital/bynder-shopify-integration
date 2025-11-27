/**
 * Google Gemini Vision API integration for AI-powered alt text generation
 *
 * Uses Google's Gemini 2.0 Flash model to analyze images and generate
 * descriptive, accessibility-focused alt text for images uploaded to Shopify.
 */

import { GoogleGenAI } from "@google/genai";

/**
 * Service account credentials structure
 */
interface ServiceAccountCredentials {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	client_id: string;
	auth_uri: string;
	token_uri: string;
	auth_provider_x509_cert_url: string;
	client_x509_cert_url: string;
	universe_domain?: string;
}

/**
 * Parse service account credentials from environment variable
 */
function getServiceAccountCredentials(): ServiceAccountCredentials | null {
	const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
	if (!credentialsJson) {
		return null;
	}

	try {
		return JSON.parse(credentialsJson) as ServiceAccountCredentials;
	} catch (error) {
		console.error(
			"[Gemini Vision] Failed to parse service account credentials:",
			error
		);
		return null;
	}
}

/**
 * Get the Google Gen AI client instance
 * Uses Vertex AI with service account authentication
 */
function getGeminiClient(): GoogleGenAI | null {
	const credentials = getServiceAccountCredentials();

	// Option 1: API key (simplest)
	const apiKey = process.env.GEMINI_API_KEY;
	if (apiKey) {
		return new GoogleGenAI({ apiKey });
	}

	// Option 2: Vertex AI with service account
	if (credentials) {
		// For service account auth, we need to use Vertex AI
		// The SDK uses Application Default Credentials (ADC) under the hood
		// We need to set GOOGLE_APPLICATION_CREDENTIALS or use the credentials directly
		const project = credentials.project_id;
		const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

		return new GoogleGenAI({
			vertexai: true,
			project,
			location,
			googleAuthOptions: {
				credentials: {
					client_email: credentials.client_email,
					private_key: credentials.private_key,
				},
				projectId: project,
			},
		});
	}

	return null;
}

/**
 * Check if AI alt text generation is available (credentials configured)
 */
export function isAiAltTextAvailable(): boolean {
	return !!(
		process.env.GEMINI_API_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
	);
}

/**
 * Generate alt text for an image using Google Gemini Vision
 *
 * @param imageBuffer - The image data as a Buffer
 * @param mimeType - The MIME type of the image (e.g., "image/jpeg", "image/png")
 * @param filename - Optional filename for context
 * @returns Generated alt text or null if generation fails
 */
export async function generateAltText(
	imageBuffer: Buffer,
	mimeType: string,
	filename?: string
): Promise<string | null> {
	const client = getGeminiClient();

	if (!client) {
		console.warn(
			"[Gemini Vision] No credentials configured for AI alt text generation"
		);
		return null;
	}

	// Only process image types
	if (!mimeType.startsWith("image/")) {
		console.log(
			`[Gemini Vision] Skipping non-image file: ${mimeType} (${filename || "unknown"})`
		);
		return null;
	}

	// Skip SVG files (text-based, not suitable for vision analysis)
	if (mimeType === "image/svg+xml") {
		console.log(
			`[Gemini Vision] Skipping SVG file (not suitable for vision analysis): ${filename || "unknown"}`
		);
		return null;
	}

	try {
		// Convert buffer to base64
		const base64Image = imageBuffer.toString("base64");

		// Create the image part for multimodal input
		const imagePart = {
			inlineData: {
				data: base64Image,
				mimeType: mimeType,
			},
		};

		// Craft a prompt specifically for e-commerce/marketing alt text
		const prompt = `Analyze this image and generate a concise, descriptive alt text suitable for accessibility and SEO purposes on an e-commerce website.

Requirements for the alt text:
1. Be descriptive but concise (ideally 10-20 words, max 125 characters)
2. Focus on what's visually important in the image
3. If it's a product image, describe the product clearly
4. Avoid starting with "Image of" or "Picture of"
5. Include relevant details like colors, actions, or key features
6. Make it useful for screen reader users

Respond with ONLY the alt text, no explanations or formatting.`;

		// Use Gemini 2.0 Flash for fast, efficient image analysis
		const response = await client.models.generateContent({
			model: "gemini-2.0-flash",
			contents: [imagePart, prompt],
		});

		const altText = response.text?.trim();

		if (!altText) {
			console.warn(
				`[Gemini Vision] Empty response for image: ${filename || "unknown"}`
			);
			return null;
		}

		// Truncate if too long (Shopify alt text limit is ~512 chars, but we aim for shorter)
		const maxLength = 125;
		const finalAltText =
			altText.length > maxLength
				? `${altText.substring(0, maxLength - 3)}...`
				: altText;

		console.log(
			`[Gemini Vision] Generated alt text for ${filename || "image"}: "${finalAltText}"`
		);

		return finalAltText;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(
			`[Gemini Vision] Failed to generate alt text for ${filename || "image"}:`,
			errorMessage
		);

		// Don't throw - return null so the upload can continue without AI alt text
		return null;
	}
}

/**
 * Test the Gemini Vision connection
 * Useful for settings page to verify credentials are valid
 */
export async function testGeminiConnection(): Promise<{
	success: boolean;
	error?: string;
	model?: string;
}> {
	const client = getGeminiClient();

	if (!client) {
		return {
			success: false,
			error:
				"No credentials configured. Set GEMINI_API_KEY or GOOGLE_SERVICE_ACCOUNT_JSON environment variable.",
		};
	}

	try {
		// Simple test: generate content with a text-only prompt
		const response = await client.models.generateContent({
			model: "gemini-2.0-flash",
			contents: ["Say 'Hello' in one word."],
		});

		const text = response.text?.trim();
		if (text) {
			return {
				success: true,
				model: "gemini-2.0-flash",
			};
		}

		return {
			success: false,
			error: "Empty response from model",
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: errorMessage,
		};
	}
}
