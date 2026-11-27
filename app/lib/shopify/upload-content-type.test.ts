import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action as bulkUploadAction } from "../../routes/app.upload.js";
import { authenticate } from "../../shopify.server.js";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import { uploadBufferToShopify, uploadBynderAsset } from "./files.js";
import { setBynderMetafields } from "./metafields.js";

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

vi.mock("./metafields.js", () => ({
	setBynderMetafields: vi.fn().mockResolvedValue(undefined),
	setFileTags: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Spec for the missing content-type allowlist on Shopify Files uploads.
 * Dangerous bodies must be rejected before stagedUploadsCreate, the staged
 * PUT, or fileCreate. These tests fail until that check exists.
 *
 * Callers that only forward into uploadBynderAsset (same bytes and type):
 * app/lib/sync/auto-sync.ts, app/lib/sync/worker.ts,
 * app/lib/sync/single-asset-sync.ts, app/routes/api.sync.tsx.
 */

const BYNDER_DOWNLOAD_URL =
	"https://cdn.example.test/api/v4/media/asset-1/download";
const S3_FILE_URL = "https://cdn.example.test/s3/asset-1.bin";
const STAGED_PUT_URL =
	"https://storage.example/upload?X-Goog-Algorithm=GOOG4-RSA-SHA256";
const STAGED_RESOURCE_URL = "https://cdn.shopify.com/staged/resource";
const CREATED_FILE_URL = "https://cdn.shopify.com/files/photo.jpg";

const jpegBytes = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff,
	0xd9,
]);

const pngBytes = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const svgBytes = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
	"utf8"
);

const xmlSvgBytes = Buffer.from(
	'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
	"utf8"
);

const htmlBytes = Buffer.from(
	"<!DOCTYPE html><html><head><title>x</title></head><body><script>alert(1)</script></body></html>",
	"utf8"
);

type CapturedUpload = {
	contentType: string | null;
	body: Buffer;
};

type DownloadBody = {
	bytes: Buffer;
	contentType: string;
};

const uploads: CapturedUpload[] = [];
let s3Downloads: DownloadBody[] = [];
let directDownloads: DownloadBody[] = [];

const admin: AdminApi = {
	graphql: vi.fn(),
};

const bynderClient = {
	getMediaInfo: vi.fn(),
	getMediaDownloadUrl: vi.fn(),
	config: {
		baseURL: "https://cdn.example.test/api",
	},
} as unknown as BynderClient;

function asArrayBuffer(bytes: Buffer): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function httpResponse(bytes: Buffer, contentType: string) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "content-type" ? contentType : null,
		},
		arrayBuffer: async (): Promise<ArrayBuffer> => asArrayBuffer(bytes),
		json: async (): Promise<unknown> => JSON.parse(bytes.toString("utf8")),
		text: async (): Promise<string> => bytes.toString("utf8"),
	};
}

function jsonRedirect(s3Url: string) {
	const payload = JSON.stringify({ s3_file: s3Url });
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "content-type" ? "application/json" : null,
		},
		json: async (): Promise<{ s3_file: string }> => ({ s3_file: s3Url }),
		arrayBuffer: async (): Promise<ArrayBuffer> =>
			asArrayBuffer(Buffer.from(payload)),
		text: async (): Promise<string> => payload,
	};
}

function installFetch() {
	uploads.length = 0;
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;

		if (url === STAGED_PUT_URL) {
			const headers = new Headers(init?.headers);
			const raw = init?.body;
			const body =
				raw instanceof Uint8Array
					? Buffer.from(raw)
					: Buffer.from(typeof raw === "string" ? raw : "");
			uploads.push({
				contentType: headers.get("content-type"),
				body,
			});
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				text: async (): Promise<string> => "",
			};
		}

		if (url === BYNDER_DOWNLOAD_URL) {
			const next = directDownloads.shift();
			if (!next) {
				throw new Error("Unexpected extra download of the Bynder URL");
			}
			if (next.contentType.includes("application/json")) {
				return jsonRedirect(S3_FILE_URL);
			}
			return httpResponse(next.bytes, next.contentType);
		}

		if (url === S3_FILE_URL) {
			const next = s3Downloads.shift();
			if (!next) {
				throw new Error("Unexpected extra download of the S3 URL");
			}
			return httpResponse(next.bytes, next.contentType);
		}

		throw new Error(`Unexpected fetch: ${url}`);
	}) as unknown as typeof fetch;
}

