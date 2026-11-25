import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BynderClient } from "../bynder/client.js";
import type { AdminApi } from "../types.js";
import { syncBynderAssets } from "./auto-sync.js";
import {
	buildSyncTagList,
	MAX_SYNC_TAGS,
	parseSyncTags,
} from "./sync-tag-security-limits.js";

vi.mock("../../db.server.js", () => {
	const mockPrisma = {
		shop: {
			findUnique: vi.fn(),
		},
		syncedAsset: {
			findUnique: vi.fn(),
			upsert: vi.fn(),
		},
		syncJob: {
			create: vi.fn(),
			update: vi.fn(),
			findUnique: vi.fn(),
		},
		syncMetrics: {
			create: vi.fn(),
		},
	};
	return { default: mockPrisma };
});

vi.mock("../shopify/files.js", () => ({
	uploadBynderAsset: vi.fn(),
}));

import prisma from "../../db.server.js";

const mockPrisma = prisma as unknown as {
	shop: { findUnique: ReturnType<typeof vi.fn> };
	syncJob: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		findUnique: ReturnType<typeof vi.fn>;
	};
};

const admin = { graphql: vi.fn() } as unknown as AdminApi;

function shopRecord(syncTags: string) {
	return {
		id: "shop-a",
		shop: "staff-shop.myshopify.com",
		syncTags,
		bynderBaseUrl: "https://portal.example/api",
		fileFolderTemplate: null,
		filenamePrefix: null,
		filenameSuffix: null,
		altTextPrefix: null,
		enableAutoAltText: false,
	};
}

describe("syncBynderAssets tag scan cap", () => {
	const scannedTags: string[] = [];
	const bynderClient = {
		getAllMediaItems: vi.fn(async (params: { tags?: string }) => {
			scannedTags.push(params.tags ?? "");
			return [];
		}),
	} as unknown as BynderClient;

	beforeEach(() => {
		vi.clearAllMocks();
		scannedTags.length = 0;
		process.env.ENABLE_METRICS = "false";
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mockPrisma.syncJob.findUnique.mockResolvedValue({
			id: "job-a",
			status: "running",
		});
		mockPrisma.syncJob.update.mockResolvedValue({ id: "job-a" });
	});

	function expectPrefix(tags: string[]) {
		expect(scannedTags).toHaveLength(MAX_SYNC_TAGS);
		expect(scannedTags[0]).toBe(tags[0]);
		expect(scannedTags[MAX_SYNC_TAGS - 1]).toBe(tags[MAX_SYNC_TAGS - 1]);
		expect(scannedTags).not.toContain(tags[MAX_SYNC_TAGS]);
	}

	it("scans every tag when the saved list is within the cap", async () => {
		const tags = parseSyncTags(buildSyncTagList(MAX_SYNC_TAGS));
		mockPrisma.shop.findUnique.mockResolvedValue(shopRecord(tags.join(",")));

		await syncBynderAssets({
			shopId: "shop-a",
			admin,
			bynderClient,
			jobId: "job-a",
		});

		expect(scannedTags).toEqual(tags);
	});

	it("stops at the cap even if a later shop read returns a longer list", async () => {
		const checkedTags = parseSyncTags(
			buildSyncTagList(MAX_SYNC_TAGS + 30, "checked")
		);
		const rereadTags = parseSyncTags(buildSyncTagList(10_000, "reread"));
		let reads = 0;
		mockPrisma.shop.findUnique.mockImplementation(async () => {
			reads += 1;
			const tags = reads === 1 ? checkedTags : rereadTags;
			return shopRecord(tags.join(","));
		});

		await syncBynderAssets({
			shopId: "shop-a",
			admin,
			bynderClient,
			jobId: "job-a",
		});

		expectPrefix(checkedTags);
	});

	it("does not scan tens of thousands of saved tags", async () => {
		const tags = parseSyncTags(buildSyncTagList(10_000));
		mockPrisma.shop.findUnique.mockResolvedValue(shopRecord(tags.join(",")));

		await syncBynderAssets({
			shopId: "shop-a",
			admin,
			bynderClient,
			jobId: "job-a",
		});

		expectPrefix(tags);
	});
});
