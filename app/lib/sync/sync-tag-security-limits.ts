/**
 * Bounds the sync pipeline must enforce. The tests are the specification:
 * a shop may persist and scan at most this many tags, and one tag scan may
 * issue at most this many Bynder media-list requests.
 *
 * Tag counts use the same split the worker uses: comma-separated, trimmed,
 * empty segments dropped. Duplicate names still count, because the scan
 * loop does not dedupe.
 */
export const MAX_SYNC_TAGS = 50;

/** One page is the media client's existing page size (50). */
export const MAX_PAGES_PER_TAG = 20;

export function parseSyncTags(syncTags: string): string[] {
	return syncTags
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

export function buildSyncTagList(count: number, prefix = "campaign"): string {
	return Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join(
		","
	);
}
