import { createHmac } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const API_KEY = process.env.SHOPIFY_API_KEY ?? "test-api-key";
const API_SECRET = process.env.SHOPIFY_API_SECRET ?? "test-api-secret";

/**
 * HMAC-SHA256 of the raw body, base64, matching
 * `@shopify/shopify-api` 12.1.2 `validateHmacString` (HashFormat.Base64).
 */
export function signWebhookBody(rawBody: string): string {
	return createHmac("sha256", API_SECRET).update(rawBody).digest("base64");
}

/**
 * HS256 session token whose `aud` is the app key and whose `dest` host is the
 * shop. `@shopify/shopify-api` 12.1.2 `decodeSessionToken` verifies that pair.
 */
export function signAdminSessionToken(shop: string): string {
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const now = Math.floor(Date.now() / 1000);
	const payload = base64Url(
		JSON.stringify({
			aud: API_KEY,
			dest: `https://${shop}`,
			sub: "1",
			iat: now,
			nbf: now,
			exp: now + 120,
		})
	);
	const data = `${header}.${payload}`;
	const signature = createHmac("sha256", API_SECRET)
		.update(data)
		.digest("base64url");
	return `${data}.${signature}`;
}

export function shopifyWebhookRequest(input: {
	url: string;
	shop: string;
	topic: string;
	body: string;
	hmac?: string;
}): Request {
	return new Request(input.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "Shopify-Captain-Hook",
			"X-Shopify-Hmac-Sha256": input.hmac ?? signWebhookBody(input.body),
			"X-Shopify-API-Version": "2025-10",
			"X-Shopify-Shop-Domain": input.shop,
			"X-Shopify-Topic": input.topic,
			"X-Shopify-Webhook-Id": "webhook-delivery-previous-install",
		},
		body: input.body,
	});
}

export function adminRequest(url: string, shop: string): Request {
	return new Request(url, {
		headers: {
			Authorization: `Bearer ${signAdminSessionToken(shop)}`,
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	});
}

export function asAction(request: Request): ActionFunctionArgs {
	return { request } as ActionFunctionArgs;
}

export function asLoader(request: Request): LoaderFunctionArgs {
	return { request } as LoaderFunctionArgs;
}

function base64Url(value: string): string {
	return Buffer.from(value).toString("base64url");
}
