import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
	bufferRequest,
	MAX_REQUEST_BODY_BYTES,
	rejectOversizedBody,
} from "../lib/http/body-limits.js";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
	const { payload, session, topic, shop } = await authenticate.webhook(
		await bufferRequest(request, MAX_REQUEST_BODY_BYTES).catch(
			rejectOversizedBody
		)
	);
	console.log(`Received ${topic} webhook for ${shop}`);

	const current = payload.current as string[];
	if (session) {
		await db.session.update({
			where: {
				id: session.id,
			},
			data: {
				scope: current.toString(),
			},
		});
	}
	return new Response();
};