function installShopifyAccept() {
	vi.mocked(admin.graphql).mockImplementation(async (query: string) => {
		if (query.includes("stagedUploadsCreate")) {
			return {
				json: async () => ({
					data: {
						stagedUploadsCreate: {
							stagedTargets: [
								{
									resourceUrl: STAGED_RESOURCE_URL,
									url: STAGED_PUT_URL,
									parameters: [{ name: "key", value: "tmp/key" }],
								},
							],
							userErrors: [],
						},
					},
				}),
			} as unknown as Response;
		}

		if (query.includes("fileCreate")) {
			return {
				json: async () => ({
					data: {
						fileCreate: {
							files: [
								{
									id: "gid://shopify/MediaImage/1",
									fileStatus: "READY",
									image: { url: CREATED_FILE_URL },
									url: CREATED_FILE_URL,
								},
							],
							userErrors: [],
						},
					},
				}),
			} as unknown as Response;
		}

		return {
			json: async () => ({ data: {} }),
		} as unknown as Response;
	});
}

function queueS3(contentType: string, bytes: Buffer) {
	directDownloads = [
		{ bytes: Buffer.from("{}"), contentType: "application/json" },
	];
	s3Downloads = [{ bytes, contentType }];
}

function queueDirect(contentType: string, bytes: Buffer) {
	directDownloads = [{ bytes, contentType }];
	s3Downloads = [];
}

async function syncAsset() {
	return uploadBynderAsset(admin, bynderClient, "asset-1", "shop-1", "auto", {
		syncTags: "shopify-sync",
	});
}

async function expectSyncRejected() {
	let thrown: unknown = null;
	try {
		await syncAsset();
	} catch (error) {
		thrown = error;
	}

	expect(
		thrown,
		"sync must reject before creating a Shopify file"
	).toBeInstanceOf(Error);
	expect(admin.graphql).not.toHaveBeenCalled();
	expect(uploads).toEqual([]);
	expect(setBynderMetafields).not.toHaveBeenCalled();
}

function expectStagedUpload(bytes: Buffer, mimeType: string) {
	expect(uploads).toEqual([{ contentType: mimeType, body: bytes }]);
	const stagedCall = vi
		.mocked(admin.graphql)
		.mock.calls.find((call) => String(call[0]).includes("stagedUploadsCreate"));
	expect(stagedCall?.[1]?.variables).toMatchObject({
		input: [{ mimeType, resource: "IMAGE" }],
	});
	const createCall = vi
		.mocked(admin.graphql)
		.mock.calls.find((call) => String(call[0]).includes("fileCreate"));
	expect(createCall?.[1]?.variables).toMatchObject({
		files: [{ originalSource: STAGED_RESOURCE_URL }],
	});
}

