/**
 * Upper bound on configured sync tags. Every tag costs at least one full
 * Bynder media scan on the shared worker and rate limiter, so an unbounded
 * list lets one shop stall every other shop's sync jobs.
 */
export const MAX_SYNC_TAGS = 50;

/**
 * Split a stored or submitted comma-separated tag list. Duplicates are kept so
 * callers validating user input count every submitted entry.
 */
export function parseSyncTags(syncTags: string): string[] {
	return syncTags
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

/**
 * Tags a sync job may scan: unique, in configured order, and never more than
 * MAX_SYNC_TAGS, even if an oversized list was stored before the cap existed.
 */
export function getScannableSyncTags(syncTags: string): string[] {
	return [...new Set(parseSyncTags(syncTags))].slice(0, MAX_SYNC_TAGS);
}
