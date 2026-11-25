import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "../api.sync.js";

interface StoredJob {
	id: string;
	shopId: string;
	status: string;
}

interface JobWhere {
	shopId?: string;
	status?: string | { in?: string[]; not?: string; notIn?: string[] };
	OR?: JobWhere[];
	AND?: JobWhere[];
	NOT?: JobWhere;
}

const jobs: StoredJob[] = [];

function matches(job: StoredJob, where?: JobWhere): boolean {
	if (!where) {
		return true;
	}
	if (where.shopId !== undefined && job.shopId !== where.shopId) {
		return false;
	}
	const status = where.status;
	if (typeof status === "string" && job.status !== status) {
		return false;
	}
	if (status && typeof status === "object") {
		if (status.in && !status.in.includes(job.status)) {
			return false;
		}
		if (status.not && job.status === status.not) {
			return false;
		}
		if (status.notIn?.includes(job.status)) {
			return false;
		}
	}
	if (where.OR && !where.OR.some((clause) => matches(job, clause))) {
		return false;
	}
	if (where.AND && !where.AND.every((clause) => matches(job, clause))) {
		return false;
	}
	if (where.NOT && matches(job, where.NOT)) {
		return false;
	}
	return true;
}

const shopA = {
	id: "shop-a",
	shop: "staff-shop.myshopify.com",
	bynderBaseUrl: "https://portal.example/api",
	syncTags: "shopify-sync",
};

const shopB = {
	id: "shop-b",
	shop: "other-merchant.myshopify.com",
	bynderBaseUrl: "https://other.example/api",
	syncTags: "shopify-sync",
};

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
			findFirst: vi.fn(),
			findMany: vi.fn(),
			count: vi.fn(),
		},
	};
	return { default: mockPrisma };
});

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

vi.mock("../../lib/bynder/client.js", () => ({
	BynderClient: {
		createFromEnv: vi.fn(() => ({ getMediaInfo: vi.fn() })),
	},
}));

vi.mock("../../lib/shopify/files.js", () => ({
	uploadBynderAsset: vi.fn(),
}));

import prisma from "../../db.server.js";
import { authenticate } from "../../shopify.server.js";

const mockPrisma = prisma as unknown as {
	shop: { findUnique: ReturnType<typeof vi.fn> };
	syncJob: {
		create: ReturnType<typeof vi.fn>;
		findFirst: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		count: ReturnType<typeof vi.fn>;
	};
};

function shopsByWhere(where?: { shop?: string; id?: string }) {
	if (where?.shop === shopA.shop || where?.id === shopA.id) {
		return shopA;
	}
	if (where?.shop === shopB.shop || where?.id === shopB.id) {
		return shopB;
	}
	return null;
}

describe("full sync keeps one active job per shop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		jobs.length = 0;
		(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: { shop: shopA.shop },
			admin: { graphql: vi.fn() },
		});
		mockPrisma.shop.findUnique.mockImplementation(
			async (args: {
				where?: { shop?: string; id?: string };
				include?: { syncJobs?: boolean | { where?: JobWhere } };
			}) => {
				const shop = shopsByWhere(args?.where);
				if (!shop) {
					return null;
				}
				const include = args.include?.syncJobs;
				if (!include) {
					return shop;
				}
				const where = include === true ? undefined : include.where;
				return {
					...shop,
					syncJobs: jobs.filter(
						(job) => job.shopId === shop.id && matches(job, where)
					),
				};
			}
		);
		mockPrisma.syncJob.findFirst.mockImplementation(
			async (args?: { where?: JobWhere }) =>
				jobs.find((job) => matches(job, args?.where)) ?? null
		);
		mockPrisma.syncJob.findMany.mockImplementation(
			async (args?: { where?: JobWhere }) =>
				jobs.filter((job) => matches(job, args?.where))
		);
		mockPrisma.syncJob.count.mockImplementation(
			async (args?: { where?: JobWhere }) =>
				jobs.filter((job) => matches(job, args?.where)).length
		);
		mockPrisma.syncJob.create.mockImplementation(
			async (args: { data: { shopId: string; status: string } }) => {
				const job = {
					id: `job-${jobs.length + 1}`,
					shopId: args.data.shopId,
					status: args.data.status,
				};
				jobs.push(job);
				return job;
			}
		);
	});

	async function postFullSync(url = "http://localhost/api/sync") {
		const request = new Request(url, { method: "POST" });
		return action({ request } as ActionFunctionArgs);
	}

	it("creates one full sync job for the authenticated shop", async () => {
		const response = await postFullSync(
			"http://localhost/api/sync?shop=other-merchant.myshopify.com"
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(mockPrisma.syncJob.create).toHaveBeenCalledTimes(1);
		expect(jobs).toEqual([
			expect.objectContaining({ shopId: shopA.id, status: "pending" }),
		]);
	});

	it("does not queue a second job while one is pending", async () => {
		await postFullSync();
		await postFullSync();

		expect(mockPrisma.syncJob.create).toHaveBeenCalledTimes(1);
		expect(jobs.filter((job) => job.shopId === shopA.id)).toHaveLength(1);
	});

	it("does not queue a second job while one is running", async () => {
		jobs.push({ id: "job-running", shopId: shopA.id, status: "running" });

		await postFullSync();

		expect(mockPrisma.syncJob.create).not.toHaveBeenCalled();
	});

	it("still queues a job when only another shop has an active job", async () => {
		jobs.push({ id: "job-b", shopId: shopB.id, status: "running" });

		await postFullSync();

		expect(mockPrisma.syncJob.create).toHaveBeenCalledTimes(1);
		expect(jobs.some((job) => job.shopId === shopA.id)).toBe(true);
	});

	it.each([
		"completed",
		"failed",
		"cancelled",
	] as const)("queues a new job after the previous one is %s", async (status) => {
		jobs.push({ id: `job-${status}`, shopId: shopA.id, status });

		await postFullSync();

		expect(mockPrisma.syncJob.create).toHaveBeenCalledTimes(1);
		expect(jobs.filter((job) => job.shopId === shopA.id)).toHaveLength(2);
	});
});
