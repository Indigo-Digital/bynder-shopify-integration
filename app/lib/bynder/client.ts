import Bynder from "@bynder/bynder-js-sdk";
import { env } from "../env.server.js";
import type { BynderConfig, BynderOAuthTokens } from "./types.js";

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
	}) {
		return this.bynder.getMediaList(params);
	}

	/**
	 * Get media info by ID
	 */
	async getMediaInfo(params: { id: string }) {
		return this.bynder.getMediaInfo(params);
	}

	/**
	 * Get media download URL
	 * Uses the SDK's getMediaDownloadUrl method or constructs URL
	 */
	async getMediaDownloadUrl(params: {
		id: string;
		itemId?: string;
	}): Promise<string> {
		try {
			// Try SDK method first
			if (this.bynder.getMediaDownloadUrl) {
				const result = await this.bynder.getMediaDownloadUrl(params);
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
	 * Handles pagination automatically
	 */
	async getAllMediaItems(params: {
		type?: string;
		tags?: string | string[];
		keyword?: string;
	}): Promise<
		Array<{
			id: string;
			tags?: string[];
			version?: number;
			[key: string]: unknown;
		}>
	> {
		// Use getMediaList with pagination
		const allItems: Array<{
			id: string;
			tags?: string[];
			version?: number;
			[key: string]: unknown;
		}> = [];
		let page = 1;
		const limit = 50;
		let hasMore = true;
		let total = 0;

		while (hasMore) {
			const response = await this.getMediaList({
				...params,
				page,
				limit,
			});

			if (response && typeof response === "object") {
				// Check if response has media array
				if (
					"media" in response &&
					Array.isArray((response as { media: unknown[] }).media)
				) {
					const mediaList = (response as { media: unknown[]; total?: number })
						.media;
					// Type guard: ensure items have id property
					const validItems = mediaList.filter(
						(
							item
						): item is {
							id: string;
							tags?: string[];
							version?: number;
							[key: string]: unknown;
						} =>
							item !== null &&
							typeof item === "object" &&
							"id" in item &&
							typeof (item as { id: unknown }).id === "string"
					);
					allItems.push(...validItems);
					total = (response as { total?: number }).total || mediaList.length;
					hasMore = allItems.length < total && mediaList.length === limit;
					page++;
				} else if (Array.isArray(response)) {
					// Response is directly an array
					// Type guard: ensure items have id property
					const validItems = response.filter(
						(
							item
						): item is {
							id: string;
							tags?: string[];
							version?: number;
							[key: string]: unknown;
						} =>
							item !== null &&
							typeof item === "object" &&
							"id" in item &&
							typeof (item as { id: unknown }).id === "string"
					);
					allItems.push(...validItems);
					hasMore = response.length === limit;
					page++;
				} else {
					hasMore = false;
				}
			} else {
				hasMore = false;
			}
		}

		return allItems;
	}
}
