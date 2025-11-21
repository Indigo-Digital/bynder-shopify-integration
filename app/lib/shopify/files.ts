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
 */
async function downloadFile(
	url: string
): Promise<{ buffer: Buffer; contentType: string }> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download file: ${response.statusText}`);
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

	try {
		downloadUrl = await bynderClient.getMediaDownloadUrl({ id: assetId });
	} catch (error) {
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
	if (!downloadUrl) {
		const baseUrl = bynderClient.config.baseURL.replace("/api", "");
		downloadUrl = `${baseUrl}/api/v4/media/${assetId}/download`;
	}

	// Download the file
	const { buffer, contentType } = await downloadFile(downloadUrl);

	// Generate file name with naming convention
	const originalFilename = assetInfo.name || `bynder-${assetId}`;
	const fileName = generateFileName(originalFilename, assetInfo.tags || []);

	// Convert buffer to base64 for GraphQL upload
	const base64File = buffer.toString("base64");

	// Upload to Shopify Files
	const response = await admin.graphql(
		`#graphql
      mutation filesCreate($files: [FileCreateInput!]!) {
        filesCreate(files: $files) {
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

	if (data.data?.filesCreate?.userErrors?.length > 0) {
		throw new Error(
			`Failed to upload file: ${JSON.stringify(data.data.filesCreate.userErrors)}`
		);
	}

	const file = data.data?.filesCreate?.files?.[0];
	if (!file) {
		throw new Error("No file returned from Shopify");
	}

	const fileId = file.id;
	const fileUrl = file.image?.url || file.url || "";

	// Set metafields
	await setBynderMetafields(admin, fileId, {
		assetId,
		permalink: `${bynderClient.config.baseURL.replace("/api", "")}/media/${assetId}`,
		tags: assetInfo.tags || [],
		version: assetInfo.version || 1,
		syncedAt: new Date().toISOString(),
	});

	return { fileId, fileUrl };
}
