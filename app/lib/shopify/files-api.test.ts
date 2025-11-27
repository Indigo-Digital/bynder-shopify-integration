import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApi } from "../types.js";
import {
	extractBynderTags,
	filterFiles,
	getShopifyFiles,
	type ShopifyFile,
} from "./files-api.js";

describe("files-api", () => {
	describe("getShopifyFiles", () => {
		const mockAdmin: AdminApi = {
			graphql: vi.fn(),
			rest: {
				resources: {},
			},
		};

		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("should fetch files with default options", async () => {
			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				json: async () => ({
					data: {
						files: {
							edges: [
								{
									cursor: "cursor1",
									node: {
										id: "gid://shopify/MediaImage/123",
										alt: "Test image",
										createdAt: "2024-01-01T00:00:00Z",
										updatedAt: "2024-01-01T00:00:00Z",
										fileStatus: "READY",
										mimeType: "image/jpeg",
										image: {
											url: "https://cdn.shopify.com/test.jpg",
											altText: "Test image",
											width: 800,
											height: 600,
										},
										originalSource: {
											fileSize: 12345,
										},
										metafields: {
											edges: [],
										},
									},
								},
							],
							pageInfo: {
								hasNextPage: false,
								hasPreviousPage: false,
								startCursor: "cursor1",
								endCursor: "cursor1",
							},
						},
					},
				}),
			});

			const result = await getShopifyFiles(mockAdmin);

			expect(result.files).toHaveLength(1);
			const file = result.files[0];
			expect(file).toBeDefined();
			expect(file?.id).toBe("gid://shopify/MediaImage/123");
			expect(file?.fileType).toBe("MediaImage");
			expect(file?.thumbnailUrl).toBe("https://cdn.shopify.com/test.jpg");
			expect(result.pageInfo.hasNextPage).toBe(false);
		});

		it("should parse Bynder metafields correctly", async () => {
			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				json: async () => ({
					data: {
						files: {
							edges: [
								{
									cursor: "cursor1",
									node: {
										id: "gid://shopify/MediaImage/456",
										alt: "Bynder image",
										createdAt: "2024-01-01T00:00:00Z",
										updatedAt: "2024-01-01T00:00:00Z",
										fileStatus: "READY",
										mimeType: "image/png",
										image: {
											url: "https://cdn.shopify.com/bynder.png",
											altText: "Bynder image",
											width: 1200,
											height: 800,
										},
										originalSource: {
											fileSize: 54321,
										},
										metafields: {
											edges: [
												{
													node: {
														key: "asset_id",
														value: "bynder-asset-123",
													},
												},
												{
													node: {
														key: "permalink",
														value: "https://bynder.com/asset/123",
													},
												},
												{
													node: {
														key: "tags",
														value: '["summer", "campaign"]',
													},
												},
												{
													node: {
														key: "version",
														value: "2",
													},
												},
												{
													node: {
														key: "synced_at",
														value: "2024-01-15T10:30:00Z",
													},
												},
											],
										},
									},
								},
							],
							pageInfo: {
								hasNextPage: false,
								hasPreviousPage: false,
								startCursor: "cursor1",
								endCursor: "cursor1",
							},
						},
					},
				}),
			});

			const result = await getShopifyFiles(mockAdmin);

			expect(result.files).toHaveLength(1);
			const file = result.files[0];
			expect(file).toBeDefined();
			expect(file?.bynderMetadata).not.toBeNull();
			expect(file?.bynderMetadata?.assetId).toBe("bynder-asset-123");
			expect(file?.bynderMetadata?.permalink).toBe(
				"https://bynder.com/asset/123"
			);
			expect(file?.bynderMetadata?.tags).toEqual(["summer", "campaign"]);
			expect(file?.bynderMetadata?.version).toBe(2);
			expect(file?.bynderMetadata?.syncedAt).toBe("2024-01-15T10:30:00Z");
		});

		it("should handle GenericFile type", async () => {
			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				json: async () => ({
					data: {
						files: {
							edges: [
								{
									cursor: "cursor1",
									node: {
										id: "gid://shopify/GenericFile/789",
										alt: "Document",
										createdAt: "2024-01-01T00:00:00Z",
										updatedAt: "2024-01-01T00:00:00Z",
										fileStatus: "READY",
										mimeType: "application/pdf",
										url: "https://cdn.shopify.com/document.pdf",
										originalFileSize: 999999,
									},
								},
							],
							pageInfo: {
								hasNextPage: false,
								hasPreviousPage: false,
								startCursor: "cursor1",
								endCursor: "cursor1",
							},
						},
					},
				}),
			});

			const result = await getShopifyFiles(mockAdmin);

			expect(result.files).toHaveLength(1);
			const file = result.files[0];
			expect(file).toBeDefined();
			expect(file?.fileType).toBe("GenericFile");
			expect(file?.thumbnailUrl).toBeNull();
			expect(file?.bynderMetadata).toBeNull();
		});

		it("should pass pagination cursor", async () => {
			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				json: async () => ({
					data: {
						files: {
							edges: [],
							pageInfo: {
								hasNextPage: false,
								hasPreviousPage: true,
								startCursor: null,
								endCursor: null,
							},
						},
					},
				}),
			});

			await getShopifyFiles(mockAdmin, { after: "someCursor", first: 25 });

			expect(mockAdmin.graphql).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					variables: expect.objectContaining({
						first: 25,
						after: "someCursor",
					}),
				})
			);
		});

		it("should handle GraphQL errors", async () => {
			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				json: async () => ({
					errors: [{ message: "Something went wrong" }],
				}),
			});

			await expect(getShopifyFiles(mockAdmin)).rejects.toThrow(
				"GraphQL errors"
			);
		});

		it("should handle empty response", async () => {
			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				json: async () => ({
					data: {
						files: null,
					},
				}),
			});

			const result = await getShopifyFiles(mockAdmin);

			expect(result.files).toHaveLength(0);
			expect(result.pageInfo.hasNextPage).toBe(false);
		});
	});

	describe("filterFiles", () => {
		const mockFiles: ShopifyFile[] = [
			{
				id: "1",
				alt: "Bynder image",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				fileStatus: "READY",
				fileType: "MediaImage",
				filename: "bynder-image.jpg",
				mimeType: "image/jpeg",
				fileSize: 1000,
				fileUrl: "https://cdn.shopify.com/bynder.jpg",
				thumbnailUrl: "https://cdn.shopify.com/bynder.jpg",
				width: 800,
				height: 600,
				bynderMetadata: {
					assetId: "asset-1",
					permalink: "https://bynder.com/1",
					tags: ["tag1"],
					version: 1,
					syncedAt: "2024-01-01T00:00:00Z",
				},
			},
			{
				id: "2",
				alt: "Regular image",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				fileStatus: "READY",
				fileType: "MediaImage",
				filename: "regular.jpg",
				mimeType: "image/jpeg",
				fileSize: 2000,
				fileUrl: "https://cdn.shopify.com/regular.jpg",
				thumbnailUrl: "https://cdn.shopify.com/regular.jpg",
				width: 1200,
				height: 800,
				bynderMetadata: null,
			},
			{
				id: "3",
				alt: "Document",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				fileStatus: "READY",
				fileType: "GenericFile",
				filename: "document.pdf",
				mimeType: "application/pdf",
				fileSize: 5000,
				fileUrl: "https://cdn.shopify.com/document.pdf",
				thumbnailUrl: null,
				width: null,
				height: null,
				bynderMetadata: null,
			},
		];

		it("should filter by source: bynder", () => {
			const result = filterFiles(mockFiles, { source: "bynder" });
			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe("1");
		});

		it("should filter by source: other", () => {
			const result = filterFiles(mockFiles, { source: "other" });
			expect(result).toHaveLength(2);
			expect(result.map((f) => f.id)).toEqual(["2", "3"]);
		});

		it("should filter by source: all", () => {
			const result = filterFiles(mockFiles, { source: "all" });
			expect(result).toHaveLength(3);
		});

		it("should filter by fileType: image", () => {
			const result = filterFiles(mockFiles, { fileType: "image" });
			expect(result).toHaveLength(2);
			expect(result.every((f) => f.fileType === "MediaImage")).toBe(true);
		});

		it("should filter by fileType: file", () => {
			const result = filterFiles(mockFiles, { fileType: "file" });
			expect(result).toHaveLength(1);
			expect(result[0]?.fileType).toBe("GenericFile");
		});

		it("should combine filters", () => {
			const result = filterFiles(mockFiles, {
				source: "other",
				fileType: "image",
			});
			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe("2");
		});
	});

	describe("extractBynderTags", () => {
		it("should extract unique tags from files", () => {
			const files: ShopifyFile[] = [
				{
					id: "1",
					alt: null,
					createdAt: "",
					updatedAt: "",
					fileStatus: "READY",
					fileType: "MediaImage",
					filename: null,
					mimeType: null,
					fileSize: null,
					fileUrl: null,
					thumbnailUrl: null,
					width: null,
					height: null,
					bynderMetadata: {
						assetId: "1",
						permalink: "",
						tags: ["summer", "campaign"],
						version: 1,
						syncedAt: "",
					},
				},
				{
					id: "2",
					alt: null,
					createdAt: "",
					updatedAt: "",
					fileStatus: "READY",
					fileType: "MediaImage",
					filename: null,
					mimeType: null,
					fileSize: null,
					fileUrl: null,
					thumbnailUrl: null,
					width: null,
					height: null,
					bynderMetadata: {
						assetId: "2",
						permalink: "",
						tags: ["summer", "winter"],
						version: 1,
						syncedAt: "",
					},
				},
				{
					id: "3",
					alt: null,
					createdAt: "",
					updatedAt: "",
					fileStatus: "READY",
					fileType: "MediaImage",
					filename: null,
					mimeType: null,
					fileSize: null,
					fileUrl: null,
					thumbnailUrl: null,
					width: null,
					height: null,
					bynderMetadata: null,
				},
			];

			const tags = extractBynderTags(files);

			expect(tags).toEqual(["campaign", "summer", "winter"]);
		});

		it("should return empty array when no files have Bynder metadata", () => {
			const files: ShopifyFile[] = [
				{
					id: "1",
					alt: null,
					createdAt: "",
					updatedAt: "",
					fileStatus: "READY",
					fileType: "MediaImage",
					filename: null,
					mimeType: null,
					fileSize: null,
					fileUrl: null,
					thumbnailUrl: null,
					width: null,
					height: null,
					bynderMetadata: null,
				},
			];

			const tags = extractBynderTags(files);

			expect(tags).toEqual([]);
		});
	});
});
