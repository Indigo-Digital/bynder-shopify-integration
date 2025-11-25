import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import { uploadBynderAsset } from "./files.js";

vi.mock("./metafields.js", () => ({
	setBynderMetafields: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("axios", () => ({
	default: {
		post: vi.fn(),
		isAxiosError: vi.fn((error) => error?.isAxiosError === true),
	},
}));

describe("uploadBynderAsset", () => {
	const mockAdmin: AdminApi = {
		graphql: vi.fn(),
		rest: {
			resources: {},
		},
	};

	const mockBynderClient = {
		getMediaInfo: vi.fn(),
		getMediaDownloadUrl: vi.fn(),
		config: {
			baseURL: "https://test.bynder.com/api",
			permanentToken: "test-token",
		},
	} as unknown as BynderClient;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should upload asset with correct naming convention", async () => {
		const assetId = "test-asset-123";
		const shopId = "test-shop-id";

		// Mock Bynder responses
		mockBynderClient.getMediaInfo = vi.fn().mockResolvedValue({
			id: assetId,
			name: "test-image.jpg",
			tags: ["campaign-summer", "shopify-sync"],
			version: 1,
		});

		mockBynderClient.getMediaDownloadUrl = vi
			.fn()
			.mockResolvedValue(
				"https://test.bynder.com/api/v4/media/test-asset-123/download"
			);

		// Mock file download from Bynder
		const mockFetch = vi.fn();
		global.fetch = mockFetch;

		// First fetch: Download from Bynder
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(8),
			headers: {
				get: () => "image/jpeg",
			},
		});

		// Mock axios for upload to staged URL
		(axios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			status: 200,
			statusText: "OK",
			data: "",
		});

		// Mock Shopify GraphQL responses
		// First call: stagedUploadsCreate
		// Second call: fileCreate
		(mockAdmin.graphql as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				json: async () => ({
					data: {
						stagedUploadsCreate: {
							stagedTargets: [
								{
									resourceUrl: "https://shopify.com/staged-upload/resource-url",
									url: "https://shopify.com/staged-upload/upload-url",
									parameters: [
										{ name: "key", value: "test-key" },
										{ name: "policy", value: "test-policy" },
									],
								},
							],
							userErrors: [],
						},
					},
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({
					data: {
						fileCreate: {
							files: [
								{
									id: "gid://shopify/File/123",
									fileStatus: "READY",
									image: {
										url: "https://cdn.shopify.com/test.jpg",
									},
								},
							],
							userErrors: [],
						},
					},
				}),
			});

		const result = await uploadBynderAsset(
			mockAdmin,
			mockBynderClient,
			assetId,
			shopId
		);

		expect(result.fileId).toBe("gid://shopify/File/123");
		expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

		// Verify staged upload was called with correct resource type
		const stagedUploadCall = (mockAdmin.graphql as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		expect(stagedUploadCall).toBeDefined();
		const stagedUploadVariables = stagedUploadCall?.[1]?.variables;
		expect(stagedUploadVariables?.input?.[0]?.resource).toBe("IMAGE");
		// Staged upload should use just the filename, not the full path
		expect(stagedUploadVariables?.input?.[0]?.filename).toBe("test-image.jpg");

		// Verify fileCreate was called with resourceUrl
		const fileCreateCall = (mockAdmin.graphql as ReturnType<typeof vi.fn>).mock
			.calls[1];
		expect(fileCreateCall).toBeDefined();
		const fileCreateVariables = fileCreateCall?.[1]?.variables;
		expect(fileCreateVariables?.files?.[0]?.originalSource).toBe(
			"https://shopify.com/staged-upload/resource-url"
		);
	});

	it("should handle missing tags gracefully", async () => {
		const assetId = "test-asset-456";
		const shopId = "test-shop-id";

		mockBynderClient.getMediaInfo = vi.fn().mockResolvedValue({
			id: assetId,
			name: "test-image.jpg",
			tags: [],
			version: 1,
		});

		mockBynderClient.getMediaDownloadUrl = vi
			.fn()
			.mockResolvedValue(
				"https://test.bynder.com/api/v4/media/test-asset-456/download"
			);

		// Mock file download from Bynder
		const mockFetch = vi.fn();
		global.fetch = mockFetch;

		// First fetch: Download from Bynder
		mockFetch.mockResolvedValueOnce({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(8),
			headers: {
				get: () => "image/jpeg",
			},
		});

		// Mock axios for upload to staged URL
		(axios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			status: 200,
			statusText: "OK",
			data: "",
		});

		// Mock Shopify GraphQL responses
		// First call: stagedUploadsCreate
		// Second call: fileCreate
		(mockAdmin.graphql as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				json: async () => ({
					data: {
						stagedUploadsCreate: {
							stagedTargets: [
								{
									resourceUrl: "https://shopify.com/staged-upload/resource-url",
									url: "https://shopify.com/staged-upload/upload-url",
									parameters: [
										{ name: "key", value: "test-key" },
										{ name: "policy", value: "test-policy" },
									],
								},
							],
							userErrors: [],
						},
					},
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({
					data: {
						fileCreate: {
							files: [
								{
									id: "gid://shopify/File/456",
									fileStatus: "READY",
									image: {
										url: "https://cdn.shopify.com/test.jpg",
									},
								},
							],
							userErrors: [],
						},
					},
				}),
			});

		const result = await uploadBynderAsset(
			mockAdmin,
			mockBynderClient,
			assetId,
			shopId
		);

		expect(result.fileId).toBe("gid://shopify/File/456");

		// Should use default tag when no tags provided
		const stagedUploadCall = (mockAdmin.graphql as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		expect(stagedUploadCall).toBeDefined();
		const stagedUploadVariables = stagedUploadCall?.[1]?.variables;
		// Staged upload should use just the filename, not the full path
		expect(stagedUploadVariables?.input?.[0]?.filename).toBe("test-image.jpg");

		// Verify fileCreate uses the full path
		const fileCreateCall = (mockAdmin.graphql as ReturnType<typeof vi.fn>).mock
			.calls[1];
		expect(fileCreateCall).toBeDefined();
		const fileCreateVariables = fileCreateCall?.[1]?.variables;
		expect(fileCreateVariables?.files?.[0]?.filename).toMatch(
			/^campaigns\/shopify-sync\/test-image\.jpg$/
		);
	});
});
