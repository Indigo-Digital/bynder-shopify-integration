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
		return Response.json(
			{
				status: "unhealthy",
				error: error instanceof Error ? error.message : "Unknown error",
				timestamp: new Date().toISOString(),
			},
			{ status: 503 }
		);
	}
};
