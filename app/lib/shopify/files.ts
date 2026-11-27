import axios from "axios";
import FormData from "form-data";
import { generateAltText } from "../ai/gemini-vision.js";
import type { BynderClient } from "../bynder/client.js";
import type { BynderMediaInfoResponse } from "../bynder/types.js";
import { recordApiCall } from "../metrics/collector.js";
import type { AdminApi } from "../types.js";
import { generateFilePath, type TemplateContext } from "./file-template.js";
import { setBynderMetafields } from "./metafields.js";
import {
	ensureExtensionForMimeType,
	resolveUploadContentType,
	UnsupportedUploadTypeError,
} from "./upload-content-type.js";

/**
 * Download file from URL and return as buffer
 * Supports optional authentication token
 *
 * IMPORTANT: Bynder's download API returns a JSON response with an S3 URL,
 * not the actual file bytes. This function detects that pattern and follows
 * the S3 URL to download the actual file.
 */
async function downloadFile(
	url: string,
	authToken?: string,
	depth = 0
): Promise<{ buffer: Buffer; contentType: string }> {
	// Prevent infinite redirect loops
	if (depth > 3) {
		throw new Error(
			`Download redirect loop detected: Too many redirects (${depth}). URL: ${url}`
		);
	}

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

	// Check if response is JSON with s3_file (Bynder's download API pattern)
	// Bynder's /v4/media/{id}/download endpoint returns JSON like:
	// {"s3_file": "https://bynder-media-*.s3.*.amazonaws.com/..."}
	const responseContentType =
		response.headers.get("content-type") || "application/octet-stream";

	if (responseContentType.includes("application/json")) {
		try {
			const jsonData = await response.json();

			// Check for Bynder's s3_file redirect pattern
			if (jsonData.s3_file && typeof jsonData.s3_file === "string") {
				console.log(
					`[Download] Bynder returned S3 URL redirect, following: ${jsonData.s3_file.substring(0, 100)}...`
				);
				// Recursively download from the actual S3 URL (no auth needed for S3)
				return downloadFile(jsonData.s3_file, undefined, depth + 1);
			}

			// If JSON but no s3_file, this is unexpected - throw error
			throw new Error(
				`Bynder returned unexpected JSON response without s3_file. Keys: ${Object.keys(jsonData).join(", ")}`
			);
		} catch (parseError) {
			// If JSON parsing fails, it might be a different content type that included "json"
			// Fall through to treat as binary
			if (
				parseError instanceof Error &&
				parseError.message.includes("s3_file")
			) {
				throw parseError;
			}
			console.warn(
				`[Download] Response had JSON content-type but failed to parse: ${parseError}`
			);
		}
	}

	const arrayBuffer = await response.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);

	console.log(
		`[Download] Successfully downloaded file: ${buffer.length} bytes, Content-Type: ${responseContentType}`
	);

	return { buffer, contentType: responseContentType };
}

/**
 * Upload a buffer to Shopify Files
 * Handles staged upload creation, file upload to target (S3/GCS), and file creation in Shopify
 *
 * The uploaded type is detected from `buffer`; `declaredContentType` is only
 * accepted when it agrees with the bytes.
 *
 * @throws {UnsupportedUploadTypeError} Before any Shopify call when the bytes
 *   are not an allowed format or do not match `declaredContentType`
 */
