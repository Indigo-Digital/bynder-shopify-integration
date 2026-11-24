// @vitest-environment node
/**
 * Spec for the bulk-upload memory cap.
 *
 * The action must reject an authenticated staff upload before request.formData()
 * reads the whole body. A file at or under the ceiling still uploads.
 *
 * Required failure: status 413 and an error containing
 * "maximum upload size of <MAX_ASSET_BYTES> bytes".
 *
 * authenticate.admin does not read the body (it checks the session token and
 * headers), so the test stubs that step and streams the body into the action
 * the same way @mjackson/node-fetch-server does: a Web Request whose body
 * stays unread until the action pulls it.
 */
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const PAUSE_AFTER_BYTES = MAX_ASSET_BYTES + 64 * 1024;
const DECLARED_OVERSIZE_BYTES = MAX_ASSET_BYTES + 32 * 1024 * 1024;
const SIZE_LIMIT_WAIT_MS = 3000;
const BOUNDARY = "----upload-limit-boundary";

const uploadBufferToShopify = vi.fn(async (..._args: unknown[]) => ({
	fileId: "gid://shopify/MediaImage/1",
	fileUrl: "https://cdn.example/photo.jpg",
}));

vi.mock("../../shopify.server.js", () => ({
	authenticate: {
		admin: vi.fn(async () => ({
			admin: { graphql: vi.fn() },
			session: { shop: "staff-shop.myshopify.com" },
		})),
	},
}));

vi.mock("../../lib/shopify/files.js", () => ({
	uploadBufferToShopify: (...args: unknown[]) => uploadBufferToShopify(...args),
}));

vi.mock("../../lib/shopify/metafields.js", () => ({
	setFileTags: vi.fn(),
}));

vi.mock("../../lib/ai/gemini-vision.js", () => ({
	generateAltText: vi.fn(),
}));

import { action } from "../app.upload.js";

interface DataResult {
	data: { error?: string; success?: boolean };
	init: { status?: number } | null;
}

function isDataResult(value: unknown): value is DataResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		"init" in value
	);
}

function multipartPrefix(): Buffer {
	return Buffer.from(
		`--${BOUNDARY}\r\n` +
			'Content-Disposition: form-data; name="folder"\r\n\r\n\r\n' +
			`--${BOUNDARY}\r\n` +
			'Content-Disposition: form-data; name="tags"\r\n\r\n\r\n' +
			`--${BOUNDARY}\r\n` +
			'Content-Disposition: form-data; name="useAiAltText"\r\n\r\nfalse\r\n' +
			`--${BOUNDARY}\r\n` +
			'Content-Disposition: form-data; name="file"; filename="photo.jpg"\r\n' +
			"Content-Type: image/jpeg\r\n\r\n"
	);
}

function multipartSuffix(): Buffer {
	return Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
}

function buildMultipart(fileBytes: Buffer): Buffer {
	return Buffer.concat([multipartPrefix(), fileBytes, multipartSuffix()]);
}

/**
 * Body that yields `pauseAfter` bytes and then never ends, so formData()
 * cannot finish unless the action stops reading.
 */
function pausedBody(pauseAfter: number): {
	stream: ReadableStream<Uint8Array>;
	readBytes: () => number;
} {
	let sent = 0;
	const prefix = multipartPrefix();
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (sent >= pauseAfter) {
				await new Promise<void>(() => {});
				return;
			}
			const source =
				sent < prefix.length ? prefix : Buffer.alloc(16 * 1024, 0x61);
			const offset = sent < prefix.length ? sent : 0;
			const n = Math.min(16 * 1024, pauseAfter - sent, source.length - offset);
			controller.enqueue(source.subarray(offset, offset + n));
			sent += n;
		},
	});
	return { stream, readBytes: () => sent };
}

function requestFor(
	body: Uint8Array | ReadableStream<Uint8Array>,
	contentLength?: number
): Request {
	const headers: Record<string, string> = {
		"content-type": `multipart/form-data; boundary=${BOUNDARY}`,
	};
	if (contentLength !== undefined) {
		headers["content-length"] = String(contentLength);
	}
	return new Request("https://app.example/app/upload", {
		method: "POST",
		headers,
		body,
		duplex: "half",
	} as RequestInit);
}

async function runAction(
	request: Request
): Promise<
	| { kind: "result"; result: unknown }
	| { kind: "rejected"; error: unknown }
	| { kind: "pending" }
> {
	const pending = Promise.resolve(
		action({ request } as unknown as ActionFunctionArgs)
	).then(
		(result) => ({ kind: "result" as const, result }),
		(error: unknown) => ({ kind: "rejected" as const, error })
	);
	return Promise.race([
		pending,
		new Promise<{ kind: "pending" }>((resolve) => {
			setTimeout(() => resolve({ kind: "pending" }), SIZE_LIMIT_WAIT_MS);
		}),
	]);
}

function expectUploadRejected(
	outcome: Awaited<ReturnType<typeof runAction>>
): void {
	expect(outcome.kind, "the upload kept reading the request body").not.toBe(
		"pending"
	);
	if (outcome.kind === "pending") {
		return;
	}
	const result = outcome.kind === "result" ? outcome.result : undefined;
	expect(isDataResult(result)).toBe(true);
	if (!isDataResult(result)) {
		return;
	}
	expect(result.init?.status).toBe(413);
	expect(result.data.error).toContain(
		`maximum upload size of ${MAX_ASSET_BYTES} bytes`
	);
	expect(uploadBufferToShopify).not.toHaveBeenCalled();
}

describe("bulk upload size cap", () => {
	beforeEach(() => {
		uploadBufferToShopify.mockClear();
	});

	it("uploads a file that is under the maximum size", async () => {
		const file = Buffer.alloc(1024, 0x22);
		file[0] = 0xff;
		file[1] = 0xd8;
		file[2] = 0xff;
		const body = buildMultipart(file);
		const request = requestFor(new Uint8Array(body), body.length);
		const outcome = await runAction(request);
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !isDataResult(outcome.result)) {
			throw new Error("expected a data result");
		}
		expect(outcome.result.data.success).toBe(true);
		expect(uploadBufferToShopify).toHaveBeenCalledTimes(1);
		const uploaded = uploadBufferToShopify.mock.calls[0]?.[1];
		expect(Buffer.isBuffer(uploaded)).toBe(true);
		if (Buffer.isBuffer(uploaded)) {
			expect(uploaded.length).toBe(file.length);
		}
	});

	it("stops a chunked upload once the body exceeds the cap", async () => {
		const { stream } = pausedBody(PAUSE_AFTER_BYTES);
		const request = requestFor(stream);
		const outcome = await runAction(request);
		expectUploadRejected(outcome);
	});

	it("stops an upload whose Content-Length is above the cap", async () => {
		const { stream } = pausedBody(PAUSE_AFTER_BYTES);
		const request = requestFor(stream, DECLARED_OVERSIZE_BYTES);
		const outcome = await runAction(request);
		expectUploadRejected(outcome);
	});
});
