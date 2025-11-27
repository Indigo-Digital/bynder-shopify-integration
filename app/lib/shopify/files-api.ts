import type { AdminApi } from "../types.js";
import type { BynderMetafields } from "./metafields.js";

/**
 * Represents a file from Shopify Files API
 */
export interface ShopifyFile {
	id: string;
	alt: string | null;
	createdAt: string;
	updatedAt: string;
	fileStatus: "READY" | "PROCESSING" | "FAILED" | "UPLOADED";
	fileType: "MediaImage" | "GenericFile";
	filename: string | null;
	mimeType: string | null;
	fileSize: number | null;
	fileUrl: string | null;
	thumbnailUrl: string | null;
	width: number | null;
	height: number | null;
	bynderMetadata: BynderMetafields | null;
}

/**
 * Pagination info for files query
 */
export interface FilesPageInfo {
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	startCursor: string | null;
	endCursor: string | null;
}

/**
 * Result of files query
 */
export interface FilesQueryResult {
	files: ShopifyFile[];
	pageInfo: FilesPageInfo;
	totalCount: number;
}

/**
 * Options for querying files
 */
export interface FilesQueryOptions {
	first?: number;
	after?: string;
	search?: string;
	status?: "ready" | "processing" | "failed" | "all";
	sortKey?: "CREATED_AT" | "UPDATED_AT" | "FILENAME" | "ID";
	reverse?: boolean;
}

/**
 * GraphQL query for fetching files with metafields
 */
const FILES_QUERY = `#graphql
query getFiles($first: Int!, $after: String, $query: String, $sortKey: FileSortKeys, $reverse: Boolean) {
  files(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    edges {
      cursor
      node {
        ... on MediaImage {
          id
          alt
          createdAt
          updatedAt
          fileStatus
          mimeType
          image {
            url
            altText
            width
            height
          }
          originalSource {
            fileSize
          }
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
          alt
          createdAt
          updatedAt
          fileStatus
          mimeType
          url
          originalFileSize
        }
      }
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
  }
}
`;

/**
 * Build query string for Shopify Files API
 */
function buildQueryString(options: FilesQueryOptions): string {
	const parts: string[] = [];

	// Add search term if provided
	if (options.search) {
		parts.push(options.search);
	}

	// Add status filter
	if (options.status && options.status !== "all") {
		parts.push(`status:${options.status}`);
	}

	// Filter to only show files (not product images)
	// Product images have a different context
	parts.push("media_type:IMAGE OR media_type:FILE");

	return parts.join(" AND ");
}

/**
 * Parse file node from GraphQL response
 */
function parseFileNode(node: Record<string, unknown>): ShopifyFile | null {
	if (!node || !node.id) {
		return null;
	}

	const id = node.id as string;
	const isMediaImage = "image" in node;

	// Extract metafields (only available on MediaImage)
	let bynderMetadata: BynderMetafields | null = null;
	if (isMediaImage && node.metafields) {
		const metafieldsData = node.metafields as {
			edges: Array<{ node: { key: string; value: string } }>;
		};
		const metafieldMap: Record<string, string> = {};

		for (const edge of metafieldsData.edges || []) {
			if (edge.node?.key && edge.node?.value) {
				metafieldMap[edge.node.key] = edge.node.value;
			}
		}

		if (Object.keys(metafieldMap).length > 0) {
			bynderMetadata = {
				assetId: metafieldMap.asset_id || "",
				permalink: metafieldMap.permalink || "",
				tags: metafieldMap.tags ? JSON.parse(metafieldMap.tags) : [],
				version: parseInt(metafieldMap.version || "0", 10),
				syncedAt: metafieldMap.synced_at || new Date().toISOString(),
			};
		}
	}

	if (isMediaImage) {
		const image = node.image as {
			url?: string;
			altText?: string;
			width?: number;
			height?: number;
		} | null;
		const originalSource = node.originalSource as { fileSize?: number } | null;

		// Extract filename from URL
		let filename: string | null = null;
		if (image?.url) {
			try {
				const url = new URL(image.url);
				const pathParts = url.pathname.split("/");
				filename = pathParts[pathParts.length - 1] || null;
			} catch {
				// Invalid URL, skip filename extraction
			}
		}

		return {
			id,
			alt: (node.alt as string) || image?.altText || null,
			createdAt: node.createdAt as string,
			updatedAt: node.updatedAt as string,
			fileStatus: node.fileStatus as ShopifyFile["fileStatus"],
			fileType: "MediaImage",
			filename,
			mimeType: (node.mimeType as string) || null,
			fileSize: originalSource?.fileSize || null,
			fileUrl: image?.url || null,
			thumbnailUrl: image?.url || null,
			width: image?.width || null,
			height: image?.height || null,
			bynderMetadata,
		};
	}

	// GenericFile
	const url = node.url as string | null;
	let filename: string | null = null;
	if (url) {
		try {
			const parsedUrl = new URL(url);
			const pathParts = parsedUrl.pathname.split("/");
			filename = pathParts[pathParts.length - 1] || null;
		} catch {
			// Invalid URL
		}
	}

	return {
		id,
		alt: (node.alt as string) || null,
		createdAt: node.createdAt as string,
		updatedAt: node.updatedAt as string,
		fileStatus: node.fileStatus as ShopifyFile["fileStatus"],
		fileType: "GenericFile",
		filename,
		mimeType: (node.mimeType as string) || null,
		fileSize: (node.originalFileSize as number) || null,
		fileUrl: url,
		thumbnailUrl: null, // Generic files don't have thumbnails
		width: null,
		height: null,
		bynderMetadata: null, // Generic files don't have metafields in our query
	};
}

