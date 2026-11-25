// @vitest-environment node
/**
 * Spec for the asset-browsing denial of service.
 *
 * These tests fail while the vulnerability is present. They pass once:
 * - `limit` is an integer from 1 through 50 (missing means 24; anything else is a 4xx and does not open a socket)
 * - a Bynder response larger than 1 MiB aborts the socket before the rest of the body is read
 * - only https hosts that are getbynder.com or a subdomain of it are saved or requested
 * - the host that is requested is the host that was checked, even if the shop row is read again
 *
 * The HTTP client under test is @bynder/bynder-js-sdk 2.5.2 on axios 0.30.2.
 * Axios defaults maxContentLength to -1 and copies every response chunk into one buffer.
 */
import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
} from "node:http";
import {
	createServer as createHttpsServer,
	type Server as HttpsServer,
} from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

process.env.BYNDER_RATE_LIMIT_BURST = "1000";
process.env.BYNDER_RATE_LIMIT_RPS = "1000";

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

import prisma from "../../db.server.js";
import { BynderClient } from "../../lib/bynder/client.js";
import { authenticate } from "../../shopify.server.js";
import { loader as assetsLoader } from "../api.bynder.assets.js";
import { loader as testConnectionLoader } from "../api.bynder.test.js";
import { action as settingsAction } from "../app.settings.js";

const MAX_BYNDER_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 24;
const MAX_BYNDER_RESPONSE_BYTES = 1_048_576;
const RESPONSE_SLACK_BYTES = 512 * 1024;
const SHOP = "test-shop.myshopify.com";
const ALLOWED_HOSTNAME = "page-size-test.getbynder.com";

const REJECTED_PORTALS = [
	"http://127.0.0.1:9/api",
	"https://127.0.0.1/api",
	"https://localhost/api",
	"http://page-size-test.getbynder.com/api",
	"https://evil.example/api",
	"https://evil-getbynder.com/api",
	"https://page-size-test.getbynder.com.evil.example/api",
	"https://user:placeholder@page-size-test.getbynder.com/api",
	"not-a-url",
];

const ACCEPTED_PORTALS = [
	"https://getbynder.com/api",
	"https://page-size-test.getbynder.com/api",
	"https://brand.eu.getbynder.com",
	"https://page-size-test.getbynder.com:8443/api",
];

interface UpstreamHit {
	url: string;
	limit: number | null;
	bytesWritten: number;
	done: Promise<void>;
}

interface PortalServers {
	httpPort: number;
	httpsPort: number;
	allowedBaseUrl: string;
	evilBaseUrl: string;
	httpHits: UpstreamHit[];
	httpsHits: UpstreamHit[];
	close: () => Promise<void>;
}

const db = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
};

const authenticateAdmin = authenticate.admin as unknown as ReturnType<
	typeof vi.fn
>;

let servers: PortalServers;
let bodyMode: "small" | "large" = "small";
let restoreLookup: (() => void) | undefined;
let previousTlsSetting: string | undefined;

const smallList = Buffer.from(
	JSON.stringify({
		media: [{ id: "asset-1", name: "ok", type: "image" }],
		total: 1,
		count: 1,
	})
);
const smallInfo = Buffer.from(
	JSON.stringify({ id: "asset-1", name: "ok", type: "image" })
);
const largeList = oversizedJson(
	'{"media":[{"id":"asset-1","name":"',
	'","type":"image"}],"total":1,"count":1}'
);
const largeInfo = oversizedJson(
	'{"id":"asset-1","name":"',
	'","type":"image"}'
);

function oversizedJson(prefix: string, suffix: string): Buffer {
	const prefixBytes = Buffer.from(prefix);
	const suffixBytes = Buffer.from(suffix);
	const target = MAX_BYNDER_RESPONSE_BYTES * 3;
	const fillerLength = target - prefixBytes.length - suffixBytes.length;
	return Buffer.concat([
		prefixBytes,
		Buffer.alloc(fillerLength, 0x61),
		suffixBytes,
	]);
}

