import prisma from "../../db.server.js";

/** Statuses that occupy the shared worker queue for a shop. */
export const ACTIVE_SYNC_JOB_STATUSES = ["pending", "running"] as const;

/**
 * Cancel every other pending full-sync job for the shop that owns `jobId`.
 *
 * Full-sync jobs carry no parameters, so the job being started already covers
 * the work of any duplicates queued concurrently past the API's
 * one-active-job check. A single atomic update keeps those duplicates from
 * each running a full scan on the shared worker.
 *
 * @returns Number of jobs that were cancelled
 */
export async function supersedePendingSyncJobs(job: {
	id: string;
	shopId: string;
}): Promise<number> {
	const result = await prisma.syncJob.updateMany({
		where: {
			shopId: job.shopId,
			status: "pending",
			id: { not: job.id },
		},
		data: {
			status: "cancelled",
			completedAt: new Date(),
			error: `Superseded by sync job ${job.id}`,
		},
	});
	return result.count;
}
