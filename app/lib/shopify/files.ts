import axios from "axios";
import FormData from "form-data";
import type { BynderClient } from "../bynder/client.js";
import type { BynderMediaInfoResponse } from "../bynder/types.js";
import type { AdminApi } from "../types.js";
import { generateFilePath, type TemplateContext } from "./file-template.js";
import { setBynderMetafields } from "./metafields.js";

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
	_syncType: "auto" | "manual" = "manual",
	shopConfig?: {
		fileFolderTemplate?: string | null;
		filenamePrefix?: string | null;
		filenameSuffix?: string | null;
		altTextPrefix?: string | null;
		syncTags?: string;
	}
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

	// Log staged upload details for debugging
	console.log(
		`[Upload Debug] Staged upload URL: ${stagedTarget.url.substring(0, 150)}...`
	);
	console.log(
		`[Upload Debug] Staged upload parameters count: ${stagedTarget.parameters.length}`
	);
	console.log(
		`[Upload Debug] Staged upload parameter names: ${stagedTarget.parameters.map((p: { name: string }) => p.name).join(", ")}`
	);

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

	// Helper function to create FormData for upload
	// Explicitly use form-data package to ensure getHeaders() and getBuffer() are available
	const createFormData = (): FormData => {
		const retryFormData = new FormData();

		// We're explicitly using form-data package, so it always has getHeaders() and getBuffer()
		const retryIsPolyfill = true;

		// Log parameters being added (for debugging signature issues)
		console.log(
			`[Upload Debug] Adding ${stagedTarget.parameters.length} parameters to FormData`
		);
		for (const param of stagedTarget.parameters) {
			console.log(
				`[Upload Debug] Parameter: ${param.name} = ${param.value.substring(0, 50)}${param.value.length > 50 ? "..." : ""}`
			);
		}

		// Add parameters from staged upload first (S3/GCS requires specific order)
		for (const param of stagedTarget.parameters) {
			retryFormData.append(param.name, param.value);
		}

		// Add the file last - this is critical for S3/GCS uploads
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
			console.log(
				`[Upload Debug] Added file to FormData (polyfill): ${sanitizedStagedFilename}, size: ${buffer.length} bytes, contentType: ${contentType}`
			);
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
			console.log(
				`[Upload Debug] Added file to FormData (native): ${sanitizedStagedFilename}, size: ${buffer.length} bytes, contentType: ${contentType}`
			);
		}

		return retryFormData;
	};

	// Retry logic for transient network failures
	// Using axios with form-data stream directly (not getBuffer()) to preserve signature
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
			// This is critical because streams can only be consumed once
			const formData = createFormData();

			// Detect if we're using the form-data polyfill
			const isPolyfill =
				"_boundary" in formData ||
				typeof (formData as { _streams?: unknown })._streams !== "undefined";

			// CRITICAL: For GCS signed URLs, we MUST use getBuffer() + getHeaders() together
			// The boundary in Content-Type MUST exactly match the body format
			// We use getBuffer() to serialize the FormData, then getHeaders() to get the matching Content-Type
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
					// CRITICAL: Call getHeaders() FIRST to lock in the boundary
					// Then call getBuffer() to get the body with that exact boundary
					const rawHeaders = polyfillFormData.getHeaders();

					// Convert HeadersInit to Record<string, string>
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

					// Get the buffer (uses the boundary from getHeaders())
					const bodyBuffer = polyfillFormData.getBuffer();
					uploadBody = bodyBuffer;

					// Log headers for debugging
					const headersForLog: Record<string, string> = {};
					for (const [key, value] of Object.entries(uploadHeaders)) {
						if (key.toLowerCase() === "content-type") {
							headersForLog[key] = value; // Log Content-Type fully (includes boundary)
						} else {
							headersForLog[key] =
								value.length > 100 ? `${value.substring(0, 100)}...` : value;
						}
					}
					console.log(
						`[Upload Debug] Using form-data polyfill with getBuffer() + getHeaders()`
					);
					console.log(
						`[Upload Debug] Headers: ${JSON.stringify(headersForLog, null, 2)}`
					);
					console.log(
						`[Upload Debug] Body buffer size: ${bodyBuffer.length} bytes`
					);
				} else {
					console.log(
						`[Upload Debug] WARNING: form-data polyfill detected but getHeaders() or getBuffer() not available`
					);
				}
			} else {
				console.log(
					`[Upload Debug] Using native FormData - axios will handle Content-Type automatically`
				);
			}

			if (attempt > 1) {
				console.log(
					`[Upload] Retry attempt ${attempt}/${MAX_RETRIES} for file upload to Shopify`
				);
			}

			// Log upload attempt details
			if (attempt === 1) {
				console.log(
					`[Upload] Starting upload to Shopify staged URL using axios`
				);
				console.log(
					`[Upload Debug] File: ${sanitizedStagedFilename}, size: ${buffer.length} bytes`
				);
				console.log(
					`[Upload Debug] URL: ${stagedTarget.url.substring(0, 100)}...`
				);
				console.log(
					`[Upload Debug] Using ${isPolyfill ? "form-data polyfill" : "native FormData"}`
				);
			}

			// Use axios to upload - it handles form-data streams correctly
			// CRITICAL: For GCS signed URLs with X-Goog-SignedHeaders=host, only host header is signed
			// But the request body (multipart form) must still match exactly what was signed
			// The issue might be that axios modifies Content-Type or the request format
			try {
				// Log the exact URL and headers before sending
				const urlObj = new URL(stagedTarget.url);
				console.log(`[Upload Debug] Upload URL path: ${urlObj.pathname}`);
				console.log(
					`[Upload Debug] URL query params: ${Array.from(urlObj.searchParams.keys()).join(", ")}`
				);
				console.log(
					`[Upload Debug] Headers being sent: ${JSON.stringify(uploadHeaders, null, 2)}`
				);
				console.log(
					`[Upload Debug] FormData type: ${isPolyfill ? "polyfill" : "native"}, has getHeaders: ${typeof (formData as unknown as { getHeaders?: () => HeadersInit }).getHeaders === "function"}`
				);
				// Count FormData entries - form-data package doesn't have entries() method
				// We're always using form-data package now, so count manually
				const polyfillFormData = formData as unknown as {
					_streams?: unknown[];
					_length?: number;
				};
				// The polyfill stores entries in _streams array (rough count)
				const formDataEntryCount =
					polyfillFormData._streams?.length || polyfillFormData._length || 0;
				console.log(
					`[Upload Debug] Number of FormData entries: ${formDataEntryCount}`
				);

				// CRITICAL: For GCS signed URLs, we might need to NOT set Content-Type manually
				// and let axios/form-data set it automatically, OR ensure it matches exactly
				// Try without manually setting Content-Type first - let axios handle it
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
					validateStatus: () => true, // Don't throw on error status codes
				};

				// CRITICAL: For GCS signed URLs, we MUST use native fetch with the exact Buffer
				// from getBuffer() and exact headers from getHeaders() to avoid any modifications
				// axios might make to the request
				if (
					uploadBody instanceof Buffer &&
					Object.keys(uploadHeaders).length > 0
				) {
					console.log(
						`[Upload Debug] Using native fetch with Buffer from getBuffer() and headers from getHeaders()`
					);
					console.log(
						`[Upload Debug] Content-Type: ${uploadHeaders["Content-Type"] || uploadHeaders["content-type"] || "not set"}`
					);
					console.log(
						`[Upload Debug] Body buffer size: ${uploadBody.length} bytes`
					);

					// Use native fetch to avoid axios modifications
					// Convert Buffer to Uint8Array for fetch API
					const bodyArray = new Uint8Array(uploadBody);
					const fetchResponse = await fetch(stagedTarget.url, {
						method: "POST",
						body: bodyArray,
						headers: uploadHeaders,
					});

					const responseData = await fetchResponse.text();
					uploadResponse = {
						status: fetchResponse.status,
						statusText: fetchResponse.statusText,
						data: responseData,
					};
				} else {
					// Fallback to axios if we don't have buffer + headers
					console.log(
						`[Upload Debug] WARNING: Falling back to axios - buffer: ${uploadBody instanceof Buffer}, headers: ${Object.keys(uploadHeaders).length > 0}`
					);
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

				console.log(
					`[Upload Debug] Upload successful: HTTP ${uploadResponse.status} ${uploadResponse.statusText}`
				);
				lastError = null;
				break; // Success, exit retry loop
			} catch (axiosError) {
				// Enhanced error logging for debugging
				if (axios.isAxiosError(axiosError)) {
					const errorDetails = {
						message: axiosError.message,
						status: axiosError.response?.status,
						statusText: axiosError.response?.statusText,
						responseData:
							axiosError.response?.data &&
							typeof axiosError.response.data === "string"
								? axiosError.response.data.substring(0, 500)
								: String(axiosError.response?.data).substring(0, 500),
						headers: axiosError.response?.headers,
					};
					console.error(
						`[Upload Debug] Axios error on attempt ${attempt}/${MAX_RETRIES}:`,
						JSON.stringify(errorDetails, null, 2)
					);
					lastError = axiosError;
				} else {
					const errorDetails =
						axiosError instanceof Error
							? {
									name: axiosError.name,
									message: axiosError.message,
									stack: axiosError.stack,
								}
							: { error: String(axiosError) };
					console.error(
						`[Upload Debug] Unknown error on attempt ${attempt}/${MAX_RETRIES}:`,
						JSON.stringify(errorDetails, null, 2)
					);
					lastError =
						axiosError instanceof Error
							? axiosError
							: new Error(String(axiosError));
				}

				// Re-throw to be handled by retry logic
				throw axiosError;
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
					`Upload timeout: File upload to Shopify took longer than 5 minutes. This may indicate a network issue or the file is too large. URL: ${stagedTarget.url}`
				);
			}

			// Retry on network errors (transient failures)
			if (attempt < MAX_RETRIES) {
				const waitTime = attempt * 1000; // Exponential backoff: 1s, 2s, 3s
				console.log(
					`[Upload] Network error (attempt ${attempt}/${MAX_RETRIES}): ${errorMessage}. Retrying in ${waitTime}ms...`
				);
				await new Promise((resolve) => setTimeout(resolve, waitTime));
				continue;
			}

			// Final attempt failed
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

		// Log the staged upload URL and parameters for debugging (without sensitive values)
		console.error(
			`[Upload Error] Failed to upload to staged URL: ${stagedTarget.url.substring(0, 100)}...`
		);
		console.error(
			`[Upload Error] Parameters: ${stagedTarget.parameters.map((p: { name: string; value: string }) => p.name).join(", ")}`
		);
		console.error(
			`[Upload Error] Response status: ${statusCode} ${statusText}`
		);
		console.error(
			`[Upload Error] Response data: ${typeof uploadResponse.data === "string" ? uploadResponse.data.substring(0, 500) : JSON.stringify(uploadResponse.data).substring(0, 500)}`
		);

		const errorDetails =
			typeof uploadResponse.data === "string"
				? uploadResponse.data.substring(0, 1000)
				: String(uploadResponse.data).substring(0, 1000);

		throw new Error(
			`Failed to upload file to staged URL: HTTP ${statusCode}: ${statusText} - ${errorDetails}`
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
						alt: shopConfig?.altTextPrefix
							? `${shopConfig.altTextPrefix} ${assetInfo.description || assetInfo.name}`.trim()
							: assetInfo.description || assetInfo.name,
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
