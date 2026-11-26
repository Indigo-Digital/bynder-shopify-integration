// @vitest-environment node
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BynderStandIn } from "./helpers/bynder-stand-in.js";
import {
	adminRequest,
	asAction,
	asLoader,
	shopifyWebhookRequest,
	signWebhookBody,
} from "./helpers/shopify-signed-request.js";

const retentionEnv = vi.hoisted(() => {
	const dbFile = "/tmp/bynder-uninstall-retention-5557.sqlite";
	process.env.DATABASE_URL = `file:${dbFile}`;
	return { dbFile };
});
const DB_FILE = retentionEnv.dbFile;
const UPLOAD_LOG = join(
	tmpdir(),
	`bynder-retention-uploads-${process.pid}.log`
);
const PREVIOUS_SHOP = "previous-merchant.myshopify.com";
const OTHER_SHOP = "other-merchant.myshopify.com";
const PREVIOUS_ASSET_ID = "asset-previous-install";
const PREVIOUS_WEBHOOK_ID = "bynder-subscription-previous";
const PREVIOUS_ERROR = "previous-install sync error";
const PREVIOUS_PAYLOAD = '{"marker":"previous-install-webhook-body"}';
const REINSTALLED_FILE_ID = "gid://shopify/MediaImage/reinstalled";

vi.mock("../../db.server", async () => vi.importActual("../../db.server"));

const standIn = new BynderStandIn();
let portal = "";
let previousShopId = "";
let otherShopId = "";
let pendingJobId = "";

type ShopDelegate = {
	findUnique: (args: {
		where: { shop: string };
	}) => Promise<{ id: string; bynderBaseUrl: string | null } | null>;
	deleteMany: () => Promise<unknown>;
	create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
};
type CountDelegate = {
	count: (args: { where: Record<string, unknown> }) => Promise<number>;
	deleteMany: () => Promise<unknown>;
	create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
	findUnique: (args: { where: { id: string } }) => Promise<{
		id: string;
		status: string;
		errors: string | null;
		assetsCreated: number;
		assetsProcessed: number;
	} | null>;
	findFirst: (args: {
		where: Record<string, unknown>;
	}) => Promise<{ shopifyFileId: string } | null>;
};

let prisma: {
	shop: ShopDelegate;
	syncedAsset: CountDelegate;
	webhookSubscription: CountDelegate;
	webhookEvent: CountDelegate;
	syncJob: CountDelegate;
	syncMetrics: CountDelegate;
	session: CountDelegate & {
		count: (args: { where: { shop: string } }) => Promise<number>;
	};
	$disconnect: () => Promise<void>;
	$queryRawUnsafe: (query: string) => Promise<unknown>;
};

let uninstallAction: (args: ReturnType<typeof asAction>) => Promise<Response>;

beforeAll(async () => {
	patchShopifyFetch();
	rmSync(DB_FILE, { force: true });
	execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
		cwd: repoRoot(),
		env: { ...process.env, DATABASE_URL: `file:${DB_FILE}` },
		stdio: "pipe",
	});
	portal = await standIn.start();
	const db = await import("../../db.server.js");
	prisma = db.default as unknown as typeof prisma;
	await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
	await import("../../shopify.server.js");
	const uninstall = await import("../webhooks.app.uninstalled.js");
	uninstallAction = uninstall.action;
}, 60_000);

afterAll(async () => {
	await standIn.stop();
	await prisma?.$disconnect();
	rmSync(DB_FILE, { force: true });
	rmSync(`${DB_FILE}-journal`, { force: true });
	rmSync(`${DB_FILE}-wal`, { force: true });
	rmSync(`${DB_FILE}-shm`, { force: true });
	rmSync(UPLOAD_LOG, { force: true });
});

beforeEach(async () => {
	standIn.requests.length = 0;
	await prisma.syncMetrics.deleteMany();
	await prisma.webhookEvent.deleteMany();
	await prisma.webhookSubscription.deleteMany();
	await prisma.syncedAsset.deleteMany();
	await prisma.syncJob.deleteMany();
	await prisma.session.deleteMany();
	await prisma.shop.deleteMany();
	const previous = await seedShop(PREVIOUS_SHOP, true);
	const other = await seedShop(OTHER_SHOP, false);
	previousShopId = previous.id;
	otherShopId = other.id;
	pendingJobId = previous.jobId;
});

