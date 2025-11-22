import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./api.bynder.assets.js";

vi.mock("../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
		},
	};
	return {
		default: mockPrisma,
	};
});

vi.mock("../lib/bynder/client.js", () => ({
	BynderClient: {
		createFromEnv: vi.fn(),
	},
}));

vi.mock("../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import { authenticate } from "../shopify.server.js";

const mockPrisma = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
	};
};

const mockBynderClient = {
	getMediaList: vi.fn(),
	config: {
		baseURL: "https://test.bynder.com/api",
	},
};

describe("api.bynder.assets loader", () => {
	const mockSession = {
		shop: "test-shop.myshopify.com",
	};

	const mockShopConfig = {
		id: "shop-123",
		shop: "test-shop.myshopify.com",
		bynderBaseUrl: "https://test.bynder.com/api",
		syncTags: "shopify-sync",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: mockSession,
		});
		mockPrisma.shop.findUnique.mockResolvedValue(mockShopConfig);
		(BynderClient.createFromEnv as ReturnType<typeof vi.fn>).mockReturnValue(
			mockBynderClient
		);
	});

	it("should return assets with default pagination", async () => {
		const mockAssets = [
			{
				id: "asset-1",
				name: "Test Image 1",
				type: "image",
				tags: ["shopify-sync", "campaign"],
				dateModified: "2024-01-01T00:00:00Z",
				dateCreated: "2024-01-01T00:00:00Z",
				version: 1,
				derivatives: {},
				thumbnails: {},
			},
			{
				id: "asset-2",
				name: "Test Image 2",
				type: "image",
				tags: ["shopify-sync"],
				dateModified: "2024-01-02T00:00:00Z",
				dateCreated: "2024-01-02T00:00:00Z",
				version: 1,
				derivatives: {},
				thumbnails: {},
			},
		];

		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: mockAssets,
			total: 2,
			count: 2,
			page: 1,
			limit: 24,
		});

		const request = new Request("http://localhost/api/bynder/assets");
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(data.assets).toHaveLength(2);
		expect(data.total).toBe(2);
		expect(data.page).toBe(1);
		expect(data.limit).toBe(24);
		expect(data.hasMore).toBe(false);
		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			page: 1,
			limit: 24,
		});
	});

	it("should handle keyword search", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: [],
			total: 0,
			count: 0,
			page: 1,
			limit: 24,
		});

		const request = new Request(
			"http://localhost/api/bynder/assets?keyword=summer"
		);
		await loader({ request } as LoaderFunctionArgs);

		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			keyword: "summer",
			page: 1,
			limit: 24,
		});
	});

	it("should handle tag filtering", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: [],
			total: 0,
			count: 0,
			page: 1,
			limit: 24,
		});

		const request = new Request(
			"http://localhost/api/bynder/assets?tags=shopify-sync,campaign"
		);
		await loader({ request } as LoaderFunctionArgs);

		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			tags: ["shopify-sync", "campaign"],
			page: 1,
			limit: 24,
		});
	});

	it("should handle single tag filter", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: [],
			total: 0,
			count: 0,
			page: 1,
			limit: 24,
		});

		const request = new Request(
			"http://localhost/api/bynder/assets?tags=shopify-sync"
		);
		await loader({ request } as LoaderFunctionArgs);

		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			tags: "shopify-sync",
			page: 1,
			limit: 24,
		});
	});

	it("should handle asset type filtering", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: [],
			total: 0,
			count: 0,
			page: 1,
			limit: 24,
		});

		const request = new Request(
			"http://localhost/api/bynder/assets?type=image"
		);
		await loader({ request } as LoaderFunctionArgs);

		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			type: "image",
			page: 1,
			limit: 24,
		});
	});

	it("should handle pagination parameters", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: [],
			total: 50,
			count: 24,
			page: 2,
			limit: 24,
		});

		const request = new Request(
			"http://localhost/api/bynder/assets?page=2&limit=24"
		);
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			page: 2,
			limit: 24,
		});
		expect(data.page).toBe(2);
		expect(data.hasMore).toBe(false); // count === limit but no more items
	});

	it("should detect hasMore when count equals limit", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: Array(24).fill({ id: "asset", tags: [] }),
			total: 50,
			count: 24,
			page: 1,
			limit: 24,
		});

		const request = new Request("http://localhost/api/bynder/assets");
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(data.hasMore).toBe(true);
	});

	it("should handle array response format", async () => {
		const mockAssets = [
			{
				id: "asset-1",
				name: "Test Image",
				type: "image",
				tags: ["shopify-sync"],
				dateModified: "2024-01-01T00:00:00Z",
				dateCreated: "2024-01-01T00:00:00Z",
				version: 1,
				derivatives: {},
				thumbnails: {},
			},
		];

		mockBynderClient.getMediaList = vi.fn().mockResolvedValue(mockAssets);

		const request = new Request("http://localhost/api/bynder/assets");
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(data.assets).toHaveLength(1);
		expect(data.total).toBe(1);
	});

	it("should return error when shop config is missing", async () => {
		mockPrisma.shop.findUnique.mockResolvedValue(null);

		const request = new Request("http://localhost/api/bynder/assets");
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(result.status).toBe(400);
		expect(data.error).toContain("Bynder base URL not configured");
	});

	it("should return error when bynderBaseUrl is missing", async () => {
		mockPrisma.shop.findUnique.mockResolvedValue({
			...mockShopConfig,
			bynderBaseUrl: null,
		});

		const request = new Request("http://localhost/api/bynder/assets");
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(result.status).toBe(400);
		expect(data.error).toContain("Bynder base URL not configured");
	});

	it("should handle Bynder API errors", async () => {
		mockBynderClient.getMediaList = vi
			.fn()
			.mockRejectedValue(new Error("Bynder API error"));

		const request = new Request("http://localhost/api/bynder/assets");
		const result = await loader({ request } as LoaderFunctionArgs);
		const data = await result.json();

		expect(result.status).toBe(500);
		expect(data.error).toBe("Bynder API error");
	});

	it("should handle combined filters", async () => {
		mockBynderClient.getMediaList = vi.fn().mockResolvedValue({
			media: [],
			total: 0,
			count: 0,
			page: 1,
			limit: 24,
		});

		const request = new Request(
			"http://localhost/api/bynder/assets?keyword=summer&tags=shopify-sync&type=image&page=1&limit=12"
		);
		await loader({ request } as LoaderFunctionArgs);

		expect(mockBynderClient.getMediaList).toHaveBeenCalledWith({
			keyword: "summer",
			tags: "shopify-sync",
			type: "image",
			page: 1,
			limit: 12,
		});
	});
});
