import Bynder from "@bynder/bynder-js-sdk";
import { env } from "../env.server.js";
import {
	MAX_BYNDER_JSON_BYTES,
	readResponseBody,
} from "../http/body-limits.js";
import { recordApiCall, recordRateLimitHit } from "../metrics/collector.js";
import { getRateLimiter } from "./rate-limiter.js";
import type { BynderConfig, BynderOAuthTokens } from "./types.js";

const BYNDER_REQUEST_TIMEOUT_MS = 60 * 1000;

/** Highest page getAllMediaItems will request before giving up. */
export const MAX_BYNDER_PAGES = 40;

/** Most assets getAllMediaItems will collect for one query. */
export const MAX_BYNDER_ASSETS = 1000;

const MEDIA_PAGE_SIZE = 50;

type BynderQueryValue = string | number | boolean | string[] | undefined;

interface BynderMediaItem {
	id: string;
	tags?: string[];
	version?: number;
	[key: string]: unknown;
}

interface BynderMediaPage {
	items: BynderMediaItem[];
	pageLength: number;
	total?: number;
}

export class BynderApiError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, statusText: string, body: string) {
		super(
			`Bynder API error: HTTP ${status} ${statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`
		);
		this.name = "BynderApiError";
		this.status = status;
		this.body = body;
	}
}

