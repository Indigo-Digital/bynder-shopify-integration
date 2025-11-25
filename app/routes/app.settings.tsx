import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { AssetBrowser } from "../components/AssetBrowser.js";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
		include: {
			webhookSubscriptions: {
				where: { active: true },
				take: 1,
			},
		},
	});

	if (!shopConfig) {
		return {
			shop,
			shopConfig: null,
			stats: null,
			recentFailures: [],
		};
	}

	// Get stats
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
		take: 10,
	});

	const lastSuccessfulJob = recentJobs.find(
		(job) => job.status === "completed"
	);
	const lastJob = recentJobs[0] || null;

	// Calculate success rate (last 10 jobs)
	const completedJobs = recentJobs.filter((job) => job.status === "completed");
	const successRate =
		recentJobs.length > 0
			? Math.round((completedJobs.length / recentJobs.length) * 100)
			: null;

	// Get recent failures
	const recentFailures = await prisma.syncJob.findMany({
		where: {
			shopId: shopConfig.id,
			status: "failed",
		},
		orderBy: { createdAt: "desc" },
		take: 5,
	});

	// Get webhook subscription status
	const webhookSubscription =
		shopConfig?.webhookSubscriptions?.[0] || null;

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
		recentFailures,
		webhookSubscription,
	};
};

export const action = async ({ request }: ActionFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "update_sync_tags") {
		const syncTagsInput = formData.get("syncTags")?.toString() || "";
		// Parse comma-separated tags, trim, and filter empty
		const syncTags =
			syncTagsInput
				.split(",")
				.map((tag: string) => tag.trim())
				.filter((tag: string) => tag.length > 0)
				.join(",") || "shopify-sync";

		await prisma.shop.upsert({
			where: { shop },
			create: {
				shop,
				syncTags,
			},
			update: {
				syncTags,
			},
		});

		return redirect("/app/settings?updated=true");
	}

	if (intent === "update_bynder_url") {
		const bynderBaseUrl = formData.get("bynderBaseUrl")?.toString();

		if (!bynderBaseUrl) {
			return { error: "Bynder base URL is required" };
		}

		await prisma.shop.upsert({
			where: { shop },
			create: {
				shop,
				bynderBaseUrl,
			},
			update: {
				bynderBaseUrl,
			},
		});

		return redirect("/app/settings?updated=true");
	}

	return { error: "Invalid intent" };
};

