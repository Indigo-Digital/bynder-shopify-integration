import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import { syncBynderAssets } from "./auto-sync.js";

vi.mock("../../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			upsert: vi.fn(),
		},
		syncedAsset: {
			findUnique: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			upsert: vi.fn(),
		},
		syncJob: {
			create: vi.fn(),
			update: vi.fn(),
			findMany: vi.fn(),
		},
		$queryRaw: vi.fn(),
	};
	return {
		default: mockPrisma,
	};
});

// Get the mocked prisma instance
import prisma from "../../db.server.js";

const mockPrisma = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	syncedAsset: {
		findUnique: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	syncJob: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
	};
	$queryRaw: ReturnType<typeof vi.fn>;
};

vi.mock("../shopify/files.js", () => ({
	uploadBynderAsset: vi.fn().mockResolvedValue({
		fileId: "gid://shopify/File/123",
		fileUrl: "https://cdn.shopify.com/test.jpg",
	}),
}));

describe("syncBynderAssets", () => {
	const mockAdmin: AdminApi = {
		graphql: vi.fn(),
		rest: {
			resources: {},
		},
	};

	const mockBynderClient = {
		getAllMediaItems: vi.fn(),
		getMediaInfo: vi.fn(),
		getMediaDownloadUrl: vi.fn(),
		config: {
			baseURL: "https://test.bynder.com/api",
		},
	} as unknown as BynderClient;

	const mockShop = {
		id: "shop-123",
		shop: "test-shop.myshopify.com",
		syncTags: "shopify-sync,campaign-assets",
		bynderBaseUrl: "https://test.bynder.com/api",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockPrisma.shop.findUnique.mockResolvedValue(mockShop);
		mockPrisma.syncJob.create.mockResolvedValue({
			id: "job-123",
			shopId: "shop-123",
			status: "running",
		});
	});

	it("should sync assets with matching tags", async () => {
		const mockAssets = [
			{
				id: "asset-1",
				tags: ["shopify-sync"],
				version: 1,
			},
			{
				id: "asset-2",
				tags: ["campaign-assets"],
				version: 1,
			},
		];

		mockBynderClient.getAllMediaItems = vi.fn().mockResolvedValue(mockAssets);
		mockBynderClient.getMediaInfo = vi
			.fn()
			.mockImplementation(({ id }) =>
				Promise.resolve(mockAssets.find((a) => a.id === id))
			);

		mockPrisma.syncedAsset.findUnique.mockResolvedValue(null);
		mockPrisma.syncedAsset.upsert.mockResolvedValue({
			id: "synced-1",
			shopId: "shop-123",
			bynderAssetId: "asset-1",
			shopifyFileId: "gid://shopify/File/123",
		});
		(prisma.syncJob.update as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "job-123",
			status: "completed",
		});

		const result = await syncBynderAssets({
			shopId: "shop-123",
			admin: mockAdmin,
			bynderClient: mockBynderClient,
		});

		expect(result.processed).toBe(2);
		expect(result.created).toBe(2);
		expect(result.updated).toBe(0);
	});

	it("should skip assets that already exist with same version", async () => {
		const mockAssets = [
			{
				id: "asset-1",
				tags: ["shopify-sync"],
				version: 1,
			},
		];

		mockBynderClient.getAllMediaItems = vi.fn().mockResolvedValue(mockAssets);

		mockPrisma.syncedAsset.findUnique.mockResolvedValue({
			id: "synced-1",
			shopId: "shop-123",
			bynderAssetId: "asset-1",
			shopifyFileId: "gid://shopify/File/123",
			bynderVersion: 1,
		});

		mockPrisma.syncJob.update.mockResolvedValue({
			id: "job-123",
			status: "completed",
		});

		const result = await syncBynderAssets({
			shopId: "shop-123",
			admin: mockAdmin,
			bynderClient: mockBynderClient,
		});

		expect(result.processed).toBe(1);
		expect(result.created).toBe(0);
		expect(result.updated).toBe(0);
	});
});
