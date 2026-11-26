import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ApiVersion,
	AppDistribution,
	Session,
	shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { testConfig } from "@shopify/shopify-app-react-router/test-helpers";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import {
	type ActionFunctionArgs,
	createMemoryRouter,
	RouterProvider,
} from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../db.server.js";
import { action as syncAction } from "../routes/api.sync.js";
import { action as fileManagerAction } from "../routes/app.file-manager.js";
import SyncedAssetsPage from "../routes/app.files.js";
import { action as uploadAction } from "../routes/app.upload.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../.."
);

/**
 * The files page mounts BynderPicker, which appends Bynder's compact view.
 * These tests are the spec for that load: they fail while a replaced copy of
 * the floating script can run in the merchant document, and they pass once the
 * script is pinned, integrity-checked before insertion, and withheld unless
 * the saved portal host is a Bynder host.
 *
 * Same-origin fetches from that document receive the merchant session token.
 * App Bridge 0.41.6 (the unversioned app-bridge.js this app loads) replaces
 * global fetch and, for a same-origin request that has no Authorization
 * header, sets `Authorization: Bearer` from idToken(). idToken() resolves to
 * the session token string. Document requests for an embedded app carry that
 * same token in the `id_token` query parameter, which authenticate.admin
 * accepts from the Authorization header. The page harness below installs that
 * fetch behavior before the picker runs.
 */
const authBridge = vi.hoisted(() => ({
	admin: null as null | ((request: Request) => Promise<unknown>),
}));

vi.mock("@bynder/bynder-js-sdk", () => ({
	default: class BynderMock {
		getMediaInfo(): Promise<Record<string, unknown>> {
			return Promise.resolve({
				id: "4bfd3c8f-7acc-4d1e-98a2-7bfddc6c511e",
				name: "photo.jpg",
				type: "image",
				tags: [],
				dateModified: "2026-01-01T00:00:00.000Z",
				dateCreated: "2026-01-01T00:00:00.000Z",
				version: 1,
				files: [],
			});
		}

		getMediaDownloadUrl(): Promise<string> {
			return Promise.resolve("https://download.example.test/asset.jpg");
		}
	},
}));

vi.mock("../shopify.server.js", () => ({
	authenticate: {
		admin: (request: Request) => {
			if (!authBridge.admin) {
				throw new Error("authenticate.admin is not installed");
			}
			return authBridge.admin(request);
		},
	},
}));

const SHOP = "supply-chain-test.myshopify.com";
const FILE_ID = "gid://shopify/MediaImage/8675309";
const REPLACED_ALT = "replaced-by-compact-view";
const SYNC_ASSET_ID = "4bfd3c8f-7acc-4d1e-98a2-7bfddc6c511e";
const UPLOAD_NAME = "attacker-note.txt";
const MERCHANT_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BYNDER_PORTAL = "https://brand.getbynder.com/api";
const FOREIGN_PORTAL = "https://evil.example/api";
type ScriptSnapshot = {
	src: string;
	integrity: string;
	crossOrigin: string;
};

type PageState = {
	ran: string | null;
	script: ScriptSnapshot | null;
	effects: string[];
	failures: string[];
};

function signSessionToken(secret: string, apiKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "HS256", typ: "JWT" })
	).toString("base64url");
	const body = Buffer.from(
		JSON.stringify({
			iss: `https://${SHOP}/admin`,
			dest: `https://${SHOP}`,
			aud: apiKey,
			sub: "1",
			exp: now + 3600,
			nbf: now - 60,
			iat: now - 60,
			sid: "placeholder-session",
		})
	).toString("base64url");
	const signature = createHmac("sha256", secret)
		.update(`${header}.${body}`)
		.digest("base64url");
	return `${header}.${body}.${signature}`;
}

function sanitize(value: string): string {
	return value.replace(
		/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
		"[session-token]"
	);
}

