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

	// Determine resource type based on content type
	// Use IMAGE for image types, FILE for everything else
	const isImage = contentType.startsWith("image/");
	const resourceType = isImage ? "IMAGE" : "FILE";

	// Step 1: Create staged upload target
	const stagedUploadResponse = await admin.graphql(
		`#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            resourceUrl
            url
            parameters {
              name
              value
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
				input: [
					{
						resource: resourceType,
						filename: fileName,
						mimeType: contentType,
					},
				],
			},
		}
	);

	const stagedUploadData = await stagedUploadResponse.json();

	if (stagedUploadData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
		throw new Error(
			`Failed to create staged upload: ${JSON.stringify(stagedUploadData.data.stagedUploadsCreate.userErrors)}`
		);
	}

	const stagedTarget =
		stagedUploadData.data?.stagedUploadsCreate?.stagedTargets?.[0];
	if (!stagedTarget) {
		throw new Error("No staged upload target returned from Shopify");
	}

	// Step 2: Upload file to staged upload URL
	const formData = new FormData();
	// Add parameters from staged upload
	for (const param of stagedTarget.parameters) {
		formData.append(param.name, param.value);
	}
	// Add the file - convert Buffer to Uint8Array for Blob
	const uint8Array = new Uint8Array(buffer);
	const blob = new Blob([uint8Array], { type: contentType });
	formData.append("file", blob, fileName);

	const uploadResponse = await fetch(stagedTarget.url, {
		method: "POST",
		body: formData,
	});

	if (!uploadResponse.ok) {
		const statusText = uploadResponse.statusText || "Unknown error";
		const statusCode = uploadResponse.status;
		throw new Error(
			`Failed to upload file to staged URL: HTTP ${statusCode}: ${statusText}`
		);
	}

	// Step 3: Create file in Shopify using the resourceUrl
	const fileCreateResponse = await admin.graphql(
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
						originalSource: stagedTarget.resourceUrl,
						filename: fileName,
						alt: assetInfo.description || assetInfo.name,
					},
				],
			},
		}
	);

	const fileCreateData = await fileCreateResponse.json();

	if (fileCreateData.data?.fileCreate?.userErrors?.length > 0) {
		throw new Error(
			`Failed to upload file: ${JSON.stringify(fileCreateData.data.fileCreate.userErrors)}`
		);
	}

	const file = fileCreateData.data?.fileCreate?.files?.[0];
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
