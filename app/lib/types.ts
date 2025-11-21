// Admin API type - the admin object returned from authenticate.admin(request)
export type AdminApi = {
	graphql: (
		query: string,
		options?: { variables?: Record<string, unknown> }
	) => Promise<Response>;
	rest?: {
		resources: {
			[key: string]: {
				[method: string]: (...args: unknown[]) => Promise<unknown>;
			};
		};
	};
};
