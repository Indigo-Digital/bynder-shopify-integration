import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { env } from "../lib/env.server.js";
import { authenticate } from "../shopify.server.js";

/**
 * Initiate Bynder OAuth flow
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;
	const url = new URL(request.url);
	const code = url.searchParams.get("code");

	if (code) {
		// Handle OAuth callback
		return handleOAuthCallback(request, shop, code);
	}

	// Start OAuth flow
	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	if (!shopConfig || !shopConfig.bynderBaseUrl) {
		return Response.json(
			{ error: "Bynder base URL not configured" },
			{ status: 400 }
		);
	}

	if (!env.BYNDER_CLIENT_ID || !env.BYNDER_CLIENT_SECRET) {
		return Response.json(
			{ error: "Bynder client credentials not configured" },
			{ status: 500 }
		);
	}

	const bynderClient = BynderClient.createOAuthClient({
		baseURL: shopConfig.bynderBaseUrl,
		clientId: env.BYNDER_CLIENT_ID,
		clientSecret: env.BYNDER_CLIENT_SECRET,
		redirectUri: `${env.SHOPIFY_APP_URL}/api/bynder/auth`,
	});

	const authUrl = bynderClient.makeAuthorizationURL();
	return redirect(authUrl);
};

async function handleOAuthCallback(
	_request: Request,
	shop: string,
	code: string
) {
	try {
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return Response.json({ error: "Shop not configured" }, { status: 400 });
		}

		if (!env.BYNDER_CLIENT_ID || !env.BYNDER_CLIENT_SECRET) {
			return Response.json(
				{ error: "Bynder client credentials not configured" },
				{ status: 500 }
			);
		}

		const bynderClient = BynderClient.createOAuthClient({
			baseURL: shopConfig.bynderBaseUrl,
			clientId: env.BYNDER_CLIENT_ID,
			clientSecret: env.BYNDER_CLIENT_SECRET,
			redirectUri: `${env.SHOPIFY_APP_URL}/api/bynder/auth`,
		});

		const tokens = await bynderClient.getToken(code);

		// Update shop with tokens
		await prisma.shop.upsert({
			where: { shop },
			create: {
				shop,
				bynderBaseUrl: shopConfig.bynderBaseUrl,
				bynderAccessToken: tokens.accessToken,
				bynderRefreshToken: tokens.refreshToken || null,
				bynderTokenExpires: tokens.expiresAt || null,
			},
			update: {
				bynderAccessToken: tokens.accessToken,
				bynderRefreshToken: tokens.refreshToken || null,
				bynderTokenExpires: tokens.expiresAt || null,
			},
		});

		return redirect("/app/settings?bynder_connected=true");
	} catch (error) {
		console.error("Bynder OAuth error:", error);
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Authentication failed",
			},
			{ status: 500 }
		);
	}
}

/**
 * Disconnect Bynder
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	const { session } = await authenticate.admin(request);
	const shop = session.shop;

	await prisma.shop.update({
		where: { shop },
		data: {
			bynderAccessToken: null,
			bynderRefreshToken: null,
			bynderTokenExpires: null,
		},
	});

	return Response.json({ success: true });
};