function limitFromUrl(url: string): number | null {
	const raw = new URL(url, "http://127.0.0.1").searchParams.get("limit");
	if (raw == null) {
		return null;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function payloadFor(url: string): Buffer {
	const path = url.split("?")[0] ?? "";
	const isCollection = path.endsWith("/v4/media/");
	if (bodyMode === "small") {
		return isCollection ? smallList : smallInfo;
	}
	return isCollection ? largeList : largeInfo;
}

function streamPayload(
	req: IncomingMessage,
	res: ServerResponse,
	hits: UpstreamHit[]
): void {
	const url = req.url ?? "/";
	let resolveDone = () => {};
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const hit: UpstreamHit = {
		url,
		limit: limitFromUrl(url),
		bytesWritten: 0,
		done,
	};
	hits.push(hit);

	const payload = payloadFor(url);
	const chunkSize = 16 * 1024;
	let offset = 0;
	let settled = false;
	const finish = () => {
		if (settled) {
			return;
		}
		settled = true;
		hit.bytesWritten = offset;
		resolveDone();
	};
	const writeChunk = () => {
		if (settled || res.destroyed || res.writableEnded || req.destroyed) {
			finish();
			return;
		}
		if (offset >= payload.length) {
			res.end();
			return;
		}
		const next = Math.min(offset + chunkSize, payload.length);
		try {
			const queued = res.write(payload.subarray(offset, next));
			offset = next;
			hit.bytesWritten = offset;
			if (!queued) {
				res.once("drain", writeChunk);
				return;
			}
		} catch {
			finish();
			return;
		}
		setImmediate(writeChunk);
	};

	res.on("finish", finish);
	res.on("close", finish);
	req.on("aborted", finish);
	res.writeHead(200, {
		"Content-Type": "application/json",
		Connection: "close",
	});
	writeChunk();
}

function redirectLookup(): () => void {
	const original = dns.lookup;
	const redirected = ((
		hostname: string,
		options: unknown,
		callback?: unknown
	) => {
		const cb = (typeof options === "function" ? options : callback) as (
			err: NodeJS.ErrnoException | null,
			address: string | dns.LookupAddress[],
			family?: number
		) => void;
		const all =
			typeof options === "object" &&
			options !== null &&
			"all" in options &&
			options.all === true;
		const allowed =
			hostname === ALLOWED_HOSTNAME ||
			hostname === "127.0.0.1" ||
			hostname === "localhost";
		if (!allowed) {
			const error = new Error(
				`blocked lookup ${hostname}`
			) as NodeJS.ErrnoException;
			error.code = "ENOTFOUND";
			cb(error, "", 4);
			return;
		}
		if (all) {
			cb(null, [{ address: "127.0.0.1", family: 4 }]);
			return;
		}
		cb(null, "127.0.0.1", 4);
	}) as typeof dns.lookup;
	dns.lookup = redirected;
	return () => {
		dns.lookup = original;
	};
}

function listen(server: HttpServer | HttpsServer): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				resolve(address.port);
				return;
			}
			reject(new Error("server did not bind a port"));
		});
	});
}

async function startServers(): Promise<PortalServers> {
	const certDir = mkdtempSync(join(tmpdir(), "bynder-page-size-"));
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			join(certDir, "key.pem"),
			"-out",
			join(certDir, "cert.pem"),
			"-days",
			"1",
			"-nodes",
			"-subj",
			`/CN=${ALLOWED_HOSTNAME}`,
		],
		{ stdio: "pipe" }
	);
	const httpHits: UpstreamHit[] = [];
	const httpsHits: UpstreamHit[] = [];
	const httpServer = createHttpServer((req, res) => {
		streamPayload(req, res, httpHits);
	});
	const httpsServer = createHttpsServer(
		{
			key: readFileSync(join(certDir, "key.pem")),
			cert: readFileSync(join(certDir, "cert.pem")),
		},
		(req, res) => {
			streamPayload(req, res, httpsHits);
		}
	);
	const httpPort = await listen(httpServer);
	const httpsPort = await listen(httpsServer);
	return {
		httpPort,
		httpsPort,
		allowedBaseUrl: `https://${ALLOWED_HOSTNAME}:${httpsPort}/api`,
		evilBaseUrl: `http://127.0.0.1:${httpPort}/api`,
		httpHits,
		httpsHits,
		close: async () => {
			await Promise.all([
				new Promise<void>((resolve) => httpServer.close(() => resolve())),
				new Promise<void>((resolve) => httpsServer.close(() => resolve())),
			]);
		},
	};
}

function shopRow(bynderBaseUrl: string) {
	return {
		id: "shop-123",
		shop: SHOP,
		bynderBaseUrl,
		syncTags: "shopify-sync",
	};
}

async function readJson(response: Response): Promise<{
	text: string;
	body: Record<string, unknown>;
}> {
	const text = await response.text();
	const body = JSON.parse(text) as Record<string, unknown>;
	return { text, body };
}

async function expectBodyStopped(hits: UpstreamHit[]): Promise<void> {
	for (const hit of hits) {
		await hit.done;
		expect(hit.bytesWritten).toBeLessThan(
			MAX_BYNDER_RESPONSE_BYTES + RESPONSE_SLACK_BYTES
		);
	}
}

beforeAll(async () => {
	previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	// The local portal certificate is self-signed. Verification is disabled
	// only so this process can finish the handshake; the SDK still uses axios.
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	restoreLookup = redirectLookup();
	servers = await startServers();
});

