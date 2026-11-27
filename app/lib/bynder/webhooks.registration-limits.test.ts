/**
 * @vitest-environment node
 *
 * Spec for portal webhook registration limits.
 *
 * These tests exercise the real axios calls made when a shop's saved Bynder
 * portal address is used to create, update, delete, or read a webhook
 * subscription. They fail while those calls wait forever and buffer the
 * whole response.
 *
 * A fix has to:
 * - Abort a portal that accepts the connection and sends no bytes, and close
 *   that socket, within 5 seconds. Use a client timeout of 3 seconds or less.
 * - Reject a response body larger than 64 KiB and stop reading. The drip
 *   below sends 16 KiB every 10 ms, up to 2 MiB. A 64 KiB cap overshoots by
 *   one chunk (about 80 KiB). This test allows 128 KiB of server writes.
 *   An inactivity timeout does not satisfy this test: a steady drip keeps
 *   the socket active, and the body is still buffered.
 * - Refuse an http:// portal before any TCP connection is accepted.
 * - On the webhooks action, allow at most 3 registration attempts per shop in a
 *   10 second window. Create, update, and delete share that cap. The fourth
 *   must fail before a socket is accepted. Direct calls in the other tests
 *   issue one request each and must reach the portal.
 *
 * getWebhookSubscription is not referenced by a route. It uses the same
 * unbounded client, so it is included here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import type { ActionFunctionArgs } from "react-router";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import prisma from "../../db.server.js";
import { action as settingsAction } from "../../routes/app.settings.js";
import { action as webhooksAction } from "../../routes/app.webhooks.js";
import { authenticate } from "../../shopify.server.js";
import { BynderClient } from "./client.js";
import {
	createWebhookSubscription,
	deleteWebhookSubscription,
	getWebhookSubscription,
	updateWebhookSubscription,
} from "./webhooks.js";

vi.mock("../../db.server.js", () => ({
	default: {
		shop: {
			findUnique: vi.fn(),
			upsert: vi.fn(),
		},
		webhookSubscription: {
			create: vi.fn(),
			update: vi.fn(),
		},
	},
}));

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

const MAX_HANG_MS = 5_000;
const MAX_RESPONSE_BODY_BYTES = 128 * 1024;
const DRIP_CHUNK_BYTES = 16 * 1024;
const DRIP_INTERVAL_MS = 10;
const OFFERED_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRATIONS_PER_WINDOW = 3;
const WEBHOOK_CALLBACK = "https://app.example/api/bynder/webhooks";

const db = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	webhookSubscription: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
};

const adminAuthenticate = authenticate.admin as ReturnType<typeof vi.fn>;

type PortalMode = "hang" | "drip" | "tiny";

type SubscriptionRow = {
	id: string;
	bynderWebhookId: string;
	active: boolean;
};

class LocalPortal {
	accepted = 0;
	open = 0;
	peakOpen = 0;
	bytesWritten = 0;
	requests: Array<{ method: string; url: string | undefined }> = [];

	private readonly sockets = new Set<Socket>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly server: HttpsServer | ReturnType<typeof createHttpServer>;
	private readonly secure: boolean;

	constructor(
		mode: PortalMode,
		material?: { certPem: string; keyPem: string }
	) {
		this.secure = material !== undefined;
		const handler = (request: IncomingMessage, response: ServerResponse) => {
			this.noteRequest(request, response, mode);
		};
		this.server = material
			? createHttpsServer(
					{ cert: material.certPem, key: material.keyPem },
					handler
				)
			: createHttpServer(handler);
		this.server.on("connection", (socket) => {
			this.trackSocket(socket);
		});
		this.server.on("clientError", () => undefined);
	}

	async listen(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.server.listen(0, "127.0.0.1", () => resolve());
		});
	}

	baseUrl(): string {
		const address = this.server.address();
		if (address === null || typeof address === "string") {
			throw new Error("Portal is not listening");
		}
		const scheme = this.secure ? "https" : "http";
		return `${scheme}://127.0.0.1:${address.port}`;
	}

	async destroy(): Promise<void> {
		console.error = () => undefined;
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		this.timers.clear();
		for (const socket of this.sockets) {
			socket.destroy();
		}
		if (!this.server.listening) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.server.close(() => resolve());
		});
	}

	private trackSocket(socket: Socket): void {
		this.sockets.add(socket);
		this.accepted += 1;
		this.open += 1;
		this.peakOpen = Math.max(this.peakOpen, this.open);
		socket.on("close", () => {
			this.open -= 1;
			this.sockets.delete(socket);
		});
		socket.on("error", () => undefined);
	}

	private noteRequest(
		request: IncomingMessage,
		response: ServerResponse,
		mode: PortalMode
	): void {
		this.requests.push({
			method: request.method ?? "",
			url: request.url,
		});
		response.on("error", () => undefined);
		request.on("error", () => undefined);
		if (mode === "hang") {
			return;
		}
		if (mode === "tiny") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					id: "sub",
					url: WEBHOOK_CALLBACK,
					events: ["asset.tagged"],
					active: true,
				})
			);
			return;
		}
		this.drip(response);
	}

	private drip(response: ServerResponse): void {
		const chunk = Buffer.alloc(DRIP_CHUNK_BYTES, 0x61);
		response.writeHead(200, { "Content-Type": "application/json" });
		const writeChunk = () => {
			if (response.destroyed || response.writableEnded) {
				return;
			}
			if (this.bytesWritten >= OFFERED_BODY_BYTES) {
				response.end();
				return;
			}
			try {
				response.write(chunk);
			} catch {
				return;
			}
			this.bytesWritten += chunk.length;
			const timer = setTimeout(writeChunk, DRIP_INTERVAL_MS);
			this.timers.add(timer);
		};
		writeChunk();
	}
}

function createCertificate(): {
	directory: string;
	certPem: string;
	keyPem: string;
} {
	const directory = mkdtempSync(join(tmpdir(), "webhook-registration-"));
	const keyPath = join(directory, "key.pem");
	const certPath = join(directory, "cert.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"1",
			"-nodes",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		],
		{ stdio: "pipe" }
	);
	return {
		directory,
		certPem: readFileSync(certPath, "utf8"),
		keyPem: readFileSync(keyPath, "utf8"),
	};
}

async function openPortal(
	mode: PortalMode,
	material?: { certPem: string; keyPem: string }
): Promise<LocalPortal> {
	const portal = new LocalPortal(mode, material);
	await portal.listen();
	return portal;
}

function clientFor(origin: string): BynderClient {
	return BynderClient.createFromEnv(origin);
}

let originalConsoleError: typeof console.error | undefined;

function silencePortalTestLogs(): void {
	if (!originalConsoleError) {
		originalConsoleError = console.error;
	}
	console.error = () => undefined;
}

function restorePortalTestLogs(): void {
	if (originalConsoleError) {
		console.error = originalConsoleError;
		originalConsoleError = undefined;
	}
}

type LibraryCall = {
	name: string;
	method: string;
	run: (origin: string) => Promise<unknown>;
};

const libraryCalls: LibraryCall[] = [
	{
		name: "createWebhookSubscription",
		method: "POST",
		run: (origin) =>
			createWebhookSubscription(clientFor(origin), WEBHOOK_CALLBACK, [
				"asset.tagged",
			]),
	},
	{
		name: "updateWebhookSubscription",
		method: "PUT",
		run: (origin) =>
			updateWebhookSubscription(clientFor(origin), "wh-1", WEBHOOK_CALLBACK, [
				"asset.tagged",
			]),
	},
	{
		name: "deleteWebhookSubscription",
		method: "DELETE",
		run: (origin) => deleteWebhookSubscription(clientFor(origin), "wh-1"),
	},
	{
		name: "getWebhookSubscription",
		method: "GET",
		run: (origin) => getWebhookSubscription(clientFor(origin), "wh-1"),
	},
];

function authenticateAs(shop: string): void {
	adminAuthenticate.mockResolvedValue({ session: { shop } });
}

function rememberShop(
	shop: string,
	bynderBaseUrl: string,
	subscriptions: SubscriptionRow[]
): void {
	db.shop.findUnique.mockImplementation(
		async (args: { where: { shop: string } }) => {
			if (args.where.shop !== shop) {
				return null;
			}
			return {
				id: `id-${shop}`,
				shop,
				bynderBaseUrl,
				webhookSubscriptions: subscriptions,
			};
		}
	);
}

function submitWebhooks(
	shop: string,
	origin: string,
	active: boolean,
	subscriptions: SubscriptionRow[]
): Promise<unknown> {
	authenticateAs(shop);
	rememberShop(shop, origin, subscriptions);
	const body = new URLSearchParams();
	body.append("intent", "toggle_webhook");
	body.append("active", String(active));
	body.append("eventTypes", "asset.tagged");
	const request = new Request("https://app.example/app/webhooks", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	return webhooksAction({ request } as ActionFunctionArgs);
}

async function outcomeOf(
	run: () => Promise<unknown>,
	waitMs: number
): Promise<"fulfilled" | "rejected" | "pending"> {
	return Promise.race([
		run().then(
			() => "fulfilled" as const,
			() => "rejected" as const
		),
		delay(waitMs).then(() => "pending" as const),
	]);
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await delay(20);
	}
	return predicate();
}

describe("portal webhook registration limits", () => {
	let material: { certPem: string; keyPem: string };
	let certificateDirectory = "";
	let originalCertificates: readonly string[] = [];

	beforeAll(() => {
		const created = createCertificate();
		certificateDirectory = created.directory;
		material = { certPem: created.certPem, keyPem: created.keyPem };
		originalCertificates = tls.getCACertificates("default").slice();
		tls.setDefaultCACertificates([...originalCertificates, created.certPem]);
	});

	afterAll(() => {
		if (originalCertificates.length > 0) {
			tls.setDefaultCACertificates([...originalCertificates]);
		}
		if (certificateDirectory) {
			rmSync(certificateDirectory, { recursive: true, force: true });
		}
		restorePortalTestLogs();
	});

	beforeEach(() => {
		silencePortalTestLogs();
	});

	describe("library client", () => {
		it.each(
			libraryCalls
		)("$name aborts a silent portal and closes the socket", async (call) => {
			silencePortalTestLogs();
			const portal = await openPortal("hang", material);
			const pending = call.run(portal.baseUrl());
			try {
				const outcome = await Promise.race([
					pending.then(
						() => "fulfilled" as const,
						() => "rejected" as const
					),
					delay(MAX_HANG_MS).then(() => "pending" as const),
				]);
				if (outcome !== "pending") {
					await waitUntil(() => portal.open === 0, 1_000);
				}
				expect(outcome).toBe("rejected");
				expect(portal.requests.map((request) => request.method)).toContain(
					call.method
				);
				expect(portal.requests[0]?.url).toContain(
					"/v7/webhooks/public/api/subscriptions"
				);
				expect(portal.open).toBe(0);
			} finally {
				await portal.destroy();
				await pending.catch(() => undefined);
			}
		}, 20_000);

		it.each(
			libraryCalls
		)("$name stops reading a dribbled portal response", async (call) => {
			silencePortalTestLogs();
			const portal = await openPortal("drip", material);
			try {
				const outcome = await call.run(portal.baseUrl()).then(
					() => "fulfilled" as const,
					() => "rejected" as const
				);
				expect(portal.bytesWritten).toBeLessThanOrEqual(
					MAX_RESPONSE_BODY_BYTES
				);
				expect(portal.bytesWritten).toBeGreaterThan(0);
				expect(outcome).toBe("rejected");
				expect(portal.requests[0]?.method).toBe(call.method);
			} finally {
				await portal.destroy();
			}
		}, 20_000);

		it.each(
			libraryCalls
		)("$name does not open a socket to an http portal", async (call) => {
			silencePortalTestLogs();
			const portal = await openPortal("tiny");
			try {
				const outcome = await outcomeOf(
					() => call.run(portal.baseUrl()),
					2_000
				);
				expect(portal.accepted).toBe(0);
				expect(outcome).toBe("rejected");
			} finally {
				await portal.destroy();
			}
		}, 20_000);
	});

	describe("webhooks action", () => {
		const shop = "staff-shop.myshopify.com";

		beforeEach(() => {
			silencePortalTestLogs();
			db.webhookSubscription.create.mockResolvedValue({ id: "sub-1" });
			db.webhookSubscription.update.mockResolvedValue({ id: "sub-1" });
			db.shop.upsert.mockResolvedValue({ shop });
		});

		it("activate aborts a silent portal when no subscription exists", async () => {
			const portal = await openPortal("hang", material);
			const pending = submitWebhooks(shop, portal.baseUrl(), true, []);
			try {
				const outcome = await Promise.race([
					pending.then(
						() => "fulfilled" as const,
						() => "rejected" as const
					),
					delay(MAX_HANG_MS).then(() => "pending" as const),
				]);
				if (outcome !== "pending") {
					await waitUntil(() => portal.open === 0, 1_000);
				}
				expect(outcome).not.toBe("pending");
				expect(portal.requests[0]?.method).toBe("POST");
				expect(portal.open).toBe(0);
				await expect(pending).resolves.toEqual(
					expect.objectContaining({ error: expect.any(String) })
				);
			} finally {
				await portal.destroy();
				await pending.catch(() => undefined);
			}
		}, 20_000);

		it("activate aborts a silent portal when a subscription exists", async () => {
			const portal = await openPortal("hang", material);
			const pending = submitWebhooks(shop, portal.baseUrl(), true, [
				{ id: "sub-1", bynderWebhookId: "wh-1", active: false },
			]);
			try {
				const outcome = await Promise.race([
					pending.then(
						() => "fulfilled" as const,
						() => "rejected" as const
					),
					delay(MAX_HANG_MS).then(() => "pending" as const),
				]);
				if (outcome !== "pending") {
					await waitUntil(() => portal.open === 0, 1_000);
				}
				expect(outcome).not.toBe("pending");
				expect(portal.requests[0]?.method).toBe("PUT");
				expect(portal.open).toBe(0);
			} finally {
				await portal.destroy();
				await pending.catch(() => undefined);
			}
		}, 20_000);

		it("deactivate aborts a silent portal and closes the socket", async () => {
			const portal = await openPortal("hang", material);
			const pending = submitWebhooks(shop, portal.baseUrl(), false, [
				{ id: "sub-1", bynderWebhookId: "wh-1", active: true },
			]);
			try {
				const outcome = await Promise.race([
					pending.then(
						() => "fulfilled" as const,
						() => "rejected" as const
					),
					delay(MAX_HANG_MS).then(() => "pending" as const),
				]);
				if (outcome !== "pending") {
					await waitUntil(() => portal.open === 0, 1_000);
				}
				expect(outcome).not.toBe("pending");
				expect(portal.requests[0]?.method).toBe("DELETE");
				expect(portal.open).toBe(0);
			} finally {
				await portal.destroy();
				await pending.catch(() => undefined);
			}
		}, 20_000);

		it("activate stops reading a dribbled create response", async () => {
			const portal = await openPortal("drip", material);
			try {
				const result = await submitWebhooks(shop, portal.baseUrl(), true, []);
				expect(portal.bytesWritten).toBeLessThanOrEqual(
					MAX_RESPONSE_BODY_BYTES
				);
				expect(portal.bytesWritten).toBeGreaterThan(0);
				expect(result).toEqual(
					expect.objectContaining({ error: expect.any(String) })
				);
			} finally {
				await portal.destroy();
			}
		}, 20_000);

		it("activate stops reading a dribbled update response", async () => {
			const portal = await openPortal("drip", material);
			try {
				const result = await submitWebhooks(shop, portal.baseUrl(), true, [
					{ id: "sub-1", bynderWebhookId: "wh-1", active: false },
				]);
				expect(portal.bytesWritten).toBeLessThanOrEqual(
					MAX_RESPONSE_BODY_BYTES
				);
				expect(portal.requests[0]?.method).toBe("PUT");
				expect(result).toEqual(
					expect.objectContaining({ error: expect.any(String) })
				);
			} finally {
				await portal.destroy();
			}
		}, 20_000);

		it("deactivate stops reading a dribbled delete response", async () => {
			const portal = await openPortal("drip", material);
			try {
				await submitWebhooks(shop, portal.baseUrl(), false, [
					{ id: "sub-1", bynderWebhookId: "wh-1", active: true },
				]);
				expect(portal.bytesWritten).toBeLessThanOrEqual(
					MAX_RESPONSE_BODY_BYTES
				);
				expect(portal.bytesWritten).toBeGreaterThan(0);
				expect(portal.requests[0]?.method).toBe("DELETE");
			} finally {
				await portal.destroy();
			}
		}, 20_000);

		it("does not contact an http portal saved from settings", async () => {
			const portal = await openPortal("tiny");
			const attackerUrl = portal.baseUrl();
			authenticateAs(shop);
			db.shop.upsert.mockResolvedValue({ shop, bynderBaseUrl: attackerUrl });
			const body = new URLSearchParams();
			body.append("intent", "update_bynder_url");
			body.append("bynderBaseUrl", attackerUrl);
			const settingsRequest = new Request("https://app.example/app/settings", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			});
			await settingsAction({ request: settingsRequest } as ActionFunctionArgs);
			const pending = submitWebhooks(shop, attackerUrl, true, []);
			try {
				const outcome = await outcomeOf(() => pending, 2_000);
				expect(portal.accepted).toBe(0);
				expect(outcome).toBe("rejected");
			} finally {
				await portal.destroy();
				await pending.catch(() => undefined);
			}
		}, 20_000);

		it("refuses a fourth registration for the same shop before connecting", async () => {
			const rateShop = "rate-limit-shop.myshopify.com";
			const portal = await openPortal("tiny", material);
			const origin = portal.baseUrl();
			try {
				await submitWebhooks(rateShop, origin, true, []);
				await submitWebhooks(rateShop, origin, true, []);
				await submitWebhooks(rateShop, origin, true, [
					{ id: "sub-1", bynderWebhookId: "wh-1", active: false },
				]);
				expect(portal.requests).toHaveLength(MAX_REGISTRATIONS_PER_WINDOW);
				await submitWebhooks(rateShop, origin, false, [
					{ id: "sub-1", bynderWebhookId: "wh-1", active: true },
				]);
				expect(portal.requests).toHaveLength(MAX_REGISTRATIONS_PER_WINDOW);
			} finally {
				await portal.destroy();
			}
		}, 20_000);
	});
});
