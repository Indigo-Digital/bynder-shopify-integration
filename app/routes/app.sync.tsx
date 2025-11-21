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

	const handleSync = () => {
		fetcher.submit({}, { method: "POST", action: "/api/sync" });
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
			</s-section>

			<s-section heading="Recent Sync Jobs">
				{syncJobs.length === 0 ? (
					<s-paragraph>
						No sync jobs yet. Click "Sync Now" to start.
					</s-paragraph>
				) : (
					<table>
						<thead>
							<tr>
								<th>Status</th>
								<th>Started</th>
								<th>Completed</th>
								<th>Assets Processed</th>
								<th>Error</th>
							</tr>
						</thead>
						<tbody>
							{syncJobs.map((job) => (
								<tr key={job.id}>
									<td>{job.status}</td>
									<td>
										{job.startedAt
											? new Date(job.startedAt).toLocaleString()
											: "-"}
									</td>
									<td>
										{job.completedAt
											? new Date(job.completedAt).toLocaleString()
											: "-"}
									</td>
									<td>{String(job.assetsProcessed)}</td>
									<td>{job.error || "-"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
