/**
 * Integration test for file upload functionality
 *
 * This test requires:
 * - SHOPIFY_SHOP_DOMAIN environment variable (e.g., "your-shop.myshopify.com")
 * - SHOPIFY_ACCESS_TOKEN environment variable (OAuth access token, not client secret)
 *
 * To get an access token:
 * 1. Create a custom app in Shopify Admin (Settings → Apps → Develop apps)
 * 2. Configure Admin API scopes (read_files, write_files, read_metaobjects, write_metaobjects)
 * 3. Install the app and reveal the access token
 * 4. Or run: pnpm tsx scripts/get-shopify-token.ts for detailed instructions
 *
 * Run with: pnpm test files.integration.test.ts
 *
 * Note: This test makes real API calls to Shopify and will create actual files.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import { uploadBynderAsset } from "./files.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create a Shopify AdminApi client from credentials
 *
 * Note: This requires SHOPIFY_ACCESS_TOKEN environment variable
 * The access token is obtained through OAuth flow, not the client secret
 */
function createShopifyAdminApi(
	shopDomain: string,
	accessToken: string
): AdminApi {
	const baseUrl = `https://${shopDomain}/admin/api/2026-01/graphql.json`;

	return {
		graphql: async (
			query: string,
			options?: { variables?: Record<string, unknown> }
		) => {
			const response = await fetch(baseUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Shopify-Access-Token": accessToken,
				},
				body: JSON.stringify({
					query,
					variables: options?.variables,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Shopify API error: ${response.status} ${response.statusText} - ${errorText}`
				);
			}

			return response;
		},
		rest: {
			resources: {},
		},
	};
}

/**
 * Create a mock Bynder client that serves a local test image
 * Uses a simple HTTP server approach to serve the image
 */
function createMockBynderClient(_testImagePath: string): BynderClient {
	// Image buffer is read in beforeAll, not needed here

	// Create a simple server URL that will serve the image
	// In a real test, you might use a test HTTP server, but for simplicity
	// we'll intercept the fetch call in beforeAll
	let downloadUrl: string;

	return {
		getMediaInfo: async () => {
			return {
				id: "test-asset-integration",
				name: "test-image.png",
				type: "image",
				tags: ["integration-test", "shopify-sync"],
				dateModified: new Date().toISOString(),
				dateCreated: new Date().toISOString(),
				version: 1,
				derivatives: {},
				thumbnails: {},
				description: "Integration test image",
				files: [
					{
						type: "original",
						url: downloadUrl || "http://localhost:9999/test-image.png",
					},
				],
			};
		},
		getMediaDownloadUrl: async () => {
			// Return a special URL that our fetch mock will intercept
			downloadUrl = "http://mock-bynder-download/test-image.png";
			return downloadUrl;
		},
		config: {
			baseURL: "https://test.bynder.com/api",
			permanentToken: "test-permanent-token",
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
		},
	} as unknown as BynderClient;
}

describe("uploadBynderAsset - Integration Test", () => {
	const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
	const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

	// Skip if shop domain or access token is not provided
	const shouldSkip = !shopDomain || !accessToken;

	let testImageBuffer: Buffer;

	beforeAll(() => {
		// Path from app/lib/shopify/ to tests/fixtures/ at root
		const testImagePath = join(
			__dirname,
			"../../../tests/fixtures/test-image.png"
		);
		testImageBuffer = readFileSync(testImagePath);

		// Mock fetch to handle Bynder download URLs
		const originalFetch = global.fetch;
		global.fetch = async (
			input: RequestInfo | URL,
			init?: RequestInit
		): Promise<Response> => {
			let url: string;
			if (typeof input === "string") {
				url = input;
			} else if (input instanceof URL) {
				url = input.href;
			} else {
				// Request object
				url = input.url;
			}

			// Handle mock Bynder download URLs
			if (
				url.includes("mock-bynder-download") ||
				url.includes("test-image.png")
			) {
				return new Response(new Uint8Array(testImageBuffer), {
					status: 200,
					headers: {
						"Content-Type": "image/png",
					},
				});
			}

			// For all other requests (Shopify API), use original fetch
			return originalFetch(input, init);
		};
	});

	const testFn = shouldSkip ? it.skip : it;
	testFn(
		"should upload a real image file to Shopify",
		async () => {
			const testImagePath = join(
				__dirname,
				"../../../tests/fixtures/test-image.png"
			);

			// Verify test image exists
			try {
				readFileSync(testImagePath);
			} catch (_error) {
				throw new Error(
					`Test image not found at ${testImagePath}. Please ensure the test image exists.`
				);
			}

			if (!shopDomain || !accessToken) {
				throw new Error("Shop domain and access token are required");
			}

			const admin = createShopifyAdminApi(shopDomain, accessToken);
			const bynderClient = createMockBynderClient(testImagePath);

			const assetId = "test-asset-integration";
			const shopId = "test-shop-id";

			// Upload the asset
			const result = await uploadBynderAsset(
				admin,
				bynderClient,
				assetId,
				shopId,
				"manual"
			);

			// Verify the result
			expect(result).toBeDefined();
			expect(result.fileId).toBeDefined();
			// Shopify returns MediaImage for images, GenericFile for other files
			expect(result.fileId).toMatch(
				/^gid:\/\/shopify\/(File|MediaImage)\/\d+$/
			);

			console.log(`✅ Successfully uploaded file to Shopify:`);
			console.log(`   File ID: ${result.fileId}`);
			console.log(
				`   File URL: ${result.fileUrl || "(may be empty if file is still processing)"}`
			);

			// File URL may be empty if the file is still being processed by Shopify
			// The important thing is that the file was created successfully
			if (result.fileUrl) {
				expect(result.fileUrl.length).toBeGreaterThan(0);
			}

			// Verify the file exists in Shopify by querying it
			const fileQueryResponse = await admin.graphql(
				`#graphql
        query getFile($id: ID!) {
          node(id: $id) {
            ... on File {
              id
              fileStatus
              ... on MediaImage {
                image {
                  url
                }
              }
              ... on GenericFile {
                url
              }
            }
          }
        }
      `,
				{
					variables: {
						id: result.fileId,
					},
				}
			);

			const fileQueryData = await fileQueryResponse.json();

			expect(fileQueryData.data?.node).toBeDefined();
			expect(fileQueryData.data?.node?.id).toBe(result.fileId);

			console.log(`✅ Verified file exists in Shopify`);
		},
		30000 // timeout in ms
	);
});
