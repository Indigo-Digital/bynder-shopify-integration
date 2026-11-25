import prisma from "../../db.server.js";

export const FULL_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;

const ACTIVE_JOB_STATUSES = ["pending", "running"];

export type EnqueueFullSyncResult =
	| { outcome: "queued"; jobId: string }
	| { outcome: "active"; jobId: string }
	| { outcome: "throttled"; retryAfterSeconds: number };

let enqueueTail: Promise<unknown> = Promise.resolve();

/**
 * SQLite deadlocks (until its busy timeout) when several deferred write
 * transactions overlap, so this process runs enqueue transactions one at a
 * time. The row lock in enqueueFullSync is what keeps other processes out.
 */
function runSerially<T>(task: () => Promise<T>): Promise<T> {
	const run = enqueueTail.then(task, task);
	enqueueTail = run.catch(() => undefined);
	return run;
}

/**
 * Queues a background full sync for a shop, at most one active job per shop
 * and at most one new job per FULL_SYNC_MIN_INTERVAL_MS.
 *
 * The shop row is written first so the transaction holds its lock (a row lock
 * on PostgreSQL, the write lock on SQLite) while the existing jobs are read and
 * the new job is inserted. Concurrent requests for the same shop therefore
 * wait and then see the job the first one committed.
 */
export function enqueueFullSync(
	shopId: string
): Promise<EnqueueFullSyncResult> {
	return runSerially(() => insertFullSyncJob(shopId));
}

function insertFullSyncJob(shopId: string): Promise<EnqueueFullSyncResult> {
	return prisma.$transaction(
		async (tx): Promise<EnqueueFullSyncResult> => {
			await tx.shop.update({
				where: { id: shopId },
				data: { updatedAt: new Date() },
			});

			const activeJob = await tx.syncJob.findFirst({
				where: { shopId, status: { in: ACTIVE_JOB_STATUSES } },
				select: { id: true },
			});
			if (activeJob) {
				return { outcome: "active", jobId: activeJob.id };
			}

			const latestJob = await tx.syncJob.findFirst({
				where: { shopId },
				orderBy: { createdAt: "desc" },
				select: { createdAt: true },
			});
			const elapsedMs = latestJob
				? Date.now() - latestJob.createdAt.getTime()
				: Number.POSITIVE_INFINITY;
			if (elapsedMs < FULL_SYNC_MIN_INTERVAL_MS) {
				return {
					outcome: "throttled",
					retryAfterSeconds: Math.ceil(
						(FULL_SYNC_MIN_INTERVAL_MS - elapsedMs) / 1000
					),
				};
			}

			const job = await tx.syncJob.create({
				data: { shopId, status: "pending", assetsProcessed: 0 },
				select: { id: true },
			});
			return { outcome: "queued", jobId: job.id };
		},
		{ maxWait: 10_000, timeout: 10_000 }
	);
}
