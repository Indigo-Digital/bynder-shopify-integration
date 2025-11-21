import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApi } from "../types.js";
import { getBynderMetafields, setBynderMetafields } from "./metafields.js";

describe("Bynder Metafields", () => {
	const mockAdmin: AdminApi = {
		graphql: vi.fn(),
		rest: {
			resources: {},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("setBynderMetafields", () => {
		it("should set all required metafields with $app:bynder namespace", async () => {
			const fileId = "gid://shopify/File/123";
			const metafields = {
				assetId: "bynder-asset-123",
				permalink: "https://test.bynder.com/media/bynder-asset-123",
				tags: ["tag1", "tag2"],
				version: 1,
				syncedAt: "2024-01-01T00:00:00Z",
			};

			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
				json: async () => ({
					data: {
						metafieldsSet: {
							metafields: [
								{ id: "meta-1", namespace: "$app:bynder", key: "asset_id" },
								{ id: "meta-2", namespace: "$app:bynder", key: "permalink" },
								{ id: "meta-3", namespace: "$app:bynder", key: "tags" },
								{ id: "meta-4", namespace: "$app:bynder", key: "version" },
								{ id: "meta-5", namespace: "$app:bynder", key: "synced_at" },
							],
							userErrors: [],
						},
					},
				}),
			});

			await setBynderMetafields(mockAdmin, fileId, metafields);

			expect(mockAdmin.graphql).toHaveBeenCalled();
			const call = (mockAdmin.graphql as ReturnType<typeof vi.fn>).mock
				.calls[0];
			expect(call).toBeDefined();
			const variables = call?.[1]?.variables;

			expect(variables.metafields).toHaveLength(5);
			expect(variables.metafields[0].namespace).toBe("$app:bynder");
			expect(variables.metafields[0].key).toBe("asset_id");
			expect(variables.metafields[0].value).toBe("bynder-asset-123");
		});

		it("should throw error on user errors", async () => {
			const fileId = "gid://shopify/File/123";
			const metafields = {
				assetId: "bynder-asset-123",
				permalink: "https://test.bynder.com/media/bynder-asset-123",
				tags: [],
				version: 1,
				syncedAt: "2024-01-01T00:00:00Z",
			};

			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
				json: async () => ({
					data: {
						metafieldsSet: {
							metafields: [],
							userErrors: [
								{ field: ["namespace"], message: "Invalid namespace" },
							],
						},
					},
				}),
			});

			await expect(
				setBynderMetafields(mockAdmin, fileId, metafields)
			).rejects.toThrow();
		});
	});

	describe("getBynderMetafields", () => {
		it("should retrieve metafields from file", async () => {
			const fileId = "gid://shopify/File/123";

			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
				json: async () => ({
					data: {
						metafields: {
							edges: [
								{
									node: {
										namespace: "$app:bynder",
										key: "asset_id",
										value: "bynder-asset-123",
										type: "single_line_text_field",
									},
								},
								{
									node: {
										namespace: "$app:bynder",
										key: "permalink",
										value: "https://test.bynder.com/media/bynder-asset-123",
										type: "url",
									},
								},
								{
									node: {
										namespace: "$app:bynder",
										key: "tags",
										value: '["tag1", "tag2"]',
										type: "list.single_line_text_field",
									},
								},
								{
									node: {
										namespace: "$app:bynder",
										key: "version",
										value: "1",
										type: "number_integer",
									},
								},
								{
									node: {
										namespace: "$app:bynder",
										key: "synced_at",
										value: "2024-01-01T00:00:00Z",
										type: "date_time",
									},
								},
							],
						},
					},
				}),
			});

			const result = await getBynderMetafields(mockAdmin, fileId);

			expect(result).toEqual({
				assetId: "bynder-asset-123",
				permalink: "https://test.bynder.com/media/bynder-asset-123",
				tags: ["tag1", "tag2"],
				version: 1,
				syncedAt: "2024-01-01T00:00:00Z",
			});
		});

		it("should return null when no metafields exist", async () => {
			const fileId = "gid://shopify/File/123";

			(mockAdmin.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
				json: async () => ({
					data: {
						metafields: {
							edges: [],
						},
					},
				}),
			});

			const result = await getBynderMetafields(mockAdmin, fileId);

			expect(result).toBeNull();
		});
	});
});