describe("upload content type allowlist", () => {
	beforeEach(() => {
		process.env.ENABLE_METRICS = "false";
		vi.clearAllMocks();
		installFetch();
		installShopifyAccept();
		vi.mocked(bynderClient.getMediaInfo).mockResolvedValue({
			id: "asset-1",
			name: "photo.jpg",
			description: "photo",
			type: "image",
			tags: ["shopify-sync"],
			dateModified: "2026-01-01T00:00:00.000Z",
			dateCreated: "2026-01-01T00:00:00.000Z",
			version: 1,
			derivatives: {},
			thumbnails: {},
			files: [],
		});
		vi.mocked(bynderClient.getMediaDownloadUrl).mockResolvedValue(
			BYNDER_DOWNLOAD_URL
		);
	});

	describe("Bynder sync download", () => {
		it("rejects an SVG body served as image/svg+xml", async () => {
			queueS3("image/svg+xml", svgBytes);
			await expectSyncRejected();
		});

		it("rejects an SVG body when the type includes a charset parameter", async () => {
			queueS3("image/svg+xml; charset=utf-8", svgBytes);
			await expectSyncRejected();
		});

		it("rejects an SVG body when the type uses different letter case", async () => {
			queueS3("Image/SVG+XML", svgBytes);
			await expectSyncRejected();
		});

		it("rejects HTML served as text/html", async () => {
			queueS3("text/html", htmlBytes);
			await expectSyncRejected();
		});

		it("rejects HTML when the type uses different letter case", async () => {
			queueS3("Text/HTML; charset=utf-8", htmlBytes);
			await expectSyncRejected();
		});

		it("rejects a direct file URL whose response type is image/svg+xml", async () => {
			queueDirect("image/svg+xml", svgBytes);
			await expectSyncRejected();
		});

		it("rejects a wildcard image response whose bytes contain an svg marker", async () => {
			queueS3("image/*", svgBytes);
			await expectSyncRejected();
		});

		it("rejects a wildcard image response whose bytes contain an xml marker", async () => {
			queueS3("image/*", xmlSvgBytes);
			await expectSyncRejected();
		});

		it("rejects a wildcard image response of HTML instead of labeling it jpeg", async () => {
			queueS3("image/*", htmlBytes);
			await expectSyncRejected();
		});

		it("rejects HTML bytes presented as image/jpeg", async () => {
			queueS3("image/jpeg", htmlBytes);
			await expectSyncRejected();
		});

		it("rejects SVG bytes presented as image/jpeg", async () => {
			queueS3("image/jpeg", svgBytes);
			await expectSyncRejected();
		});

		it("rejects HTML bytes presented as application/pdf", async () => {
			queueS3("application/pdf", htmlBytes);
			await expectSyncRejected();
		});

		it("rejects a declared image type that does not match the detected bytes", async () => {
			queueS3("image/png", jpegBytes);
			await expectSyncRejected();
		});

		it("uploads the jpeg from the download that was checked when a later download differs", async () => {
			directDownloads = [
				{ bytes: Buffer.from("{}"), contentType: "application/json" },
			];
			s3Downloads = [
				{ bytes: jpegBytes, contentType: "image/jpeg" },
				{ bytes: svgBytes, contentType: "image/svg+xml" },
			];

			const result = await syncAsset();

			expect(result).toMatchObject({
				fileId: "gid://shopify/MediaImage/1",
				fileUrl: CREATED_FILE_URL,
			});
			expectStagedUpload(jpegBytes, "image/jpeg");
			expect(setBynderMetafields).toHaveBeenCalledWith(
				admin,
				"gid://shopify/MediaImage/1",
				expect.objectContaining({ assetId: "asset-1" })
			);
			expect(s3Downloads).toHaveLength(1);
		});

		it("uploads a jpeg downloaded through the Bynder s3 redirect", async () => {
			queueS3("image/jpeg", jpegBytes);
			const result = await syncAsset();
			expect(result.fileUrl).toBe(CREATED_FILE_URL);
			expectStagedUpload(jpegBytes, "image/jpeg");
			expect(setBynderMetafields).toHaveBeenCalledOnce();
		});

		it("uploads a png when the response type matches the png bytes", async () => {
			queueS3("image/png", pngBytes);
			await syncAsset();
			expectStagedUpload(pngBytes, "image/png");
			expect(setBynderMetafields).toHaveBeenCalledOnce();
		});

		it("uploads a wildcard image response as the detected jpeg type", async () => {
			queueS3("image/*", jpegBytes);
			await syncAsset();
			expectStagedUpload(jpegBytes, "image/jpeg");
			expect(setBynderMetafields).toHaveBeenCalledOnce();
		});
	});

	describe("uploadBufferToShopify", () => {
		async function expectBufferRejected(bytes: Buffer, contentType: string) {
			let thrown: unknown = null;
			try {
				await uploadBufferToShopify(
					admin,
					bytes,
					contentType,
					"photo.jpg",
					"photo.jpg",
					"shop-1"
				);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(Error);
			expect(admin.graphql).not.toHaveBeenCalled();
			expect(uploads).toEqual([]);
		}

		it("rejects HTML and SVG content types before calling Shopify", async () => {
			await expectBufferRejected(htmlBytes, "text/html");
			vi.clearAllMocks();
			installShopifyAccept();
			await expectBufferRejected(svgBytes, "image/svg+xml");
			vi.clearAllMocks();
			installShopifyAccept();
			await expectBufferRejected(htmlBytes, "application/xhtml+xml");
		});

		it("rejects caller-supplied types that do not match the bytes", async () => {
			await expectBufferRejected(htmlBytes, "image/jpeg");
			vi.clearAllMocks();
			installShopifyAccept();
			await expectBufferRejected(svgBytes, "image/png");
			vi.clearAllMocks();
			installShopifyAccept();
			await expectBufferRejected(jpegBytes, "image/png");
			vi.clearAllMocks();
			installShopifyAccept();
			await expectBufferRejected(svgBytes, "application/octet-stream");
		});

		it("uploads jpeg bytes only with the detected image/jpeg type", async () => {
			const result = await uploadBufferToShopify(
				admin,
				jpegBytes,
				"image/jpeg",
				"photo.jpg",
				"photo.jpg",
				"shop-1"
			);
			expect(result.fileId).toBe("gid://shopify/MediaImage/1");
			expectStagedUpload(jpegBytes, "image/jpeg");
			expect(setBynderMetafields).not.toHaveBeenCalled();
		});

		it("replaces an unspecified octet-stream label with the detected jpeg type", async () => {
			await uploadBufferToShopify(
				admin,
				jpegBytes,
				"application/octet-stream",
				"photo.jpg",
				"photo.jpg",
				"shop-1"
			);
			expectStagedUpload(jpegBytes, "image/jpeg");
		});
	});

	describe("bulk upload action", () => {
		beforeEach(() => {
			vi.mocked(authenticate.admin).mockResolvedValue({
				admin,
				session: { shop: "shop-1.myshopify.com" },
			} as unknown as Awaited<ReturnType<typeof authenticate.admin>>);
		});

		function uploadRequest(bytes: Buffer, name: string, type: string) {
			const file = new File([new Uint8Array(bytes)], name, { type });
			const form = new FormData();
			form.set("file", file);
			form.set("folder", "");
			form.set("tags", "");
			form.set("useAiAltText", "false");
			return new Request("https://app.example.test/app/upload", {
				method: "POST",
				body: form,
			});
		}

		async function runUpload(bytes: Buffer, name: string, type: string) {
			const request = uploadRequest(bytes, name, type);
			return (await bulkUploadAction({
				request,
			} as unknown as ActionFunctionArgs)) as {
				data: { error?: string; success?: boolean; fileId?: string };
				init: { status?: number } | null;
			};
		}

		async function expectActionRejected(
			bytes: Buffer,
			name: string,
			type: string
		) {
			const result = await runUpload(bytes, name, type);
			expect(result.data.success).not.toBe(true);
			expect(result.data.error).toEqual(expect.any(String));
			expect(result.init?.status).toBeGreaterThanOrEqual(400);
			expect(admin.graphql).not.toHaveBeenCalled();
			expect(uploads).toEqual([]);
		}

		it("rejects an HTML post that bypasses the browser file filter", async () => {
			await expectActionRejected(htmlBytes, "page.html", "text/html");
		});

		it("rejects an SVG post", async () => {
			await expectActionRejected(svgBytes, "logo.svg", "image/svg+xml");
		});

		it("rejects HTML bytes labeled image/jpeg", async () => {
			await expectActionRejected(htmlBytes, "photo.jpg", "image/jpeg");
		});

		it("rejects SVG bytes labeled image/jpeg", async () => {
			await expectActionRejected(svgBytes, "photo.jpg", "image/jpeg");
		});

		it("rejects SVG bytes labeled application/octet-stream", async () => {
			await expectActionRejected(
				svgBytes,
				"logo.svg",
				"application/octet-stream"
			);
		});

		it("uploads a real jpeg with image/jpeg", async () => {
			const result = await runUpload(jpegBytes, "photo.jpg", "image/jpeg");
			expect(result.data).toMatchObject({
				success: true,
				fileId: "gid://shopify/MediaImage/1",
			});
			expectStagedUpload(jpegBytes, "image/jpeg");
		});
	});
});
