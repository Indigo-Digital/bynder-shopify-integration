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

const getStatusTone = (
	status: string
): "success" | "critical" | "warning" | "neutral" => {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "critical";
		case "running":
		case "pending":
			return "warning";
		default:
			return "neutral";
	}
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
						<strong>Setup Required:</strong> Please configure your Bynder
						connection in <s-link href="/app/settings">Settings</s-link> to get
						started.
					</s-banner>
				</s-section>
				<s-section heading="Quick Actions">
					<s-stack direction="inline" gap="base">
						<s-button variant="primary" href="/app/settings">
							Go to Settings
						</s-button>
						<s-button variant="secondary" href="/app/file-manager">
							File Manager
						</s-button>
					</s-stack>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="Bynder Integration Dashboard">
			{/* Connection Status Banner */}
			{connectionStatus && (
				<s-banner tone="success" dismissible>
					<strong>Connected:</strong> Bynder integration is configured and
					ready.
				</s-banner>
			)}

			{/* Stats Cards */}
			{stats && (
				<s-section heading="Sync Statistics">
					<s-grid
						gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
						gap="base"
					>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-stack direction="block" gap="small-200">
								<s-text color="subdued">Total Synced Assets</s-text>
								<s-heading>{stats.totalSynced}</s-heading>
							</s-stack>
						</s-box>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-stack direction="block" gap="small-200">
								<s-text color="subdued">Synced Last 24h</s-text>
								<s-heading>{stats.syncedLast24h}</s-heading>
							</s-stack>
						</s-box>
						{stats.successRate !== null && (
							<s-box padding="base" borderWidth="base" borderRadius="base">
								<s-stack direction="block" gap="small-200">
									<s-text color="subdued">Success Rate</s-text>
									<s-heading>{stats.successRate}%</s-heading>
								</s-stack>
							</s-box>
						)}
						{stats.lastSyncTime && (
							<s-box padding="base" borderWidth="base" borderRadius="base">
								<s-stack direction="block" gap="small-200">
									<s-text color="subdued">Last Sync</s-text>
									<s-text>
										{new Date(stats.lastSyncTime).toLocaleString()}
									</s-text>
									{stats.lastSyncStatus && (
										<s-badge tone={getStatusTone(stats.lastSyncStatus)}>
											{stats.lastSyncStatus}
										</s-badge>
									)}
								</s-stack>
							</s-box>
						)}
					</s-grid>
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
					<s-button variant="secondary" href="/app/file-manager">
						File Manager
					</s-button>
					<s-button variant="secondary" href="/app/files">
						Synced Assets
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
					<s-stack direction="block" gap="small">
						{recentJobs.map((job) => (
							<s-box
								key={job.id}
								padding="small"
								borderWidth="base"
								borderRadius="base"
							>
								<s-stack direction="inline" gap="base" alignItems="center">
									{job.status === "running" && <s-spinner size="base" />}
									<s-badge tone={getStatusTone(job.status)}>
										{job.status}
									</s-badge>
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
										<s-badge tone="success">
											{job.assetsCreated} created
										</s-badge>
									)}
									{job.assetsUpdated !== undefined && job.assetsUpdated > 0 && (
										<s-badge tone="warning">
											{job.assetsUpdated} updated
										</s-badge>
									)}
								</s-stack>
								{job.error && (
									<s-banner tone="critical">Error: {job.error}</s-banner>
								)}
							</s-box>
						))}
					</s-stack>
					<s-link href="/app/sync">View all sync jobs →</s-link>
				</s-section>
			)}

			{recentJobs.length === 0 && (
				<s-section heading="Recent Activity">
					<s-box padding="large" background="subdued" borderRadius="base">
						<s-stack direction="block" gap="base" alignItems="center">
							<s-text>
								No sync jobs yet. Click "Sync Now" to start syncing assets from
								Bynder.
							</s-text>
						</s-stack>
					</s-box>
				</s-section>
			)}
		</s-page>
	);
}

export const headers = boundary.headers;
