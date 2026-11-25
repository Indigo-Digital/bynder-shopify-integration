export class BodyTooLargeError extends Error {
	constructor(readonly limitBytes: number) {
		super(`Request body exceeds ${limitBytes} bytes`);
		this.name = "BodyTooLargeError";
	}
}

/**
 * Reads a request body into memory, stopping as soon as it passes
 * `limitBytes`. Content-Length is only used to refuse early; the streamed
 * byte count is what is enforced, since the header may be absent or wrong.
 *
 * @throws {BodyTooLargeError} When the body is larger than `limitBytes`
 */
export async function readLimitedBody(
	request: Request,
	limitBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
		throw new BodyTooLargeError(limitBytes);
	}
	if (!request.body) {
		return new Uint8Array();
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		received += value.byteLength;
		if (received > limitBytes) {
			await reader.cancel();
			throw new BodyTooLargeError(limitBytes);
		}
		chunks.push(value);
	}

	const body = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
