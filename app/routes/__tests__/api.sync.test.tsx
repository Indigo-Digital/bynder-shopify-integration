import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "../api.sync.js";

vi.mock("../../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
		},
		syncedAsset: {
			upsert: vi.fn(),
		},
		syncJob: {
			create: vi.fn(),
		},
	};
	return {
		default: mockPrisma,
	};
});

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

vi.mock("../../lib/bynder/client.js", () => ({
	BynderClient: {
		createFromEnv: vi.fn(),
	},
}));

vi.mock("../../lib/shopify/files.js", () => ({
	uploadBynderAsset: vi.fn(),
}));

vi.mock("../../lib/sync/auto-sync.js", () => ({
	syncBynderAssets: vi.fn(),
}));

import prisma from "../../db.server.js";
import { BynderClient } from "../../lib/bynder/client.js";
import { uploadBynderAsset } from "../../lib/shopify/files.js";
import { syncBynderAssets } from "../../lib/sync/auto-sync.js";
import { authenticate } from "../../shopify.server.js";

const mockPrisma = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
	};
	syncedAsset: {
		upsert: ReturnType<typeof vi.fn>;
	};
	syncJob: {
		create: ReturnType<typeof vi.fn>;
	};
};

const mockAuthenticate = authenticate as unknown as {
	admin: ReturnType<typeof vi.fn>;
};

const mockBynderClient = BynderClient as unknown as {
	createFromEnv: ReturnType<typeof vi.fn>;
};

describe("api.sync", () => {
	const mockSession = {
		shop: "test-shop.myshopify.com",
	};

	const mockAdmin = {
		graphql: vi.fn(),
	};

	const mockShop = {
		id: "shop-123",
		shop: "test-shop.myshopify.com",
		bynderBaseUrl: "https://test.bynder.com/api",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockAuthenticate.admin.mockResolvedValue({
			session: mockSession,
			admin: mockAdmin,
		});
		mockPrisma.shop.findUnique.mockResolvedValue(mockShop);
		mockBynderClient.createFromEnv.mockReturnValue({
			getMediaInfo: vi.fn(),
		} as unknown as ReturnType<typeof BynderClient.createFromEnv>);
	});

	it("should create pending job for full sync", async () => {
		const mockJob = {
			id: "job-123",
			shopId: "shop-123",
			status: "pending",
		};

		mockPrisma.syncJob.create.mockResolvedValue(mockJob);

		const request = new Request("http://localhost/api/sync", {
			method: "POST",
		});

		const response = await action({ request } as unknown as ActionFunctionArgs);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.jobId).toBe("job-123");
		expect(data.message).toContain("Processing in background");
		expect(mockPrisma.syncJob.create).toHaveBeenCalledWith({
			data: {
				shopId: "shop-123",
				status: "pending",
				assetsProcessed: 0,
			},
		});
		expect(syncBynderAssets).not.toHaveBeenCalled();
	});

	it("should sync single asset synchronously", async () => {
		const mockAssetInfo = {
			id: "asset-123",
			tags: ["shopify-sync"],
			version: 1,
		};

		mockBynderClient.createFromEnv.mockReturnValue({
			getMediaInfo: vi.fn().mockResolvedValue(mockAssetInfo),
		} as unknown as ReturnType<typeof BynderClient.createFromEnv>);

		vi.mocked(uploadBynderAsset).mockResolvedValue({
			fileId: "gid://shopify/File/123",
			fileUrl: "https://cdn.shopify.com/test.jpg",
		});

		mockPrisma.syncedAsset.upsert.mockResolvedValue({
			id: "synced-1",
			shopId: "shop-123",
			bynderAssetId: "asset-123",
			shopifyFileId: "gid://shopify/File/123",
		});

		const request = new Request("http://localhost/api/sync?assetId=asset-123", {
			method: "POST",
		});

		const response = await action({ request } as unknown as ActionFunctionArgs);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.fileId).toBe("gid://shopify/File/123");
		expect(uploadBynderAsset).toHaveBeenCalledWith(
			mockAdmin,
			expect.any(Object),
			"asset-123",
			"shop-123",
			"manual"
		);
	});

	it("should return error when Bynder not configured", async () => {
		const shopWithoutBynder = {
			...mockShop,
			bynderBaseUrl: null,
		};

		mockPrisma.shop.findUnique.mockResolvedValue(shopWithoutBynder);

		const request = new Request("http://localhost/api/sync", {
			method: "POST",
		});

		const response = await action({ request } as unknown as ActionFunctionArgs);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("Bynder not configured");
	});

	it("should return error for non-POST requests", async () => {
		const request = new Request("http://localhost/api/sync", {
			method: "GET",
		});

		const response = await action({ request } as unknown as ActionFunctionArgs);
		const data = await response.json();

		expect(response.status).toBe(405);
		expect(data.error).toContain("Method not allowed");
	});

	it("should handle sync errors gracefully", async () => {
		mockPrisma.syncJob.create.mockRejectedValue(new Error("Database error"));

		const request = new Request("http://localhost/api/sync", {
			method: "POST",
		});

		const response = await action({ request } as unknown as ActionFunctionArgs);
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.error).toContain("Database error");
	});
});
