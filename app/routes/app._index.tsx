import { boundary } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
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
			stats: null,
			recentJobs: [],
			connectionStatus: false,
		};
	}

	// Get sync stats
	const totalSynced = await prisma.syncedAsset.count({
		where: { shopId: shopConfig.id },
	});

	const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const syncedLast24h = await prisma.syncedAsset.count({
		where: {
			shopId: shopConfig.id,
			syncedAt: { gte: last24Hours },
		},
	});

	// Get recent sync jobs for stats
	const recentJobs = await prisma.syncJob.findMany({
		where: { shopId: shopConfig.id },
		orderBy: { createdAt: "desc" },
		take: 5,
	});

	const lastSuccessfulJob = recentJobs.find(
		(job) => job.status === "completed"
	);
	const lastJob = recentJobs[0] || null;

	// Calculate success rate (last 5 jobs)
	const completedJobs = recentJobs.filter((job) => job.status === "completed");
	const successRate =
		recentJobs.length > 0
			? Math.round((completedJobs.length / recentJobs.length) * 100)
			: null;

	// Check connection status
	const connectionStatus = !!shopConfig.bynderBaseUrl;

	return {
		shop,
		shopConfig,
		stats: {
			totalSynced,
			syncedLast24h,
			lastSuccessfulSync: lastSuccessfulJob?.completedAt || null,
			lastSyncStatus: lastJob?.status || null,
			lastSyncTime: lastJob?.completedAt || lastJob?.startedAt || null,
			successRate,
		},
		recentJobs,
		connectionStatus,
	};
};

export default function Dashboard() {
	const { shopConfig, stats, recentJobs, connectionStatus } =
		useLoaderData<typeof loader>();
	const fetcher = useFetcher();

	if (!shopConfig || !connectionStatus) {
		return (
			<s-page heading="Bynder Integration Dashboard">
				<s-section>
					<s-banner tone="warning">
						<s-paragraph>
							<strong>Setup Required:</strong> Please configure your Bynder
							connection in <s-link href="/app/settings">Settings</s-link> to
							get started.
						</s-paragraph>
					</s-banner>
					<div style={{ marginTop: "1rem" }}>
						<s-stack direction="block" gap="base">
							<s-heading>Quick Actions</s-heading>
							<s-stack direction="inline" gap="base">
								<s-button variant="primary" href="/app/settings">
									Go to Settings
								</s-button>
								<s-button variant="secondary" href="/app/files">
									View Files
								</s-button>
							</s-stack>
						</s-stack>
					</div>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="Bynder Integration Dashboard">
			{/* Connection Status Banner */}
			{connectionStatus && (
				<s-banner tone="success">
					<s-paragraph>
						<strong>Connected:</strong> Bynder integration is configured and
						ready.
					</s-paragraph>
				</s-banner>
			)}

			{/* Stats Cards */}
			{stats && (
				<s-section heading="Sync Statistics">
					<s-stack direction="inline" gap="base">
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-text>Total Synced Assets</s-text>
							<s-heading>{stats.totalSynced}</s-heading>
						</s-box>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-text>Synced Last 24 Hours</s-text>
							<s-heading>{stats.syncedLast24h}</s-heading>
						</s-box>
						{stats.successRate !== null && (
							<s-box padding="base" borderWidth="base" borderRadius="base">
								<s-text>Success Rate</s-text>
								<s-heading>{stats.successRate}%</s-heading>
							</s-box>
						)}
						{stats.lastSyncTime && (
							<s-box padding="base" borderWidth="base" borderRadius="base">
								<s-text>Last Sync</s-text>
								<s-heading>
									{new Date(stats.lastSyncTime).toLocaleString()}
								</s-heading>
								{stats.lastSyncStatus && (
									<div style={{ fontSize: "0.75rem", color: "#666" }}>
										Status: {stats.lastSyncStatus}
									</div>
								)}
							</s-box>
						)}
					</s-stack>
				</s-section>
			)}

			{/* Quick Actions */}
			<s-section heading="Quick Actions">
				<s-stack direction="inline" gap="base">
					<fetcher.Form method="POST" action="/api/sync">
						<s-button
							type="submit"
							variant="primary"
							disabled={fetcher.state !== "idle"}
						>
							{fetcher.state !== "idle" ? "Syncing..." : "Sync Now"}
						</s-button>
					</fetcher.Form>
					<s-button variant="secondary" href="/app/files">
						View Files
					</s-button>
					<s-button variant="secondary" href="/app/sync">
						Sync Dashboard
					</s-button>
					<s-button variant="secondary" href="/app/settings">
						Settings
					</s-button>
				</s-stack>
			</s-section>

			{/* Recent Activity */}
			{recentJobs.length > 0 && (
				<s-section heading="Recent Activity">
					<s-stack direction="block" gap="base">
						{recentJobs.map((job) => (
							<s-box
								key={job.id}
								padding="base"
								borderWidth="base"
								borderRadius="base"
							>
								<s-stack direction="inline" gap="base" alignItems="center">
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
														: job.status === "running"
															? "#fff3cd"
															: "#e2e3e5",
											color:
												job.status === "completed"
													? "#155724"
													: job.status === "failed"
														? "#721c24"
														: job.status === "running"
															? "#856404"
															: "#383d41",
										}}
									>
										{job.status}
									</span>
									<s-text>
										<strong>
											{job.startedAt
												? new Date(job.startedAt).toLocaleString()
												: "Not started"}
										</strong>
									</s-text>
									{job.assetsProcessed > 0 && (
										<s-text>
											{job.assetsProcessed} asset
											{job.assetsProcessed !== 1 ? "s" : ""} processed
										</s-text>
									)}
									{job.assetsCreated !== undefined && job.assetsCreated > 0 && (
										<span style={{ color: "#155724" }}>
											{job.assetsCreated} created
										</span>
									)}
									{job.assetsUpdated !== undefined && job.assetsUpdated > 0 && (
										<span style={{ color: "#856404" }}>
											{job.assetsUpdated} updated
										</span>
									)}
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
								</s-stack>
								{job.error && (
									<div style={{ marginTop: "0.5rem", color: "#721c24" }}>
										Error: {job.error}
									</div>
								)}
							</s-box>
						))}
						<style>
							{`
								@keyframes spin {
									to { transform: rotate(360deg); }
								}
							`}
						</style>
					</s-stack>
					<div style={{ marginTop: "1rem" }}>
						<s-link href="/app/sync">View all sync jobs →</s-link>
					</div>
				</s-section>
			)}

			{recentJobs.length === 0 && (
				<s-section heading="Recent Activity">
					<s-paragraph>
						No sync jobs yet. Click "Sync Now" to start syncing assets from
						Bynder.
					</s-paragraph>
				</s-section>
			)}
		</s-page>
	);
}

export const headers = boundary.headers;
