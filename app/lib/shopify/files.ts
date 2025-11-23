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
		// Create abort controller for timeout (2 minutes for download)
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2 * 60 * 1000);

		response = await fetch(url, {
			headers,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Check if it's an abort error (timeout)
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`Download timeout: File download from Bynder took longer than 2 minutes. URL: ${url}`
			);
		}
		// Generic network error
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

	// Extract just the filename (without path) for staged upload
	// Shopify's stagedUploadsCreate expects only a filename, not a path
	const stagedUploadFilename = fileName.includes("/")
		? fileName.split("/").pop() || originalFilename
		: fileName;

	// Sanitize the filename for staged upload
	// Shopify has restrictions on filenames - remove invalid characters
	// Remove colons, trailing spaces, and other problematic characters
	const sanitizedStagedFilename =
		stagedUploadFilename
			.replace(/:/g, "-") // Replace colons with dashes
			.replace(/\s+$/g, "") // Remove trailing spaces
			.replace(/^\s+/g, "") // Remove leading spaces
			.trim() || // Final trim
		originalFilename; // Fallback to original if empty after sanitization

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
						filename: sanitizedStagedFilename,
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

	if (stagedUploadData.errors) {
		throw new Error(
			`Shopify GraphQL errors: ${JSON.stringify(stagedUploadData.errors)}`
		);
	}

	const stagedTarget =
		stagedUploadData.data?.stagedUploadsCreate?.stagedTargets?.[0];
	if (!stagedTarget) {
		throw new Error(
			`No staged upload target returned from Shopify. Response: ${JSON.stringify(stagedUploadData, null, 2)}`
		);
	}

	// Step 2: Upload file to staged upload URL
	// For Shopify staged uploads (typically S3), we need to:
	// 1. Add all parameters first (in order)
	// 2. Add the file last
	// 3. Handle both native FormData and form-data polyfill
	// Note: @bynder/bynder-js-sdk pulls in isomorphic-form-data which polyfills FormData
	// The polyfill expects streams/buffers, not File objects
	const formData = new FormData();

	// Detect if we're using the form-data polyfill (has _boundary property) vs native FormData
	const isPolyfill =
		"_boundary" in formData ||
		typeof (formData as { _streams?: unknown })._streams !== "undefined";

	// Add parameters from staged upload first (S3 requires specific order)
	for (const param of stagedTarget.parameters) {
		formData.append(param.name, param.value);
	}

	// Add the file last - this is critical for S3 uploads
	if (isPolyfill) {
		// form-data polyfill expects Buffer or stream, not File
		// Type assertion needed because form-data polyfill has different signature
		const polyfillFormData = formData as unknown as {
			append: (
				name: string,
				value: Buffer,
				options?: { filename?: string; contentType?: string }
			) => void;
		};
		polyfillFormData.append("file", buffer, {
			filename: sanitizedStagedFilename,
			contentType: contentType,
		});
	} else {
		// Native FormData (Node.js 20+) supports File objects
		const fileToUpload = new File(
			[new Uint8Array(buffer)],
			sanitizedStagedFilename,
			{
				type: contentType,
			}
		);
		formData.append("file", fileToUpload);
	}

	// Upload to staged URL
	// Native FormData: fetch will automatically set Content-Type with boundary
	// form-data polyfill: must send as stream to preserve signature, convert Node.js stream to web ReadableStream
	let uploadBody: BodyInit;
	let uploadHeaders: HeadersInit = {};

	if (isPolyfill) {
		// form-data polyfill must be sent as stream to preserve Shopify's signature
		// Converting to buffer breaks the signature because it changes the exact bytes
		const polyfillFormData = formData as unknown as {
			getHeaders?: () => HeadersInit;
		} & NodeJS.ReadableStream;

		// Get headers first
		if (typeof polyfillFormData.getHeaders === "function") {
			uploadHeaders = polyfillFormData.getHeaders();
		}

		// Convert Node.js ReadableStream to web ReadableStream for fetch
		// This preserves the exact stream data that Shopify signed
		const nodeStream = polyfillFormData as NodeJS.ReadableStream;
		uploadBody = new ReadableStream({
			start(controller) {
				nodeStream.on("data", (chunk: Buffer) => {
					controller.enqueue(new Uint8Array(chunk));
				});
				nodeStream.on("end", () => {
					controller.close();
				});
				nodeStream.on("error", (err) => {
					controller.error(err);
				});
			},
		});
	} else {
		// Native FormData - fetch handles it automatically
		uploadBody = formData;
	}

	let uploadResponse: Response;
	try {
		// Create abort controller for timeout (5 minutes for large files)
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

		uploadResponse = await fetch(stagedTarget.url, {
			method: "POST",
			body: uploadBody,
			headers: uploadHeaders,
			// Required when using ReadableStream as body in Node.js fetch
			...(isPolyfill && { duplex: "half" as const }),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Check if it's an abort error (timeout or cancelled)
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`Upload timeout: File upload to Shopify took longer than 5 minutes. This may indicate a network issue or the file is too large. URL: ${stagedTarget.url}`
			);
		}
		// Generic network error
		throw new Error(
			`Network error uploading file to Shopify: ${errorMessage}. URL: ${stagedTarget.url}`
		);
	}

	if (!uploadResponse.ok) {
		const statusText = uploadResponse.statusText || "Unknown error";
		const statusCode = uploadResponse.status;

		// Try to get more details from the response body
		let errorDetails = statusText;
		try {
			const errorBody = await uploadResponse.text();
			if (errorBody && errorBody.length < 1000) {
				errorDetails = `${statusText} - ${errorBody}`;
			}
		} catch {
			// Ignore errors reading response body
		}

		// Log the staged upload URL and parameters for debugging (without sensitive values)
		console.error(
			`[Upload Error] Failed to upload to staged URL: ${stagedTarget.url.substring(0, 100)}...`
		);
		console.error(
			`[Upload Error] Parameters: ${stagedTarget.parameters.map((p: { name: string; value: string }) => p.name).join(", ")}`
		);

		throw new Error(
			`Failed to upload file to staged URL: HTTP ${statusCode}: ${errorDetails}`
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
