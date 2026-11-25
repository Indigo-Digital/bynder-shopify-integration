/**
 * Byte ceilings for every HTTP body the app buffers in memory.
 *
 * The app and the sync worker run on a single 2048 MB Fly machine that serves
 * every installed shop (fly.toml), so no single response or request may be
 * allowed to grow without a hard stop.
 */

/** Largest asset the app will download from Bynder or accept through bulk upload. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** Largest JSON response accepted from the Bynder API (one media page or asset). */
export const MAX_BYNDER_JSON_BYTES = 4 * 1024 * 1024;

/** Largest form, JSON or webhook request body accepted by non-upload routes. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Room for multipart boundaries and the small text fields sent next to an upload. */
export const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

type BodyKind = "download" | "upload";

export class BodyTooLargeError extends Error {
	readonly maxBytes: number;

	constructor(kind: BodyKind, maxBytes: number) {
		const subject = kind === "download" ? "Download" : "Upload";
		super(`${subject} exceeds the maximum ${kind} size of ${maxBytes} bytes`);
		this.name = "BodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

function declaredLength(headers: Headers): number | null {
	const value = headers.get("content-length");
	if (value === null) {
		return null;
	}
	const length = Number(value);
	return Number.isFinite(length) ? length : null;
}

function discard(body: ReadableStream<Uint8Array> | null): void {
	body?.cancel().catch(() => {});
}

/**
 * Reads a body stream into memory, refusing it as soon as the declared length
 * or the bytes actually received pass `maxBytes`. The stream is cancelled on
 * refusal so the connection is released instead of being drained.
 */
async function readStreamWithLimit(
	body: ReadableStream<Uint8Array> | null,
	headers: Headers,
	kind: BodyKind,
	maxBytes: number
): Promise<Buffer> {
	const length = declaredLength(headers);
	if (length !== null && length > maxBytes) {
		discard(body);
		throw new BodyTooLargeError(kind, maxBytes);
	}
	if (!body) {
		return Buffer.alloc(0);
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		received += value.byteLength;
		if (received > maxBytes) {
			reader.cancel().catch(() => {});
			throw new BodyTooLargeError(kind, maxBytes);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, received);
}

/** Reads a fetch response body, throwing BodyTooLargeError past `maxBytes`. */
export function readResponseBody(
	response: Response,
	maxBytes: number
): Promise<Buffer> {
	return readStreamWithLimit(
		response.body,
		response.headers,
		"download",
		maxBytes
	);
}

/** Reads an incoming request body, throwing BodyTooLargeError past `maxBytes`. */
export function readRequestBody(
	request: Request,
	maxBytes: number
): Promise<Buffer> {
	return readStreamWithLimit(request.body, request.headers, "upload", maxBytes);
}

export async function readRequestText(
	request: Request,
	maxBytes: number
): Promise<string> {
	return (await readRequestBody(request, maxBytes)).toString("utf8");
}

/**
 * Parses a multipart or urlencoded request body after reading at most
 * `maxBytes`, so request.formData() never buffers an unbounded upload.
 */
export async function readRequestFormData(
	request: Request,
	maxBytes: number
): Promise<FormData> {
	const body = await readRequestBody(request, maxBytes);
	const contentType = request.headers.get("content-type") ?? "";
	return new Response(new Uint8Array(body), {
		headers: { "content-type": contentType },
	}).formData();
}

/**
 * Returns a copy of `request` whose body has already been read with a cap,
 * for handlers (such as library webhook validators) that read the body
 * themselves.
 */
export async function bufferRequest(
	request: Request,
	maxBytes: number
): Promise<Request> {
	const body = await readRequestBody(request, maxBytes);
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.delete("transfer-encoding");
	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	return new Request(request.url, {
		method: request.method,
		headers,
		body: hasBody ? new Uint8Array(body) : null,
	});
}

/** Rethrows a BodyTooLargeError as a 413 response for route error handling. */
export function rejectOversizedBody(error: unknown): never {
	if (error instanceof BodyTooLargeError) {
		throw Response.json({ error: error.message }, { status: 413 });
	}
	throw error;
}
