import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "../app.settings.js";

vi.mock("../../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
			upsert: vi.fn(),
		},
		syncedAsset: {
			count: vi.fn(),
		},
		syncJob: {
			findMany: vi.fn(),
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

import prisma from "../../db.server.js";
import { authenticate } from "../../shopify.server.js";

const mockPrisma = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	syncedAsset: {
		count: ReturnType<typeof vi.fn>;
	};
	syncJob: {
		findMany: ReturnType<typeof vi.fn>;
	};
};

describe("app.settings loader", () => {
	const mockSession = {
		shop: "test-shop.myshopify.com",
	};

	const mockShopConfig = {
		id: "shop-123",
		shop: "test-shop.myshopify.com",
		bynderBaseUrl: "https://test.bynder.com/api",
		syncTags: "shopify-sync,campaign",
		webhookSubscriptions: [],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: mockSession,
		});
		mockPrisma.shop.findUnique.mockResolvedValue(mockShopConfig);
		mockPrisma.syncedAsset.count.mockResolvedValue(10);
		mockPrisma.syncJob.findMany.mockResolvedValue([]);
	});

	it("should return shop config and stats", async () => {
		const request = new Request("http://localhost/app/settings");
		const result = await loader({ request } as LoaderFunctionArgs);

		expect(result.shopConfig).toEqual(mockShopConfig);
		expect(result.stats).toBeDefined();
		expect(result.stats?.totalSynced).toBe(10);
	});

	it("should handle missing shop config", async () => {
		mockPrisma.shop.findUnique.mockResolvedValue(null);

		const request = new Request("http://localhost/app/settings");
		const result = await loader({ request } as LoaderFunctionArgs);

		expect(result.shopConfig).toBeNull();
		expect(result.stats).toBeNull();
	});

	it("should calculate sync statistics", async () => {
		// Jobs ordered by createdAt desc (most recent first)
		const mockJobs = [
			{
				id: "job-2",
				shopId: "shop-123",
				status: "failed",
				createdAt: new Date("2024-01-02"),
				startedAt: new Date("2024-01-02"),
				completedAt: null,
			},
			{
				id: "job-1",
				shopId: "shop-123",
				status: "completed",
				createdAt: new Date("2024-01-01"),
				startedAt: new Date("2024-01-01"),
				completedAt: new Date("2024-01-01"),
			},
		];

		mockPrisma.syncJob.findMany
			.mockResolvedValueOnce(mockJobs) // For recentJobs
			.mockResolvedValueOnce([]); // For recentFailures

		const request = new Request("http://localhost/app/settings");
		const result = await loader({ request } as LoaderFunctionArgs);

		expect(result.stats?.successRate).toBe(50);
		expect(result.stats?.lastSyncStatus).toBe("failed"); // Most recent job
	});
});

describe("app.settings action", () => {
	const mockSession = {
		shop: "test-shop.myshopify.com",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: mockSession,
		});
		mockPrisma.shop.upsert.mockResolvedValue({
			id: "shop-123",
			shop: "test-shop.myshopify.com",
			syncTags: "shopify-sync",
			bynderBaseUrl: "https://test.bynder.com/api",
		});
	});

	it("should update sync tags", async () => {
		const formData = new FormData();
		formData.append("intent", "update_sync_tags");
		formData.append("syncTags", "shopify-sync,campaign,new-tag");

		const request = new Request("http://localhost/app/settings", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).toHaveBeenCalledWith({
			where: { shop: "test-shop.myshopify.com" },
			create: {
				shop: "test-shop.myshopify.com",
				syncTags: "shopify-sync,campaign,new-tag",
			},
			update: {
				syncTags: "shopify-sync,campaign,new-tag",
			},
		});

		expect(result).toHaveProperty("status", 302); // redirect
	});

	it("should trim and filter empty tags", async () => {
		const formData = new FormData();
		formData.append("intent", "update_sync_tags");
		formData.append("syncTags", "shopify-sync, , campaign,  ,new-tag");

		const request = new Request("http://localhost/app/settings", {
			method: "POST",
			body: formData,
		});

		await action({ request } as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					syncTags: "shopify-sync,campaign,new-tag",
				}),
			})
		);
	});

	it("should use default tag when empty", async () => {
		const formData = new FormData();
		formData.append("intent", "update_sync_tags");
		formData.append("syncTags", "");

		const request = new Request("http://localhost/app/settings", {
			method: "POST",
			body: formData,
		});

		await action({ request } as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					syncTags: "shopify-sync",
				}),
			})
		);
	});

	it("should update Bynder base URL", async () => {
		const formData = new FormData();
		formData.append("intent", "update_bynder_url");
		formData.append("bynderBaseUrl", "https://test.bynder.com/api");

		const request = new Request("http://localhost/app/settings", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).toHaveBeenCalledWith({
			where: { shop: "test-shop.myshopify.com" },
			create: {
				shop: "test-shop.myshopify.com",
				bynderBaseUrl: "https://test.bynder.com/api",
			},
			update: {
				bynderBaseUrl: "https://test.bynder.com/api",
			},
		});

		expect(result).toHaveProperty("status", 302);
	});

	it("should return error when Bynder URL is missing", async () => {
		const formData = new FormData();
		formData.append("intent", "update_bynder_url");
		formData.append("bynderBaseUrl", "");

		const request = new Request("http://localhost/app/settings", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);

		// The action returns a plain object with error, not a Response
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toContain(
			"Bynder base URL is required"
		);
	});

	it("should return error for invalid intent", async () => {
		const formData = new FormData();
		formData.append("intent", "invalid_intent");

		const request = new Request("http://localhost/app/settings", {
			method: "POST",
			body: formData,
		});

		const result = await action({ request } as ActionFunctionArgs);

		// The action returns a plain object with error, not a Response
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toBe("Invalid intent");
	});
});
