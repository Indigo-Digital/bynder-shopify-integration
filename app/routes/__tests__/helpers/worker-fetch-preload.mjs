/**
 * Replaces global fetch before the Shopify web-api adapter captures it.
 * GraphQL calls aimed at a myshopify.com admin API are answered locally.
 * Every other URL, including the Bynder stand-in, uses the original fetch.
 */
import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const uploadLog = process.env.UPLOAD_LOG;
const standInOrigin = process.env.BYNDER_STANDIN_ORIGIN ?? "";

function appendUpload(entry) {
	if (!uploadLog) {
		return;
	}
	appendFileSync(uploadLog, `${JSON.stringify(entry)}\n`);
}

function graphqlData(query) {
	if (query.includes("stagedUploadsCreate")) {
		return {
			stagedUploadsCreate: {
				stagedTargets: [
					{
						resourceUrl: `${standInOrigin}/files/previous-campaign.pdf`,
						url: `${standInOrigin}/staged-upload`,
						parameters: [
							{ name: "key", value: "previous-campaign.pdf" },
							{ name: "policy", value: "placeholder-policy" },
							{ name: "x-amz-credential", value: "placeholder" },
							{ name: "x-amz-algorithm", value: "AWS4-HMAC-SHA256" },
							{ name: "x-amz-signature", value: "placeholder-signature" },
						],
					},
				],
				userErrors: [],
			},
		};
	}
	if (query.includes("fileCreate")) {
		return {
			fileCreate: {
				files: [
					{
						id: "gid://shopify/MediaImage/reinstalled",
						fileStatus: "READY",
						url: `${standInOrigin}/files/previous-campaign.pdf`,
					},
				],
				userErrors: [],
			},
		};
	}
	if (query.includes("metafieldsSet")) {
		return {
			metafieldsSet: {
				metafields: [
					{
						id: "gid://shopify/Metafield/1",
						namespace: "$app:bynder",
						key: "asset_id",
					},
				],
				userErrors: [],
			},
		};
	}
	return {
		files: {
			edges: [],
			pageInfo: {
				hasNextPage: false,
				hasPreviousPage: false,
				startCursor: null,
				endCursor: null,
			},
		},
	};
}

globalThis.fetch = async (input, init) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	const isShopifyGraphql =
		url.includes("myshopify.com") && url.includes("graphql");
	if (!isShopifyGraphql) {
		return originalFetch(input, init);
	}
	const body = typeof init?.body === "string" ? init.body : "";
	let query = "";
	try {
		query = JSON.parse(body).query ?? "";
	} catch {
		query = body;
	}
	const host = new URL(url).host;
	if (query.includes("fileCreate")) {
		appendUpload({ kind: "fileCreate", host });
	}
	if (query.includes("stagedUploadsCreate")) {
		appendUpload({ kind: "stagedUploadsCreate", host });
	}
	return new Response(JSON.stringify({ data: graphqlData(query) }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
