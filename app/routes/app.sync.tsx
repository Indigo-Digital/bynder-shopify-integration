import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import prisma from "../db.server.js";
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

	// Get recent sync jobs
	const syncJobs = await prisma.syncJob.findMany({
		where: { shopId: shopConfig.id },
		orderBy: { createdAt: "desc" },
		take: 20,
	});

	// Get synced assets count
	const syncedAssetsCount = await prisma.syncedAsset.count({
		where: { shopId: shopConfig.id },
	});

	return {
		shop,
		shopConfig,
		syncJobs,
		syncedAssetsCount,
	};
};

export default function SyncDashboard() {
	const { shopConfig, syncJobs, syncedAssetsCount } =
		useLoaderData<typeof loader>();
	const fetcher = useFetcher();
	const revalidator = useRevalidator();

	const handleSync = () => {
		fetcher.submit({}, { method: "POST", action: "/api/sync" });
	};

	const handleImportAll = () => {
		fetcher.submit(
			{},
			{ method: "POST", action: "/api/sync?forceImportAll=true" }
		);
	};

	const handleCancelJob = (jobId: string) => {
		fetcher.submit({ jobId }, { method: "POST", action: "/api/sync/cancel" });
	};

	// Reload data when sync or cancel completes
	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data) {
			// Wait a bit for the job to be saved, then reload
			const timer = setTimeout(() => {
				revalidator.revalidate();
			}, 500);
			return () => clearTimeout(timer);
		}
	}, [fetcher.state, fetcher.data, revalidator]);

	// Poll for running sync jobs - only when there's a running job
	useEffect(() => {
		const hasRunningJob = syncJobs.some((job) => job.status === "running");
		if (!hasRunningJob) {
			return; // No running jobs, don't poll
		}

		// Poll every 5 seconds when there's a running job
		const interval = setInterval(() => {
			revalidator.revalidate();
		}, 5000);

		return () => clearInterval(interval);
	}, [syncJobs, revalidator]);

	const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
	const [currentTime, setCurrentTime] = useState(new Date());

	// Update current time every second for elapsed time calculation
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

	// Find running sync job
	const runningJob = syncJobs.find((job) => job.status === "running");
	const isPolling = runningJob !== undefined;

	// Calculate elapsed time helper
	const formatElapsedTime = (startedAt: Date | null): string => {
		if (!startedAt) return "";
		const elapsed = Math.floor(
			(currentTime.getTime() - new Date(startedAt).getTime()) / 1000
		);
		if (elapsed < 60) return `${elapsed}s`;
		const minutes = Math.floor(elapsed / 60);
		const seconds = elapsed % 60;
		return `${minutes}m ${seconds}s`;
	};

	if (!shopConfig) {
		return (
			<s-page heading="Sync Dashboard">
				<s-section>
					<s-paragraph>
						Please configure Bynder in{" "}
						<s-link href="/app/settings">Settings</s-link>.
					</s-paragraph>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="Sync Dashboard">
			{isPolling && runningJob && (
				<s-banner tone="info">
					<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<span
							style={{
								display: "inline-block",
								width: "16px",
								height: "16px",
								border: "2px solid #0066cc",
								borderTopColor: "transparent",
								borderRadius: "50%",
								animation: "spin 1s linear infinite",
							}}
						/>
						<strong>Sync in progress...</strong>
						{runningJob.startedAt && (
							<span style={{ marginLeft: "0.5rem" }}>
								({formatElapsedTime(runningJob.startedAt)} elapsed)
							</span>
						)}
						{runningJob.assetsProcessed > 0 && (
							<span style={{ marginLeft: "0.5rem" }}>
								- {runningJob.assetsProcessed} asset
								{runningJob.assetsProcessed !== 1 ? "s" : ""} processed
							</span>
						)}
						<span
							style={{
								marginLeft: "0.5rem",
								fontSize: "0.875rem",
								opacity: 0.8,
							}}
						>
							(Refreshing every 5 seconds...)
						</span>
					</div>
					<style>
						{`
							@keyframes spin {
								to { transform: rotate(360deg); }
							}
						`}
					</style>
				</s-banner>
			)}
			{syncResult && showSuccess && (
				<s-banner
					tone={
						syncResult.errors !== undefined && syncResult.errors.length > 0
							? "warning"
							: "success"
					}
				>
					Sync completed!{" "}
					{syncResult.processed !== undefined && (
						<>
							Found {syncResult.processed} asset
							{syncResult.processed !== 1 ? "s" : ""}.{" "}
						</>
					)}
					{syncResult.created !== undefined && syncResult.created > 0 && (
						<>
							{syncResult.created} new asset
							{syncResult.created !== 1 ? "s" : ""} imported.{" "}
						</>
					)}
					{syncResult.updated !== undefined && syncResult.updated > 0 && (
						<>
							{syncResult.updated} asset{syncResult.updated !== 1 ? "s" : ""}{" "}
							updated.{" "}
						</>
					)}
					{syncResult.errors !== undefined && syncResult.errors.length > 0 && (
						<>
							{syncResult.errors.length} error
							{syncResult.errors.length !== 1 ? "s" : ""} occurred. Click on the
							job in the table below to see details.
						</>
					)}
				</s-banner>
			)}

			{showError && (
				<s-banner tone="critical">
					Sync failed:{" "}
					{typeof fetcher.data === "object" &&
					fetcher.data !== null &&
					"error" in fetcher.data
						? String(fetcher.data.error)
						: "Unknown error"}
				</s-banner>
			)}

			<s-button
				slot="primary-action"
				variant="primary"
				onClick={handleSync}
				disabled={fetcher.state !== "idle"}
			>
				{fetcher.state !== "idle" ? "Syncing..." : "Sync Now"}
			</s-button>

			<s-section heading="Overview">
				<s-stack direction="inline" gap="base">
					<s-box padding="base" borderWidth="base" borderRadius="base">
						<s-text>Total Synced Assets</s-text>
						<s-heading>{syncedAssetsCount}</s-heading>
					</s-box>
				</s-stack>
				<div style={{ marginTop: "1rem" }}>
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
				</div>
				<div style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#666" }}>
					<s-paragraph>
						<strong>Sync Now:</strong> Only imports assets that are new or have
						been updated since last sync.
					</s-paragraph>
					<s-paragraph>
						<strong>Import All with Tags:</strong> Imports ALL assets with your
						configured tags, even if they already exist. Use this to import
						existing assets for the first time.
					</s-paragraph>
				</div>
			</s-section>

			<s-section heading="Recent Sync Jobs">
				{syncJobs.length === 0 ? (
					<s-paragraph>
						No sync jobs yet. Click "Sync Now" to start.
					</s-paragraph>
				) : (
					<div style={{ overflowX: "auto" }}>
						<table
							style={{
								width: "100%",
								borderCollapse: "collapse",
								fontSize: "0.875rem",
							}}
						>
							<thead>
								<tr
									style={{
										backgroundColor: "#f5f5f5",
										borderBottom: "2px solid #ddd",
									}}
								>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "left",
											fontWeight: "600",
										}}
									>
										Status
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "left",
											fontWeight: "600",
										}}
									>
										Started
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "left",
											fontWeight: "600",
										}}
									>
										Completed
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "right",
											fontWeight: "600",
										}}
									>
										Found
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "right",
											fontWeight: "600",
										}}
									>
										Created
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "right",
											fontWeight: "600",
										}}
									>
										Updated
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "left",
											fontWeight: "600",
										}}
									>
										Errors
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "center",
											fontWeight: "600",
										}}
									>
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								{syncJobs.map(
									(job: (typeof syncJobs)[number], index: number) => (
										<tr
											key={job.id}
											style={{
												borderBottom: "1px solid #eee",
												backgroundColor: index % 2 === 0 ? "#fff" : "#fafafa",
											}}
										>
											<td style={{ padding: "0.75rem" }}>
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: "0.5rem",
													}}
												>
													{job.status === "running" && (
														<span
															style={{
																display: "inline-block",
																width: "12px",
																height: "12px",
																border: "2px solid #856404",
																borderTopColor: "transparent",
																borderRadius: "50%",
																animation: "spin 1s linear infinite",
															}}
														/>
													)}
													<span
														style={{
															padding: "0.25rem 0.5rem",
															borderRadius: "4px",
															fontSize: "0.75rem",
															fontWeight: "600",
															textTransform: "uppercase",
															backgroundColor:
																job.status === "completed"
																	? "#d4edda"
																	: job.status === "failed"
																		? "#f8d7da"
																		: job.status === "cancelled"
																			? "#e2e3e5"
																			: "#fff3cd",
															color:
																job.status === "completed"
																	? "#155724"
																	: job.status === "failed"
																		? "#721c24"
																		: job.status === "cancelled"
																			? "#383d41"
																			: "#856404",
														}}
													>
														{job.status}
													</span>
												</div>
											</td>
											<td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
												{job.startedAt
													? new Date(job.startedAt).toLocaleString()
													: "-"}
											</td>
											<td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
												{job.completedAt ? (
													new Date(job.completedAt).toLocaleString()
												) : job.status === "running" ? (
													<div>
														<div>In progress...</div>
														{job.startedAt && (
															<div
																style={{
																	fontSize: "0.75rem",
																	color: "#666",
																	marginTop: "0.25rem",
																}}
															>
																{formatElapsedTime(job.startedAt)} elapsed
															</div>
														)}
													</div>
												) : (
													"-"
												)}
											</td>
											<td style={{ padding: "0.75rem", textAlign: "right" }}>
												{job.assetsProcessed > 0 ? (
													<div>
														<strong>{job.assetsProcessed}</strong>
														{job.status === "running" && (
															<div
																style={{
																	fontSize: "0.75rem",
																	color: "#666",
																	marginTop: "0.25rem",
																}}
															>
																processing...
															</div>
														)}
													</div>
												) : job.status === "running" ? (
													<span style={{ color: "#999", fontStyle: "italic" }}>
														Starting...
													</span>
												) : (
													"-"
												)}
											</td>
											<td style={{ padding: "0.75rem", textAlign: "right" }}>
												{job.assetsCreated !== undefined &&
												job.assetsCreated > 0 ? (
													<span style={{ color: "#155724", fontWeight: "600" }}>
														{job.assetsCreated}
													</span>
												) : (
													<span style={{ color: "#999" }}>-</span>
												)}
											</td>
											<td style={{ padding: "0.75rem", textAlign: "right" }}>
												{job.assetsUpdated !== undefined &&
												job.assetsUpdated > 0 ? (
													<span style={{ color: "#856404", fontWeight: "600" }}>
														{job.assetsUpdated}
													</span>
												) : (
													<span style={{ color: "#999" }}>-</span>
												)}
											</td>
											<td style={{ padding: "0.75rem", maxWidth: "400px" }}>
												{(() => {
													// Parse errors from JSON or use error field
													let errorList: Array<{
														assetId: string;
														error: string;
													}> = [];
													if (job.errors) {
														try {
															const parsed = JSON.parse(job.errors);
															// Handle both array and object formats
															if (Array.isArray(parsed)) {
																errorList = parsed;
															} else if (
																typeof parsed === "object" &&
																parsed !== null
															) {
																// If it's an object, try to extract errors
																errorList = Object.entries(parsed).map(
																	([key, value]) => ({
																		assetId: key,
																		error: String(value),
																	})
																);
															}
														} catch (e) {
															// If parsing fails, log and try to use as string
															console.warn(
																`Failed to parse errors for job ${job.id}:`,
																e,
																"Raw errors:",
																job.errors
															);
														}
													}
													const hasErrors = errorList.length > 0 || job.error;

													if (!hasErrors) {
														return <span style={{ color: "#999" }}>-</span>;
													}

													// Calculate error count - prefer JSON errors, fallback to error field
													const errorCount =
														errorList.length || (job.error ? 1 : 0);
													const isExpanded = expandedErrors.has(job.id);

													return (
														<div>
															<button
																type="button"
																onClick={() => {
																	const newExpanded = new Set(expandedErrors);
																	if (isExpanded) {
																		newExpanded.delete(job.id);
																	} else {
																		newExpanded.add(job.id);
																	}
																	setExpandedErrors(newExpanded);
																}}
																style={{
																	background: "none",
																	border: "none",
																	color: "#721c24",
																	cursor: "pointer",
																	padding: "0.25rem 0.5rem",
																	fontSize: "0.875rem",
																	fontWeight: "600",
																	textDecoration: "underline",
																}}
															>
																{errorCount} error{errorCount !== 1 ? "s" : ""}
																{isExpanded ? " ▼" : " ▶"}
															</button>
															{isExpanded && (
																<div
																	style={{
																		marginTop: "0.5rem",
																		padding: "0.75rem",
																		backgroundColor: "#f8d7da",
																		borderRadius: "4px",
																		border: "1px solid #f5c6cb",
																	}}
																>
																	{/* Show detailed JSON errors first if available */}
																	{errorList.length > 0 ? (
																		<div>
																			<strong>Asset Errors:</strong>
																			<ul
																				style={{
																					margin: "0.5rem 0 0 0",
																					paddingLeft: "1.5rem",
																				}}
																			>
																				{errorList.map((err) => (
																					<li
																						key={err.assetId}
																						style={{
																							marginBottom: "0.5rem",
																						}}
																					>
																						<strong>
																							Asset {err.assetId}:
																						</strong>{" "}
																						{err.error}
																					</li>
																				))}
																			</ul>
																		</div>
																	) : job.error ? (
																		/* Fallback: show error field if no JSON errors */
																		<div>
																			<strong>Errors:</strong>
																			<div
																				style={{
																					marginTop: "0.25rem",
																					fontSize: "0.8125rem",
																					wordBreak: "break-word",
																					whiteSpace: "pre-wrap",
																				}}
																			>
																				{job.error}
																			</div>
																		</div>
																	) : job.errors ? (
																		/* Fallback: show raw errors if JSON parsing failed */
																		<div>
																			<strong>Errors (raw):</strong>
																			<div
																				style={{
																					marginTop: "0.25rem",
																					fontSize: "0.8125rem",
																					wordBreak: "break-word",
																					whiteSpace: "pre-wrap",
																				}}
																			>
																				{job.errors}
																			</div>
																		</div>
																	) : null}
																</div>
															)}
														</div>
													);
												})()}
											</td>
											<td style={{ padding: "0.75rem", textAlign: "center" }}>
												{job.status === "running" ||
												job.status === "pending" ? (
													<button
														type="button"
														onClick={() => handleCancelJob(job.id)}
														disabled={fetcher.state !== "idle"}
														style={{
															padding: "0.5rem 1rem",
															backgroundColor: "#dc3545",
															color: "white",
															border: "none",
															borderRadius: "4px",
															cursor:
																fetcher.state !== "idle"
																	? "not-allowed"
																	: "pointer",
															fontSize: "0.875rem",
															fontWeight: "600",
															opacity: fetcher.state !== "idle" ? 0.6 : 1,
														}}
													>
														Cancel
													</button>
												) : (
													<span style={{ color: "#999" }}>-</span>
												)}
											</td>
										</tr>
									)
								)}
							</tbody>
						</table>
						<style>
							{`
								@keyframes spin {
									to { transform: rotate(360deg); }
								}
							`}
						</style>
						{syncJobs.some(
							(job) => job.status === "completed" && job.assetsProcessed > 0
						) && (
							<div
								style={{
									marginTop: "1rem",
									fontSize: "0.875rem",
									color: "#666",
								}}
							>
								<s-paragraph>
									<strong>Note:</strong> "Assets Found" shows how many assets
									were discovered with your configured tags. Assets are only
									imported if they're new or have been updated in Bynder. Check
									the "Files" page to see which assets were actually imported.
								</s-paragraph>
							</div>
						)}
					</div>
				)}
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
