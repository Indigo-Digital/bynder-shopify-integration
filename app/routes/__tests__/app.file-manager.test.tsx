import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "../app.file-manager.js";

vi.mock("../../db.server.js", () => {
	return {
		default: {
			shop: {
				findUnique: vi.fn(),
			},
		},
	};
});

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

vi.mock("../../lib/shopify/files-api.js", () => ({
	getShopifyFiles: vi.fn(),
	filterFiles: vi.fn(),
	extractBynderTags: vi.fn(),
}));

import prisma from "../../db.server.js";
import {
	extractBynderTags,
	filterFiles,
	getShopifyFiles,
} from "../../lib/shopify/files-api.js";
import { authenticate } from "../../shopify.server.js";

const mockPrisma = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
	};
};

const mockAuthenticateAdmin = authenticate.admin as ReturnType<typeof vi.fn>;
const mockGetShopifyFiles = getShopifyFiles as unknown as ReturnType<
	typeof vi.fn
>;
const mockFilterFiles = filterFiles as unknown as ReturnType<typeof vi.fn>;
const mockExtractBynderTags = extractBynderTags as unknown as ReturnType<
	typeof vi.fn
>;

describe("app.file-manager loader", () => {
	const session = { shop: "test-shop.myshopify.com" };
	const adminClient = { graphql: vi.fn(), rest: { resources: {} } };

	beforeEach(() => {
		vi.clearAllMocks();
		adminClient.graphql = vi.fn();
		mockGetShopifyFiles.mockResolvedValue({
			files: [],
			pageInfo: {
				hasNextPage: false,
				hasPreviousPage: false,
				startCursor: null,
				endCursor: null,
			},
			totalCount: 0,
		});
		mockFilterFiles.mockReturnValue([]);
		mockExtractBynderTags.mockReturnValue([]);
		mockAuthenticateAdmin.mockResolvedValue({
			session,
			admin: adminClient,
		});
	});

	it("returns default state when Bynder is not configured", async () => {
		mockPrisma.shop.findUnique.mockResolvedValue(null);

		const request = new Request("https://example.com/app/file-manager");
		const result = await loader({ request } as LoaderFunctionArgs);

		expect(result.shop).toBe(session.shop);
		expect(result.shopConfig).toBeNull();
		expect(result.files).toEqual([]);
		expect(result.allFiles).toEqual([]);
		expect(result.allTags).toEqual([]);
		expect(result.filters).toEqual({
			search: "",
			source: "all",
			fileType: "all",
		});
		expect(mockGetShopifyFiles).toHaveBeenCalledTimes(1);
	});

	it("fetches Shopify files and applies filters", async () => {
		const shopConfig = {
			id: "shop-1",
			shop: session.shop,
			bynderBaseUrl: "https://bynder.example.com/api",
		};

		mockPrisma.shop.findUnique.mockResolvedValue(shopConfig);

		const shopifyFiles = {
			files: [
				{ id: "gid://shopify/MediaImage/1", fileType: "MediaImage" },
				{ id: "gid://shopify/GenericFile/2", fileType: "GenericFile" },
			],
			pageInfo: {
				hasNextPage: true,
				hasPreviousPage: false,
				startCursor: "cursor-1",
				endCursor: "cursor-2",
			},
			totalCount: 2,
		};

		const filteredFiles = [shopifyFiles.files[0]];
		const tagList = ["campaign", "summer"];

		mockGetShopifyFiles.mockResolvedValue(shopifyFiles);
		mockFilterFiles.mockReturnValue(filteredFiles);
		mockExtractBynderTags.mockReturnValue(tagList);

		const request = new Request(
			"https://example.com/app/file-manager?search=hero&source=bynder&type=image&after=cursor-1"
		);

		const result = await loader({ request } as LoaderFunctionArgs);

		expect(mockGetShopifyFiles).toHaveBeenCalledWith(
			adminClient,
			expect.objectContaining({
				first: 50,
				after: "cursor-1",
				search: "hero",
				sortKey: "CREATED_AT",
				reverse: true,
			})
		);

		expect(mockFilterFiles).toHaveBeenCalledWith(shopifyFiles.files, {
			source: "bynder",
			fileType: "image",
		});

		expect(mockExtractBynderTags).toHaveBeenCalledWith(shopifyFiles.files);
		expect(result.files).toEqual(filteredFiles);
		expect(result.allFiles).toEqual(shopifyFiles.files);
		expect(result.pageInfo).toEqual(shopifyFiles.pageInfo);
		expect(result.allTags).toEqual(tagList);
		expect(result.filters).toEqual({
			search: "hero",
			source: "bynder",
			fileType: "image",
		});
	});
});

describe("app.file-manager action", () => {
	const adminClient = { graphql: vi.fn(), rest: { resources: {} } };
	let mockGraphql: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		adminClient.graphql = vi.fn();
		mockGraphql = adminClient.graphql as ReturnType<typeof vi.fn>;
		mockAuthenticateAdmin.mockResolvedValue({
			admin: adminClient,
		});
	});

	it("returns an error when deleting without selections", async () => {
		const formData = new FormData();
		formData.append("intent", "delete");

		const request = new Request("https://example.com/app/file-manager", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);
		expect(result).toEqual({ error: "No files selected" });
	});

	it("acknowledges bulk delete requests", async () => {
		mockGraphql.mockResolvedValue({
			json: async () => ({
				data: {
					fileDelete: {
						deletedFileIds: ["gid://1", "gid://2"],
						userErrors: [],
					},
				},
			}),
		});

		const formData = new FormData();
		formData.append("intent", "delete");
		formData.append("fileIds", "gid://1,gid://2");

		const request = new Request("https://example.com/app/file-manager", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);
		expect(mockGraphql).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ success: true, deleted: 2 });
	});

	it("updates alt text for a specific file", async () => {
		mockGraphql.mockResolvedValue({
			json: async () => ({
				data: {
					fileUpdate: {
						files: [{ id: "gid://shopify/File/1", alt: "New alt text" }],
						userErrors: [],
					},
				},
			}),
		});

		const formData = new FormData();
		formData.append("intent", "updateAlt");
		formData.append("fileId", "gid://shopify/File/1");
		formData.append("altText", "New alt text");

		const request = new Request("https://example.com/app/file-manager", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);

		expect(mockGraphql).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ success: true });
	});

	it("requires a file ID when editing alt text", async () => {
		const formData = new FormData();
		formData.append("intent", "updateAlt");

		const request = new Request("https://example.com/app/file-manager", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);
		expect(result).toEqual({ error: "No file specified" });
	});

	it("returns error for unknown intent", async () => {
		const formData = new FormData();
		formData.append("intent", "unknown");

		const request = new Request("https://example.com/app/file-manager", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);
		expect(result).toEqual({ error: "Invalid action" });
	});
});
