/**
 * @vitest-environment node
 *
 * Spec for the unsanitized Bynder portal URL.
 *
 * These tests fail while a shop staff session can store any portal URL and
 * later operations send the deployment BYNDER_PERMANENT_TOKEN to that host
 * or fetch a second URL the host names. They pass once all of the following
 * hold:
 *
 * - A portal URL is saved only when its scheme is https, it has no username
 *   or password, and its host is getbynder.com, bynder.com, or a subdomain
 *   of one of those. The host is the URL parser's host, not a substring.
 * - The permanent token is attached only to requests whose host passes that
 *   same check. A value already stored on the shop is refused before any
 *   socket is opened.
 * - A download response with an s3_file URL is fetched only when that URL is
 *   https, has no username or password, and its host is a Bynder storage
 *   host: the leftmost label starts with "bynder", and the rest is
 *   .s3.amazonaws.com, .s3.<region>.amazonaws.com, or
 *   .s3-<region>.amazonaws.com.
 * - An HTTP redirect is followed only when the next hop passes the same
 *   check as the URL that produced it. A refused hop is not requested.
 * - Bytes from a refused URL are not uploaded to Shopify, and the response
 *   body is not returned to the caller.
 */

import type { Server } from "node:http";
import http from "node:http";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BynderClient } from "./client.js";
import {
	createWebhookSubscription,
	deleteWebhookSubscription,
	getWebhookSubscription,
	updateWebhookSubscription,
} from "./webhooks.js";

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
	unauthenticated: {
		admin: vi.fn(),
	},
}));

import prisma from "../../db.server.js";
import { loader as assetsLoader } from "../../routes/api.bynder.assets.js";
import { loader as bynderTestLoader } from "../../routes/api.bynder.test.js";
import { action as webhookReceiver } from "../../routes/api.bynder.webhooks.js";
import { action as webhookTestEndpoint } from "../../routes/api.bynder.webhooks.test-endpoint.js";
import { action as syncAction } from "../../routes/api.sync.js";
import { action as retryAction } from "../../routes/api.sync.retry.js";
import { action as settingsAction } from "../../routes/app.settings.js";
import { action as webhooksAction } from "../../routes/app.webhooks.js";
import { authenticate, unauthenticated } from "../../shopify.server.js";
import { syncBynderAssets } from "../sync/auto-sync.js";

const SHOP = "staff-shop.myshopify.com";
const SHOP_ID = "shop-123";
const ERROR_MARKER = "portal-ssrf-body-marker";
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0xd9]);

type RecordedRequest = {
	method: string;
	url: string;
	sentPermanentToken: boolean;
};

type Probe = {
	requests: RecordedRequest[];
	origin: string;
	close: () => Promise<void>;
};

function authorizationCarriesPermanentToken(
	authorization: string | undefined
): boolean {
	const token = process.env.BYNDER_PERMANENT_TOKEN;
	if (!token || !authorization) {
		return false;
	}
	return authorization === `Bearer ${token}`;
}

function listen(
	onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<Probe> {
	const requests: RecordedRequest[] = [];
	const server: Server = http.createServer((req, res) => {
		requests.push({
			method: req.method ?? "GET",
			url: req.url ?? "",
			sentPermanentToken: authorizationCarriesPermanentToken(
				req.headers.authorization
			),
		});
		onRequest(req, res);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Probe did not bind a TCP port"));
				return;
			}
			resolve({
				requests,
				origin: `http://127.0.0.1:${address.port}`,
				close: () =>
					new Promise((done, fail) => {
						server.close((error) => (error ? fail(error) : done()));
					}),
			});
		});
	});
}

function isApprovedPortalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return (
		host === "getbynder.com" ||
		host.endsWith(".getbynder.com") ||
		host === "bynder.com" ||
		host.endsWith(".bynder.com")
	);
}

let portal: Probe;
let internal: Probe;
let portalMode: "api" | "download-redirect" = "api";
let s3Target = "";
let internalMode: "error" | "file" = "error";
let subscriptionActive = false;
let currentBaseUrl = "";

const graphql = vi.fn();