export async function uploadBufferToShopify(
	admin: AdminApi,
	sourceBuffer: Buffer,
	declaredContentType: string,
	requestedFilename: string,
	originalFilename: string,
	shopId: string,
	syncJobId?: string,
	altText?: string
): Promise<{ fileId: string; fileUrl: string }> {
	// Private copy so the bytes uploaded are exactly the bytes checked here.
	const buffer = Buffer.from(sourceBuffer);
	const contentType = resolveUploadContentType(buffer, declaredContentType);
	const filename = ensureExtensionForMimeType(requestedFilename, contentType);

	// Extract just the filename (without path) for staged upload
	// Shopify's stagedUploadsCreate expects only a filename, not a path
	const stagedUploadFilename = filename.includes("/")
		? filename.split("/").pop() || originalFilename
		: filename;

	// Sanitize the filename for staged upload
	// Shopify has restrictions on filenames - remove invalid characters
	// Remove colons, trailing spaces, and other problematic characters
	const sanitizedStagedFilename = ensureExtensionForMimeType(
		stagedUploadFilename
			.replace(/:/g, "-") // Replace colons with dashes
			.replace(/\s+$/g, "") // Remove trailing spaces
			.replace(/^\s+/g, "") // Remove leading spaces
			.trim() || // Final trim
			originalFilename, // Fallback to original if empty after sanitization
		contentType
	);

	// Determine resource type based on content type
	// Use IMAGE for image types, FILE for everything else
	const isImage = contentType.startsWith("image/");
	const resourceType = isImage ? "IMAGE" : "FILE";

	// Step 1: Create staged upload target
	// Track Shopify API call
	await recordApiCall(shopId, "shopify_stagedUploadsCreate", syncJobId);
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

	// Log staged upload details for debugging
	const urlObj = new URL(stagedTarget.url);
	console.log(`[Upload Debug] Staged upload URL: ${stagedTarget.url}`);

	// Detect V4 signed URL format vs policy-based POST format
	const isV4SignedUrl = urlObj.searchParams.has("X-Goog-Algorithm");
	const hasMinimalParams = stagedTarget.parameters.length <= 3;

	if (isV4SignedUrl && hasMinimalParams) {
		console.error(
			`[Upload Debug] Detected V4 signed URL format - using PUT with raw bytes`
		);

		// For V4 signed URLs, use PUT with raw file bytes
		const MAX_RETRIES = 3;
		let uploadResponse: {
			status: number;
			statusText: string;
			data: unknown;
		} | null = null;
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				if (attempt > 1) {
					console.error(
						`[Upload] Retry attempt ${attempt}/${MAX_RETRIES} for PUT upload`
					);
				}

				// Convert Buffer to Uint8Array for fetch API compatibility
				const bodyArray = new Uint8Array(buffer);
				const putResponse = await fetch(stagedTarget.url, {
					method: "PUT",
					body: bodyArray,
					headers: {
						"Content-Type": contentType,
					},
				});

				const responseData = await putResponse.text();
				uploadResponse = {
					status: putResponse.status,
					statusText: putResponse.statusText,
					data: responseData,
				};

				if (putResponse.ok) {
					break;
				}

				// If not successful, check if we should retry
				if (attempt < MAX_RETRIES) {
					const waitTime = attempt * 1000;
					await new Promise((resolve) => setTimeout(resolve, waitTime));
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < MAX_RETRIES) {
					const waitTime = attempt * 1000;
					await new Promise((resolve) => setTimeout(resolve, waitTime));
					continue;
				}
				throw new Error(
					`PUT upload failed after ${MAX_RETRIES} attempts: ${lastError.message}`
				);
			}
		}

		if (!uploadResponse) {
			throw new Error(
				`PUT upload failed after ${MAX_RETRIES} attempts: ${lastError?.message || "Unknown error"}`
			);
		}

		if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
			const errorDetails =
				typeof uploadResponse.data === "string"
					? uploadResponse.data.substring(0, 1000)
					: String(uploadResponse.data).substring(0, 1000);
			throw new Error(
				`Failed to PUT file to staged URL: HTTP ${uploadResponse.status}: ${uploadResponse.statusText} - ${errorDetails}`
			);
		}
	} else {
		console.error(
			`[Upload Debug] Using policy-based POST multipart format (isV4=${isV4SignedUrl}, params=${stagedTarget.parameters.length})`
		);
	}

	// Step 2: Upload file to staged upload URL (POST multipart - for policy-based uploads)
	// Skip this if we already uploaded via PUT above
	if (!(isV4SignedUrl && hasMinimalParams)) {
		// Helper function to create FormData for upload
		const createFormData = (): FormData => {
			const retryFormData = new FormData();
			const retryIsPolyfill = true;

			// Add parameters from staged upload in the EXACT order Shopify provides
			for (let i = 0; i < stagedTarget.parameters.length; i++) {
				const param = stagedTarget.parameters[i];
				retryFormData.append(param.name, param.value);
			}

			// Add the file last - this is CRITICAL for S3/GCS uploads
			if (retryIsPolyfill) {
				// form-data polyfill expects Buffer or stream, not File
				const polyfillFormData = retryFormData as unknown as {
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
				retryFormData.append("file", fileToUpload);
			}

			return retryFormData;
		};

		// Retry logic for transient network failures
		const MAX_RETRIES = 3;
		let uploadResponse: {
			status: number;
			statusText: string;
			data: unknown;
		} | null = null;
		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				// Create fresh FormData for each retry attempt
				const formData = createFormData();

				// Detect if we're using the form-data polyfill
				const isPolyfill =
					"_boundary" in formData ||
					typeof (formData as { _streams?: unknown })._streams !== "undefined";

				let uploadBody: Buffer | FormData = formData;
				let uploadHeaders: Record<string, string> = {};

				if (isPolyfill) {
					const polyfillFormData = formData as unknown as {
						getHeaders?: () => HeadersInit;
						getBuffer?: () => Buffer;
					};

					if (
						typeof polyfillFormData.getHeaders === "function" &&
						typeof polyfillFormData.getBuffer === "function"
					) {
						const rawHeaders = polyfillFormData.getHeaders();

						if (rawHeaders instanceof Headers) {
							rawHeaders.forEach((value, key) => {
								uploadHeaders[key] = value;
							});
						} else if (Array.isArray(rawHeaders)) {
							for (const [key, value] of rawHeaders) {
								uploadHeaders[key] = value;
							}
						} else {
							uploadHeaders = rawHeaders as Record<string, string>;
						}

						const bodyBuffer = polyfillFormData.getBuffer();
						uploadBody = bodyBuffer;
					}
				}

				// Try buffer + headers first if available
				if (
					uploadBody instanceof Buffer &&
					Object.keys(uploadHeaders).length > 0
				) {
					const bodyArray = new Uint8Array(uploadBody);
					const fetchHeaders: HeadersInit = {};
					for (const [key, value] of Object.entries(uploadHeaders)) {
						fetchHeaders[key] = value;
					}

					if (
						fetchHeaders["Content-Length"] ||
						fetchHeaders["content-length"]
					) {
						delete fetchHeaders["Content-Length"];
						delete fetchHeaders["content-length"];
					}

					const fetchResponse = await fetch(stagedTarget.url, {
						method: "POST",
						body: bodyArray,
						headers: fetchHeaders,
					});

					const responseData = await fetchResponse.text();
					uploadResponse = {
						status: fetchResponse.status,
						statusText: fetchResponse.statusText,
						data: responseData,
					};
				} else {
					// Fallback to axios
					const axiosConfig: {
						headers?: Record<string, string>;
						maxContentLength: number;
						maxBodyLength: number;
						timeout: number;
						validateStatus: () => boolean;
					} = {
						maxContentLength: Infinity,
						maxBodyLength: Infinity,
						timeout: 5 * 60 * 1000,
						validateStatus: () => true,
					};

					if (Object.keys(uploadHeaders).length > 0) {
						axiosConfig.headers = uploadHeaders;
					}

					const axiosResponse = await axios.post(
						stagedTarget.url,
						uploadBody,
						axiosConfig
					);
					uploadResponse = {
						status: axiosResponse.status,
						statusText: axiosResponse.statusText,
						data: axiosResponse.data,
					};
				}

				if (uploadResponse) {
					lastError = null;
					break;
				} else {
					throw new Error("uploadResponse not set after all upload attempts");
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				const errorMessage = lastError.message;

				// Don't retry on timeout errors
				if (
					lastError.message.includes("timeout") ||
					lastError.message.includes("ETIMEDOUT")
				) {
					throw new Error(
						`Upload timeout: File upload to Shopify took longer than 5 minutes. URL: ${stagedTarget.url}`
					);
				}

				// Retry on network errors
				if (attempt < MAX_RETRIES) {
					const waitTime = attempt * 1000;
					await new Promise((resolve) => setTimeout(resolve, waitTime));
					continue;
				}

				throw new Error(
					`Network error uploading file to Shopify after ${MAX_RETRIES} attempts: ${errorMessage}. URL: ${stagedTarget.url}`
				);
			}
		}

		if (!uploadResponse) {
			throw new Error(
				`Failed to upload file after ${MAX_RETRIES} attempts: ${lastError?.message || "Unknown error"}`
			);
		}

		if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
			const statusText = uploadResponse.statusText || "Unknown error";
			const statusCode = uploadResponse.status;
			const errorDetails =
				typeof uploadResponse.data === "string"
					? uploadResponse.data.substring(0, 1000)
					: String(uploadResponse.data).substring(0, 1000);

			throw new Error(
				`Failed to upload file to staged URL: HTTP ${statusCode}: ${statusText} - ${errorDetails}`
			);
		}
	}

	// Step 3: Create file in Shopify using the resourceUrl
	// Track Shopify API call
	await recordApiCall(shopId, "shopify_fileCreate", syncJobId);
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
						filename: filename,
						alt: altText,
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
	const fileStatus = file.fileStatus || "UNKNOWN";

	console.log(
		`[Upload] File created successfully: id=${fileId}, status=${fileStatus}, url=${fileUrl || "(not yet available)"}`
	);

	return { fileId, fileUrl };
}

