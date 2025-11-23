import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "../api.sync.cancel.js";

vi.mock("../../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
		},
		syncJob: {
			findUnique: vi.fn(),
			update: vi.fn(),
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
	};
	syncJob: {
		findUnique: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
};

const mockAuthenticate = authenticate as unknown as {
	admin: ReturnType<typeof vi.fn>;
};

describe("api.sync.cancel", () => {
	const mockSession = {
		shop: "test-shop.myshopify.com",
	};

	const mockShop = {
		id: "shop-123",
		shop: "test-shop.myshopify.com",
	};

	const mockJob = {
		id: "job-123",
		shopId: "shop-123",
		status: "running",
		shop: mockShop,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockAuthenticate.admin.mockResolvedValue({
			session: mockSession,
		});
		mockPrisma.shop.findUnique.mockResolvedValue(mockShop);
	});

	it("should cancel a running job", async () => {
		mockPrisma.syncJob.findUnique.mockResolvedValue(mockJob);
		mockPrisma.syncJob.update.mockResolvedValue({
			...mockJob,
			status: "cancelled",
		});

		const request = new Request("http://localhost/api/sync/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: "job-123" }),
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(mockPrisma.syncJob.update).toHaveBeenCalledWith({
			where: { id: "job-123" },
			data: {
				status: "cancelled",
				completedAt: expect.any(Date),
			},
		});
	});

	it("should cancel a pending job", async () => {
		const pendingJob = {
			...mockJob,
			status: "pending",
		};

		mockPrisma.syncJob.findUnique.mockResolvedValue(pendingJob);
		mockPrisma.syncJob.update.mockResolvedValue({
			...pendingJob,
			status: "cancelled",
		});

		const request = new Request("http://localhost/api/sync/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: "job-123" }),
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
	});

	it("should reject cancelling completed job", async () => {
		const completedJob = {
			...mockJob,
			status: "completed",
		};

		mockPrisma.syncJob.findUnique.mockResolvedValue(completedJob);

		const request = new Request("http://localhost/api/sync/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: "job-123" }),
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("Cannot cancel job with status: completed");
		expect(mockPrisma.syncJob.update).not.toHaveBeenCalled();
	});

	it("should reject cancelling job from different shop", async () => {
		const otherShopJob = {
			...mockJob,
			shopId: "other-shop-456",
			shop: {
				id: "other-shop-456",
				shop: "other-shop.myshopify.com",
			},
		};

		mockPrisma.syncJob.findUnique.mockResolvedValue(otherShopJob);

		const request = new Request("http://localhost/api/sync/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: "job-123" }),
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(403);
		expect(data.error).toContain("does not belong to this shop");
	});

	it("should return 404 for non-existent job", async () => {
		mockPrisma.syncJob.findUnique.mockResolvedValue(null);

		const request = new Request("http://localhost/api/sync/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId: "non-existent" }),
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toContain("Job not found");
	});

	it("should return 400 for missing jobId", async () => {
		const request = new Request("http://localhost/api/sync/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("jobId is required");
	});

	it("should return 405 for non-POST requests", async () => {
		const request = new Request("http://localhost/api/sync/cancel", {
			method: "GET",
		});

		const response = await action({ request } as any);
		const data = await response.json();

		expect(response.status).toBe(405);
		expect(data.error).toContain("Method not allowed");
	});
});
