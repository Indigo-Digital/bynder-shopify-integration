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
			findUnique: vi.fn(),
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
		findUnique: ReturnType<typeof vi.fn>;
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

	it("should use existing job when jobId is provided", async () => {
		const existingJob = {
			id: "existing-job-123",
			shopId: "shop-123",
			status: "pending",
			startedAt: null,
		};

		mockPrisma.syncJob.findUnique.mockResolvedValue(existingJob);
		mockPrisma.syncJob.update.mockResolvedValue({
			...existingJob,
			status: "running",
			startedAt: new Date(),
		});

		const mockAssets = [
			{
				id: "asset-1",
				tags: ["shopify-sync"],
				version: 1,
			},
		];

		mockBynderClient.getAllMediaItems = vi.fn().mockResolvedValue(mockAssets);
		mockPrisma.syncedAsset.findUnique.mockResolvedValue(null);
		mockPrisma.syncedAsset.upsert.mockResolvedValue({
			id: "synced-1",
			shopId: "shop-123",
			bynderAssetId: "asset-1",
			shopifyFileId: "gid://shopify/File/123",
		});

		mockPrisma.syncJob.update.mockResolvedValueOnce({
			...existingJob,
			status: "running",
		});

		mockPrisma.syncJob.update.mockResolvedValueOnce({
			...existingJob,
			status: "completed",
		});

		const result = await syncBynderAssets({
			shopId: "shop-123",
			admin: mockAdmin,
			bynderClient: mockBynderClient,
			jobId: "existing-job-123",
		});

		expect(mockPrisma.syncJob.findUnique).toHaveBeenCalledWith({
			where: { id: "existing-job-123" },
		});
		expect(mockPrisma.syncJob.create).not.toHaveBeenCalled();
		expect(result.processed).toBe(1);
	});

	it("should stop processing when job is cancelled", async () => {
		const existingJob = {
			id: "job-123",
			shopId: "shop-123",
			status: "pending",
			startedAt: null,
		};

		const mockAssets = [
			{
				id: "asset-1",
				tags: ["shopify-sync"],
				version: 1,
			},
			{
				id: "asset-2",
				tags: ["shopify-sync"],
				version: 1,
			},
		];

		mockBynderClient.getAllMediaItems = vi.fn().mockResolvedValue(mockAssets);
		mockPrisma.syncedAsset.findUnique.mockResolvedValue(null);

		// Mock cancellation check - first call returns pending, then cancelled
		let callCount = 0;
		mockPrisma.syncJob.findUnique.mockImplementation(
			(args: { where: { id: string } }) => {
				if (args.where.id === "job-123") {
					callCount++;
					if (callCount === 1) {
						// First call: get existing job (pending)
						return Promise.resolve(existingJob);
					}
					// Subsequent calls: check for cancellation (cancelled)
					return Promise.resolve({
						...existingJob,
						status: "cancelled",
					});
				}
				return Promise.resolve(null);
			}
		);

		mockPrisma.syncJob.update
			.mockResolvedValueOnce({
				...existingJob,
				status: "running",
				startedAt: new Date(),
			})
			.mockResolvedValueOnce({
				...existingJob,
				status: "cancelled",
				completedAt: new Date(),
			});

		await syncBynderAssets({
			shopId: "shop-123",
			admin: mockAdmin,
			bynderClient: mockBynderClient,
			jobId: "job-123",
		});

		// Should have checked for cancellation (at least once for initial check, plus cancellation checks)
		expect(mockPrisma.syncJob.findUnique).toHaveBeenCalled();
		// Should have marked job as cancelled
		expect(mockPrisma.syncJob.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "job-123" },
				data: expect.objectContaining({
					status: "cancelled",
				}),
			})
		);
	});

	it("should update existing job from pending to running", async () => {
		const pendingJob = {
			id: "job-123",
			shopId: "shop-123",
			status: "pending",
			startedAt: null,
		};

		mockPrisma.syncJob.findUnique.mockResolvedValue(pendingJob);
		mockPrisma.syncJob.update.mockResolvedValue({
			...pendingJob,
			status: "running",
			startedAt: new Date(),
		});

		const mockAssets: Array<{ id: string; tags: string[]; version: number }> =
			[];

		mockBynderClient.getAllMediaItems = vi.fn().mockResolvedValue(mockAssets);
		mockPrisma.syncJob.update.mockResolvedValue({
			...pendingJob,
			status: "completed",
		});

		await syncBynderAssets({
			shopId: "shop-123",
			admin: mockAdmin,
			bynderClient: mockBynderClient,
			jobId: "job-123",
		});

		expect(mockPrisma.syncJob.update).toHaveBeenCalledWith({
			where: { id: "job-123" },
			data: {
				status: "running",
				startedAt: expect.any(Date),
			},
		});
	});
});
