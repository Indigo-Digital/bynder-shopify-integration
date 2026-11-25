/**
 * @vitest-environment node
 *
 * Spec for the framework-mode `/__manifest` handler shipped with react-router
 * 7.9.6. These tests fail while that handler is in place and pass on 7.18.0.
 */
import { createRequestHandler, type ServerBuild } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";

/** Same ceiling react-router uses for a manifest URL. Not exported in 7.9.6. */
const MANIFEST_URL_LIMIT = 7680;

/**
 * Stand-in for the manifest version inlined into the public document.
 * It is not a credential. The handler compares it to `build.assets.version`.
 */
const MANIFEST_VERSION = "public-manifest-version";

interface RouteDefinition {
	id: string;
	path?: string;
	parentId?: string;
	index?: true;
}

/**
 * Route shape produced by `flatRoutes()` for this app, plus a parent/index/child
 * trio that makes ancestor expansion visible in the manifest response.
 */
const ROUTE_DEFINITIONS: RouteDefinition[] = [
	{ id: "root" },
	{ id: "routes/_index", parentId: "root", index: true },
	{ id: "routes/app", parentId: "root", path: "app" },
	{ id: "routes/app._index", parentId: "routes/app", index: true },
	{ id: "routes/app.additional", parentId: "routes/app", path: "additional" },
	{
		id: "routes/app.file-manager",
		parentId: "routes/app",
		path: "file-manager",
	},
	{ id: "routes/app.files", parentId: "routes/app", path: "files" },
	{ id: "routes/app.settings", parentId: "routes/app", path: "settings" },
	{ id: "routes/app.sync", parentId: "routes/app", path: "sync" },
	{ id: "routes/app.upload", parentId: "routes/app", path: "upload" },
	{ id: "routes/app.webhooks", parentId: "routes/app", path: "webhooks" },
	{ id: "routes/auth.$", parentId: "root", path: "auth/*" },
	{ id: "routes/auth.login", parentId: "root", path: "auth/login" },
	{ id: "routes/health", parentId: "root", path: "health" },
	{ id: "routes/api.ai-test", parentId: "root", path: "api/ai-test" },
	{
		id: "routes/api.bynder.assets",
		parentId: "root",
		path: "api/bynder/assets",
	},
	{
		id: "routes/api.bynder.test",
		parentId: "root",
		path: "api/bynder/test",
	},
	{
		id: "routes/api.bynder.webhooks",
		parentId: "root",
		path: "api/bynder/webhooks",
	},
	{
		id: "routes/api.bynder.webhooks.test-endpoint",
		parentId: "root",
		path: "api/bynder/webhooks/test-endpoint",
	},
	{ id: "routes/api.sync", parentId: "root", path: "api/sync" },
	{ id: "routes/api.sync.cancel", parentId: "root", path: "api/sync/cancel" },
	{ id: "routes/api.sync.retry", parentId: "root", path: "api/sync/retry" },
	{
		id: "routes/webhooks.app.scopes_update",
		parentId: "root",
		path: "webhooks/app/scopes_update",
	},
	{
		id: "routes/webhooks.app.uninstalled",
		parentId: "root",
		path: "webhooks/app/uninstalled",
	},
	{ id: "routes/parent", parentId: "root", path: "parent" },
	{ id: "routes/parent._index", parentId: "routes/parent", index: true },
	{ id: "routes/parent.child", parentId: "routes/parent", path: "child" },
];

function optionalRouteFields(definition: RouteDefinition): {
	path?: string;
	index?: true;
	parentId?: string;
} {
	return {
		...(definition.path !== undefined ? { path: definition.path } : {}),
		...(definition.index !== undefined ? { index: definition.index } : {}),
		...(definition.parentId !== undefined
			? { parentId: definition.parentId }
			: {}),
	};
}

function createFrameworkBuild(): ServerBuild {
	const assetsRoutes: ServerBuild["assets"]["routes"] = {};
	const routes: ServerBuild["routes"] = {};

	for (const definition of ROUTE_DEFINITIONS) {
		assetsRoutes[definition.id] = {
			id: definition.id,
			...optionalRouteFields(definition),
			module: "",
			hasAction: false,
			hasLoader: true,
			hasClientAction: false,
			hasClientLoader: false,
			hasClientMiddleware: false,
			hasErrorBoundary: definition.id === "root",
			clientActionModule: undefined,
			clientLoaderModule: undefined,
			clientMiddlewareModule: undefined,
			hydrateFallbackModule: undefined,
		};
		routes[definition.id] = {
			id: definition.id,
			...optionalRouteFields(definition),
			module: {
				default: () => null,
				loader: () => {
					throw new Error(
						`Route loader for ${definition.id} ran during a manifest request`
					);
				},
			},
		};
	}

	return {
		entry: {
			module: {
				default: async (_request, status, headers) =>
					new Response("document", { status, headers }),
			},
		},
		routes,
		assets: {
			entry: { imports: [], module: "" },
			routes: assetsRoutes,
			url: "",
			version: MANIFEST_VERSION,
		},
		publicPath: "/",
		assetsBuildDirectory: "build/client",
		future: {
			unstable_subResourceIntegrity: false,
			v8_middleware: false,
		},
		ssr: true,
		isSpaMode: false,
		prerender: [],
		routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
	};
}