function graphqlPayload(query: string): Record<string, unknown> {
	if (query.includes("fileDelete")) {
		return {
			fileDelete: { deletedFileIds: [FILE_ID], userErrors: [] },
		};
	}
	if (query.includes("fileUpdate")) {
		return {
			fileUpdate: {
				files: [{ id: FILE_ID, alt: REPLACED_ALT }],
				userErrors: [],
			},
		};
	}
	if (query.includes("stagedUploadsCreate")) {
		return {
			stagedUploadsCreate: {
				stagedTargets: [
					{
						resourceUrl: "https://cdn.example.test/resource",
						url: "https://upload.example.test/put?X-Goog-Algorithm=GOOG4-RSA-SHA256",
						parameters: [{ name: "content-type", value: "text/plain" }],
					},
				],
				userErrors: [],
			},
		};
	}
	if (query.includes("fileCreate")) {
		return {
			fileCreate: {
				files: [
					{
						id: "gid://shopify/GenericFile/99",
						fileStatus: "READY",
						url: "https://cdn.example.test/attacker-note.txt",
					},
				],
				userErrors: [],
			},
		};
	}
	return {};
}

function operationName(query: string): string | null {
	const match = query.match(
		/\b(fileDelete|fileUpdate|fileCreate|stagedUploadsCreate)\b/
	);
	return match?.[1] ?? null;
}

function shopifyRuntimeUrl(): string {
	const requireFromApp = createRequire(
		path.join(
			repoRoot,
			"node_modules/@shopify/shopify-app-react-router/package.json"
		)
	);
	const cjsRuntime = requireFromApp.resolve("@shopify/shopify-api/runtime");
	const esmRuntime = cjsRuntime
		.replace(
			`${path.sep}dist${path.sep}cjs${path.sep}`,
			`${path.sep}dist${path.sep}esm${path.sep}`
		)
		.replace(/\.js$/, ".mjs");
	return pathToFileURL(esmRuntime).href;
}

