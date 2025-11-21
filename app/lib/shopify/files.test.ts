import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import { uploadBynderAsset } from "./files.js";

vi.mock("./metafields.js", () => ({
	setBynderMetafields: vi.fn().mockResolvedValue(undefined),
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

		// Mock file download
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(8),
			headers: {
				get: () => "image/jpeg",
			},
		});

		// Mock Shopify GraphQL response
		(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
			json: async () => ({
				data: {
					filesCreate: {
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
		expect(mockAdmin.graphql).toHaveBeenCalled();

		// Verify file name follows campaigns/{tag}/{filename} convention
		const graphqlCall = (mockAdmin.graphql as ReturnType<typeof vi.fn>).mock
			.calls[0];
		expect(graphqlCall).toBeDefined();
		const variables = graphqlCall?.[1]?.variables;
		expect(variables?.files?.[0]?.filename).toMatch(
			/^campaigns\/campaign-summer\/test-image\.jpg$/
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

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(8),
			headers: {
				get: () => "image/jpeg",
			},
		});

		(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
			json: async () => ({
				data: {
					filesCreate: {
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
		const graphqlCall = (mockAdmin.graphql as ReturnType<typeof vi.fn>).mock
			.calls[0];
		expect(graphqlCall).toBeDefined();
		const variables = graphqlCall?.[1]?.variables;
		expect(variables?.files?.[0]?.filename).toMatch(
			/^campaigns\/shopify-sync\/test-image\.jpg$/
		);
	});
});
