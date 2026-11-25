import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSyncTagList,
	MAX_SYNC_TAGS,
	parseSyncTags,
} from "../../lib/sync/sync-tag-security-limits.js";
import { action } from "../app.settings.js";

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
	return { default: mockPrisma };
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
};

const authenticatedShop = "staff-shop.myshopify.com";

function settingsRequest(syncTags: string, extra?: Record<string, string>) {
	const formData = new FormData();
	formData.append("intent", "update_sync_tags");
	formData.append("syncTags", syncTags);
	for (const [key, value] of Object.entries(extra ?? {})) {
		formData.append(key, value);
	}
	return new Request("http://localhost/app/settings", {
		method: "POST",
		body: formData,
	});
}

function savedSyncTags(): string | undefined {
	const call = mockPrisma.shop.upsert.mock.calls[0]?.[0] as
		| { update?: { syncTags?: string }; where?: { shop?: string } }
		| undefined;
	return call?.update?.syncTags;
}

describe("settings sync tag cap", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: { shop: authenticatedShop },
		});
		mockPrisma.shop.upsert.mockResolvedValue({
			id: "shop-a",
			shop: authenticatedShop,
		});
	});

	it("saves a tag list at the cap for the authenticated shop", async () => {
		const submitted = buildSyncTagList(MAX_SYNC_TAGS)
			.split(",")
			.map((tag) => ` ${tag} `)
			.join(",");

		const result = await action({
			request: settingsRequest(submitted, {
				shop: "other-merchant.myshopify.com",
			}),
		} as ActionFunctionArgs);

		expect(result).toHaveProperty("status", 302);
		expect(mockPrisma.shop.upsert).toHaveBeenCalledTimes(1);
		const saved = savedSyncTags();
		expect(parseSyncTags(saved ?? "")).toEqual(
			parseSyncTags(buildSyncTagList(MAX_SYNC_TAGS))
		);
		expect(mockPrisma.shop.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { shop: authenticatedShop },
			})
		);
	});

	it("rejects one tag over the cap and does not write the shop", async () => {
		const submitted = buildSyncTagList(MAX_SYNC_TAGS + 1)
			.split(",")
			.map((tag) => ` ${tag} `)
			.join(", ");

		await action({
			request: settingsRequest(submitted),
		} as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).not.toHaveBeenCalled();
	});

	it("rejects a list of tens of thousands of tags and does not write", async () => {
		await action({
			request: settingsRequest(buildSyncTagList(10_000)),
		} as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).not.toHaveBeenCalled();
	});

	it("counts duplicate tags toward the cap", async () => {
		const submitted = Array.from(
			{ length: MAX_SYNC_TAGS + 1 },
			() => "sale"
		).join(",");

		await action({
			request: settingsRequest(submitted),
		} as ActionFunctionArgs);

		expect(mockPrisma.shop.upsert).not.toHaveBeenCalled();
	});
});
