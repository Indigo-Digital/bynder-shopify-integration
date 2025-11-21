/**
 * Environment variable validation
 * Validates required environment variables at startup
 */

const requiredEnvVars = [
	"SHOPIFY_API_KEY",
	"SHOPIFY_API_SECRET",
	"SHOPIFY_APP_URL",
] as const;

interface EnvConfig {
	SHOPIFY_API_KEY: string;
	SHOPIFY_API_SECRET: string;
	SHOPIFY_APP_URL: string;
	BYNDER_CLIENT_ID?: string | undefined;
	BYNDER_CLIENT_SECRET?: string | undefined;
	SCOPES?: string | undefined;
	SHOP_CUSTOM_DOMAIN?: string | undefined;
}

/**
 * Validate required environment variables
 * Throws error if any required vars are missing
 */
export function validateEnv(): EnvConfig {
	const missing: string[] = [];

	for (const envVar of requiredEnvVars) {
		if (!process.env[envVar]) {
			missing.push(envVar);
		}
	}

	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}`
		);
	}

	const shopifyApiKey = process.env.SHOPIFY_API_KEY;
	const shopifyApiSecret = process.env.SHOPIFY_API_SECRET;
	const shopifyAppUrl = process.env.SHOPIFY_APP_URL;

	if (!shopifyApiKey || !shopifyApiSecret || !shopifyAppUrl) {
		throw new Error("Required environment variables are missing");
	}

	return {
		SHOPIFY_API_KEY: shopifyApiKey,
		SHOPIFY_API_SECRET: shopifyApiSecret,
		SHOPIFY_APP_URL: shopifyAppUrl,
		BYNDER_CLIENT_ID: process.env.BYNDER_CLIENT_ID ?? undefined,
		BYNDER_CLIENT_SECRET: process.env.BYNDER_CLIENT_SECRET ?? undefined,
		SCOPES: process.env.SCOPES ?? undefined,
		SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN ?? undefined,
	};
}

/**
 * Get validated environment configuration
 * Call this at app startup
 */
export const env = validateEnv();