function manifestUrl(paths: string, version = MANIFEST_VERSION): string {
	const url = new URL("http://localhost/__manifest");
	url.searchParams.set("paths", paths);
	url.searchParams.set("version", version);
	return url.toString();
}

function repeatedSegmentPath(segmentCount: number): string {
	return `/${Array.from({ length: segmentCount }, () => "a").join("/")}`;
}

function segmentCountAtOrBelowLimit(): number {
	let largest = 1;
	let low = 1;
	let high = 5000;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const length = manifestUrl(repeatedSegmentPath(mid)).length;
		if (length <= MANIFEST_URL_LIMIT) {
			largest = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return largest;
}

function unauthenticatedRequest(url: string): Request {
	return new Request(url, {
		method: "GET",
		headers: { accept: "*/*" },
	});
}

async function dispatch(
	handler: ReturnType<typeof createRequestHandler>,
	request: Request
): Promise<{ response: Response; compiledPatterns: number }> {
	const originalRegExp = globalThis.RegExp;
	let compiledPatterns = 0;
	const countingRegExp = new Proxy(originalRegExp, {
		construct(target, args, newTarget) {
			compiledPatterns += 1;
			return Reflect.construct(target, args, newTarget);
		},
		apply(target, thisArg, args) {
			compiledPatterns += 1;
			return Reflect.apply(target, thisArg, args);
		},
	});
	globalThis.RegExp = countingRegExp as typeof RegExp;
	try {
		const response = await handler(request);
		return { response, compiledPatterns };
	} finally {
		globalThis.RegExp = originalRegExp;
	}
}

describe("framework manifest endpoint", () => {
	const handler = createRequestHandler(createFrameworkBuild(), "production");
	const deepestInBudget = segmentCountAtOrBelowLimit();
	const inBudgetPath = repeatedSegmentPath(deepestInBudget);
	const overBudgetPath = repeatedSegmentPath(deepestInBudget + 80);

	beforeAll(async () => {
		const warmed = await handler(
			unauthenticatedRequest(manifestUrl("/health"))
		);
		expect(warmed.status).toBe(200);
	});

	it("serves a manifest patch to a request with no credentials", async () => {
		const request = unauthenticatedRequest(manifestUrl("/health"));
		expect(request.headers.has("cookie")).toBe(false);
		expect(request.headers.has("authorization")).toBe(false);

		const { response } = await dispatch(handler, request);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable"
		);
		expect(Object.keys(await response.json()).sort()).toEqual([
			"root",
			"routes/health",
		]);
	});

	it("does not invent ancestor patches for a path the client did not send", async () => {
		const { response, compiledPatterns } = await dispatch(
			handler,
			unauthenticatedRequest(manifestUrl("/parent/child"))
		);

		expect(response.status).toBe(200);
		expect(compiledPatterns).toBe(0);
		expect(Object.keys(await response.json()).sort()).toEqual([
			"root",
			"routes/parent",
			"routes/parent.child",
		]);
	});

	it("matches a maximum in-budget manifest URL without recompiling route patterns", async () => {
		const url = manifestUrl(inBudgetPath);
		expect(url.length).toBeLessThanOrEqual(MANIFEST_URL_LIMIT);
		expect(url.length).toBeGreaterThan(MANIFEST_URL_LIMIT - 8);

		const { response, compiledPatterns } = await dispatch(
			handler,
			unauthenticatedRequest(url)
		);

		expect(response.status).toBe(200);
		expect(compiledPatterns).toBe(0);
		expect(await response.json()).toEqual({});
	}, 20_000);

	it("does not recompile route patterns for every comma-separated path", async () => {
		const paths = Array.from({ length: 400 }, (_value, index) => `/p${index}`);
		const url = manifestUrl(paths.join(","));
		expect(url.length).toBeLessThanOrEqual(MANIFEST_URL_LIMIT);

		const { response, compiledPatterns } = await dispatch(
			handler,
			unauthenticatedRequest(url)
		);

		expect(response.status).toBe(200);
		expect(compiledPatterns).toBe(0);
	});

	it("rejects an over-budget manifest URL before compiling route patterns", async () => {
		const url = manifestUrl(overBudgetPath);
		expect(url.length).toBeGreaterThan(MANIFEST_URL_LIMIT);

		const { response, compiledPatterns } = await dispatch(
			handler,
			unauthenticatedRequest(url)
		);

		expect(response.status).toBe(400);
		expect(compiledPatterns).toBe(0);
	}, 20_000);

	it("rejects an over-budget manifest URL before the version short-circuit", async () => {
		const url = manifestUrl(overBudgetPath, "wrong-version");
		expect(url.length).toBeGreaterThan(MANIFEST_URL_LIMIT);

		const { response, compiledPatterns } = await dispatch(
			handler,
			unauthenticatedRequest(url)
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("x-remix-reload-document")).toBeNull();
		expect(compiledPatterns).toBe(0);
	}, 20_000);
});
