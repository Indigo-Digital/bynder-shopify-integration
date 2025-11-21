declare module "@bynder/bynder-js-sdk" {
	export interface BynderConfig {
		baseURL: string;
		clientId: string;
		clientSecret: string;
		redirectUri?: string;
		permanentToken?: string;
		token?: string;
	}

	export interface TokenResponse {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	}

	export default class Bynder {
		constructor(config: BynderConfig);
		getTokenClientCredentials(): Promise<string>;
		makeAuthorizationURL(): string;
		getToken(code: string): Promise<TokenResponse>;
		getMediaList(params: {
			type?: string;
			tags?: string | string[];
			limit?: number;
			page?: number;
			keyword?: string;
		}): Promise<unknown>;
		getMediaInfo(params: { id: string }): Promise<unknown>;
		getMediaDownloadUrl?(params: {
			id: string;
			itemId?: string;
		}): Promise<string | { url: string }>;
	}
}
