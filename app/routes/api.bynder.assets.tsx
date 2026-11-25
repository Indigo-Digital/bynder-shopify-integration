import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { MAX_BYNDER_PAGE_LIMIT } from "../lib/bynder/limits.js";
import { InvalidBynderPortalUrlError } from "../lib/bynder/portal-url.js";
import type { BynderAsset } from "../lib/bynder/types.js";
import { authenticate } from "../shopify.server.js";

const DEFAULT_PAGE_LIMIT = 24;

interface AssetsResponse {
	assets: BynderAsset[];
	total: number;
	page: number;
	limit: number;
	hasMore: boolean;
}

/**
 * Parses a positive decimal integer query value, returning the fallback when
 * the parameter is absent and null when it is malformed or above max.
 */
function parsePositiveIntParam(
	rawValue: string | null,
	fallback: number,
	max: number = Number.MAX_SAFE_INTEGER
): number | null {
	if (rawValue === null) {
		return fallback;
	}
	if (!/^\d+$/.test(rawValue)) {
		return null;
	}
	const value = Number(rawValue);
	return value >= 1 && value <= max ? value : null;
}

/**
 * GET /api/bynder/assets - Fetch assets from Bynder with search/filter support
 * Query parameters:
 * - keyword: Search keyword
 * - tags: Comma-separated tags to filter by
 * - type: Asset type filter (image, video, document, etc.)
 * - page: Page number (default: 1)
 * - limit: Results per page (default: 24, max: 50)
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

	const url = new URL(request.url);
	const page = parsePositiveIntParam(url.searchParams.get("page"), 1);
	const limit = parsePositiveIntParam(
		url.searchParams.get("limit"),
		DEFAULT_PAGE_LIMIT,
		MAX_BYNDER_PAGE_LIMIT
	);
	if (page === null || limit === null) {
		return Response.json(
			{
				error: `page must be a positive integer and limit an integer from 1 to ${MAX_BYNDER_PAGE_LIMIT}`,
			},
			{ status: 400 }
		);
	}

	try {
		const keyword = url.searchParams.get("keyword") || undefined;
		const tagsParam = url.searchParams.get("tags");
		const tags = tagsParam
			? tagsParam
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;
		const type = url.searchParams.get("type") || undefined;

		// Create Bynder client
		const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);

		// Build query parameters
		const queryParams: Parameters<typeof bynderClient.getMediaList>[0] = {
			page,
			limit,
			...(keyword && { keyword }),
			...(tags &&
				tags.length > 0 && {
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
		if (error instanceof InvalidBynderPortalUrlError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
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
