import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import {
	BodyTooLargeError,
	readLimitedBody,
} from "../lib/http/read-limited-body.js";
import {
	RetryRequestError,
	retryFailedAssets,
} from "../lib/sync/retry-failed-assets.js";
import { authenticate } from "../shopify.server.js";

const MAX_RETRY_BODY_BYTES = 16 * 1024;

interface RetryRequestBody {
	jobId?: string;
	assetIds?: string[];
	onlyTransient?: boolean;
}

function toRetryRequestBody(raw: {
	jobId?: unknown;
	assetIds?: unknown;
	onlyTransient?: unknown;
}): RetryRequestBody {
	const { jobId, assetIds, onlyTransient } = raw;
	if (jobId !== undefined && typeof jobId !== "string") {
		throw new TypeError("jobId must be a string");
	}
	if (
		assetIds !== undefined &&
		!(
			Array.isArray(assetIds) &&
			assetIds.every((id) => typeof id === "string" && id.length > 0)
		)
	) {
		throw new TypeError("assetIds must be an array of non-empty strings");
	}
	return {
		...(jobId && { jobId }),
		...(assetIds && { assetIds }),
		onlyTransient: onlyTransient === true,
	};
}

/**
 * @throws {BodyTooLargeError} Before parsing, when the body exceeds MAX_RETRY_BODY_BYTES
 */
async function parseRetryBody(request: Request): Promise<RetryRequestBody> {
	const contentType = request.headers.get("content-type") ?? "";
	const bytes = await readLimitedBody(request, MAX_RETRY_BODY_BYTES);

	if (contentType.includes("application/json")) {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof parsed !== "object" || parsed === null) {
			throw new TypeError("Body must be a JSON object");
		}
		return toRetryRequestBody(parsed);
	}

	const formData = await new Response(bytes, {
		headers: { "content-type": contentType },
	}).formData();
	const assetIdsValue = formData.get("assetIds")?.toString();
	return toRetryRequestBody({
		jobId: formData.get("jobId")?.toString() || undefined,
		assetIds: assetIdsValue ? JSON.parse(assetIdsValue) : undefined,
		onlyTransient: formData.get("onlyTransient") === "true",
	});
}

/**
 * Retry failed assets endpoint
 * POST /api/sync/retry
 * Body: { jobId?: string, assetIds?: string[], onlyTransient?: boolean }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	try {
		const { session, admin } = await authenticate.admin(request);
		const shop = session.shop;

		// Get shop configuration
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return Response.json(
				{ error: "Bynder not configured for this shop" },
				{ status: 400 }
			);
		}

		let body: RetryRequestBody;
		try {
			body = await parseRetryBody(request);
		} catch (error) {
			if (error instanceof BodyTooLargeError) {
				return Response.json({ error: error.message }, { status: 413 });
			}
			return Response.json({ error: "Invalid request body" }, { status: 400 });
		}

		if (!body.jobId && (!body.assetIds || body.assetIds.length === 0)) {
			return Response.json(
				{ error: "Either jobId or assetIds must be provided" },
				{ status: 400 }
			);
		}

		// Initialize Bynder client
		let bynderClient: BynderClient;
		try {
			bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Bynder configuration error",
				},
				{ status: 500 }
			);
		}

		// Retry failed assets
		const retryOptions: {
			shopId: string;
			admin: typeof admin;
			bynderClient: typeof bynderClient;
			jobId?: string;
			assetIds?: string[];
			onlyTransient?: boolean;
		} = {
			shopId: shopConfig.id,
			admin,
			bynderClient,
			onlyTransient: body.onlyTransient || false,
		};

		if (body.jobId) {
			retryOptions.jobId = body.jobId;
		}
		if (body.assetIds) {
			retryOptions.assetIds = body.assetIds;
		}

		const result = await retryFailedAssets(retryOptions);

		return Response.json({
			success: true,
			processed: result.processed,
			successful: result.successful,
			failed: result.failed,
			skipped: result.skipped,
			errors: result.errors,
			message: `Retry completed: ${result.successful} successful, ${result.failed} failed, ${result.skipped} skipped`,
		});
	} catch (error) {
		if (error instanceof RetryRequestError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		console.error("Retry error:", error);
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Retry failed",
			},
			{ status: 500 }
		);
	}
};