async function installTransport(effects: string[]): Promise<() => void> {
	const originalFetch = globalThis.fetch.bind(globalThis);
	const originalAdapter = axios.defaults.adapter;
	const stubFetch: typeof fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const body =
			typeof init?.body === "string"
				? init.body
				: input instanceof Request
					? await input.clone().text()
					: "";
		const operation = operationName(body);
		if (operation) {
			effects.push(operation);
		}
		if (url.includes("/graphql.json") || url.includes("myshopify.com")) {
			return new Response(JSON.stringify({ data: graphqlPayload(body) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (
			url.startsWith("http://127.0.0.1") ||
			url.startsWith("http://localhost")
		) {
			return originalFetch(input, init);
		}
		return new Response("file-bytes", {
			status: 200,
			headers: { "content-type": "image/jpeg" },
		});
	};
	globalThis.fetch = stubFetch;
	const runtime = (await import(shopifyRuntimeUrl())) as {
		setAbstractFetchFunc: (fn: typeof fetch) => void;
	};
	runtime.setAbstractFetchFunc(stubFetch);
	axios.defaults.adapter = async (config) => {
		const url = config.url ?? "";
		const data = url.includes("download")
			? { url: "https://download.example.test/asset.jpg" }
			: {
					id: SYNC_ASSET_ID,
					name: "photo.jpg",
					type: "image",
					tags: [],
					dateModified: new Date().toISOString(),
					dateCreated: new Date().toISOString(),
					version: 1,
					files: [],
				};
		return {
			data,
			status: 200,
			statusText: "OK",
			headers: {},
			config,
		};
	};
	return () => {
		globalThis.fetch = originalFetch;
		runtime.setAbstractFetchFunc(originalFetch);
		if (originalAdapter !== undefined) {
			axios.defaults.adapter = originalAdapter;
		}
	};
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function browserHarnessSource(): string {
	return `
		import { useState } from "react";
		import { createRoot } from "react-dom/client";
		import { BynderPicker } from ${JSON.stringify(path.join(repoRoot, "app/components/BynderPicker.tsx"))};

		function Harness() {
			const params = new URLSearchParams(location.search);
			const baseUrl = params.get("baseUrl") || ${JSON.stringify(BYNDER_PORTAL)};
			const [open, setOpen] = useState(false);
			if (!open) {
				return (
					<button type="button" onClick={() => setOpen(true)}>
						Import from Bynder
					</button>
				);
			}
			return (
				<BynderPicker
					baseUrl={baseUrl}
					mode="SingleSelect"
					onAssetSelect={() => {}}
					onClose={() => setOpen(false)}
				/>
			);
		}

		const root = document.getElementById("root");
		if (!root) {
			throw new Error("missing root");
		}
		createRoot(root).render(<Harness />);
	`;
}

function pageHtml(): string {
	return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<div id="root"></div>
<script>
window.__scriptAtAppend = null;
const originalAppend = Node.prototype.appendChild;
Node.prototype.appendChild = function (node) {
	if (node && node.tagName === "SCRIPT" && typeof node.src === "string" && node.src.indexOf("bynder-compactview") !== -1) {
		window.__scriptAtAppend = {
			src: node.src,
			integrity: node.integrity || "",
			crossOrigin: node.crossOrigin || ""
		};
	}
	return originalAppend.call(this, node);
};
const originalFetch = window.fetch.bind(window);
const sessionToken = new URL(location.href).searchParams.get("id_token");
window.fetch = async function (input, init) {
	const request = new Request(input instanceof Request ? input.clone() : input, init);
	const url = new URL(request.url);
	const sameOrigin = url.protocol === location.protocol && (url.hostname === location.hostname || url.hostname.endsWith("." + location.hostname));
	if (sameOrigin && !request.headers.has("Authorization") && sessionToken) {
		request.headers.set("Authorization", "Bearer " + sessionToken);
	}
	return originalFetch(request);
};
</script>
<script src="/picker.js"></script>
</body>
</html>`;
}

const ATTACKER_SCRIPT = `
document.documentElement.dataset.compactViewRan = "1";
(async function () {
	await fetch("/app/file-manager", {
		method: "POST",
		body: new URLSearchParams({ intent: "delete", fileIds: ${JSON.stringify(FILE_ID)} }),
	});
	await fetch("/app/file-manager", {
		method: "POST",
		body: new URLSearchParams({
			intent: "updateAlt",
			fileId: ${JSON.stringify(FILE_ID)},
			altText: ${JSON.stringify(REPLACED_ALT)},
		}),
	});
	await fetch("/api/sync?assetId=${SYNC_ASSET_ID}", {
		method: "POST",
		body: new URLSearchParams({ assetId: ${JSON.stringify(SYNC_ASSET_ID)} }),
	});
	const upload = new FormData();
	upload.set("file", new File(["note"], ${JSON.stringify(UPLOAD_NAME)}, { type: "text/plain" }));
	upload.set("folder", "campaigns");
	await fetch("/app/upload", { method: "POST", body: upload });
	document.documentElement.dataset.compactViewDone = "1";
})();
`;

async function openChrome(): Promise<{
	process: ChildProcess;
	devtoolsUrl: string;
}> {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "picker-chrome-"));
	const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
	const chrome = spawn(
		chromePath,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			`--user-data-dir=${userDataDir}`,
			"--remote-debugging-port=0",
			`--user-agent=${MERCHANT_USER_AGENT}`,
			"about:blank",
		],
		{ stdio: ["ignore", "pipe", "pipe"] }
	);
	const websocketUrl = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Chrome did not open a DevTools socket")),
			15000
		);
		const onData = (chunk: Buffer) => {
			const match = chunk
				.toString("utf8")
				.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+/i);
			if (!match) {
				return;
			}
			clearTimeout(timer);
			resolve(match[0]);
		};
		chrome.stderr?.on("data", onData);
		chrome.stdout?.on("data", onData);
		chrome.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Chrome exited before DevTools was ready (${code})`));
		});
	});
	chrome.on("exit", () => {
		void rm(userDataDir, { recursive: true, force: true });
	});
	return { process: chrome, devtoolsUrl: websocketUrl };
}

