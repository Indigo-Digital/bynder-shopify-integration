import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import prisma from "../db.server.js";
import { getShopAlerts } from "../lib/alerts/checker.js";
import { getMetricsSummary } from "../lib/metrics/queries.js";
import { categorizeErrors } from "../lib/sync/error-categorization.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	if (!shopConfig) {
		return {
			shop,
			shopConfig: null,
			syncJobs: [],
			syncedAssets: [],
		};
	}

	const syncJobs = await prisma.syncJob.findMany({
		where: { shopId: shopConfig.id },
		orderBy: { createdAt: "desc" },
		take: 20,
	});

	const syncedAssetsCount = await prisma.syncedAsset.count({
		where: { shopId: shopConfig.id },
	});

	const metricsSummary = await getMetricsSummary(shopConfig.id, 10);
	const alerts = await getShopAlerts(shopConfig.id);

	return {
		shop,
		shopConfig,
		syncJobs,
		syncedAssetsCount,
		metricsSummary,
		alerts,
	};
};

export default function SyncDashboard() {
	const { shopConfig, syncJobs, syncedAssetsCount, metricsSummary, alerts } =
		useLoaderData<typeof loader>();
	const fetcher = useFetcher();
	const retryFetcher = useFetcher();
	const revalidator = useRevalidator();

	const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
	const [currentTime, setCurrentTime] = useState(new Date());
	const [retryingJobId, setRetryingJobId] = useState<string | null>(null);

	const handleSync = useCallback(() => {
		fetcher.submit({}, { method: "POST", action: "/api/sync" });
	}, [fetcher]);

	const handleImportAll = useCallback(() => {
		fetcher.submit(
			{},
			{ method: "POST", action: "/api/sync?forceImportAll=true" }
		);
	}, [fetcher]);

	const handleCancelJob = useCallback(
		(jobId: string) => {
			console.log("[UI] Cancelling job:", jobId);
			fetcher.submit({ jobId }, { method: "POST", action: "/api/sync/cancel" });
		},
		[fetcher]
	);

	const handleRetryFailedAssets = useCallback(
		(jobId: string, onlyTransient = false) => {
			setRetryingJobId(jobId);
			retryFetcher.submit(
				{ jobId, onlyTransient: onlyTransient.toString() },
				{ method: "POST", action: "/api/sync/retry" }
			);
		},
		[retryFetcher]
	);

	const toggleErrorExpanded = useCallback((jobId: string) => {
		setExpandedErrors((prev) => {
			const next = new Set(prev);
			if (next.has(jobId)) {
				next.delete(jobId);
			} else {
				next.add(jobId);
			}
			return next;
		});
	}, []);

	// Reload data when sync or cancel completes
	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data) {
			const timer = setTimeout(() => {
				revalidator.revalidate();
			}, 500);
			return () => clearTimeout(timer);
		}
	}, [fetcher.state, fetcher.data, revalidator]);

	// Reload data when retry completes
	useEffect(() => {
		if (retryFetcher.state === "idle" && retryFetcher.data) {
			setRetryingJobId(null);
			const timer = setTimeout(() => {
				revalidator.revalidate();
			}, 500);
			return () => clearTimeout(timer);
		}
	}, [retryFetcher.state, retryFetcher.data, revalidator]);

	const hasRunningJob = useMemo(
		() => syncJobs.some((job) => job.status === "running"),
		[syncJobs]
	);

	useEffect(() => {
		if (!hasRunningJob) return;
		const interval = setInterval(() => {
			revalidator.revalidate();
		}, 5000);
		return () => clearInterval(interval);
	}, [hasRunningJob, revalidator]);

	useEffect(() => {
		const timer = setInterval(() => {
			setCurrentTime(new Date());
		}, 1000);
		return () => clearInterval(timer);
	}, []);

	const showSuccess =
		fetcher.data && "success" in fetcher.data && fetcher.data.success;
	const showError = fetcher.data && "error" in fetcher.data;
	const syncResult =
		fetcher.data && "success" in fetcher.data ? fetcher.data : null;

	const runningJob = syncJobs.find((job) => job.status === "running");
	const isPolling = runningJob !== undefined;

	const formatElapsedTime = useCallback(
		(startedAt: Date | null): string => {
			if (!startedAt) return "";
			const elapsed = Math.floor(
				(currentTime.getTime() - new Date(startedAt).getTime()) / 1000
			);
			if (elapsed < 60) return `${elapsed}s`;
			const minutes = Math.floor(elapsed / 60);
			const seconds = elapsed % 60;
			return `${minutes}m ${seconds}s`;
		},
		[currentTime]
	);

	const getStatusTone = useCallback(
		(
			status: string
		): "success" | "critical" | "warning" | "info" | "neutral" => {
			switch (status) {
				case "completed":
					return "success";
				case "failed":
					return "critical";
				case "cancelled":
					return "neutral";
				case "running":
				case "pending":
					return "warning";
				default:
					return "neutral";
			}
		},
		[]
	);

	if (!shopConfig) {
		return (
			<s-page heading="Sync Dashboard">
				<s-section>
					<s-banner tone="warning">
						Please configure Bynder in{" "}
						<s-link href="/app/settings">Settings</s-link>.
					</s-banner>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="Sync Dashboard">
			<s-button
				slot="primary-action"
				variant="primary"
				onClick={handleSync}
				disabled={fetcher.state !== "idle"}
			>
				{fetcher.state !== "idle" ? "Syncing..." : "Sync Now"}
			</s-button>

			{/* Running Job Banner */}
			{isPolling && runningJob && (
				<s-banner tone="info">
					<s-stack direction="inline" gap="small" alignItems="center">
						<s-spinner size="base" />
						<s-text>
							<strong>Sync in progress...</strong>
						</s-text>
						{runningJob.startedAt && (
							<s-text>
								({formatElapsedTime(runningJob.startedAt)} elapsed)
							</s-text>
						)}
						{runningJob.assetsProcessed > 0 && (
							<s-text>
								- {runningJob.assetsProcessed} asset
								{runningJob.assetsProcessed !== 1 ? "s" : ""} processed
							</s-text>
						)}
						<s-text color="subdued">(Refreshing every 5 seconds...)</s-text>
					</s-stack>
				</s-banner>
			)}

			{/* Alerts */}
			{alerts &&
				alerts.length > 0 &&
				alerts.map((alert) => (
					<s-banner key={alert.message} tone={alert.severity}>
						{alert.message}
					</s-banner>
				))}

			{/* Success Banner */}
			{syncResult && showSuccess && (
				<s-banner
					tone={
						syncResult.errors !== undefined && syncResult.errors.length > 0
							? "warning"
							: "success"
					}
					dismissible
				>
					<s-stack direction="inline" gap="small">
						<s-text>Sync completed!</s-text>
						{syncResult.processed !== undefined && (
							<s-text>
								Found {syncResult.processed} asset
								{syncResult.processed !== 1 ? "s" : ""}.
							</s-text>
						)}
						{syncResult.created !== undefined && syncResult.created > 0 && (
							<s-text>
								{syncResult.created} new asset
								{syncResult.created !== 1 ? "s" : ""} imported.
							</s-text>
						)}
						{syncResult.updated !== undefined && syncResult.updated > 0 && (
							<s-text>
								{syncResult.updated} asset{syncResult.updated !== 1 ? "s" : ""}{" "}
								updated.
							</s-text>
						)}
						{syncResult.errors !== undefined &&
							syncResult.errors.length > 0 && (
								<s-text>
									{syncResult.errors.length} error
									{syncResult.errors.length !== 1 ? "s" : ""} occurred.
								</s-text>
							)}
					</s-stack>
				</s-banner>
			)}

			{/* Error Banner */}
			{showError && (
				<s-banner tone="critical" dismissible>
					{fetcher.formAction === "/api/sync/cancel"
						? "Cancel failed: "
						: "Sync failed: "}
					{typeof fetcher.data === "object" &&
					fetcher.data !== null &&
					"error" in fetcher.data
						? String(fetcher.data.error)
						: "Unknown error"}
				</s-banner>
			)}

			{/* Retry Notifications */}
			{retryFetcher.data &&
				"success" in retryFetcher.data &&
				retryFetcher.data.success && (
					<s-banner tone="success" dismissible>
						{retryFetcher.data.message ||
							`Retry completed: ${retryFetcher.data.successful || 0} successful, ${retryFetcher.data.failed || 0} failed`}
					</s-banner>
				)}
			{retryFetcher.data &&
				"error" in retryFetcher.data &&
				retryFetcher.data.error && (
					<s-banner tone="critical" dismissible>
						Retry failed:{" "}
						{typeof retryFetcher.data.error === "string"
							? retryFetcher.data.error
							: "Unknown error"}
					</s-banner>
				)}

			{/* Overview Section */}
			<s-section heading="Overview">
				<s-stack direction="block" gap="base">
					<s-grid
						gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
						gap="base"
					>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-stack direction="block" gap="small-200">
								<s-text color="subdued">Total Synced Assets</s-text>
								<s-heading>{syncedAssetsCount}</s-heading>
							</s-stack>
						</s-box>
						{metricsSummary && (
							<>
								<s-box padding="base" borderWidth="base" borderRadius="base">
									<s-stack direction="block" gap="small-200">
										<s-text color="subdued">Avg Sync Duration</s-text>
										<s-heading>
											{metricsSummary.averageSyncDuration > 0
												? `${metricsSummary.averageSyncDuration}s`
												: "N/A"}
										</s-heading>
									</s-stack>
								</s-box>
								<s-box padding="base" borderWidth="base" borderRadius="base">
									<s-stack direction="block" gap="small-200">
										<s-text color="subdued">Avg Throughput</s-text>
										<s-heading>
											{metricsSummary.averageThroughput > 0
												? `${metricsSummary.averageThroughput.toFixed(1)}/sec`
												: "N/A"}
										</s-heading>
									</s-stack>
								</s-box>
								<s-box padding="base" borderWidth="base" borderRadius="base">
									<s-stack direction="block" gap="small-200">
										<s-text color="subdued">API Calls</s-text>
										<s-heading>
											{metricsSummary.totalApiCalls > 0
												? metricsSummary.totalApiCalls.toLocaleString()
												: "N/A"}
										</s-heading>
									</s-stack>
								</s-box>
								{metricsSummary.rateLimitHits > 0 && (
									<s-box
										padding="base"
										borderWidth="base"
										borderRadius="base"
										background="subdued"
									>
										<s-stack direction="block" gap="small-200">
											<s-badge tone="critical">Rate Limit Hits</s-badge>
											<s-heading>{metricsSummary.rateLimitHits}</s-heading>
										</s-stack>
									</s-box>
								)}
							</>
						)}
					</s-grid>

					<s-stack direction="inline" gap="base">
						<s-button
							onClick={handleSync}
							disabled={fetcher.state !== "idle"}
							variant="primary"
						>
							{fetcher.state !== "idle" ? "Syncing..." : "Sync Now"}
						</s-button>
						<s-button
							onClick={handleImportAll}
							disabled={fetcher.state !== "idle"}
							variant="secondary"
						>
							{fetcher.state !== "idle"
								? "Importing..."
								: "Import All with Tags"}
						</s-button>
					</s-stack>

					<s-box padding="base" background="subdued" borderRadius="base">
						<s-stack direction="block" gap="small">
							<s-text>
								<strong>Sync Now:</strong>
							</s-text>
							<s-text color="subdued">
								Only imports assets that are new or have been updated since last
								sync.
							</s-text>
							<s-text>
								<strong>Import All with Tags:</strong>
							</s-text>
							<s-text color="subdued">
								Imports ALL assets with your configured tags, even if they
								already exist.
							</s-text>
						</s-stack>
					</s-box>
				</s-stack>
			</s-section>

			{/* Recent Sync Jobs */}
			<s-section heading="Recent Sync Jobs">
				{syncJobs.length === 0 ? (
					<s-box padding="large" background="subdued" borderRadius="base">
						<s-stack direction="block" gap="base" alignItems="center">
							<s-text>No sync jobs yet.</s-text>
							<s-button onClick={handleSync}>Start First Sync</s-button>
						</s-stack>
					</s-box>
				) : (
					<s-table>
						<s-table-header-row>
							<s-table-header listSlot="primary">Status</s-table-header>
							<s-table-header>Started</s-table-header>
							<s-table-header>Completed</s-table-header>
							<s-table-header format="numeric">Found</s-table-header>
							<s-table-header format="numeric">Created</s-table-header>
							<s-table-header format="numeric">Updated</s-table-header>
							<s-table-header listSlot="secondary">Errors</s-table-header>
							<s-table-header>Actions</s-table-header>
						</s-table-header-row>
						<s-table-body>
							{syncJobs.map((job: (typeof syncJobs)[number]) => {
								// Parse errors
								let errorList: Array<{ assetId: string; error: string }> = [];
								if (job.errors) {
									try {
										const parsed = JSON.parse(job.errors);
										if (Array.isArray(parsed)) {
											errorList = parsed;
										} else if (typeof parsed === "object" && parsed !== null) {
											errorList = Object.entries(parsed).map(
												([key, value]) => ({
													assetId: key,
													error: String(value),
												})
											);
										}
									} catch (_e) {
										// Ignore
									}
								}
								const hasErrors = errorList.length > 0 || job.error;
								const categorized = categorizeErrors(errorList);
								const errorCount = errorList.length || (job.error ? 1 : 0);
								const isExpanded = expandedErrors.has(job.id);

								return (
									<s-table-row key={job.id}>
										<s-table-cell>
											<s-stack
												direction="inline"
												gap="small"
												alignItems="center"
											>
												{job.status === "running" && <s-spinner size="base" />}
												<s-badge tone={getStatusTone(job.status)}>
													{job.status}
												</s-badge>
											</s-stack>
										</s-table-cell>
										<s-table-cell>
											<s-text>
												{job.startedAt
													? new Date(job.startedAt).toLocaleString()
													: "-"}
											</s-text>
										</s-table-cell>
										<s-table-cell>
											<s-text>
												{job.completedAt
													? new Date(job.completedAt).toLocaleString()
													: job.status === "running" && job.startedAt
														? `${formatElapsedTime(job.startedAt)} elapsed`
														: "-"}
											</s-text>
										</s-table-cell>
										<s-table-cell>
											<s-text>
												{job.assetsProcessed > 0 ? job.assetsProcessed : "-"}
											</s-text>
										</s-table-cell>
										<s-table-cell>
											{job.assetsCreated !== undefined &&
											job.assetsCreated > 0 ? (
												<s-badge tone="success">{job.assetsCreated}</s-badge>
											) : (
												<s-text color="subdued">-</s-text>
											)}
										</s-table-cell>
										<s-table-cell>
											{job.assetsUpdated !== undefined &&
											job.assetsUpdated > 0 ? (
												<s-badge tone="warning">{job.assetsUpdated}</s-badge>
											) : (
												<s-text color="subdued">-</s-text>
											)}
										</s-table-cell>
										<s-table-cell>
											{hasErrors ? (
												<s-stack direction="block" gap="small">
													<s-stack
														direction="inline"
														gap="small-200"
														alignItems="center"
													>
														<s-button
															variant="tertiary"
															onClick={() => toggleErrorExpanded(job.id)}
														>
															{errorCount} error{errorCount !== 1 ? "s" : ""}
															{isExpanded ? " ▼" : " ▶"}
														</s-button>
														{categorized.stats.transient > 0 && (
															<s-badge tone="warning">
																{categorized.stats.transient} Transient
															</s-badge>
														)}
														{categorized.stats.permanent > 0 && (
															<s-badge tone="critical">
																{categorized.stats.permanent} Permanent
															</s-badge>
														)}
													</s-stack>
													{isExpanded && (
														<s-box
															padding="small"
															background="subdued"
															borderRadius="small"
														>
															<s-stack direction="block" gap="small-200">
																{errorList.length > 0 ? (
																	errorList.map((err) => {
																		const errCat = categorizeErrors([err]);
																		return (
																			<s-stack
																				key={err.assetId}
																				direction="inline"
																				gap="small-200"
																				alignItems="start"
																			>
																				<s-text>
																					<strong>{err.assetId}:</strong>
																				</s-text>
																				<s-text>{err.error}</s-text>
																				{errCat.transient.length > 0 && (
																					<s-badge tone="warning" size="base">
																						Transient
																					</s-badge>
																				)}
																			</s-stack>
																		);
																	})
																) : job.error ? (
																	<s-text>{job.error}</s-text>
																) : job.errors ? (
																	<s-text>{job.errors}</s-text>
																) : null}
															</s-stack>
														</s-box>
													)}
												</s-stack>
											) : (
												<s-text color="subdued">-</s-text>
											)}
										</s-table-cell>
										<s-table-cell>
											<s-stack direction="block" gap="small-200">
												{job.status === "running" ||
												job.status === "pending" ? (
													<s-button
														variant="secondary"
														tone="critical"
														onClick={() => handleCancelJob(job.id)}
														disabled={fetcher.state !== "idle"}
													>
														Cancel
													</s-button>
												) : hasErrors &&
													(job.status === "completed" ||
														job.status === "failed") ? (
													<>
														<s-button
															variant="secondary"
															onClick={() =>
																handleRetryFailedAssets(job.id, false)
															}
															disabled={
																retryFetcher.state !== "idle" ||
																retryingJobId === job.id
															}
														>
															{retryingJobId === job.id
																? "Retrying..."
																: "Retry All"}
														</s-button>
														{categorized.stats.transient > 0 && (
															<s-button
																variant="tertiary"
																onClick={() =>
																	handleRetryFailedAssets(job.id, true)
																}
																disabled={
																	retryFetcher.state !== "idle" ||
																	retryingJobId === job.id
																}
															>
																Retry Transient
															</s-button>
														)}
													</>
												) : (
													<s-text color="subdued">-</s-text>
												)}
											</s-stack>
										</s-table-cell>
									</s-table-row>
								);
							})}
						</s-table-body>
					</s-table>
				)}

				{syncJobs.some(
					(job) => job.status === "completed" && job.assetsProcessed > 0
				) && (
					<s-box padding="base" background="subdued" borderRadius="base">
						<s-text color="subdued">
							<strong>Note:</strong> "Assets Found" shows how many assets were
							discovered with your configured tags. Assets are only imported if
							they're new or have been updated in Bynder. Check the{" "}
							<s-link href="/app/files">Synced Assets</s-link> page to see which
							assets were actually imported.
						</s-text>
					</s-box>
				)}
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
