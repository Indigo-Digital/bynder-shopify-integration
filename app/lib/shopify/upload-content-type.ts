/**
 * Content-type policy for everything this app writes to Shopify Files.
 *
 * Files land on a public CDN, so the type is always taken from the file's
 * magic bytes and must be on the allowlist. Caller-supplied types (HTTP
 * response headers, browser `File.type`) are only accepted when they agree
 * with the detected type. Text-based formats such as HTML, SVG and XML can
 * carry script and have no reliable signature, so they are never allowed.
 */

export class UnsupportedUploadTypeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedUploadTypeError";
	}
}

interface AllowedUploadType {
	extensions: readonly string[];
	aliases: readonly string[];
}

const ALLOWED_UPLOAD_TYPES: Readonly<Record<string, AllowedUploadType>> = {
	"image/jpeg": {
		extensions: ["jpg", "jpeg", "jpe", "jfif"],
		aliases: ["image/jpg", "image/pjpeg"],
	},
	"image/png": { extensions: ["png"], aliases: ["image/x-png"] },
	"image/gif": { extensions: ["gif"], aliases: [] },
	"image/webp": { extensions: ["webp"], aliases: [] },
	"image/bmp": {
		extensions: ["bmp"],
		aliases: ["image/x-bmp", "image/x-ms-bmp"],
	},
	"image/tiff": { extensions: ["tif", "tiff"], aliases: [] },
	"image/heic": { extensions: ["heic", "heif"], aliases: ["image/heif"] },
	"application/pdf": { extensions: ["pdf"], aliases: [] },
	"video/mp4": { extensions: ["mp4", "m4v"], aliases: [] },
	"video/quicktime": { extensions: ["mov", "qt"], aliases: [] },
};

/** Declared types that carry no information and defer to byte detection. */
const UNSPECIFIED_TYPES = new Set([
	"",
	"application/octet-stream",
	"binary/octet-stream",
	"application/unknown",
	"*/*",
]);

const MIN_SIGNATURE_LENGTH = 12;

function matchesBytes(buffer: Buffer, offset: number, bytes: number[]) {
	return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function asciiAt(buffer: Buffer, offset: number, length: number): string {
	return buffer.toString("latin1", offset, offset + length);
}

function detectIsoMediaType(buffer: Buffer): string | null {
	if (asciiAt(buffer, 4, 4) !== "ftyp") return null;
	const brand = asciiAt(buffer, 8, 4);
	if (brand === "qt  ") return "video/quicktime";
	if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) {
		return "image/heic";
	}
	return "video/mp4";
}

/**
 * Identify a file from its leading bytes. Returns null for anything not on
 * the allowlist, including every text-based format.
 */
export function detectMimeTypeFromBuffer(buffer: Buffer): string | null {
	if (buffer.length < MIN_SIGNATURE_LENGTH) return null;

	if (matchesBytes(buffer, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (matchesBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (["GIF87a", "GIF89a"].includes(asciiAt(buffer, 0, 6))) return "image/gif";
	if (asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP")
		return "image/webp";
	// BMP: "BM" followed by a 4-byte size and 4 reserved zero bytes.
	if (asciiAt(buffer, 0, 2) === "BM" && matchesBytes(buffer, 6, [0, 0, 0, 0]))
		return "image/bmp";
	if (
		matchesBytes(buffer, 0, [0x49, 0x49, 0x2a, 0x00]) ||
		matchesBytes(buffer, 0, [0x4d, 0x4d, 0x00, 0x2a])
	)
		return "image/tiff";
	if (asciiAt(buffer, 0, 5) === "%PDF-") return "application/pdf";

	return detectIsoMediaType(buffer);
}

function normalizeMimeType(contentType: string | null | undefined): string {
	return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function canonicalMimeType(mimeType: string): string {
	for (const [canonical, { aliases }] of Object.entries(ALLOWED_UPLOAD_TYPES)) {
		if (aliases.includes(mimeType)) return canonical;
	}
	return mimeType;
}

function isCompatibleDeclaredType(declared: string, detected: string): boolean {
	if (UNSPECIFIED_TYPES.has(declared)) return true;
	if (declared.endsWith("/*")) {
		return detected.startsWith(declared.slice(0, -1));
	}
	return canonicalMimeType(declared) === detected;
}

/**
 * Resolve the MIME type to use for a Shopify Files upload.
 *
 * @param buffer - The exact bytes that will be uploaded
 * @param declaredContentType - Type reported by the source (header, browser)
 * @returns The allowlisted MIME type detected from the bytes
 * @throws {UnsupportedUploadTypeError} When the bytes are not an allowed
 *   format, or the declared type disagrees with the bytes
 */
export function resolveUploadContentType(
	buffer: Buffer,
	declaredContentType: string | null | undefined
): string {
	const declared = normalizeMimeType(declaredContentType);
	const detected = detectMimeTypeFromBuffer(buffer);

	if (!detected) {
		throw new UnsupportedUploadTypeError(
			`Unsupported file type${declared ? ` "${declared}"` : ""}: only ${Object.keys(ALLOWED_UPLOAD_TYPES).join(", ")} files can be uploaded`
		);
	}

	if (!isCompatibleDeclaredType(declared, detected)) {
		throw new UnsupportedUploadTypeError(
			`File content does not match its declared type: declared "${declared}", detected "${detected}"`
		);
	}

	return detected;
}

/**
 * Make the filename's extension agree with the verified MIME type, so the
 * stored name cannot advertise a different (e.g. `.html`/`.svg`) format.
 */
export function ensureExtensionForMimeType(
	filename: string,
	mimeType: string
): string {
	const allowed = ALLOWED_UPLOAD_TYPES[mimeType];
	if (!allowed) {
		throw new UnsupportedUploadTypeError(`Unsupported file type "${mimeType}"`);
	}

	const basename = filename.split("/").pop() ?? filename;
	const extIndex = basename.lastIndexOf(".");
	const extension =
		extIndex > 0 ? basename.slice(extIndex + 1).toLowerCase() : "";
	if (allowed.extensions.includes(extension)) return filename;

	return `${filename}.${allowed.extensions[0]}`;
}
