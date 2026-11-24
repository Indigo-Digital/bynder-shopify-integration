import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server.js";

/**
 * Health check endpoint for Cloud Run
 */
export const loader = async (_args: LoaderFunctionArgs) => {
	try {
		// Check database connection
		await prisma.$queryRaw`SELECT 1`;
		return Response.json({
			status: "healthy",
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		// This route is public; database errors can carry connection details,
		// so they are only written to server logs.
		console.error("Health check database probe failed:", error);
		return Response.json(
			{
				status: "unhealthy",
				timestamp: new Date().toISOString(),
			},
			{ status: 503 }
		);
	}
};
