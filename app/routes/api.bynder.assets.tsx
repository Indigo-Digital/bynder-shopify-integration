import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import type { BynderAsset } from "../lib/bynder/types.js";
import { authenticate } from "../shopify.server.js";

interface AssetsResponse {
	assets: BynderAsset[];
	total: number;
	page: number;
	limit: number;
	hasMore: boolean;
}

/**
 * GET /api/bynder/assets - Fetch assets from Bynder with search/filter support
 * Query parameters:
 * - keyword: Search keyword
 * - tags: Comma-separated tags to filter by
 * - type: Asset type filter (image, video, document, etc.)
 * - page: Page number (default: 1)
 * - limit: Results per page (default: 24)
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
				error: "Bynder base URL not configured for this shop",
			},
			{ status: 400 }
		);
	}

	try {
		// Parse query parameters
		const url = new URL(request.url);
		const keyword = url.searchParams.get("keyword") || undefined;
		const tagsParam = url.searchParams.get("tags");
		const tags = tagsParam
			? tagsParam
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;
		const type = url.searchParams.get("type") || undefined;
		const page = parseInt(url.searchParams.get("page") || "1", 10);
		const limit = parseInt(url.searchParams.get("limit") || "24", 10);

		// Create Bynder client
		const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);

		// Build query parameters
		const queryParams: Parameters<
			typeof bynderClient.getMediaList
		>[0] = {
			page,
			limit,
			...(keyword && { keyword }),
			...(tags && tags.length > 0 && {
				tags: tags.length === 1 ? tags[0] : tags,
			}),
			...(type && { type }),
		};

		// Fetch assets from Bynder
		const response = await bynderClient.getMediaList(queryParams);

		// Parse response - Bynder SDK may return different formats
		let assets: BynderAsset[] = [];
		let total = 0;
		let count = 0;

		if (response && typeof response === "object") {
			// Check if response has media array (BynderMediaListResponse format)
			if (
				"media" in response &&
				Array.isArray((response as { media: unknown[] }).media)
			) {
				const mediaResponse = response as {
					media: unknown[];
					total?: number;
					count?: number;
					page?: number;
					limit?: number;
				};
				assets = mediaResponse.media as BynderAsset[];
				total = mediaResponse.total || assets.length;
				count = mediaResponse.count || assets.length;
			} else if (Array.isArray(response)) {
				// Response is directly an array
				assets = response as BynderAsset[];
				total = assets.length;
				count = assets.length;
			}
		}

		// Calculate if there are more pages
		const hasMore = count === limit && assets.length === limit;

		const result: AssetsResponse = {
			assets,
			total,
			page,
			limit,
			hasMore,
		};

		return Response.json(result);
	} catch (error) {
		console.error("Error fetching Bynder assets:", error);
		let errorMessage = "Failed to fetch assets from Bynder";
		if (error instanceof Error) {
			errorMessage = error.message;
		}

		return Response.json(
			{
				error: errorMessage,
			},
			{ status: 500 }
		);
	}
};