afterAll(async () => {
	restoreLookup?.();
	if (previousTlsSetting === undefined) {
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	} else {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
	}
	await servers.close();
});

beforeEach(() => {
	vi.clearAllMocks();
	bodyMode = "small";
	servers.httpHits.length = 0;
	servers.httpsHits.length = 0;
	authenticateAdmin.mockResolvedValue({
		session: { shop: SHOP },
	});
	db.shop.findUnique.mockResolvedValue(shopRow(servers.allowedBaseUrl));
});

describe("Bynder asset page size", () => {
	it("runs the Node HTTP adapter, which is what the server process uses", () => {
		expect(typeof XMLHttpRequest).toBe("undefined");
	});

	it("returns a small page for the default limit and for limit 50", async () => {
		const defaultResponse = await assetsLoader({
			request: new Request("http://localhost/api/bynder/assets"),
		} as LoaderFunctionArgs);
		const defaultBody = await readJson(defaultResponse);

		expect(defaultResponse.status).toBe(200);
		expect(defaultBody.body.limit).toBe(DEFAULT_PAGE_LIMIT);
		expect(servers.httpsHits.map((hit) => hit.limit)).toEqual([
			DEFAULT_PAGE_LIMIT,
		]);

		servers.httpsHits.length = 0;
		const cappedResponse = await assetsLoader({
			request: new Request("http://localhost/api/bynder/assets?limit=50"),
		} as LoaderFunctionArgs);
		const cappedBody = await readJson(cappedResponse);

		expect(cappedResponse.status).toBe(200);
		expect(cappedBody.body.limit).toBe(MAX_BYNDER_PAGE_LIMIT);
		expect(servers.httpsHits.map((hit) => hit.limit)).toEqual([
			MAX_BYNDER_PAGE_LIMIT,
		]);
		expect(servers.httpHits).toHaveLength(0);
	});

	it.each([
		"1000000",
		"51",
		"9007199254740991",
	])("does not forward limit %s to the portal", async (limit) => {
		const response = await assetsLoader({
			request: new Request(`http://localhost/api/bynder/assets?limit=${limit}`),
		} as LoaderFunctionArgs);
		const forwarded = servers.httpsHits.map((hit) => hit.limit);

		expect(forwarded.every((value) => value !== null && value <= 50)).toBe(
			true
		);
		if (forwarded.length === 0) {
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.status).toBeLessThan(500);
			return;
		}
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.body.limit).toBeLessThanOrEqual(MAX_BYNDER_PAGE_LIMIT);
	});

	it.each([
		"0",
		"-4",
		"abc",
		"1.5",
		"1e6",
		"51abc",
	])("rejects limit %s before opening a socket", async (limit) => {
		const response = await assetsLoader({
			request: new Request(`http://localhost/api/bynder/assets?limit=${limit}`),
		} as LoaderFunctionArgs);

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(servers.httpsHits).toHaveLength(0);
		expect(servers.httpHits).toHaveLength(0);
	});

	it("stops reading an oversized asset list from an allowed portal", async () => {
		bodyMode = "large";
		const response = await assetsLoader({
			request: new Request("http://localhost/api/bynder/assets?limit=24"),
		} as LoaderFunctionArgs);
		const text = await response.text();

		await expectBodyStopped(servers.httpsHits);
		expect(servers.httpsHits.length).toBeGreaterThan(0);
		expect(text.length).toBeLessThan(MAX_BYNDER_RESPONSE_BYTES);
		expect(text.includes("a".repeat(1024))).toBe(false);
	});

	it("does not request a portal host the shop saved outside Bynder", async () => {
		bodyMode = "large";
		db.shop.findUnique.mockResolvedValue(shopRow(servers.evilBaseUrl));
		const response = await assetsLoader({
			request: new Request("http://localhost/api/bynder/assets?limit=1000000"),
		} as LoaderFunctionArgs);

		expect(servers.httpHits).toHaveLength(0);
		expect(servers.httpsHits).toHaveLength(0);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	});

	it("requests the host from the same shop read that it validated", async () => {
		let reads = 0;
		db.shop.findUnique.mockImplementation(() => {
			reads += 1;
			const bynderBaseUrl =
				reads === 1 ? servers.allowedBaseUrl : servers.evilBaseUrl;
			return Promise.resolve(shopRow(bynderBaseUrl));
		});

		const response = await assetsLoader({
			request: new Request("http://localhost/api/bynder/assets?limit=24"),
		} as LoaderFunctionArgs);

		expect(response.status).toBe(200);
		expect(servers.httpHits).toHaveLength(0);
		expect(servers.httpsHits.map((hit) => hit.limit)).toEqual([
			DEFAULT_PAGE_LIMIT,
		]);
	});
});