describe("app uninstall retention", () => {
	it("rejects an uninstall webhook whose HMAC does not match the body", async () => {
		const body = JSON.stringify({ shop_domain: OTHER_SHOP });
		const response = uninstallAction(
			asAction(
				shopifyWebhookRequest({
					url: "https://test.example.com/webhooks/app/uninstalled",
					shop: PREVIOUS_SHOP,
					topic: "app/uninstalled",
					body,
					hmac: signWebhookBody('{"shop_domain":"not-the-body"}'),
				})
			)
		);
		await expect(response).rejects.toMatchObject({ status: 401 });
		expect(
			await prisma.shop.findUnique({ where: { shop: PREVIOUS_SHOP } })
		).not.toBeNull();
	});

	it("deletes the uninstalled shop and leaves every other shop in place", async () => {
		await deliverUninstall();

		expect(
			await prisma.shop.findUnique({ where: { shop: PREVIOUS_SHOP } })
		).toBeNull();
		expect(
			await prisma.syncedAsset.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(
			await prisma.syncJob.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(
			await prisma.webhookSubscription.count({
				where: { shopId: previousShopId },
			})
		).toBe(0);
		expect(
			await prisma.webhookEvent.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(
			await prisma.syncMetrics.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(await prisma.session.count({ where: { shop: PREVIOUS_SHOP } })).toBe(
			0
		);

		const other = await prisma.shop.findUnique({ where: { shop: OTHER_SHOP } });
		expect(other?.bynderBaseUrl).toBe(`${portal}/other`);
		expect(
			await prisma.syncedAsset.count({ where: { shopId: otherShopId } })
		).toBe(1);
		expect(await prisma.session.count({ where: { shop: OTHER_SHOP } })).toBe(1);
	});

	it("deletes the remote Bynder subscription for the shop named by the webhook", async () => {
		await deliverUninstall();

		const deleted = standIn.requests.find(
			(request) =>
				request.method === "DELETE" &&
				request.path.endsWith(
					`/v7/webhooks/public/api/subscriptions/${PREVIOUS_WEBHOOK_ID}`
				)
		);
		expect(deleted).toBeDefined();
		expect(
			standIn.requests.some(
				(request) =>
					request.method === "DELETE" &&
					request.path.includes("bynder-subscription-other")
			)
		).toBe(false);
	});

	it("does not show the previous install on the next admin session", async () => {
		await deliverUninstall();
		await storeOfflineSession(PREVIOUS_SHOP);

		const settings = await loadSettings();
		const webhooks = await loadWebhooks();
		const index = await loadIndex();
		const sync = await loadSync();
		const files = await loadFiles();
		const upload = await loadUpload();
		const fileManager = await loadFileManager();

		for (const payload of [
			settings,
			webhooks,
			index,
			sync,
			files,
			fileManager,
		]) {
			const text = JSON.stringify(payload);
			expect.soft(text).not.toContain(portal);
			expect.soft(text).not.toContain(PREVIOUS_ERROR);
			expect.soft(text).not.toContain("previous-install-webhook-body");
			expect.soft(text).not.toContain(PREVIOUS_ASSET_ID);
			expect.soft(text).not.toContain(PREVIOUS_WEBHOOK_ID);
		}
		expect(upload.aiAltTextAvailable).toBe(false);
	});

	it("does not enqueue another sync against the previous shop row", async () => {
		await deliverUninstall();
		await storeOfflineSession(PREVIOUS_SHOP);
		const syncRoute = await import("../api.sync.js");
		const response = await syncRoute.action(
			asAction(
				new Request("https://test.example.com/api/sync", {
					method: "POST",
					headers: adminRequest(
						"https://test.example.com/api/sync",
						PREVIOUS_SHOP
					).headers,
				})
			)
		);

		expect(response.status).toBe(400);
		expect(
			await prisma.syncJob.count({ where: { shopId: previousShopId } })
		).toBe(0);
	});

	it("does not keep accepting Bynder events for the previous subscription", async () => {
		await deliverUninstall();
		await storeOfflineSession(PREVIOUS_SHOP);
		const route = await import("../api.bynder.webhooks.js");
		const body = JSON.stringify({
			eventType: "asset.tagged",
			assetId: PREVIOUS_ASSET_ID,
			marker: "previous-install-webhook-body",
		});
		const response = await route.action(
			asAction(
				new Request("https://test.example.com/api/bynder/webhooks", {
					method: "POST",
					headers: {
						...Object.fromEntries(
							adminRequest(
								"https://test.example.com/api/bynder/webhooks",
								PREVIOUS_SHOP
							).headers
						),
						"Content-Type": "application/json",
					},
					body,
				})
			)
		);

		expect(response.status).toBe(400);
		expect(
			await prisma.webhookEvent.count({
				where: { shopId: previousShopId, assetId: PREVIOUS_ASSET_ID },
			})
		).toBe(0);
	});
});

describe("shop/redact", () => {
	it("is subscribed in the app config at the shop redact route", () => {
		const toml = readFileSync(join(repoRoot(), "shopify.app.toml"), "utf8");
		expect(toml).toContain("shop/redact");
		expect(toml).toContain("/webhooks/shop/redact");
	});

	it("deletes the same shop data as uninstall, for the authenticated shop only", async () => {
		const routeUrl = pathToFileURL(
			join(repoRoot(), "app/routes/webhooks.shop.redact.ts")
		).href;
		const route = (await import(
			/* @vite-ignore */
			routeUrl
		)) as {
			action: (args: ReturnType<typeof asAction>) => Promise<Response>;
		};
		const body = JSON.stringify({
			shop_id: 954889,
			shop_domain: OTHER_SHOP,
		});
		await route.action(
			asAction(
				shopifyWebhookRequest({
					url: "https://test.example.com/webhooks/shop/redact",
					shop: PREVIOUS_SHOP,
					topic: "shop/redact",
					body,
				})
			)
		);

		expect(
			await prisma.shop.findUnique({ where: { shop: PREVIOUS_SHOP } })
		).toBeNull();
		expect(
			await prisma.syncedAsset.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(
			await prisma.syncJob.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(
			await prisma.webhookEvent.count({ where: { shopId: previousShopId } })
		).toBe(0);
		expect(
			standIn.requests.some(
				(request) =>
					request.method === "DELETE" &&
					request.path.endsWith(
						`/v7/webhooks/public/api/subscriptions/${PREVIOUS_WEBHOOK_ID}`
					)
			)
		).toBe(true);
		expect(
			(await prisma.shop.findUnique({ where: { shop: OTHER_SHOP } }))
				?.bynderBaseUrl
		).toBe(`${portal}/other`);
	});
});

describe("pending sync after reinstall", () => {
	it("does not import the previous install's pending job into the shop files", async () => {
		await deliverUninstall();
		await storeOfflineSession(PREVIOUS_SHOP);
		rmSync(UPLOAD_LOG, { force: true });
		const worker = startWorker();
		const observed = await waitForWorker(12_000);
		stopWorker(worker);

		const job = await prisma.syncJob.findUnique({
			where: { id: pendingJobId },
		});
		const imported = await prisma.syncedAsset.findFirst({
			where: { shopifyFileId: REINSTALLED_FILE_ID },
		});
		expect({
			fileCreates: observed.filter((entry) => entry.kind === "fileCreate"),
			jobStatus: job?.status ?? null,
			shopifyFileId: imported?.shopifyFileId ?? null,
		}).toEqual({
			fileCreates: [],
			jobStatus: null,
			shopifyFileId: null,
		});
	}, 40_000);
});

async function seedShop(shop: string, previousInstall: boolean) {
	const created = await prisma.shop.create({
		data: {
			shop,
			bynderBaseUrl: previousInstall ? portal : `${portal}/other`,
			syncTags: "shopify-sync",
			enableAutoAltText: previousInstall,
		},
	});
	await prisma.syncedAsset.create({
		data: {
			shopId: created.id,
			bynderAssetId: previousInstall ? PREVIOUS_ASSET_ID : "asset-other-shop",
			shopifyFileId: previousInstall
				? "gid://shopify/MediaImage/old"
				: "gid://shopify/MediaImage/other",
			syncType: "auto",
			bynderTags: '["shopify-sync"]',
			bynderVersion: 1,
		},
	});
	const job = await prisma.syncJob.create({
		data: {
			shopId: created.id,
			status: previousInstall ? "pending" : "completed",
			error: previousInstall ? PREVIOUS_ERROR : null,
			assetsProcessed: 0,
		},
	});
	await prisma.webhookSubscription.create({
		data: {
			shopId: created.id,
			bynderWebhookId: previousInstall
				? PREVIOUS_WEBHOOK_ID
				: "bynder-subscription-other",
			eventType: "asset.tagged",
			endpoint: "https://test.example.com/api/bynder/webhooks",
			active: true,
		},
	});
	await prisma.webhookEvent.create({
		data: {
			shopId: created.id,
			eventType: "asset.tagged",
			assetId: previousInstall ? PREVIOUS_ASSET_ID : "asset-other-shop",
			status: "success",
			payload: previousInstall
				? PREVIOUS_PAYLOAD
				: '{"marker":"other-shop-webhook-body"}',
		},
	});
	await prisma.syncMetrics.create({
		data: {
			shopId: created.id,
			metricType: "sync_duration",
			metricName: "sync_duration_seconds",
			value: 1,
		},
	});
	await storeOfflineSession(shop);
	return { id: created.id, jobId: job.id };
}

async function storeOfflineSession(shop: string) {
	await prisma.session.create({
		data: {
			id: `offline_${shop}`,
			shop,
			state: "installed",
			isOnline: false,
			scope: "write_products,read_files,write_files",
			accessToken: "placeholder-offline-access-token",
			accountOwner: false,
		},
	});
}

async function deliverUninstall() {
	const body = JSON.stringify({ shop_id: 954889, shop_domain: OTHER_SHOP });
	const response = await uninstallAction(
		asAction(
			shopifyWebhookRequest({
				url: "https://test.example.com/webhooks/app/uninstalled",
				shop: PREVIOUS_SHOP,
				topic: "app/uninstalled",
				body,
			})
		)
	);
	expect(response.status).toBe(200);
}

async function loadSettings() {
	const route = await import("../app.settings.js");
	return route.loader(
		asLoader(
			adminRequest("https://test.example.com/app/settings", PREVIOUS_SHOP)
		)
	);
}

async function loadWebhooks() {
	const route = await import("../app.webhooks.js");
	return route.loader(
		asLoader(
			adminRequest("https://test.example.com/app/webhooks", PREVIOUS_SHOP)
		)
	);
}

async function loadIndex() {
	const route = await import("../app._index.js");
	return route.loader(
		asLoader(adminRequest("https://test.example.com/app", PREVIOUS_SHOP))
	);
}

async function loadSync() {
	const route = await import("../app.sync.js");
	return route.loader(
		asLoader(adminRequest("https://test.example.com/app/sync", PREVIOUS_SHOP))
	);
}

async function loadFiles() {
	const route = await import("../app.files.js");
	return route.loader(
		asLoader(adminRequest("https://test.example.com/app/files", PREVIOUS_SHOP))
	);
}

async function loadUpload() {
	const route = await import("../app.upload.js");
	return route.loader(
		asLoader(adminRequest("https://test.example.com/app/upload", PREVIOUS_SHOP))
	);
}

async function loadFileManager() {
	const route = await import("../app.file-manager.js");
	return route.loader(
		asLoader(
			adminRequest("https://test.example.com/app/file-manager", PREVIOUS_SHOP)
		)
	);
}

function startWorker(): ChildProcess {
	const preload = join(
		repoRoot(),
		"app/routes/__tests__/helpers/worker-fetch-preload.mjs"
	);
	const tsxCli = join(repoRoot(), "node_modules/tsx/dist/cli.mjs");
	return spawn(process.execPath, [tsxCli, "app/lib/sync/worker.ts"], {
		cwd: repoRoot(),
		env: {
			...process.env,
			DATABASE_URL: `file:${DB_FILE}`,
			UPLOAD_LOG,
			BYNDER_STANDIN_ORIGIN: portal,
			NODE_OPTIONS: `--import ${preload}`,
		},
		stdio: "ignore",
	});
}

async function waitForWorker(timeoutMs: number) {
	const started = Date.now();
	let uploads: Array<{ kind: string; host: string }> = [];
	while (Date.now() - started < timeoutMs) {
		uploads = readUploads();
		if (uploads.some((entry) => entry.kind === "fileCreate")) {
			return uploads;
		}
		const job = await prisma.syncJob.findUnique({
			where: { id: pendingJobId },
		});
		if (job && (job.status === "failed" || job.status === "completed")) {
			return uploads;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return uploads;
}

function readUploads(): Array<{ kind: string; host: string }> {
	try {
		return readFileSync(UPLOAD_LOG, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { kind: string; host: string });
	} catch {
		return [];
	}
}

function stopWorker(worker: ChildProcess) {
	if (!worker.killed) {
		worker.kill("SIGTERM");
	}
}

function repoRoot(): string {
	return process.cwd();
}

function patchShopifyFetch() {
	const original = globalThis.fetch;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (url.includes(".myshopify.com/") && url.includes("/graphql.json")) {
			return new Response(
				JSON.stringify({
					data: {
						files: {
							edges: [],
							pageInfo: {
								hasNextPage: false,
								hasPreviousPage: false,
								startCursor: null,
								endCursor: null,
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		}
		return original(input, init);
	};
}