export default function SettingsPage() {
	const { shopConfig, stats, recentFailures, webhookSubscription } =
		useLoaderData<typeof loader>();
	const fetcher = useFetcher();
	const testFetcher = useFetcher();

	const [syncTags, setSyncTags] = useState(
		shopConfig?.syncTags || "shopify-sync"
	);
	const [bynderBaseUrl, setBynderBaseUrl] = useState(
		shopConfig?.bynderBaseUrl || ""
	);
	const [newTag, setNewTag] = useState("");
	const [activeTab, setActiveTab] = useState<"config" | "browse">("config");

	const isSubmitting = fetcher.state !== "idle";
	const isTesting = testFetcher.state !== "idle";
	const url = new URL(
		typeof window !== "undefined" ? window.location.href : ""
	);
	const updated = url.searchParams.get("updated") === "true";

	// Parse tags for display
	const tagList = syncTags
		.split(",")
		.map((tag: string) => tag.trim())
		.filter((tag: string) => tag.length > 0);

	const handleAddTag = () => {
		const trimmed = newTag.trim();
		if (trimmed && !tagList.includes(trimmed)) {
			const updatedTags = [...tagList, trimmed].join(",");
			setSyncTags(updatedTags);
			setNewTag("");
		}
	};

	const handleRemoveTag = (tagToRemove: string) => {
		const updatedTags =
			tagList.filter((tag: string) => tag !== tagToRemove).join(",") ||
			"shopify-sync";
		setSyncTags(updatedTags);
	};

	const handleTagSelectFromBrowser = (tag: string) => {
		const trimmed = tag.trim();
		if (trimmed && !tagList.includes(trimmed)) {
			const updatedTags = [...tagList, trimmed].join(",");
			setSyncTags(updatedTags);
			// Optionally switch to config tab to show the newly added tag
			setActiveTab("config");
		}
	};

	const handleTestConnection = () => {
		testFetcher.load("/api/bynder/test");
	};

	useEffect(() => {
		if (shopConfig?.syncTags) {
			setSyncTags(shopConfig.syncTags);
		}
		if (shopConfig?.bynderBaseUrl) {
			setBynderBaseUrl(shopConfig.bynderBaseUrl);
		}
	}, [shopConfig]);

	return (
		<s-page heading="Bynder Settings">
			{updated && (
				<s-banner tone="success">Settings updated successfully!</s-banner>
			)}
			{fetcher.data?.error && (
				<s-banner tone="critical">
					Error:{" "}
					{typeof fetcher.data.error === "string"
						? fetcher.data.error
						: "An error occurred"}
				</s-banner>
			)}

			{/* Connection Status Section */}
			<s-section heading="Bynder Connection">
				<s-stack direction="block" gap="base">
					<fetcher.Form method="POST">
						<input type="hidden" name="intent" value="update_bynder_url" />
						<s-stack direction="block" gap="base">
							<s-stack direction="block" gap="base">
								<s-text-field
									label="Bynder Base URL"
									value={bynderBaseUrl}
									onChange={(e) => {
										const target = e.currentTarget;
										if (target) {
											setBynderBaseUrl(target.value);
										}
									}}
									name="bynderBaseUrl"
									placeholder="https://portal.getbynder.com/api"
									required
								/>
								<s-text>
									Your Bynder portal URL with /api (e.g.,
									https://portal.getbynder.com/api). The /api will be added
									automatically if not included.
								</s-text>
							</s-stack>
							<s-button type="submit" disabled={isSubmitting}>
								{isSubmitting ? "Saving..." : "Save Base URL"}
							</s-button>
						</s-stack>
					</fetcher.Form>

					{shopConfig?.bynderBaseUrl && (
						<s-stack direction="block" gap="base">
							<s-button
								variant="secondary"
								onClick={handleTestConnection}
								disabled={isTesting}
							>
								{isTesting ? "Testing..." : "Test Connection"}
							</s-button>
							{testFetcher.data &&
								(testFetcher.data.connected ? (
									<s-banner tone="success">
										Connection successful! Base URL: {testFetcher.data.baseURL}
									</s-banner>
								) : (
									<s-banner tone="critical">
										Connection failed:{" "}
										{testFetcher.data.error || "Unknown error"}
									</s-banner>
								))}
							<s-paragraph>
								Using permanent token authentication (configured in environment
								variables)
							</s-paragraph>
						</s-stack>
					)}
				</s-stack>
			</s-section>

			{/* Stats Section */}
			{stats && (
				<s-section heading="Sync Statistics">
					<s-stack direction="block" gap="base">
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
									<s-text>Success Rate (Last 10 Syncs)</s-text>
									<s-heading>{stats.successRate}%</s-heading>
								</s-box>
							)}
						</s-stack>
						{stats.lastSyncTime && (
							<s-paragraph>
								Last Sync: {new Date(stats.lastSyncTime).toLocaleString()} (
								{stats.lastSyncStatus || "unknown"})
							</s-paragraph>
						)}
						{stats.lastSuccessfulSync && (
							<s-paragraph>
								Last Successful Sync:{" "}
								{new Date(stats.lastSuccessfulSync).toLocaleString()}
							</s-paragraph>
						)}
					</s-stack>
				</s-section>
			)}

			{/* Recent Failures Section */}
			{recentFailures.length > 0 && (
				<s-section heading="Recent Failures">
					<s-stack direction="block" gap="base">
						{recentFailures.map((failure) => (
							<s-box
								key={failure.id}
								padding="base"
								borderWidth="base"
								borderRadius="base"
							>
								<s-stack direction="block" gap="base">
									<s-text>
										<strong>
											{new Date(failure.createdAt).toLocaleString()}
										</strong>
									</s-text>
									{failure.error && (
										<s-text tone="critical">{failure.error}</s-text>
									)}
									{failure.assetsProcessed > 0 && (
										<s-text>Assets processed: {failure.assetsProcessed}</s-text>
									)}
								</s-stack>
							</s-box>
						))}
					</s-stack>
				</s-section>
			)}

			{/* Webhook Management Section */}
			{shopConfig?.bynderBaseUrl && (
				<s-section heading="Webhook Management">
					<s-stack direction="block" gap="base">
						<s-paragraph>
							Manage your Bynder webhook subscriptions for automatic asset
							synchronization.
						</s-paragraph>
						<s-stack direction="inline" gap="base" alignItems="center">
							<s-text>
								<strong>Status:</strong>{" "}
								{webhookSubscription?.active ? (
									<span style={{ color: "#155724" }}>Active</span>
								) : (
									<span style={{ color: "#721c24" }}>Inactive</span>
								)}
							</s-text>
							<s-button variant="secondary" href="/app/webhooks">
								Manage Webhooks
							</s-button>
						</s-stack>
						{webhookSubscription && (
							<div style={{ fontSize: "0.875rem", color: "#666" }}>
								<s-text>Events: {webhookSubscription.eventType}</s-text>
							</div>
						)}
					</s-stack>
				</s-section>
			)}

			{/* Tag Management Section */}
			<s-section heading="Sync Tag Configuration">
				<s-stack direction="block" gap="base">
					{/* Tab Navigation */}
					<s-stack direction="inline" gap="base">
						<s-button
							variant={activeTab === "config" ? "primary" : "secondary"}
							onClick={() => setActiveTab("config")}
						>
							Configure Tags
						</s-button>
						<s-button
							variant={activeTab === "browse" ? "primary" : "secondary"}
							onClick={() => setActiveTab("browse")}
							disabled={!shopConfig?.bynderBaseUrl}
						>
							Browse Assets
						</s-button>
					</s-stack>

					{/* Configuration Tab */}
					{activeTab === "config" && (
						<fetcher.Form method="POST">
							<input type="hidden" name="intent" value="update_sync_tags" />
							<input type="hidden" name="syncTags" value={syncTags} />
							<s-stack direction="block" gap="base">
								<s-paragraph>
									Assets with these tags will be automatically synced to Shopify
									Files. You can add multiple tags.
								</s-paragraph>

								{/* Tag Input */}
								<s-stack direction="inline" gap="base">
									<s-text-field
										label="Add Tag"
										value={newTag}
										onChange={(e) => {
											const target = e.currentTarget;
											if (target) {
												setNewTag(target.value);
											}
										}}
										placeholder="Enter tag name"
									/>
									<s-button
										type="button"
										variant="secondary"
										onClick={handleAddTag}
										disabled={!newTag.trim()}
									>
										Add
									</s-button>
								</s-stack>

								{/* Tag List */}
								{tagList.length > 0 && (
									<s-stack direction="block" gap="base">
										<s-text>
											<strong>Active Tags ({tagList.length}):</strong>
										</s-text>
										<s-stack direction="inline" gap="base">
											{tagList.map((tag: string) => (
												<s-box
													key={tag}
													padding="base"
													borderWidth="base"
													borderRadius="base"
												>
													<s-stack direction="inline" gap="base">
														<s-text>{tag}</s-text>
														<s-button
															type="button"
															variant="tertiary"
															onClick={() => handleRemoveTag(tag)}
														>
															×
														</s-button>
													</s-stack>
												</s-box>
											))}
										</s-stack>
									</s-stack>
								)}

								<s-button type="submit" disabled={isSubmitting}>
									{isSubmitting ? "Saving..." : "Save Tags"}
								</s-button>
							</s-stack>
						</fetcher.Form>
					)}

					{/* Browse Assets Tab */}
					{activeTab === "browse" && (
						<s-stack direction="block" gap="base">
							{!shopConfig?.bynderBaseUrl ? (
								<s-banner tone="warning">
									Please configure your Bynder Base URL first to browse assets.
								</s-banner>
							) : (
								<>
									<s-paragraph>
										Browse your Bynder assets to discover tags. Click on any tag
										to add it to your sync configuration.
									</s-paragraph>
									<AssetBrowser
										onTagSelect={handleTagSelectFromBrowser}
										existingTags={tagList}
										baseUrl={shopConfig.bynderBaseUrl}
									/>
								</>
							)}
						</s-stack>
					)}
				</s-stack>
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
