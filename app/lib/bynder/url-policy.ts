/**
 * Host allowlists for every outbound request built from Bynder-derived URLs.
 *
 * The portal URL is entered by shop staff and the deployment-wide permanent
 * token is attached to requests sent to it, so only Bynder-operated hosts may
 * ever be contacted. Hosts are compared using the WHATWG URL parser's
 * hostname, never by substring.
 */

const APPROVED_PORTAL_DOMAINS = ["getbynder.com", "bynder.com"];

/**
 * Bynder asset storage buckets: leftmost label starts with "bynder", followed
 * by .s3.amazonaws.com, .s3.<region>.amazonaws.com or .s3-<region>.amazonaws.com
 */
const APPROVED_STORAGE_HOST_PATTERN =
	/^bynder[a-z0-9-]*\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;

export class UnapprovedBynderUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnapprovedBynderUrlError";
	}
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, "");
}

export function isApprovedPortalHost(hostname: string): boolean {
	const host = normalizeHostname(hostname);
	return APPROVED_PORTAL_DOMAINS.some(
		(domain) => host === domain || host.endsWith(`.${domain}`)
	);
}

export function isApprovedStorageHost(hostname: string): boolean {
	return APPROVED_STORAGE_HOST_PATTERN.test(normalizeHostname(hostname));
}

/**
 * Parses a URL that is safe to carry Bynder traffic: https, no embedded
 * credentials and no explicit port. Returns null for anything else.
 */
export function parseSecureUrl(rawUrl: string): URL | null {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) {
		return null;
	}
	return url;
}

/**
 * Returns the hostname of an approved Bynder portal URL.
 *
 * @throws {UnapprovedBynderUrlError} When the URL is not an approved portal
 */
export function getApprovedPortalHost(rawUrl: string): string {
	const url = parseSecureUrl(rawUrl);
	if (!url || !isApprovedPortalHost(url.hostname)) {
		throw new UnapprovedBynderUrlError(
			"Bynder base URL must be an https URL on getbynder.com or bynder.com"
		);
	}
	return normalizeHostname(url.hostname);
}

/**
 * Normalizes an approved portal URL to its API base, e.g.
 * "https://portal.getbynder.com" -> "https://portal.getbynder.com/api".
 *
 * @throws {UnapprovedBynderUrlError} When the URL is not an approved portal
 */
export function normalizePortalApiUrl(rawUrl: string): string {
	return `https://${getApprovedPortalHost(rawUrl)}/api`;
}