const db = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	syncJob: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		findUnique: ReturnType<typeof vi.fn>;
	};
	syncedAsset: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	webhookSubscription: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
	webhookEvent: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
};

function shopRecord() {
	return {
		id: SHOP_ID,
		shop: SHOP,
		bynderBaseUrl: currentBaseUrl,
		syncTags: "shopify-sync",
		fileFolderTemplate: null,
		filenamePrefix: null,
		filenameSuffix: null,
		altTextPrefix: null,
		enableAutoAltText: false,
		webhookSubscriptions: subscriptionActive
			? [
					{
						id: "sub-1",
						active: true,
						bynderWebhookId: "wh-existing",
						eventType: "asset.tagged",
						endpoint: "https://test.example.com/api/bynder/webhooks",
					},
				]
			: [],
	};
}

function expectNoOutbound() {
	const sentToken = [...portal.requests, ...internal.requests].some(
		(request) => request.sentPermanentToken
	);
	expect(sentToken).toBe(false);
	expect(portal.requests).toEqual([]);
	expect(internal.requests).toEqual([]);
	expect(graphql).not.toHaveBeenCalled();
}

function portalHandler(req: http.IncomingMessage, res: http.ServerResponse) {
	const path = (req.url ?? "").split("?")[0] ?? "";
	if (path.endsWith("/download") && portalMode === "download-redirect") {
		res.writeHead(302, { Location: `${internal.origin}/via-redirect` });
		res.end();
		return;
	}
	if (path.endsWith("/download")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ s3_file: s3Target }));
		return;
	}
	if (/\/v4\/media\/[^/]+\/$/.test(path)) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				id: "asset-1",
				name: "asset.jpg",
				type: "image",
				tags: ["shopify-sync"],
				version: 1,
				description: "asset",
			})
		);
		return;
	}
	if (path.includes("/v7/webhooks")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				id: "wh-created",
				url: "https://test.example.com/api/bynder/webhooks",
				events: ["asset.tagged"],
				active: true,
			})
		);
		return;
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end("[]");
}

function internalHandler(req: http.IncomingMessage, res: http.ServerResponse) {
	const path = (req.url ?? "").split("?")[0] ?? "";
	if (internalMode === "file" || path.endsWith("/file")) {
		res.writeHead(200, { "Content-Type": "image/jpeg" });
		res.end(jpegBytes);
		return;
	}
	res.writeHead(500, { "Content-Type": "text/plain" });
	res.end(ERROR_MARKER);
}

function formPost(url: string, fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields);
	return new Request(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
}

async function readResult(result: unknown): Promise<string> {
	if (result instanceof Response) {
		return result.text();
	}
	return JSON.stringify(result);
}

async function run(work: () => Promise<unknown>): Promise<string> {
	try {
		return await readResult(await work());
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

beforeAll(async () => {
	internal = await listen(internalHandler);
	portal = await listen(portalHandler);
	s3Target = `${internal.origin}/secret`;
	currentBaseUrl = portal.origin;
});

afterAll(async () => {
	await portal.close();
	await internal.close();
});

beforeEach(() => {
	portal.requests.length = 0;
	internal.requests.length = 0;
	portalMode = "api";
	internalMode = "error";
	s3Target = `${internal.origin}/secret`;
	subscriptionActive = false;
	currentBaseUrl = portal.origin;
	graphql.mockReset();
	vi.clearAllMocks();

	db.webhookSubscription = {
		create: vi.fn().mockResolvedValue({ id: "sub-1" }),
		update: vi.fn().mockResolvedValue({ id: "sub-1" }),
	};
	db.webhookEvent = {
		create: vi.fn().mockResolvedValue({ id: "evt-1" }),
		update: vi.fn().mockResolvedValue({ id: "evt-1" }),
	};
	db.syncJob.findUnique = vi.fn().mockResolvedValue({
		id: "job-1",
		status: "running",
		errors: null,
	});
	db.syncJob.create.mockResolvedValue({ id: "job-1", status: "running" });
	db.syncJob.update.mockResolvedValue({ id: "job-1" });
	db.syncJob.findMany.mockResolvedValue([]);
	db.syncedAsset.findUnique.mockResolvedValue(null);
	db.syncedAsset.upsert.mockResolvedValue({ id: "synced-1" });
	db.shop.upsert.mockResolvedValue({ id: SHOP_ID });
	db.shop.findUnique.mockImplementation(
		async (args: { where?: { shop?: string; id?: string } }) => {
			const where = args?.where;
			if (where?.shop === SHOP || where?.id === SHOP_ID) {
				return shopRecord();
			}
			return null;
		}
	);
	(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
		session: { shop: SHOP },
		admin: { graphql },
	});
	(unauthenticated.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
		session: { shop: SHOP },
		admin: { graphql },
	});
});

