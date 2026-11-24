/**
 * Shared stand-ins for the sync-retry authorization tests.
 * The Bynder catalog and the second job read are test fixtures. Prisma itself
 * is the client the app ships.
 */

export const RETRY_AUTH_DATABASE_URL = "file:/tmp/bynder-retry-auth.sqlite";

export const SWAPPED_ASSET_ID = "asset-swapped-after-authorization";

export interface CatalogAsset {
	id: string;
	name: string;
	tags: string[];
	version: number;
}

export interface RetryAuthHarness {
	jobReads: Map<string, number>;
	mediaCalls: string[];
	catalog: Map<string, CatalogAsset>;
}

const HARNESS_KEY = "__retryAuthHarness";

type HarnessHost = typeof globalThis & {
	[HARNESS_KEY]?: RetryAuthHarness;
};

export function getRetryAuthHarness(): RetryAuthHarness {
	const host = globalThis as HarnessHost;
	if (!host[HARNESS_KEY]) {
		host[HARNESS_KEY] = {
			jobReads: new Map(),
			mediaCalls: [],
			catalog: new Map(),
		};
	}
	return host[HARNESS_KEY];
}

export function resetRetryAuthHarness(): void {
	const harness = getRetryAuthHarness();
	harness.jobReads.clear();
	harness.mediaCalls.length = 0;
	harness.catalog.clear();
}

/**
 * The SDK returns the asset object for GET v4/media/{id}/.
 * @see @bynder/bynder-js-sdk 2.5.2 dist/bynder-js-sdk.js getMediaInfo
 */
export function readCatalogAsset(
	id: string | undefined
): Promise<CatalogAsset> {
	const harness = getRetryAuthHarness();
	if (id) {
		harness.mediaCalls.push(id);
	}
	if (!id) {
		return Promise.reject(new Error("media id is required"));
	}
	const asset = harness.catalog.get(id);
	if (!asset) {
		return Promise.reject(new Error(`Asset ${id} not found`));
	}
	return Promise.resolve({ ...asset, tags: [...asset.tags] });
}

function jobIdFromWhere(where: { id?: unknown } | undefined) {
	if (!where || typeof where.id !== "string") {
		return undefined;
	}
	return where.id;
}

/**
 * The first read returns the stored row. A later read of the same id returns
 * that row with a different failed-asset list, so a check that loads the job
 * again before retrying acts on assets it did not authorize.
 */
export function divergeJobAfterFirstRead<T extends { errors?: string | null }>(
	args: { where?: { id?: unknown } },
	row: T | null
): T | null {
	const id = jobIdFromWhere(args.where);
	if (!row || !id) {
		return row;
	}
	const harness = getRetryAuthHarness();
	const seen = harness.jobReads.get(id) ?? 0;
	harness.jobReads.set(id, seen + 1);
	if (seen === 0) {
		return row;
	}
	return {
		...row,
		errors: JSON.stringify([
			{
				assetId: SWAPPED_ASSET_ID,
				error: "timeout while uploading",
			},
		]),
	};
}

export async function createRetryAuthPrisma() {
	process.env.DATABASE_URL = RETRY_AUTH_DATABASE_URL;
	const { PrismaClient } = await import("@prisma/client");
	const base = new PrismaClient();
	return base.$extends({
		query: {
			syncJob: {
				async findUnique({ args, query }) {
					const row = await query(args);
					return divergeJobAfterFirstRead(args, row);
				},
				async findFirst({ args, query }) {
					const row = await query(args);
					return divergeJobAfterFirstRead(args, row);
				},
				async findUniqueOrThrow({ args, query }) {
					const row = await query(args);
					return divergeJobAfterFirstRead(args, row);
				},
			},
		},
	});
}
