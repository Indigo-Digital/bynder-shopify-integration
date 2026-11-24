/**
 * @vitest-environment node
 *
 * The connection-test loader and action must not return exception stacks.
 * These tests fail while error.stack is copied into the JSON body.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../db.server.js";
import { authenticate } from "../../shopify.server.js";
import { action, loader } from "../api.bynder.test.js";

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(),
	},
}));

const SHOP = "stack-disclosure-shop.myshopify.com";

const mockPrisma = prisma as unknown as {
	shop: {
		findUnique: ReturnType<typeof vi.fn>;
	};
};

interface Portal {
	server: Server;
	baseUrl: string;
	requests: string[];
}

/**
 * Local stand-in for the Bynder portal. The real SDK and axios still run;
 * only the remote host is replaced so the test does not leave the machine.
 */
function listenPortal(statusCode: number, body: string): Promise<Portal> {
	const requests: string[] = [];
	const server = createServer((req, res) => {
		const host = req.headers.host ?? "";
		requests.push(`${req.method ?? "GET"} http://${host}${req.url ?? ""}`);
		res.writeHead(statusCode, { "Content-Type": "application/json" });
		res.end(body);
	});
	return new Promise((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve({
				server,
				baseUrl: `http://127.0.0.1:${address.port}`,
				requests,
			});
		});
		server.on("error", reject);
	});
}

function closePortal(portal: Portal): Promise<void> {
	return new Promise((resolve, reject) => {
		portal.server.close((err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

function assertNoStackLeak(body: unknown): void {
	const serialized = JSON.stringify(body);
	expect(serialized).not.toContain("node_modules");
	expect(serialized).not.toContain("api.bynder.test");
	expect(serialized).not.toContain("bynder-js-sdk");
	expect(serialized).not.toContain("AxiosError");
	expect(serialized).not.toMatch(/\bat\s+\S+\s+\(/);
	const record = body as { details?: unknown };
	expect(record.details).toBeUndefined();
}

async function callConnectionTest(
	method: "GET" | "POST",
	portalUrl: string
): Promise<{ status: number; body: unknown }> {
	mockPrisma.shop.findUnique.mockResolvedValue({
		shop: SHOP,
		bynderBaseUrl: portalUrl,
	});
	const request = new Request("http://localhost/api/bynder/test", { method });
	const response =
		method === "GET"
			? await loader({ request } as LoaderFunctionArgs)
			: await action({ request } as ActionFunctionArgs);
	return { status: response.status, body: await response.json() };
}

describe("Bynder connection test stack disclosure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValue({
			session: { shop: SHOP },
		});
	});

	it("returns a successful payload without a stack when the portal accepts the request", async () => {
		const portal = await listenPortal(200, "[]");
		try {
			const result = await callConnectionTest("GET", portal.baseUrl);
			expect(portal.requests.some((url) => url.includes("/api/v4/media"))).toBe(
				true
			);
			expect(result.status).toBe(200);
			expect(result.body).toMatchObject({ connected: true });
			assertNoStackLeak(result.body);
		} finally {
			await closePortal(portal);
		}
	});

	it("does not return the exception stack when the portal URL responds 404", async () => {
		const portal = await listenPortal(
			404,
			JSON.stringify({ message: "missing" })
		);
		try {
			const result = await callConnectionTest("GET", portal.baseUrl);
			expect(portal.requests.some((url) => url.includes("/api/v4/media"))).toBe(
				true
			);
			expect(result.status).toBe(500);
			expect(result.body).toMatchObject({ connected: false });
			assertNoStackLeak(result.body);
		} finally {
			await closePortal(portal);
		}
	});

	it("does not return the exception stack when the portal URL responds 500", async () => {
		const portal = await listenPortal(500, JSON.stringify({ message: "down" }));
		try {
			const result = await callConnectionTest("GET", portal.baseUrl);
			expect(portal.requests.some((url) => url.includes("/api/v4/media"))).toBe(
				true
			);
			expect(result.status).toBe(500);
			expect(result.body).toMatchObject({ connected: false });
			assertNoStackLeak(result.body);
		} finally {
			await closePortal(portal);
		}
	});

	it("does not return the exception stack from the POST action when the portal URL fails", async () => {
		const portal = await listenPortal(500, JSON.stringify({ message: "down" }));
		try {
			const result = await callConnectionTest("POST", portal.baseUrl);
			expect(portal.requests.some((url) => url.includes("/api/v4/media"))).toBe(
				true
			);
			expect(result.status).toBe(500);
			expect(result.body).toMatchObject({ connected: false });
			assertNoStackLeak(result.body);
		} finally {
			await closePortal(portal);
		}
	});

	it("does not return the exception stack when the portal URL refuses the connection", async () => {
		const portal = await listenPortal(200, "[]");
		const refusedUrl = portal.baseUrl;
		await closePortal(portal);

		const result = await callConnectionTest("GET", refusedUrl);
		expect(result.status).toBe(500);
		expect(result.body).toMatchObject({ connected: false });
		assertNoStackLeak(result.body);
	});
});