/**
 * Upload Bynder asset to Shopify Files
 */
export async function uploadBynderAsset(
	admin: AdminApi,
	bynderClient: BynderClient,
	assetId: string,
	shopId: string,
	_syncType: "auto" | "manual" = "manual",
	shopConfig?: {
		fileFolderTemplate?: string | null;
		filenamePrefix?: string | null;
		filenameSuffix?: string | null;
		altTextPrefix?: string | null;
		enableAutoAltText?: boolean; // Enable AI-generated alt text
		syncTags?: string;
		syncJobId?: string; // Optional syncJobId for metrics tracking
	}
): Promise<{ fileId: string; fileUrl: string }> {
	// Get asset info from Bynder
	const getMediaInfoParams: Parameters<BynderClient["getMediaInfo"]>[0] = {
		id: assetId,
	};
	if (shopId) {
		getMediaInfoParams.shopId = shopId;
	}
	if (shopConfig?.syncJobId) {
		getMediaInfoParams.syncJobId = shopConfig.syncJobId;
	}
	const assetInfoRaw = await bynderClient.getMediaInfo(getMediaInfoParams);

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
		const getDownloadUrlParams: Parameters<
			BynderClient["getMediaDownloadUrl"]
		>[0] = {
			id: assetId,
		};
		if (shopId) {
			getDownloadUrlParams.shopId = shopId;
		}
		if (shopConfig?.syncJobId) {
			getDownloadUrlParams.syncJobId = shopConfig.syncJobId;
		}
		downloadUrl = await bynderClient.getMediaDownloadUrl(getDownloadUrlParams);
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

	try {
		contentType = resolveUploadContentType(buffer, contentType);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new UnsupportedUploadTypeError(
			`Asset ${assetId} cannot be synced: ${errorMessage}`
		);
	}

	// Generate file path using template system
	const originalFilename = assetInfo.name || `bynder-${assetId}`;

	// Parse sync tags for template context
	const syncTags = shopConfig?.syncTags
		? shopConfig.syncTags
				.split(",")
				.map((tag) => tag.trim())
				.filter((tag) => tag.length > 0)
		: ["shopify-sync"];

	const templateContext: TemplateContext = {
		asset: assetInfo,
		syncTags,
	};

	const fileName = generateFilePath(
		shopConfig?.fileFolderTemplate,
		originalFilename,
		templateContext,
		shopConfig?.filenamePrefix,
		shopConfig?.filenameSuffix
	);

	// Generate alt text - use AI if enabled, otherwise use default
	let altText: string | undefined;
	if (shopConfig?.enableAutoAltText && contentType.startsWith("image/")) {
		// Try AI-generated alt text
		const aiAltText = await generateAltText(
			buffer,
			contentType,
			originalFilename
		);
		if (aiAltText) {
			// Apply prefix to AI-generated alt text if configured
			altText = shopConfig?.altTextPrefix
				? `${shopConfig.altTextPrefix} ${aiAltText}`.trim()
				: aiAltText;
		}
	}

	// Fallback to default alt text if AI didn't generate one
	if (!altText) {
		altText = shopConfig?.altTextPrefix
			? `${shopConfig.altTextPrefix} ${assetInfo.description || assetInfo.name}`.trim()
			: assetInfo.description || assetInfo.name;
	}

	// Use the common upload function
	const result = await uploadBufferToShopify(
		admin,
		buffer,
		contentType,
		fileName,
		originalFilename,
		shopId,
		shopConfig?.syncJobId,
		altText
	);

	// Set metafields
	// For permalink, we want the portal URL (without /api)
	const portalUrl = bynderClient.config.baseURL.replace(/\/api$/, "");
	await setBynderMetafields(admin, result.fileId, {
		assetId,
		permalink: `${portalUrl}/media/${assetId}`,
		tags: assetInfo.tags || [],
		version: assetInfo.version || 1,
		syncedAt: new Date().toISOString(),
	});

	return result;
}
