import axios from "axios";
import FormData from "form-data";
import type { BynderClient } from "../bynder/client.js";
import type { BynderMediaInfoResponse } from "../bynder/types.js";
import { recordApiCall } from "../metrics/collector.js";
import type { AdminApi } from "../types.js";
import { generateFilePath, type TemplateContext } from "./file-template.js";
import { setBynderMetafields } from "./metafields.js";

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

	// Log download success with actual file details
	console.log(
		`[Download] Successfully downloaded file: ${buffer.length} bytes, Content-Type: ${responseContentType}`
	);

	return { buffer, contentType: responseContentType };
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
	// Track Shopify API call
	await recordApiCall(
		shopId,
		"shopify_stagedUploadsCreate",
		shopConfig?.syncJobId
	);
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
	console.log(`[Upload Debug] URL pathname: ${urlObj.pathname}`);
	console.log(`[Upload Debug] URL query params: ${urlObj.search}`);
	console.log(
		`[Upload Debug] URL query param keys: ${Array.from(urlObj.searchParams.keys()).join(", ") || "none"}`
	);
	console.log(
		`[Upload Debug] Staged upload parameters count: ${stagedTarget.parameters.length}`
	);
	console.log(
		`[Upload Debug] Staged upload parameter names: ${stagedTarget.parameters.map((p: { name: string }) => p.name).join(", ")}`
	);
	// Log all parameters with their values (truncated for security)
	for (const param of stagedTarget.parameters) {
		const valuePreview =
			param.value.length > 100
				? `${param.value.substring(0, 100)}... (${param.value.length} chars)`
				: param.value;
		console.log(`[Upload Debug] Parameter "${param.name}": ${valuePreview}`);
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

	// Helper function to create FormData for upload
	// Explicitly use form-data package to ensure getHeaders() and getBuffer() are available
	// CRITICAL: Parameters must be added in the exact order Shopify provides them
	// The file MUST be added last - this is critical for GCS signature validation
	const createFormData = (): FormData => {
		const retryFormData = new FormData();

		// We're explicitly using form-data package, so it always has getHeaders() and getBuffer()
		const retryIsPolyfill = true;

		// Log parameters being added (for debugging signature issues)
		console.log(
			`[Upload Debug] Creating FormData with ${stagedTarget.parameters.length} parameters + file`
		);
		console.log(
			`[Upload Debug] Parameter order: ${stagedTarget.parameters.map((p: { name: string }) => p.name).join(" -> ")} -> file`
		);

		// Add parameters from staged upload in the EXACT order Shopify provides
		// This order is critical for GCS signature validation
		for (let i = 0; i < stagedTarget.parameters.length; i++) {
			const param = stagedTarget.parameters[i];
			retryFormData.append(param.name, param.value);
			const valuePreview =
				param.value.length > 80
					? `${param.value.substring(0, 80)}...`
					: param.value;
			console.log(
				`[Upload Debug] Added parameter ${i + 1}/${stagedTarget.parameters.length}: "${param.name}" = "${valuePreview}"`
			);
		}

		// Add the file last - this is CRITICAL for S3/GCS uploads
		// Shopify's documentation explicitly states the file must be the last parameter
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
				`[Upload Debug] Added file (last): "${sanitizedStagedFilename}", size: ${buffer.length} bytes, contentType: ${contentType}`
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
				`[Upload Debug] Added file (last): "${sanitizedStagedFilename}", size: ${buffer.length} bytes, contentType: ${contentType}`
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
					// CRITICAL: Call getHeaders() FIRST on the SAME FormData instance to lock in the boundary
					// Then call getBuffer() on the SAME instance to get the body with that exact boundary
					// The boundary in Content-Type MUST exactly match the boundary used in the body
					console.log(
						`[Upload Debug] Calling getHeaders() FIRST to lock in multipart boundary`
					);
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

					// Extract and log the boundary from Content-Type
					const contentTypeHeader =
						uploadHeaders["Content-Type"] || uploadHeaders["content-type"];
					if (contentTypeHeader) {
						const boundaryMatch = contentTypeHeader.match(/boundary=([^;]+)/);
						if (boundaryMatch) {
							console.log(
								`[Upload Debug] Content-Type boundary: ${boundaryMatch[1]}`
							);
						}
					}

					// Get the buffer (uses the boundary from getHeaders() on the same instance)
					console.log(
						`[Upload Debug] Calling getBuffer() on SAME FormData instance to get body with matching boundary`
					);
					const bodyBuffer = polyfillFormData.getBuffer();
					uploadBody = bodyBuffer;

					// Log comprehensive request details
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
						`[Upload Debug] Request headers: ${JSON.stringify(headersForLog, null, 2)}`
					);
					console.log(
						`[Upload Debug] Body buffer size: ${bodyBuffer.length} bytes`
					);

					// Log first and last bytes of body to verify format
					if (bodyBuffer.length > 0) {
						const firstBytes = Array.from(bodyBuffer.slice(0, 100))
							.map((b) => b.toString(16).padStart(2, "0"))
							.join(" ");
						const lastBytes = Array.from(
							bodyBuffer.slice(Math.max(0, bodyBuffer.length - 100))
						)
							.map((b) => b.toString(16).padStart(2, "0"))
							.join(" ");
						console.log(
							`[Upload Debug] Body first 100 bytes (hex): ${firstBytes}`
						);
						console.log(
							`[Upload Debug] Body last 100 bytes (hex): ${lastBytes}`
						);

						// Check if body starts with boundary marker
						const bodyStart = bodyBuffer.toString(
							"utf8",
							0,
							Math.min(200, bodyBuffer.length)
						);
						if (bodyStart.includes("--")) {
							const boundaryInBody = bodyStart.match(/^--([^\r\n]+)/);
							if (boundaryInBody) {
								console.log(
									`[Upload Debug] Boundary in body start: ${boundaryInBody[1]}`
								);
							}
						}
					}
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

			// CRITICAL: For GCS signed URLs, the request body (multipart form) must match exactly what was signed
			// The signature is calculated based on:
			// 1. HTTP method (POST)
			// 2. Canonical URI (path)
			// 3. Canonical query string (from URL)
			// 4. Canonical headers (host header)
			// 5. Signed headers (host)
			// 6. Payload hash (UNSIGNED-PAYLOAD means hash is not included, but format still matters)
			try {
				// Log comprehensive request details before sending
				// Use console.error() so logs appear in production (console.log() may be filtered)
				const uploadUrlObj = new URL(stagedTarget.url);
				console.error(`[Upload Debug] ===== UPLOAD REQUEST DETAILS =====`);
				console.error(`[Upload Debug] Full URL: ${stagedTarget.url}`);
				console.error(`[Upload Debug] URL pathname: ${uploadUrlObj.pathname}`);
				console.error(
					`[Upload Debug] URL query string: ${uploadUrlObj.search || "(none)"}`
				);
				if (uploadUrlObj.search) {
					console.error(
						`[Upload Debug] URL query param keys: ${Array.from(uploadUrlObj.searchParams.keys()).join(", ")}`
					);
					// Log query param values (truncated)
					for (const [key, value] of uploadUrlObj.searchParams.entries()) {
						const valuePreview =
							value.length > 80 ? `${value.substring(0, 80)}...` : value;
						console.error(
							`[Upload Debug]   Query param "${key}": "${valuePreview}"`
						);
					}
				}
				console.error(`[Upload Debug] HTTP Method: POST`);
				console.error(
					`[Upload Debug] Request headers count: ${Object.keys(uploadHeaders).length}`
				);
				for (const [key, value] of Object.entries(uploadHeaders)) {
					if (key.toLowerCase() === "content-type") {
						console.error(`[Upload Debug]   Header "${key}": ${value}`);
					} else {
						const valuePreview =
							value.length > 100 ? `${value.substring(0, 100)}...` : value;
						console.error(
							`[Upload Debug]   Header "${key}": "${valuePreview}"`
						);
					}
				}
				console.error(
					`[Upload Debug] Body type: ${uploadBody instanceof Buffer ? "Buffer" : "FormData"}`
				);
				if (uploadBody instanceof Buffer) {
					console.error(`[Upload Debug] Body size: ${uploadBody.length} bytes`);
					// Log first 500 bytes of body to verify multipart format
					const bodyStart = uploadBody.toString(
						"utf8",
						0,
						Math.min(500, uploadBody.length)
					);
					console.error(
						`[Upload Debug] Body start (first 500 bytes): ${bodyStart}`
					);
					// Extract boundary from Content-Type header
					const contentType =
						uploadHeaders["Content-Type"] ||
						uploadHeaders["content-type"] ||
						"";
					const boundaryMatch = contentType.match(/boundary=([^;]+)/);
					if (boundaryMatch?.[1]) {
						const boundary = boundaryMatch[1].trim();
						console.error(`[Upload Debug] Content-Type boundary: ${boundary}`);
						// Verify boundary appears in body
						if (bodyStart.includes(boundary)) {
							console.error(
								`[Upload Debug] ✓ Boundary found in body (matches Content-Type)`
							);
						} else {
							console.error(
								`[Upload Debug] ✗ Boundary NOT found in body - MISMATCH!`
							);
						}
					}
				}
				// Count FormData entries - form-data package doesn't have entries() method
				const polyfillFormDataForCount = formData as unknown as {
					_streams?: unknown[];
					_length?: number;
				};
				const formDataEntryCount =
					polyfillFormDataForCount._streams?.length ||
					polyfillFormDataForCount._length ||
					0;
				console.error(
					`[Upload Debug] FormData entries count: ${formDataEntryCount} (${stagedTarget.parameters.length} params + 1 file)`
				);
				console.error(`[Upload Debug] ====================================`);

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

				// CRITICAL: For GCS signed URLs, we MUST use Buffer + headers from form-data polyfill
				// The boundary in Content-Type MUST exactly match the body format
				// We cannot pass FormData directly to fetch because fetch might generate a different boundary
				// Always use getBuffer() + getHeaders() to ensure boundary consistency
				if (
					uploadBody instanceof Buffer &&
					Object.keys(uploadHeaders).length > 0
				) {
					console.error(
						`[Upload Debug] Using form-data polyfill Buffer + headers (required for GCS signature)`
					);
					console.error(
						`[Upload Debug] Content-Type header from getHeaders(): ${uploadHeaders["Content-Type"] || uploadHeaders["content-type"] || "NOT SET"}`
					);
					console.error(
						`[Upload Debug] Body buffer size: ${uploadBody.length} bytes`
					);

					// Use native fetch to avoid any modifications by HTTP clients
					// Convert Buffer to Uint8Array for fetch API compatibility
					const bodyArray = new Uint8Array(uploadBody);

					// CRITICAL: Always include Content-Type header from getHeaders()
					// The boundary in Content-Type MUST match the boundary in the Buffer body
					// Even though only 'host' is signed (X-Goog-SignedHeaders=host), Content-Type is required
					// for multipart/form-data to work correctly
					const fetchHeaders: HeadersInit = {};
					for (const [key, value] of Object.entries(uploadHeaders)) {
						fetchHeaders[key] = value;
					}
					console.error(
						`[Upload Debug] Using Content-Type header from getHeaders() with boundary matching Buffer`
					);

					// CRITICAL: For GCS signed URLs, DO NOT add Content-Length manually
					// GCS will calculate it from the body, and adding it manually might break the signature
					if (
						fetchHeaders["Content-Length"] ||
						fetchHeaders["content-length"]
					) {
						console.error(
							`[Upload Debug] WARNING: Content-Length header present - removing it`
						);
						delete fetchHeaders["Content-Length"];
						delete fetchHeaders["content-length"];
					}

					console.error(
						`[Upload Debug] Sending POST request to: ${stagedTarget.url}`
					);
					console.error(
						`[Upload Debug] Final headers: ${JSON.stringify(Object.fromEntries(Object.entries(fetchHeaders).map(([k, v]) => [k, k.toLowerCase() === "content-type" ? v : typeof v === "string" && v.length > 100 ? `${v.substring(0, 100)}...` : v])), null, 2)}`
					);
					console.error(
						`[Upload Debug] Body size: ${bodyArray.length} bytes, type: ${bodyArray.constructor.name}`
					);
					const fetchResponse = await fetch(stagedTarget.url, {
						method: "POST",
						body: bodyArray,
						headers: fetchHeaders,
					});

					const responseData = await fetchResponse.text();
					console.error(
						`[Upload Debug] Response status: ${fetchResponse.status} ${fetchResponse.statusText}`
					);
					console.error(
						`[Upload Debug] Response headers: ${JSON.stringify(Object.fromEntries(fetchResponse.headers.entries()), null, 2)}`
					);
					if (responseData) {
						const responsePreview =
							responseData.length > 500
								? `${responseData.substring(0, 500)}...`
								: responseData;
						console.error(`[Upload Debug] Response body: ${responsePreview}`);
					}

					uploadResponse = {
						status: fetchResponse.status,
						statusText: fetchResponse.statusText,
						data: responseData,
					};
				}

				// If uploadResponse is not set yet, try Buffer + headers approach or axios fallback
				if (!uploadResponse) {
					if (
						uploadBody instanceof Buffer &&
						Object.keys(uploadHeaders).length > 0
					) {
						// Buffer + headers approach already handled above
						// This should not be reached, but handle it gracefully
						console.error(
							`[Upload Debug] WARNING: uploadResponse not set but Buffer + headers available - this should not happen`
						);
					} else {
						// Fallback to axios if we don't have buffer + headers
						// This should not happen when using form-data package, but handle it gracefully
						console.log(
							`[Upload Debug] WARNING: Falling back to axios - buffer: ${uploadBody instanceof Buffer}, headers: ${Object.keys(uploadHeaders).length > 0}`
						);
						if (Object.keys(uploadHeaders).length > 0) {
							axiosConfig.headers = uploadHeaders;
							console.log(
								`[Upload Debug] Using headers from getHeaders() with axios`
							);
						} else {
							console.log(
								`[Upload Debug] WARNING: No headers from getHeaders() - axios will set Content-Type automatically (may break signature)`
							);
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
				}

				if (uploadResponse) {
					console.log(
						`[Upload Debug] Upload successful: HTTP ${uploadResponse.status} ${uploadResponse.statusText}`
					);
					lastError = null;
					break; // Success, exit retry loop
				} else {
					throw new Error("uploadResponse not set after all upload attempts");
				}
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
		const errorUrlObj = new URL(stagedTarget.url);
		console.error(
			`[Upload Error] Failed to upload to staged URL: ${stagedTarget.url.substring(0, 200)}...`
		);
		console.error(`[Upload Error] URL pathname: ${errorUrlObj.pathname}`);
		console.error(
			`[Upload Error] URL query string: ${errorUrlObj.search || "(none)"}`
		);
		if (errorUrlObj.search) {
			console.error(
				`[Upload Error] URL query param keys: ${Array.from(errorUrlObj.searchParams.keys()).join(", ")}`
			);
		}
		console.error(
			`[Upload Error] Parameters from Shopify: ${stagedTarget.parameters.map((p: { name: string; value: string }) => p.name).join(", ")}`
		);
		console.error(
			`[Upload Error] Parameter count: ${stagedTarget.parameters.length}`
		);
		// Log each parameter name (not values for security)
		for (const param of stagedTarget.parameters) {
			console.error(
				`[Upload Error]   Parameter "${param.name}": value length ${param.value.length} chars`
			);
		}
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
	// Track Shopify API call
	await recordApiCall(shopId, "shopify_fileCreate", shopConfig?.syncJobId);
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
