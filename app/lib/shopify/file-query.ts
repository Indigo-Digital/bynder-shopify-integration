import type { AdminApi } from "../types.js";
import type { BynderMetafields } from "./metafields.js";

export interface ShopifyFileDetails {
	id: string;
	fileUrl: string | null;
	thumbnailUrl: string | null;
	fileStatus: string;
	fileType: "MediaImage" | "GenericFile";
	altText: string | null;
	width: number | null;
	height: number | null;
	bynderMetadata: BynderMetafields | null;
}

/**
 * Fetch Shopify file details including URLs and metafields
 * Supports batch queries for multiple files
 */
export async function getShopifyFileDetails(
	admin: AdminApi,
	fileIds: string[]
): Promise<Map<string, ShopifyFileDetails>> {
	if (fileIds.length === 0) {
		return new Map();
	}

	// Shopify's nodes query supports up to 250 IDs per request
	// We'll batch them if needed
	const BATCH_SIZE = 250;
	const results = new Map<string, ShopifyFileDetails>();

	for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
		const batch = fileIds.slice(i, i + BATCH_SIZE);

		const response = await admin.graphql(
			`#graphql
        query getFiles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on MediaImage {
              id
              image {
                url
                altText
                width
                height
              }
              fileStatus
              metafields(namespace: "$app:bynder", first: 10) {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
            ... on GenericFile {
              id
              url
              fileStatus
              metafields(namespace: "$app:bynder", first: 10) {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      `,
			{
				variables: {
					ids: batch,
				},
			}
		);

		const data = await response.json();

		if (data.errors) {
			console.error("GraphQL errors fetching files:", data.errors);
			// Continue with partial results rather than failing completely
		}

		const nodes = data.data?.nodes || [];

		for (const node of nodes) {
			if (!node || !node.id) {
				continue;
			}

			const fileId = node.id;

			// Extract metafields
			let bynderMetadata: BynderMetafields | null = null;
			if (node.metafields?.edges) {
				const metafieldMap: Record<string, string> = {};
				for (const edge of node.metafields.edges) {
					if (edge.node?.key && edge.node?.value) {
						metafieldMap[edge.node.key] = edge.node.value;
					}
				}

				if (Object.keys(metafieldMap).length > 0) {
					bynderMetadata = {
						assetId: metafieldMap.asset_id || "",
						permalink: metafieldMap.permalink || "",
						tags: metafieldMap.tags
							? JSON.parse(metafieldMap.tags)
							: [],
						version: parseInt(metafieldMap.version || "0", 10),
						syncedAt:
							metafieldMap.synced_at || new Date().toISOString(),
					};
				}
			}

			// Determine file type and extract URLs
			let fileUrl: string | null = null;
			let thumbnailUrl: string | null = null;
			let fileType: "MediaImage" | "GenericFile" = "GenericFile";
			let altText: string | null = null;
			let width: number | null = null;
			let height: number | null = null;

			if (node.image) {
				// MediaImage
				fileType = "MediaImage";
				fileUrl = node.image.url || null;
				thumbnailUrl = node.image.url || null; // Use same URL for thumbnail
				altText = node.image.altText || null;
				width = node.image.width || null;
				height = node.image.height || null;
			} else if (node.url) {
				// GenericFile
				fileType = "GenericFile";
				fileUrl = node.url || null;
				thumbnailUrl = null; // Generic files don't have thumbnails
			}

			results.set(fileId, {
				id: fileId,
				fileUrl,
				thumbnailUrl,
				fileStatus: node.fileStatus || "READY",
				fileType,
				altText,
				width,
				height,
				bynderMetadata,
			});
		}
	}

	return results;
}

/**
 * Fetch a single Shopify file's details
 */
export async function getShopifyFileDetail(
	admin: AdminApi,
	fileId: string
): Promise<ShopifyFileDetails | null> {
	const results = await getShopifyFileDetails(admin, [fileId]);
	return results.get(fileId) || null;
}