describe("Bynder connection test", () => {
	it("stops reading an oversized body from an allowed portal", async () => {
		bodyMode = "large";
		const response = await testConnectionLoader({
			request: new Request("http://localhost/api/bynder/test"),
		} as LoaderFunctionArgs);
		const text = await response.text();

		await expectBodyStopped(servers.httpsHits);
		expect(servers.httpsHits.length).toBeGreaterThan(0);
		expect(text.length).toBeLessThan(MAX_BYNDER_RESPONSE_BYTES);
	});

	it("does not contact a non-Bynder portal", async () => {
		db.shop.findUnique.mockResolvedValue(shopRow(servers.evilBaseUrl));
		const response = await testConnectionLoader({
			request: new Request("http://localhost/api/bynder/test"),
		} as LoaderFunctionArgs);

		expect(servers.httpHits).toHaveLength(0);
		expect(servers.httpsHits).toHaveLength(0);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	});
});

describe("Bynder client shared by sync and webhooks", () => {
	it("stops reading an oversized media list", async () => {
		bodyMode = "large";
		const client = BynderClient.createFromEnv(servers.allowedBaseUrl);
		const outcome = await client.getMediaList({ limit: 24, page: 1 }).then(
			() => "resolved",
			() => "rejected"
		);

		await expectBodyStopped(servers.httpsHits);
		expect(servers.httpsHits.length).toBeGreaterThan(0);
		expect(outcome).toBe("rejected");
	});

	it("stops reading an oversized media info body", async () => {
		bodyMode = "large";
		const client = BynderClient.createFromEnv(servers.allowedBaseUrl);
		const outcome = await client.getMediaInfo({ id: "asset-1" }).then(
			() => "resolved",
			() => "rejected"
		);

		await expectBodyStopped(servers.httpsHits);
		expect(servers.httpsHits.length).toBeGreaterThan(0);
		expect(outcome).toBe("rejected");
	});

	it("does not page through an oversized media collection", async () => {
		bodyMode = "large";
		const client = BynderClient.createFromEnv(servers.allowedBaseUrl);
		const outcome = await client.getAllMediaItems({}).then(
			() => "resolved",
			() => "rejected"
		);

		await expectBodyStopped(servers.httpsHits);
		expect(servers.httpsHits.length).toBe(1);
		expect(outcome).toBe("rejected");
	});

	it("does not list media on a non-Bynder portal", async () => {
		const outcome = await Promise.resolve()
			.then(() => BynderClient.createFromEnv(servers.evilBaseUrl))
			.then((client) => client.getMediaList({ limit: 1, page: 1 }))
			.then(
				() => "resolved",
				() => "rejected"
			);

		expect(servers.httpHits).toHaveLength(0);
		expect(servers.httpsHits).toHaveLength(0);
		expect(outcome).toBe("rejected");
	});

	it("does not load media info from a non-Bynder portal", async () => {
		const outcome = await Promise.resolve()
			.then(() => BynderClient.createFromEnv(servers.evilBaseUrl))
			.then((client) => client.getMediaInfo({ id: "asset-1" }))
			.then(
				() => "resolved",
				() => "rejected"
			);

		expect(servers.httpHits).toHaveLength(0);
		expect(servers.httpsHits).toHaveLength(0);
		expect(outcome).toBe("rejected");
	});
});

function settingsRequest(bynderBaseUrl: string): Request {
	const body = new URLSearchParams();
	body.set("intent", "update_bynder_url");
	body.set("bynderBaseUrl", bynderBaseUrl);
	return new Request("http://localhost/app/settings", {
		method: "POST",
		body,
	});
}

describe("Bynder portal setting", () => {
	it.each(REJECTED_PORTALS)("does not save %s", async (bynderBaseUrl) => {
		const result = await settingsAction({
			request: settingsRequest(bynderBaseUrl),
		} as ActionFunctionArgs);

		expect(db.shop.upsert).not.toHaveBeenCalled();
		if (result instanceof Response) {
			expect(result.status).toBeGreaterThanOrEqual(400);
			expect(result.status).toBeLessThan(500);
			return;
		}
		expect(result).toMatchObject({ error: expect.any(String) });
	});

	it.each(ACCEPTED_PORTALS)("saves %s", async (bynderBaseUrl) => {
		const result = await settingsAction({
			request: settingsRequest(bynderBaseUrl),
		} as ActionFunctionArgs);

		expect(db.shop.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ bynderBaseUrl }),
				update: expect.objectContaining({ bynderBaseUrl }),
			})
		);
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(302);
	});
});
