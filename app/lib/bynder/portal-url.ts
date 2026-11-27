export class InvalidPortalUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidPortalUrlError";
	}
}

/**
 * Parses a shop's saved Bynder portal address.
 *
 * The address is staff-controlled and every portal call carries the
 * permanent token, so anything other than https:// is refused before a
 * connection is opened.
 *
 * @throws {InvalidPortalUrlError} When the address is not an https URL
 */
export function parseHttpsPortalUrl(rawUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		throw new InvalidPortalUrlError("Bynder base URL is not a valid URL");
	}
	if (parsed.protocol !== "https:") {
		throw new InvalidPortalUrlError("Bynder base URL must start with https://");
	}
	return parsed;
}
