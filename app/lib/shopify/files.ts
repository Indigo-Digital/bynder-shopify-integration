import type { BynderClient } from "../bynder/client.js";
import type { BynderMediaInfoResponse } from "../bynder/types.js";
import type { AdminApi } from "../types.js";
import { setBynderMetafields } from "./metafields.js";

/**
 * Sanitize tag for use in file path
 */
function sanitizeTag(tag: string): string {
	return tag
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Generate file name with campaigns/{tag}/{filename} convention
 */
function generateFileName(
	originalFilename: string,
	tags: string[],
	defaultTag = "shopify-sync"
): string {
	// Use first tag that's not the default, or default if none found
	const primaryTag =
		tags.find((tag) => tag !== defaultTag && tag.trim() !== "") || defaultTag;
	const sanitizedTag = sanitizeTag(primaryTag);
	return `campaigns/${sanitizedTag}/${originalFilename}`;
}

/**
 * Download file from URL and return as buffer
 * Supports optional authentication token
 */
async function downloadFile(
	url: string,
	authToken?: string
): Promise<{ buffer: Buffer; contentType: string }> {
	const headers: HeadersInit = {};
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	}

	let response: Response;
	try {
		response = await fetch(url, { headers });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to download file from ${url}: Network error - ${errorMessage}`
		);
	}

	if (!response.ok) {
		const statusText = response.statusText || "Unknown error";
		const statusCode = response.status;
		let errorDetails = `HTTP ${statusCode}: ${statusText}`;

		// Try to get error body if available
		try {
			const errorBody = await response.text();
			if (errorBody && errorBody.length < 500) {
				errorDetails += ` - ${errorBody}`;
			}
		} catch {
			// Ignore errors reading response body
		}

		throw new Error(`Failed to download file from ${url}: ${errorDetails}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	const contentType =
		response.headers.get("content-type") || "application/octet-stream";
	return { buffer, contentType };
}

/**
 * Upload Bynder asset to Shopify Files
 */
export async function uploadBynderAsset(
	admin: AdminApi,
	bynderClient: BynderClient,
	assetId: string,
	_shopId: string,
	_syncType: "auto" | "manual" = "manual"
): Promise<{ fileId: string; fileUrl: string }> {
	// Get asset info from Bynder
	const assetInfoRaw = await bynderClient.getMediaInfo({ id: assetId });

	if (!assetInfoRaw) {
		throw new Error(`Asset ${assetId} not found in Bynder`);
	}

	// Type guard for asset info
	const assetInfo: BynderMediaInfoResponse =
		assetInfoRaw && typeof assetInfoRaw === "object" && "id" in assetInfoRaw
			? (assetInfoRaw as BynderMediaInfoResponse)
			: {
					id: assetId,
					name: `bynder-${assetId}`,
					type: "image",
					tags: [],
					dateModified: new Date().toISOString(),
					dateCreated: new Date().toISOString(),
					version: 1,
					derivatives: {},
					thumbnails: {},
					files: [],
				};

	// Get download URL - try multiple methods
	let downloadUrl: string | undefined;
	let downloadUrlError: string | undefined;

	try {
		downloadUrl = await bynderClient.getMediaDownloadUrl({ id: assetId });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		downloadUrlError = `SDK method failed: ${errorMessage}`;
		console.warn("Failed to get download URL via SDK method:", error);
	}

	// Fallback: try to get from asset info
	if (
		!downloadUrl &&
		assetInfo.files &&
		assetInfo.files.length > 0 &&
		assetInfo.files[0]
	) {
		downloadUrl = assetInfo.files[0].url;
	}

	// Final fallback: construct URL
	// baseURL now includes /api, so we use it directly and append the path
	if (!downloadUrl) {
		const baseUrl = bynderClient.config.baseURL.endsWith("/api")
			? bynderClient.config.baseURL
			: `${bynderClient.config.baseURL.replace(/\/api$/, "")}/api`;
		downloadUrl = `${baseUrl}/v4/media/${assetId}/download`;
	}

	if (!downloadUrl) {
		throw new Error(
			`Could not determine download URL for asset ${assetId}. ${downloadUrlError || "No download URL available"}`
		);
	}

	// Download the file
	// Include permanent token in download request for authentication
	const permanentToken =
		"permanentToken" in bynderClient.config
			? bynderClient.config.permanentToken
			: undefined;

	let buffer: Buffer;
	let contentType: string;
	try {
		const result = await downloadFile(downloadUrl, permanentToken);
		buffer = result.buffer;
		contentType = result.contentType;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to download asset ${assetId}: ${errorMessage}`);
	}

	// Generate file name with naming convention
	const originalFilename = assetInfo.name || `bynder-${assetId}`;
	const fileName = generateFileName(originalFilename, assetInfo.tags || []);

	// Convert buffer to base64 for GraphQL upload
	const base64File = buffer.toString("base64");

	// Upload to Shopify Files
	const response = await admin.graphql(
		`#graphql
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
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
          userErrors {
            field
            message
          }
        }
      }
    `,
		{
			variables: {
				files: [
					{
						originalSource: `data:${contentType};base64,${base64File}`,
						filename: fileName,
						alt: assetInfo.description || assetInfo.name,
					},
				],
			},
		}
	);

	const data = await response.json();

	if (data.data?.fileCreate?.userErrors?.length > 0) {
		throw new Error(
			`Failed to upload file: ${JSON.stringify(data.data.fileCreate.userErrors)}`
		);
	}

	const file = data.data?.fileCreate?.files?.[0];
	if (!file) {
		throw new Error("No file returned from Shopify");
	}

	const fileId = file.id;
	const fileUrl = file.image?.url || file.url || "";

	// Set metafields
	// For permalink, we want the portal URL (without /api)
	const portalUrl = bynderClient.config.baseURL.replace(/\/api$/, "");
	await setBynderMetafields(admin, fileId, {
		assetId,
		permalink: `${portalUrl}/media/${assetId}`,
		tags: assetInfo.tags || [],
		version: assetInfo.version || 1,
		syncedAt: new Date().toISOString(),
	});

	return { fileId, fileUrl };
}
