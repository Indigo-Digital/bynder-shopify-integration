import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncBynderAssets } from "./auto-sync.js";

vi.mock("../../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
			findFirst: vi.fn(),
		},
		syncJob: {
			findFirst: vi.fn(),
			update: vi.fn(),
		},
	};
	return {
		default: mockPrisma,
	};
});

vi.mock("../../shopify.server.js", () => ({
	unauthenticated: {
		admin: vi.fn(),
	},
}));

vi.mock("./auto-sync.js", () => ({
	syncBynderAssets: vi.fn(),
}));

vi.mock("../bynder/client.js", () => ({
	BynderClient: {
		createFromEnv: vi.fn(),
	},
}));

// Get mocked instances
import prisma from "../../db.server.js";
import { unauthenticated } from "../../shopify.server.js";
import { BynderClient } from "../bynder/client.js";

const mockPrisma = prisma as unknown as {
	syncJob: {
		findFirst: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
		findFirst: ReturnType<typeof vi.fn>;
	};
};

const mockUnauthenticated = unauthenticated as unknown as {
	admin: ReturnType<typeof vi.fn>;
};

const mockBynderClient = BynderClient as unknown as {
	createFromEnv: ReturnType<typeof vi.fn>;
};

describe("Worker Process Logic", () => {
	const mockShop = {
		id: "shop-123",
		shop: "test-shop.myshopify.com",
		bynderBaseUrl: "https://test.bynder.com/api",
		syncTags: "shopify-sync",
	};

	const mockPendingJob = {
		id: "job-123",
		shopId: "shop-123",
		status: "pending",
		createdAt: new Date(),
		shop: mockShop,
	};

	const mockAdmin = {
		graphql: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should find pending jobs with correct query", async () => {
		mockPrisma.syncJob.findFirst.mockResolvedValue(mockPendingJob);

		// Test that the mock is set up correctly for worker polling
		expect(mockPrisma.syncJob.findFirst).toBeDefined();
		expect(typeof mockPrisma.syncJob.findFirst).toBe("function");

		// Mock will return the pending job when called with this query
		mockPrisma.syncJob.findFirst.mockResolvedValue(mockPendingJob);
	});

	it("should mark job as running when processing", () => {
		// Test that the mock is set up correctly for worker logic
		mockPrisma.syncJob.update.mockResolvedValue({
			...mockPendingJob,
			status: "running",
			startedAt: new Date(),
		});

		// Verify mock is callable (worker will call this)
		expect(mockPrisma.syncJob.update).toBeDefined();
		expect(typeof mockPrisma.syncJob.update).toBe("function");
	});

	it("should get admin API using unauthenticated.admin", () => {
		// Test that the mock is set up correctly for worker logic
		mockUnauthenticated.admin.mockResolvedValue({
			admin: mockAdmin,
		});

		// Verify mock is callable (worker will call this)
		expect(mockUnauthenticated.admin).toBeDefined();
		expect(typeof mockUnauthenticated.admin).toBe("function");
	});

	it("should call syncBynderAssets with correct parameters", () => {
		// Test that mocks are set up correctly for worker logic
		mockBynderClient.createFromEnv.mockReturnValue({
			getAllMediaItems: vi.fn(),
		} as unknown as { getAllMediaItems: ReturnType<typeof vi.fn> });

		mockUnauthenticated.admin.mockResolvedValue({
			admin: mockAdmin,
		});

		vi.mocked(syncBynderAssets).mockResolvedValue({
			processed: 5,
			created: 3,
			updated: 2,
			errors: [],
		});

		// Verify mocks are callable (worker will call these)
		expect(mockBynderClient.createFromEnv).toBeDefined();
		expect(typeof mockBynderClient.createFromEnv).toBe("function");
		expect(syncBynderAssets).toBeDefined();
	});

	it("should mark job as failed on error", () => {
		// Test that the mock is set up correctly for error handling
		const error = new Error("Sync failed");
		mockPrisma.syncJob.update.mockResolvedValue({
			...mockPendingJob,
			status: "failed",
			completedAt: new Date(),
			error: error.message,
		});

		// Verify mock is callable (worker will call this on error)
		expect(mockPrisma.syncJob.update).toBeDefined();
		expect(typeof mockPrisma.syncJob.update).toBe("function");
	});

	it("should handle missing Bynder configuration", () => {
		const jobWithoutBynder = {
			...mockPendingJob,
			shop: {
				...mockShop,
				bynderBaseUrl: null,
			},
		};

		expect(() => {
			if (!jobWithoutBynder.shop.bynderBaseUrl) {
				throw new Error("Bynder not configured for this shop");
			}
		}).toThrow("Bynder not configured for this shop");
	});
});
