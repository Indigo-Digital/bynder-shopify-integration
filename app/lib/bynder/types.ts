export interface BynderAsset {
	id: string;
	name: string;
	type: string;
	tags: string[];
	dateModified: string;
	dateCreated: string;
	version: number;
	derivatives: Record<string, string>;
	thumbnails: Record<string, string>;
	description?: string;
	copyright?: string;
	isPublic?: boolean;
	brandId?: string;
	userId?: string;
}

export interface BynderMediaListResponse {
	media: BynderAsset[];
	total: number;
	count: number;
	page: number;
	limit: number;
}

export interface BynderMediaInfoResponse {
	id: string;
	name: string;
	type: string;
	tags: string[];
	dateModified: string;
	dateCreated: string;
	version: number;
	derivatives: Record<string, string>;
	thumbnails: Record<string, string>;
	description?: string;
	copyright?: string;
	isPublic?: boolean;
	brandId?: string;
	userId?: string;
	files: Array<{
		type: string;
		url: string;
		width?: number;
		height?: number;
	}>;
}

export interface BynderOAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: Date;
}

export interface BynderConfig {
	baseURL: string;
	clientId: string;
	clientSecret: string;
	redirectUri?: string;
	permanentToken?: string;
}