/**
 * Fetch files from Shopify Files API with pagination and filtering
 */
export async function getShopifyFiles(
	admin: AdminApi,
	options: FilesQueryOptions = {}
): Promise<FilesQueryResult> {
	const first = options.first || 50;
	const query = buildQueryString(options);

	console.log(
		`[FilesAPI] Fetching files with query: "${query}", first: ${first}, after: ${options.after || "null"}`
	);

	const response = await admin.graphql(FILES_QUERY, {
		variables: {
			first,
			after: options.after || null,
			query: query || null,
			sortKey: options.sortKey || "CREATED_AT",
			reverse: options.reverse ?? true, // Default to newest first
		},
	});

	const data = await response.json();

	if (data.errors) {
		console.error("[FilesAPI] GraphQL errors:", data.errors);
		throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
	}

	const filesConnection = data.data?.files;
	if (!filesConnection) {
		return {
			files: [],
			pageInfo: {
				hasNextPage: false,
				hasPreviousPage: false,
				startCursor: null,
				endCursor: null,
			},
			totalCount: 0,
		};
	}

	const files: ShopifyFile[] = [];
	for (const edge of filesConnection.edges || []) {
		const file = parseFileNode(edge.node);
		if (file) {
			files.push(file);
		}
	}

	console.log(`[FilesAPI] Fetched ${files.length} files`);

	return {
		files,
		pageInfo: {
			hasNextPage: filesConnection.pageInfo?.hasNextPage || false,
			hasPreviousPage: filesConnection.pageInfo?.hasPreviousPage || false,
			startCursor: filesConnection.pageInfo?.startCursor || null,
			endCursor: filesConnection.pageInfo?.endCursor || null,
		},
		totalCount: files.length, // Note: Shopify doesn't provide total count in files query
	};
}

/**
 * Filter options for client-side filtering
 */
export interface FileFilterOptions {
	source?: "all" | "bynder" | "other";
	fileType?: "all" | "image" | "file";
}

/**
 * Apply client-side filters to files (for filters not supported by API)
 */
export function filterFiles(
	files: ShopifyFile[],
	filters: FileFilterOptions
): ShopifyFile[] {
	return files.filter((file) => {
		// Filter by source (Bynder vs non-Bynder)
		if (filters.source === "bynder" && !file.bynderMetadata) {
			return false;
		}
		if (filters.source === "other" && file.bynderMetadata) {
			return false;
		}

		// Filter by file type
		if (filters.fileType === "image" && file.fileType !== "MediaImage") {
			return false;
		}
		if (filters.fileType === "file" && file.fileType !== "GenericFile") {
			return false;
		}

		return true;
	});
}

/**
 * Get unique tags from files with Bynder metadata
 */
export function extractBynderTags(files: ShopifyFile[]): string[] {
	const tagSet = new Set<string>();

	for (const file of files) {
		if (file.bynderMetadata?.tags) {
			for (const tag of file.bynderMetadata.tags) {
				tagSet.add(tag);
			}
		}
	}

	return Array.from(tagSet).sort();
}