/** Mirrors the SDK: 2xx bodies other than 200-202 resolve to an empty object. */
function parseBynderJson(status: number, text: string): unknown {
	if (status > 202 || !text) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function isMediaItem(item: unknown): item is BynderMediaItem {
	return (
		item !== null &&
		typeof item === "object" &&
		"id" in item &&
		typeof (item as { id: unknown }).id === "string"
	);
}

/** Accepts both the raw-array and the `{ media, total }` list formats. */
function parseMediaPage(response: unknown): BynderMediaPage | null {
	if (Array.isArray(response)) {
		return { items: response.filter(isMediaItem), pageLength: response.length };
	}
	if (
		response &&
		typeof response === "object" &&
		"media" in response &&
		Array.isArray((response as { media: unknown[] }).media)
	) {
		const { media, total } = response as { media: unknown[]; total?: number };
		return {
			items: media.filter(isMediaItem),
			pageLength: media.length,
			total: total || media.length,
		};
	}
	return null;
}

export interface BynderPermanentTokenConfig {
	baseURL: string;
	permanentToken: string;
	clientId: string;
	clientSecret: string;
}

export class BynderClient {
	private bynder: Bynder;
	public config: BynderConfig | BynderPermanentTokenConfig;

	constructor(config: BynderConfig | BynderPermanentTokenConfig) {
		this.config = config;
		const bynderConfig: {
			baseURL: string;
			clientId: string;
			clientSecret: string;
			redirectUri?: string;
			permanentToken?: string;
			token?: string;
		} = {
			baseURL: config.baseURL,
			clientId: config.clientId,
			clientSecret: config.clientSecret,
		};
		if ("redirectUri" in config && config.redirectUri) {
			bynderConfig.redirectUri = config.redirectUri;
		}
		if ("permanentToken" in config && config.permanentToken) {
			bynderConfig.permanentToken = config.permanentToken;
		}
		this.bynder = new Bynder(bynderConfig);
	}

	/**
	 * Create client using permanent token (recommended for all operations)
	 */
	static createPermanentTokenClient(
		config: BynderPermanentTokenConfig
	): BynderClient {
		if (!config.permanentToken) {
			throw new Error("permanentToken is required");
		}
		return new BynderClient(config);
	}

	/**
	 * Create client using permanent token from environment variables
	 * Requires baseURL (typically from shop config) and uses env vars for token/credentials
	 * Automatically appends /api to the baseURL if not present
	 */
	static createFromEnv(baseURL: string): BynderClient {
		if (!env.BYNDER_PERMANENT_TOKEN) {
			throw new Error(
				"BYNDER_PERMANENT_TOKEN environment variable is required"
			);
		}
		if (!env.BYNDER_CLIENT_ID || !env.BYNDER_CLIENT_SECRET) {
			throw new Error(
				"BYNDER_CLIENT_ID and BYNDER_CLIENT_SECRET environment variables are required"
			);
		}

		// Normalize baseURL: ensure it ends with /api
		let normalizedBaseURL = baseURL.trim();
		// Remove trailing slash
		normalizedBaseURL = normalizedBaseURL.replace(/\/$/, "");
		// Append /api if not present
		if (!normalizedBaseURL.endsWith("/api")) {
			normalizedBaseURL = `${normalizedBaseURL}/api`;
		}

		return BynderClient.createPermanentTokenClient({
			baseURL: normalizedBaseURL,
			permanentToken: env.BYNDER_PERMANENT_TOKEN,
			clientId: env.BYNDER_CLIENT_ID,
			clientSecret: env.BYNDER_CLIENT_SECRET,
		});
	}

	/**
	 * Initialize OAuth2 client for user actions (deprecated - use permanent token instead)
	 * @deprecated Use createPermanentTokenClient instead
	 */
	static createOAuthClient(config: BynderConfig): BynderClient {
		if (!config.redirectUri) {
			throw new Error("redirectUri is required for OAuth2 client");
		}
		return new BynderClient(config);
	}

	/**
	 * Initialize client credentials client for background jobs (deprecated - use permanent token instead)
	 * @deprecated Use createPermanentTokenClient instead
	 */
	static async createClientCredentialsClient(
		config: BynderConfig
	): Promise<BynderClient> {
		const { redirectUri: _redirectUri, ...configWithoutRedirect } = config;
		const client = new BynderClient(configWithoutRedirect);
		await client.authenticateWithClientCredentials();
		return client;
	}

	/**
	 * Authenticate using client credentials
	 */
	async authenticateWithClientCredentials(): Promise<string> {
		const token = await this.bynder.getTokenClientCredentials();
		return token;
	}

	/**
	 * Get authorization URL for OAuth2 flow
	 */
	makeAuthorizationURL(): string {
		return this.bynder.makeAuthorizationURL();
	}

	/**
	 * Exchange authorization code for tokens
	 */
	async getToken(code: string): Promise<BynderOAuthTokens> {
		const token = await this.bynder.getToken(code);
		const result: BynderOAuthTokens = {
			accessToken: token.access_token,
		};
		if (token.refresh_token) {
			result.refreshToken = token.refresh_token;
		}
		if (token.expires_in) {
			result.expiresAt = new Date(Date.now() + token.expires_in * 1000);
		}
		return result;
	}

	/**
	 * Set access token directly (for already authenticated sessions)
	 * @deprecated Not needed when using permanent token
	 */
	setAccessToken(token: string): void {
		this.bynder = new Bynder({
			...this.config,
			token,
		});
	}

	/**
	 * Get media list with optional filters
	 */
	async getMediaList(params: {
		type?: string;
		tags?: string | string[];
		limit?: number;
		page?: number;
		keyword?: string;
		shopId?: string; // Optional shopId for metrics tracking
		syncJobId?: string; // Optional syncJobId for metrics tracking
	}) {
		const rateLimiter = getRateLimiter();
		const wasRateLimited = rateLimiter.getAvailableTokens() < 1;
		await rateLimiter.acquire();

		// Track metrics if shopId is provided
		if (params.shopId) {
			await recordApiCall(
				params.shopId,
				"bynder_getMediaList",
				params.syncJobId
			);
			if (wasRateLimited) {
				await recordRateLimitHit(params.shopId, params.syncJobId);
			}
		}

		const { shopId: _shopId, syncJobId: _syncJobId, ...query } = params;
		return this.getJson("v4/media/", { ...query, count: false });
	}

	/**
	 * Get media info by ID
	 */
	async getMediaInfo(params: {
		id: string;
		shopId?: string; // Optional shopId for metrics tracking
		syncJobId?: string; // Optional syncJobId for metrics tracking
	}) {
		const rateLimiter = getRateLimiter();
		const wasRateLimited = rateLimiter.getAvailableTokens() < 1;
		await rateLimiter.acquire();

		// Track metrics if shopId is provided
		if (params.shopId) {
			await recordApiCall(
				params.shopId,
				"bynder_getMediaInfo",
				params.syncJobId,
				{ assetId: params.id }
			);
			if (wasRateLimited) {
				await recordRateLimitHit(params.shopId, params.syncJobId);
			}
		}

		return this.getJson(`v4/media/${encodeURIComponent(params.id)}/`);
	}

	/**
	 * GET a Bynder API path with the permanent token and return the parsed
	 * JSON body. Replaces the SDK's request helper, whose axios call has no
	 * response size limit or timeout, for a portal host that a shop configures.
	 */
	private async getJson(
		path: string,
		query: Record<string, BynderQueryValue> = {}
	): Promise<unknown> {
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			BYNDER_REQUEST_TIMEOUT_MS
		);
		try {
			const response = await fetch(this.buildApiUrl(path, query), {
				headers: this.buildAuthHeaders(),
				signal: controller.signal,
			});
			const text = (
				await readResponseBody(response, MAX_BYNDER_JSON_BYTES)
			).toString("utf8");
			if (!response.ok) {
				throw new BynderApiError(response.status, response.statusText, text);
			}
			return parseBynderJson(response.status, text);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(
					`Bynder API request timed out after ${BYNDER_REQUEST_TIMEOUT_MS} ms: ${path}`
				);
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private buildApiUrl(
		path: string,
		query: Record<string, BynderQueryValue>
	): string {
		const url = new URL(`${this.config.baseURL.replace(/\/+$/, "")}/${path}`);
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined) {
				continue;
			}
			for (const item of Array.isArray(value) ? value : [value]) {
				url.searchParams.append(key, String(item));
			}
		}
		return url.toString();
	}

	private buildAuthHeaders(): Record<string, string> {
		if (!("permanentToken" in this.config) || !this.config.permanentToken) {
			throw new Error(
				"Bynder API reads require a permanent token client (createFromEnv)"
			);
		}
		return {
			Accept: "application/json",
			Authorization: `Bearer ${this.config.permanentToken}`,
		};
	}

	/**
	 * Get media download URL
	 * Uses the SDK's getMediaDownloadUrl method or constructs URL
	 */
	async getMediaDownloadUrl(params: {
		id: string;
		itemId?: string;
		shopId?: string; // Optional shopId for metrics tracking
		syncJobId?: string; // Optional syncJobId for metrics tracking
	}): Promise<string> {
		const rateLimiter = getRateLimiter();
		const wasRateLimited = rateLimiter.getAvailableTokens() < 1;
		await rateLimiter.acquire();

		// Track metrics if shopId is provided
		if (params.shopId) {
			await recordApiCall(
				params.shopId,
				"bynder_getMediaDownloadUrl",
				params.syncJobId,
				{ assetId: params.id }
			);
			if (wasRateLimited) {
				await recordRateLimitHit(params.shopId, params.syncJobId);
			}
		}

		try {
			// Try SDK method first
			const { shopId: _shopId, syncJobId: _syncJobId, ...sdkParams } = params;
			if (this.bynder.getMediaDownloadUrl) {
				const result = await this.bynder.getMediaDownloadUrl(sdkParams);
				if (typeof result === "string") {
					return result;
				}
				if (result && typeof result === "object" && "url" in result) {
					return (result as { url: string }).url;
				}
			}
		} catch (error) {
			console.warn(
				"getMediaDownloadUrl SDK method failed, using fallback:",
				error
			);
		}

		// Fallback: construct download URL based on Bynder API
		// baseURL now includes /api, so we use it directly and append the path
		const baseUrl = this.config.baseURL.endsWith("/api")
			? this.config.baseURL
			: `${this.config.baseURL.replace(/\/api$/, "")}/api`;
		if (params.itemId) {
			return `${baseUrl}/v4/media/${params.id}/download/${params.itemId}`;
		}
		return `${baseUrl}/v4/media/${params.id}/download`;
	}

	/**
	 * Get all media items (paginated)
	 * Handles pagination automatically. Stops with an error once the query
	 * passes MAX_BYNDER_PAGES pages or MAX_BYNDER_ASSETS assets, so a portal
	 * that keeps returning full pages cannot grow the result without bound.
	 */
	async getAllMediaItems(params: {
		type?: string;
		tags?: string | string[];
		keyword?: string;
		shopId?: string; // Optional shopId for metrics tracking
		syncJobId?: string; // Optional syncJobId for metrics tracking
	}): Promise<BynderMediaItem[]> {
		const allItems: BynderMediaItem[] = [];
		const { shopId, syncJobId, ...listParams } = params;

		for (let page = 1; ; page++) {
			const listCallParams: Parameters<BynderClient["getMediaList"]>[0] = {
				...listParams,
				page,
				limit: MEDIA_PAGE_SIZE,
			};
			if (shopId) {
				listCallParams.shopId = shopId;
			}
			if (syncJobId) {
				listCallParams.syncJobId = syncJobId;
			}
			const mediaPage = parseMediaPage(await this.getMediaList(listCallParams));
			if (!mediaPage) {
				return allItems;
			}

			allItems.push(...mediaPage.items);
			if (allItems.length > MAX_BYNDER_ASSETS) {
				throw new Error(
					`Bynder media query returned more than the maximum asset count of ${MAX_BYNDER_ASSETS}`
				);
			}

			const isFullPage = mediaPage.pageLength === MEDIA_PAGE_SIZE;
			const hasMore =
				mediaPage.total === undefined
					? isFullPage
					: allItems.length < mediaPage.total && isFullPage;
			if (!hasMore) {
				return allItems;
			}
			if (page >= MAX_BYNDER_PAGES) {
				throw new Error(
					`Bynder media query reached the maximum page count of ${MAX_BYNDER_PAGES}`
				);
			}
		}
	}
}
