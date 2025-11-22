import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
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

	// Reload data when sync completes
	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data) {
			// Wait a bit for the sync job to be saved, then reload
			const timer = setTimeout(() => {
				revalidator.revalidate();
			}, 1000);
			return () => clearTimeout(timer);
		}
	}, [fetcher.state, fetcher.data, revalidator]);

	const showSuccess =
		fetcher.data && "success" in fetcher.data && fetcher.data.success;
	const showError = fetcher.data && "error" in fetcher.data;
	const syncResult =
		fetcher.data && "success" in fetcher.data ? fetcher.data : null;

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
			{syncResult && showSuccess && (
				<s-banner tone="success">
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
					{syncResult.errors !== undefined &&
						syncResult.errors.length > 0 &&
						`${syncResult.errors.length} error${syncResult.errors.length !== 1 ? "s" : ""} occurred.`}
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
										Assets Found
									</th>
									<th
										style={{
											padding: "0.75rem",
											textAlign: "left",
											fontWeight: "600",
										}}
									>
										Error
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
																	: "#fff3cd",
														color:
															job.status === "completed"
																? "#155724"
																: job.status === "failed"
																	? "#721c24"
																	: "#856404",
													}}
												>
													{job.status}
												</span>
											</td>
											<td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
												{job.startedAt
													? new Date(job.startedAt).toLocaleString()
													: "-"}
											</td>
											<td style={{ padding: "0.75rem", whiteSpace: "nowrap" }}>
												{job.completedAt
													? new Date(job.completedAt).toLocaleString()
													: job.status === "running"
														? "In progress..."
														: "-"}
											</td>
											<td style={{ padding: "0.75rem", textAlign: "right" }}>
												{job.assetsProcessed > 0 ? (
													<strong>{job.assetsProcessed}</strong>
												) : (
													"-"
												)}
											</td>
											<td style={{ padding: "0.75rem", maxWidth: "300px" }}>
												{job.error ? (
													<span
														style={{
															color: "#721c24",
															fontSize: "0.8125rem",
															wordBreak: "break-word",
														}}
													>
														{job.error}
													</span>
												) : (
													<span style={{ color: "#999" }}>-</span>
												)}
											</td>
										</tr>
									)
								)}
							</tbody>
						</table>
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