async function driveBrowser(input: {
	devtoolsUrl: string;
	pageUrl: string;
	origin: string;
}): Promise<{ ran: string | null; script: ScriptSnapshot | null }> {
	const configPath = path.join(
		tmpdir(),
		`picker-drive-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
	);
	await writeFile(
		configPath,
		JSON.stringify({ ...input, attacker: ATTACKER_SCRIPT }),
		"utf8"
	);
	const driver = `
		import { readFileSync } from "node:fs";
		const config = JSON.parse(readFileSync(process.env.PICKER_DRIVE_CONFIG, "utf8"));
		const pending = new Map();
		let nextId = 0;
		let sessionId = "";
		const socket = new WebSocket(config.devtoolsUrl);
		const send = (method, params, targetSession) => {
			nextId += 1;
			const id = nextId;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				socket.send(JSON.stringify({ id, method, params, sessionId: targetSession }));
			});
		};
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data.toString());
			if (message.id && pending.has(message.id)) {
				const waiter = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) waiter.reject(new Error(message.error.message || "cdp error"));
				else waiter.resolve(message.result);
				return;
			}
			if (message.method !== "Fetch.requestPaused") return;
			const requestUrl = message.params?.request?.url || "";
			const requestId = message.params?.requestId;
			if (!requestId) return;
			const externalScript = !requestUrl.startsWith(config.origin) && message.params?.resourceType === "Script";
			if (!externalScript) {
				send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
				return;
			}
			send("Fetch.fulfillRequest", {
				requestId,
				responseCode: 200,
				responseHeaders: [
					{ name: "Content-Type", value: "application/javascript" },
					{ name: "Access-Control-Allow-Origin", value: config.origin },
				],
				body: Buffer.from(config.attacker, "utf8").toString("base64"),
			}, sessionId).catch((error) => {
				console.error(error);
			});
		});
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve);
			socket.addEventListener("error", () => reject(new Error("DevTools socket failed")));
		});
		const created = await send("Target.createTarget", { url: "about:blank" });
		const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
		sessionId = attached.sessionId;
		await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
		await send("Page.enable", {}, sessionId);
		await send("Page.navigate", { url: config.pageUrl }, sessionId);
		const started = Date.now();
		let ready = false;
		while (Date.now() - started < 8000) {
			const evaluated = await send("Runtime.evaluate", { expression: "!!document.querySelector('button')", returnByValue: true }, sessionId);
			if (evaluated.result?.value) { ready = true; break; }
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (!ready) throw new Error("Import button did not render");
		await send("Runtime.evaluate", { expression: "document.querySelector('button').click()", returnByValue: true }, sessionId);
		const clickedAt = Date.now();
		while (Date.now() - clickedAt < 8000) {
			const evaluated = await send("Runtime.evaluate", {
				expression: "document.documentElement.dataset.compactViewDone === '1' || document.documentElement.dataset.compactViewRan === '1' || !!window.__scriptAtAppend",
				returnByValue: true,
			}, sessionId);
			if (evaluated.result?.value) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		const evaluated = await send("Runtime.evaluate", {
			expression: "JSON.stringify({ ran: document.documentElement.dataset.compactViewRan || null, script: window.__scriptAtAppend || null })",
			returnByValue: true,
		}, sessionId);
		await send("Target.closeTarget", { targetId: created.targetId });
		socket.close();
		process.stdout.write(evaluated.result.value);
	`;
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--input-type=module", "-e", driver],
			{
				env: { ...process.env, PICKER_DRIVE_CONFIG: configPath },
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let out = "";
		let err = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		child.once("exit", (code) => {
			void rm(configPath, { force: true });
			if (code === 0) {
				resolve(out);
				return;
			}
			reject(new Error(sanitize(err || `browser driver exited ${code}`)));
		});
	});
	return JSON.parse(stdout) as {
		ran: string | null;
		script: ScriptSnapshot | null;
	};
}

async function bundlePicker(directory: string): Promise<string> {
	const entry = path.join(directory, "harness.tsx");
	const outfile = path.join(directory, "picker.js");
	await writeFile(entry, browserHarnessSource(), "utf8");
	const builder = `
		import { createRequire } from "node:module";
		const require = createRequire(${JSON.stringify(path.join(repoRoot, "node_modules/vite/package.json"))});
		const esbuild = require("esbuild");
		await esbuild.build({
			absWorkingDir: ${JSON.stringify(repoRoot)},
			bundle: true,
			define: { "process.env.NODE_ENV": '"development"' },
			entryPoints: [${JSON.stringify(entry)}],
			format: "iife",
			jsx: "automatic",
			nodePaths: [${JSON.stringify(path.join(repoRoot, "node_modules"))}],
			outfile: ${JSON.stringify(outfile)},
		});
	`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--input-type=module", "-e", builder],
			{
				stdio: "inherit",
			}
		);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`esbuild exited ${code}`));
		});
	});
	return outfile;
}

function shopConfig() {
	return {
		id: "shop-row",
		shop: SHOP,
		bynderBaseUrl: BYNDER_PORTAL,
		fileFolderTemplate: null,
		filenamePrefix: null,
		filenameSuffix: null,
		altTextPrefix: null,
		syncTags: null,
		enableAutoAltText: false,
	};
}

describe("Bynder compact view supply chain", () => {
	const effects: string[] = [];
	const failures: string[] = [];
	let restoreTransport: (() => void) | null = null;
	let server: ReturnType<typeof createServer> | null = null;
	let origin = "";
	let bundle = "";
	let sessionToken = "";
	let chrome: ChildProcess | null = null;
	let devtoolsUrl = "";
	const bundleDirectory = mkdtemp(path.join(tmpdir(), "picker-bundle-"));

	beforeAll(async () => {
		process.env.ENABLE_METRICS = "false";
		const apiKey = process.env.SHOPIFY_API_KEY;
		const apiSecret = process.env.SHOPIFY_API_SECRET;
		if (!apiKey || !apiSecret) {
			throw new Error("Shopify API key and secret placeholders are required");
		}
		const config = testConfig({
			apiKey,
			apiSecretKey: apiSecret,
			appUrl: "http://127.0.0.1:3000",
			apiVersion: ApiVersion.October25,
			distribution: AppDistribution.AppStore,
			scopes: ["read_files", "write_files"],
			logger: { level: 0 },
		});
		const shopify = shopifyApp(
			config as unknown as Parameters<typeof shopifyApp>[0]
		);
		await config.sessionStorage.storeSession(
			new Session({
				id: `offline_${SHOP}`,
				shop: SHOP,
				state: "placeholder-state",
				isOnline: false,
				accessToken: "placeholder-offline-access-token",
				scope: "read_files,write_files",
			})
		);
		authBridge.admin = (request) => shopify.authenticate.admin(request);
		const mockedPrisma = prisma as unknown as {
			shop: { findUnique: ReturnType<typeof vi.fn> };
			syncedAsset: { upsert: ReturnType<typeof vi.fn> };
		};
		mockedPrisma.shop.findUnique.mockResolvedValue(shopConfig());
		mockedPrisma.syncedAsset.upsert.mockResolvedValue({ id: "synced-row" });
		restoreTransport = await installTransport(effects);
		sessionToken = signSessionToken(apiSecret, apiKey);
		const directory = await bundleDirectory;
		bundle = await bundlePicker(directory);
		server = createServer((req, res) => {
			void handleRequest(req, res);
		});
		await new Promise<void>((resolve) => {
			server?.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Test server did not bind to a port");
		}
		origin = `http://127.0.0.1:${address.port}`;
		const opened = await openChrome();
		chrome = opened.process;
		devtoolsUrl = opened.devtoolsUrl;
	}, 60000);

	afterAll(async () => {
		restoreTransport?.();
		server?.close();
		chrome?.kill("SIGKILL");
		const directory = await bundleDirectory.catch(() => null);
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
	});

	async function handleRequest(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", origin);
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(pageHtml());
			return;
		}
		if (req.method === "GET" && url.pathname === "/picker.js") {
			const { readFile } = await import("node:fs/promises");
			const source = await readFile(bundle);
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
			res.end(source);
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(404);
			res.end();
			return;
		}
		try {
			const body = await readBody(req);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (typeof value === "string") {
					headers.set(key, value);
				}
			}
			const request = new Request(new URL(url.pathname + url.search, origin), {
				method: "POST",
				headers,
				body: new Uint8Array(body),
			});
			const action =
				url.pathname === "/app/file-manager"
					? fileManagerAction
					: url.pathname === "/app/upload"
						? uploadAction
						: url.pathname === "/api/sync"
							? syncAction
							: null;
			if (!action) {
				failures.push(`unexpected path ${url.pathname}`);
				res.writeHead(404);
				res.end();
				return;
			}
			await action({ request, params: {}, context: {} } as ActionFunctionArgs);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		} catch (error) {
			let detail = "";
			if (error instanceof Response) {
				detail = sanitize(await error.text());
			}
			const message =
				error instanceof Response
					? `${req.method} ${url.pathname} response ${error.status} ${error.statusText} authLen=${req.headers.authorization?.length ?? 0} expectedLen=${"Bearer ".length + sessionToken.length} ${detail.slice(0, 180)}`
					: error instanceof Error
						? error.message
						: String(error);
			failures.push(sanitize(message));
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("action failed");
		}
	}

	async function openImport(baseUrl: string): Promise<PageState> {
		effects.length = 0;
		failures.length = 0;
		const pageUrl = new URL("/", origin);
		pageUrl.searchParams.set("baseUrl", baseUrl);
		pageUrl.searchParams.set("embedded", "1");
		pageUrl.searchParams.set("shop", SHOP);
		pageUrl.searchParams.set("id_token", sessionToken);
		const driven = await driveBrowser({
			devtoolsUrl,
			pageUrl: pageUrl.href,
			origin,
		});
		return {
			ran: driven.ran,
			script: driven.script,
			effects: [...effects],
			failures: [...failures],
		};
	}

	function renderFilesPage(baseUrl: string) {
		const router = createMemoryRouter(
			[
				{
					path: "/app/files",
					element: <SyncedAssetsPage />,
					loader: () => ({
						shop: SHOP,
						shopConfig: { ...shopConfig(), bynderBaseUrl: baseUrl },
						syncedAssets: [],
						pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
					}),
				},
			],
			{ initialEntries: ["/app/files"] }
		);
		render(<RouterProvider router={router} />);
	}

	it("does not run a replaced compact-view script when Import from Bynder is clicked", async () => {
		const state = await openImport(BYNDER_PORTAL);
		expect({
			scriptRan: state.ran,
			effects: state.effects,
			failures: state.failures,
		}).toEqual({
			scriptRan: null,
			effects: [],
			failures: [],
		});
		expect(state.script?.integrity ?? "").toMatch(
			/^sha(256|384|512)-[A-Za-z0-9+/=]+$/
		);
		expect(state.script?.src ?? "").not.toMatch(/latest/i);
		expect(state.script?.src ?? "").toMatch(/^https:\/\//);
	}, 30000);

	it("does not request the compact view for a portal host outside Bynder", async () => {
		const state = await openImport(FOREIGN_PORTAL);
		expect(state.script).toBeNull();
		expect(state.ran).toBeNull();
		expect(state.effects).toEqual([]);
	}, 30000);

	it("loads the pinned script from the primary Import button on Synced Assets", async () => {
		renderFilesPage(BYNDER_PORTAL);
		const [primary] = await screen.findAllByText("Import from Bynder");
		if (!primary) {
			throw new Error("Import button was not rendered");
		}
		fireEvent.click(primary);
		await waitFor(() => {
			expect(
				document.querySelector("script[src*='bynder-compactview']")
			).toBeTruthy();
		});
		const script = document.querySelector("script[src*='bynder-compactview']");
		expect(script?.getAttribute("integrity") ?? "").toMatch(
			/^sha(256|384|512)-[A-Za-z0-9+/=]+$/
		);
		expect(script?.getAttribute("src") ?? "").not.toMatch(/latest/i);
	});

	it("loads the pinned script from the empty-state Import button", async () => {
		renderFilesPage(BYNDER_PORTAL);
		const buttons = await screen.findAllByText("Import from Bynder");
		const emptyState = buttons[1];
		if (!emptyState) {
			throw new Error("Empty-state Import button was not rendered");
		}
		fireEvent.click(emptyState);
		await waitFor(() => {
			expect(
				document.querySelector("script[src*='bynder-compactview']")
			).toBeTruthy();
		});
		const script = document.querySelector("script[src*='bynder-compactview']");
		expect(script?.getAttribute("integrity") ?? "").not.toBe("");
		expect(script?.getAttribute("src") ?? "").not.toMatch(/latest/i);
	});

	it("does not insert the compact view from Synced Assets for a foreign portal", async () => {
		renderFilesPage(FOREIGN_PORTAL);
		const [primary] = await screen.findAllByText("Import from Bynder");
		if (!primary) {
			throw new Error("Import button was not rendered");
		}
		fireEvent.click(primary);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			document.querySelector("script[src*='bynder-compactview']")
		).toBeNull();
	});
});
