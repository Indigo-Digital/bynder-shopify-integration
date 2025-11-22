/**
 * Quick script to verify a Shopify access token has the required scopes
 *
 * Usage (Node.js 20+ with --loader or tsx):
 *   SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com" SHOPIFY_ACCESS_TOKEN="your-token" node --loader tsx scripts/verify-shopify-token.ts
 *
 * Or install tsx first: pnpm add -D tsx
 * Then: SHOPIFY_SHOP_DOMAIN="..." SHOPIFY_ACCESS_TOKEN="..." pnpm tsx scripts/verify-shopify-token.ts
 */

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

if (!shopDomain || !accessToken) {
	console.error("❌ Missing required environment variables:");
	console.error("   SHOPIFY_SHOP_DOMAIN");
	console.error("   SHOPIFY_ACCESS_TOKEN");
	process.exit(1);
}

async function verifyToken() {
	console.log(`\n🔍 Verifying Shopify access token for: ${shopDomain}\n`);

	try {
		// Try to query shop info to verify token works
		const shopResponse = await fetch(
			`https://${shopDomain}/admin/api/2026-01/graphql.json`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Shopify-Access-Token": accessToken as string,
				},
				body: JSON.stringify({
					query: `#graphql
            query {
              shop {
                name
                myshopifyDomain
              }
            }
          `,
				}),
			}
		);

		const shopData = await shopResponse.json();

		if (shopData.errors) {
			console.error("❌ Token verification failed:");
			console.error(JSON.stringify(shopData.errors, null, 2));
			process.exit(1);
		}

		console.log("✅ Token is valid!");
		console.log(`   Shop: ${shopData.data?.shop?.name}`);
		console.log(`   Domain: ${shopData.data?.shop?.myshopifyDomain}\n`);

		// Try to test stagedUploadsCreate access
		console.log("🔍 Testing stagedUploadsCreate access...\n");

		const stagedUploadResponse = await fetch(
			`https://${shopDomain}/admin/api/2026-01/graphql.json`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Shopify-Access-Token": accessToken as string,
				},
				body: JSON.stringify({
					query: `#graphql
            mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
              stagedUploadsCreate(input: $input) {
                stagedTargets {
                  resourceUrl
                  url
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `,
					variables: {
						input: [
							{
								resource: "IMAGE",
								filename: "test.png",
								mimeType: "image/png",
							},
						],
					},
				}),
			}
		);

		const stagedUploadData = await stagedUploadResponse.json();

		if (stagedUploadData.errors) {
			console.error("❌ stagedUploadsCreate access DENIED:");
			console.error(JSON.stringify(stagedUploadData.errors, null, 2));
			console.error("\n💡 Solution:");
			console.error("   1. Go to your Shopify admin");
			console.error("   2. Settings → Apps and sales channels");
			console.error("   3. Find your custom app → Configure");
			console.error("   4. Add 'write_files' scope");
			console.error("   5. Reinstall the app");
			console.error("   6. Get a new access token\n");
			process.exit(1);
		}

		if (stagedUploadData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
			console.warn("⚠️  stagedUploadsCreate returned user errors:");
			console.warn(
				JSON.stringify(
					stagedUploadData.data.stagedUploadsCreate.userErrors,
					null,
					2
				)
			);
		} else {
			console.log("✅ stagedUploadsCreate access granted!");
		}

		console.log("\n✅ All required permissions verified!\n");
	} catch (error) {
		console.error("❌ Error verifying token:");
		console.error(error);
		process.exit(1);
	}
}

verifyToken();
