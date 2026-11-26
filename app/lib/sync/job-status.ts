import type { Prisma } from "@prisma/client";
import prisma from "../../db.server.js";

/**
 * Status transitions for sync jobs.
 *
 * Every transition is a single conditional write keyed on the job id AND the
 * status the caller expects the job to be in. A staff user can cancel a job at
 * any moment, so reading the status and then writing by id alone would let a
 * worker replace a cancellation that committed in between.
 */

export const CANCELLABLE_JOB_STATUSES = ["pending", "running"] as const;

/**
 * Moves a pending job to running.
 *
 * @returns false when the job was no longer pending (for example it was
 * cancelled, or another worker claimed it), in which case it must not be run.
 */
export async function claimPendingJob(jobId: string): Promise<boolean> {
	const { count } = await prisma.syncJob.updateMany({
		where: { id: jobId, status: "pending" },
		data: { status: "running", startedAt: new Date() },
	});
	return count > 0;
}

/**
 * Writes a terminal result (completed or failed) only while the job is still
 * running.
 *
 * @returns false when the job had already left the running state, such as
 * after a cancellation; its stored status is left untouched.
 */
export async function finishRunningJob(
	jobId: string,
	data: Prisma.SyncJobUpdateManyMutationInput
): Promise<boolean> {
	const { count } = await prisma.syncJob.updateMany({
		where: { id: jobId, status: "running" },
		data,
	});
	return count > 0;
}

/**
 * Cancels a job only while it belongs to the shop and is still pending or
 * running, so a job that has just finished keeps its result.
 *
 * @returns false when no such job was cancellable.
 */
export async function cancelActiveJob(
	jobId: string,
	shopId: string
): Promise<boolean> {
	const { count } = await prisma.syncJob.updateMany({
		where: {
			id: jobId,
			shopId,
			status: { in: [...CANCELLABLE_JOB_STATUSES] },
		},
		data: { status: "cancelled", completedAt: new Date() },
	});
	return count > 0;
}
