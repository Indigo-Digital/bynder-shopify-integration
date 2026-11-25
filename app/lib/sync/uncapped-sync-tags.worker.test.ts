import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSyncTagList,
	MAX_SYNC_TAGS,
	parseSyncTags,
} from "./sync-tag-security-limits.js";

const harness = vi.hoisted(() => ({
	findCount: 0,
	tagScans: [] as Array<{ shopId?: string; tags?: string }>,
	releaseDone: () => {},
	done: null as Promise<void> | null,
}));

harness.done = new Promise<void>((resolve) => {
	harness.releaseDone = resolve;
});

vi.mock("../../db.server.js", () => ({
	default: {
		$connect: vi.fn(async () => undefined),
		$disconnect: vi.fn(async () => undefined),
		shop: { findUnique: vi.fn() },
		syncedAsset: { findUnique: vi.fn() },
		syncJob: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
		},
		syncMetrics: { create: vi.fn() },
	},
}));

vi.mock("../../shopify.server.js", () => ({
	unauthenticated: {
		admin: vi.fn(async () => ({ admin: { graphql: vi.fn() } })),
	},
}));

vi.mock("../bynder/client.js", () => ({
	BynderClient: {
		createFromEnv: vi.fn(() => ({
			getAllMediaItems: vi.fn(
				async (params: { tags?: string; shopId?: string }) => {
					harness.tagScans.push({
						tags: params.tags,
						shopId: params.shopId,
					});
					return [];
				}
			),
		})),
	},
}));

import prisma from "../../db.server.js";

const mockPrisma = prisma as unknown as {
	shop: { findUnique: ReturnType<typeof vi.fn> };
	syncJob: {
		findFirst: ReturnType<typeof vi.fn>;
		findUnique: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
};

const shopATags = parseSyncTags(buildSyncTagList(MAX_SYNC_TAGS + 30, "shop-a"));
const shopBTag = "shop-b-only";

function shopRow(id: string, domain: string, syncTags: string) {
	return {
		id,
		shop: domain,
		syncTags,
		bynderBaseUrl: "https://portal.example/api",
		fileFolderTemplate: null,
		filenamePrefix: null,
		filenameSuffix: null,
		altTextPrefix: null,
		enableAutoAltText: false,
	};
}

describe("worker queue tag cap", () => {
	beforeEach(() => {
		process.env.ENABLE_METRICS = "false";
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		harness.findCount = 0;
		harness.tagScans.length = 0;
		const shopA = shopRow(
			"shop-a",
			"staff-shop.myshopify.com",
			shopATags.join(",")
		);
		const shopB = shopRow("shop-b", "other-merchant.myshopify.com", shopBTag);
		mockPrisma.shop.findUnique.mockImplementation(
			async (args: { where: { id: string } }) => {
				if (args.where.id === shopA.id) {
					return shopA;
				}
				if (args.where.id === shopB.id) {
					return shopB;
				}
				return null;
			}
		);
		mockPrisma.syncJob.findUnique.mockResolvedValue({
			id: "job-a",
			status: "running",
		});
		mockPrisma.syncJob.update.mockResolvedValue({});
		mockPrisma.syncJob.findFirst.mockImplementation(async () => {
			harness.findCount += 1;
			if (harness.findCount === 1) {
				return {
					id: "job-a",
					shopId: shopA.id,
					status: "pending",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					shop: shopA,
				};
			}
			if (harness.findCount === 2) {
				return {
					id: "job-b",
					shopId: shopB.id,
					status: "pending",
					createdAt: new Date("2026-01-01T00:00:01.000Z"),
					shop: shopB,
				};
			}
			harness.releaseDone();
			return new Promise(() => undefined);
		});
	});

	it("caps one shop's tag scans before it takes the next shop's job", async () => {
		await import("./worker.js");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<string>((resolve) => {
			timer = setTimeout(() => resolve("timeout"), 15_000);
		});
		const result = await Promise.race([
			harness.done?.then(() => "done"),
			timeout,
		]);
		if (timer) {
			clearTimeout(timer);
		}

		expect(result).toBe("done");
		const shopAScans = harness.tagScans.filter(
			(scan) => scan.shopId === "shop-a"
		);
		const shopBIndex = harness.tagScans.findIndex(
			(scan) => scan.shopId === "shop-b"
		);
		expect(shopAScans).toHaveLength(MAX_SYNC_TAGS);
		expect(shopAScans[0]?.tags).toBe(shopATags[0]);
		expect(shopAScans[MAX_SYNC_TAGS - 1]?.tags).toBe(
			shopATags[MAX_SYNC_TAGS - 1]
		);
		expect(
			shopAScans.some((scan) => scan.tags === shopATags[MAX_SYNC_TAGS])
		).toBe(false);
		expect(shopBIndex).toBe(MAX_SYNC_TAGS);
		expect(harness.tagScans[shopBIndex]?.tags).toBe(shopBTag);
	});
});