describe("portal URL saved from Bynder settings", () => {
	const rejected = [
		"http://127.0.0.1:9/api",
		"https://127.0.0.1/api",
		"https://2130706433/api",
		"https://0x7f000001/api",
		"http://localhost/api",
		"https://169.254.169.254/latest/meta-data",
		"https://10.1.2.3/api",
		"https://[::1]/api",
		"https://evil.example/api",
		"https://portal.getbynder.com.evil.example/api",
		"https://notbynder.com/api",
		"https://bynder.com.evil.example/api",
		"http://portal.getbynder.com/api",
		"https://user:secret@portal.getbynder.com/api",
		"https://portal.getbynder.com@evil.example/api",
		"javascript:alert(1)",
		"file:///etc/passwd",
	];

	it.each(
		rejected
	)("refuses %s before writing the shop row", async (bynderBaseUrl) => {
		const request = formPost("http://localhost/app/settings", {
			intent: "update_bynder_url",
			bynderBaseUrl,
		});

		const result = await settingsAction({ request } as ActionFunctionArgs);

		expect(db.shop.upsert).not.toHaveBeenCalled();
		if (result instanceof Response) {
			expect(result.status).not.toBe(302);
		}
	});

	it.each([
		"https://portal.getbynder.com/api",
		"https://portal.getbynder.com",
		"https://brand.bynder.com/api",
		"https://PORTAL.GETBYNDER.COM/api",
	])("stores %s only as an approved https portal", async (bynderBaseUrl) => {
		const request = formPost("http://localhost/app/settings", {
			intent: "update_bynder_url",
			bynderBaseUrl,
		});

		await settingsAction({ request } as ActionFunctionArgs);

		expect(db.shop.upsert).toHaveBeenCalledOnce();
		const stored = db.shop.upsert.mock.calls[0]?.[0]?.update
			?.bynderBaseUrl as string;
		const parsed = new URL(stored);
		expect(parsed.protocol).toBe("https:");
		expect(parsed.username).toBe("");
		expect(parsed.password).toBe("");
		expect(isApprovedPortalHost(parsed.hostname)).toBe(true);
	});
});

