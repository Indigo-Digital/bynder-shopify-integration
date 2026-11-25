const BYNDER_PORTAL_DOMAIN = "getbynder.com";

export class InvalidBynderPortalUrlError extends Error {
	constructor() {
		super(
			`Bynder portal URL must be an https address on ${BYNDER_PORTAL_DOMAIN} (e.g., https://your-portal.${BYNDER_PORTAL_DOMAIN}/api)`
		);
		this.name = "InvalidBynderPortalUrlError";
	}
}

function isBynderPortalHostname(hostname: string): boolean {
	return (
		hostname === BYNDER_PORTAL_DOMAIN ||
		hostname.endsWith(`.${BYNDER_PORTAL_DOMAIN}`)
	);
}

/**
 * Parses a shop-supplied Bynder portal URL and accepts only https hosts on
 * the Bynder domain, so shop staff cannot point server-side requests (which
 * carry the app's Bynder token) at a host they control.
 *
 * @throws {InvalidBynderPortalUrlError} When the URL is not an allowed portal
 */
export function parseBynderPortalUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new InvalidBynderPortalUrlError();
	}

	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		!isBynderPortalHostname(url.hostname)
	) {
		throw new InvalidBynderPortalUrlError();
	}

	return url;
}