describe("permanent token stays on an approved portal host", () => {
	async function clientForStoredPortal(): Promise<BynderClient> {
		return BynderClient.createFromEnv(currentBaseUrl);
	}

	it("does not post the token when creating a webhook subscription", async () => {
		const client = await clientForStoredPortal().catch(() => null);
		if (client) {
			await createWebhookSubscription(
				client,
				"https://test.example.com/api/bynder/webhooks"
			).catch(() => undefined);
		}
		expectNoOutbound();
	});

	it("does not send the token when updating a webhook subscription", async () => {
		const client = await clientForStoredPortal().catch(() => null);
		if (client) {
			await updateWebhookSubscription(
				client,
				"wh-existing",
				"https://test.example.com/api/bynder/webhooks"
			).catch(() => undefined);
		}
		expectNoOutbound();
	});

	it("does not send the token when deleting a webhook subscription", async () => {
		const client = await clientForStoredPortal().catch(() => null);
		if (client) {
			await deleteWebhookSubscription(client, "wh-existing").catch(
				() => undefined
			);
		}
		expectNoOutbound();
	});

	it("does not send the token when reading a webhook subscription", async () => {
		const client = await clientForStoredPortal().catch(() => null);
		if (client) {
			await getWebhookSubscription(client, "wh-existing").catch(
				() => undefined
			);
		}
		expectNoOutbound();
	});

	it("does not contact the stored host when a staff session activates webhooks", async () => {
		const request = formPost("http://localhost/app/webhooks", {
			intent: "toggle_webhook",
			active: "true",
		});
		await run(() => webhooksAction({ request } as ActionFunctionArgs));
		expectNoOutbound();
	});

	it("does not contact the stored host when activating an existing webhook", async () => {
		subscriptionActive = true;
		const request = formPost("http://localhost/app/webhooks", {
			intent: "toggle_webhook",
			active: "true",
		});
		await run(() => webhooksAction({ request } as ActionFunctionArgs));
		expectNoOutbound();
	});

	it("does not contact the stored host when a staff session deactivates webhooks", async () => {
		subscriptionActive = true;
		const request = formPost("http://localhost/app/webhooks", {
			intent: "toggle_webhook",
			active: "false",
		});
		await run(() => webhooksAction({ request } as ActionFunctionArgs));
		expectNoOutbound();
	});

	it("does not contact the stored host from the connection test", async () => {
		const request = new Request("http://localhost/api/bynder/test");
		await run(() => bynderTestLoader({ request } as LoaderFunctionArgs));
		expectNoOutbound();
	});

	it("does not contact the stored host when listing assets", async () => {
		const request = new Request("http://localhost/api/bynder/assets");
		await run(() => assetsLoader({ request } as LoaderFunctionArgs));
		expectNoOutbound();
	});

	it("does not contact the stored host from the background sync sequence", async () => {
		// Same calls as processJobs in app/lib/sync/worker.ts after it loads the
		// shop row. That module is not imported here: loading it starts an
		// infinite loop and exits the process when the database is missing.
		const client = await clientForStoredPortal().catch(() => null);
		if (client) {
			await syncBynderAssets({
				shopId: SHOP_ID,
				admin: { graphql },
				bynderClient: client,
				jobId: "job-1",
			}).catch(() => undefined);
		}
		expectNoOutbound();
	});

	it("does not contact the stored host when retrying a failed asset", async () => {
		const request = new Request("http://localhost/api/sync/retry", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ assetIds: ["asset-1"] }),
		});
		await run(() => retryAction({ request } as ActionFunctionArgs));
		expectNoOutbound();
	});
});

describe("download follows an attacker-named second URL", () => {
	it("does not return the second response body from a single-asset sync", async () => {
		const request = new Request("http://localhost/api/sync?assetId=asset-1", {
			method: "POST",
		});
		const body = await run(() => syncAction({ request } as ActionFunctionArgs));
		expect(body).not.toContain(ERROR_MARKER);
		expectNoOutbound();
	});

	it("does not upload bytes fetched from the second URL", async () => {
		internalMode = "file";
		s3Target = `${internal.origin}/file`;
		const request = new Request("http://localhost/api/sync?assetId=asset-1", {
			method: "POST",
		});
		await run(() => syncAction({ request } as ActionFunctionArgs));
		expectNoOutbound();
	});

	it("does not follow a redirect from the download URL to another host", async () => {
		portalMode = "download-redirect";
		const request = new Request("http://localhost/api/sync?assetId=asset-1", {
			method: "POST",
		});
		const body = await run(() => syncAction({ request } as ActionFunctionArgs));
		expect(body).not.toContain(ERROR_MARKER);
		expectNoOutbound();
	});

	it("does not fetch the second URL when an incoming webhook syncs an asset", async () => {
		subscriptionActive = true;
		const request = new Request("http://localhost/api/bynder/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ eventType: "asset.tagged", assetId: "asset-1" }),
		});
		const body = await run(() =>
			webhookReceiver({ request } as ActionFunctionArgs)
		);
		expect(body).not.toContain(ERROR_MARKER);
		expectNoOutbound();
	});

	it("does not fetch the second URL from the webhook test endpoint", async () => {
		subscriptionActive = true;
		const request = new Request(
			"http://localhost/api/bynder/webhooks/test-endpoint",
			{ method: "POST" }
		);
		const body = await run(() =>
			webhookTestEndpoint({ request } as ActionFunctionArgs)
		);
		expect(body).not.toContain(ERROR_MARKER);
		expectNoOutbound();
	});
});
