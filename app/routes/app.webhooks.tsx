import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import prisma from "../db.server.js";
import { BynderClient } from "../lib/bynder/client.js";
import {
	createWebhookSubscription,
	deleteWebhookSubscription,
	updateWebhookSubscription,
} from "../lib/bynder/webhooks.js";
import { env } from "../lib/env.server.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
		include: {
			webhookSubscriptions: {
				orderBy: { createdAt: "desc" },
				take: 1,
			},
		},
	});

	if (!shopConfig) {
		return {
			shop,
			shopConfig: null,
			webhookSubscription: null,
			stats: null,
			recentEvents: [],
		};
	}

	const webhookSubscription = shopConfig.webhookSubscriptions[0] || null;

	let totalEvents = 0;
	let successCount = 0;
	let failureCount = 0;
	let eventsLast24h = 0;
	let lastEvent = null;
	let recentEvents: Array<{
		id: string;
		eventType: string;
		assetId: string | null;
		status: string;
		payload: string;
		error: string | null;
		processedAt: Date | null;
		createdAt: Date;
	}> = [];
	let pagination = {
		page: 1,
		pageSize: 20,
		total: 0,
		totalPages: 0,
	};
	let lastSuccessfulEvent: { createdAt: Date } | null = null;

	try {
		const url = new URL(request.url);
		const page = parseInt(url.searchParams.get("page") || "1", 10);
		const pageSize = 20;
		const skip = (page - 1) * pageSize;

		const totalEventsCount = await prisma.webhookEvent.count({
			where: { shopId: shopConfig.id },
		});

		totalEvents = totalEventsCount;

		successCount = await prisma.webhookEvent.count({
			where: { shopId: shopConfig.id, status: "success" },
		});

		failureCount = await prisma.webhookEvent.count({
			where: { shopId: shopConfig.id, status: "failed" },
		});

		const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
		eventsLast24h = await prisma.webhookEvent.count({
			where: { shopId: shopConfig.id, createdAt: { gte: last24Hours } },
		});

		lastEvent = await prisma.webhookEvent.findFirst({
			where: { shopId: shopConfig.id },
			orderBy: { createdAt: "desc" },
		});

		lastSuccessfulEvent = await prisma.webhookEvent.findFirst({
			where: { shopId: shopConfig.id, status: "success" },
			orderBy: { createdAt: "desc" },
		});

		recentEvents = await prisma.webhookEvent.findMany({
			where: { shopId: shopConfig.id },
			orderBy: { createdAt: "desc" },
			take: pageSize,
			skip,
		});

		pagination = {
			page,
			pageSize,
			total: totalEventsCount,
			totalPages: Math.ceil(totalEventsCount / pageSize),
		};
	} catch (error) {
		console.warn(
			"WebhookEvent table not found, migration may not have been run:",
			error
		);
	}

	const successRate =
		totalEvents > 0 ? Math.round((successCount / totalEvents) * 100) : null;

	return {
		shop,
		shopConfig,
		webhookSubscription,
		stats: {
			totalEvents,
			successCount,
			failureCount,
			eventsLast24h,
			successRate,
			lastEventTime: lastEvent?.createdAt || null,
			lastSuccessfulEventTime: lastSuccessfulEvent?.createdAt || null,
		},
		recentEvents,
		webhookUrl: `${env.SHOPIFY_APP_URL}/api/bynder/webhooks`,
		pagination,
	};
};

export const action = async ({ request }: ActionFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "toggle_webhook") {
		const shopConfig = await prisma.shop.findUnique({
			where: { shop },
			include: {
				webhookSubscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
			},
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return { error: "Shop not configured" };
		}

		const existingSubscription = shopConfig.webhookSubscriptions[0];
		const isActivating = formData.get("active") === "true";

		try {
			const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);
			const webhookUrl = `${env.SHOPIFY_APP_URL}/api/bynder/webhooks`;
			const eventTypesInput = formData.get("eventTypes")?.toString() || "";
			const eventTypes =
				eventTypesInput.length > 0
					? eventTypesInput.split(",").map((e) => e.trim())
					: ["asset.tagged", "media.tagged"];

			if (isActivating) {
				let bynderWebhook: {
					id: string;
					url: string;
					events: string[];
					active: boolean;
				};
				if (existingSubscription?.bynderWebhookId) {
					bynderWebhook = await updateWebhookSubscription(
						bynderClient,
						existingSubscription.bynderWebhookId,
						webhookUrl,
						eventTypes
					);
				} else {
					bynderWebhook = await createWebhookSubscription(
						bynderClient,
						webhookUrl,
						eventTypes
					);
				}

				if (existingSubscription) {
					await prisma.webhookSubscription.update({
						where: { id: existingSubscription.id },
						data: {
							bynderWebhookId: bynderWebhook.id,
							active: true,
							endpoint: webhookUrl,
							eventType: eventTypes.join(","),
						},
					});
				} else {
					await prisma.webhookSubscription.create({
						data: {
							shopId: shopConfig.id,
							bynderWebhookId: bynderWebhook.id,
							eventType: eventTypes.join(","),
							endpoint: webhookUrl,
							active: true,
						},
					});
				}

				return { success: true, message: "Webhook activated" };
			} else {
				if (existingSubscription?.active) {
					try {
						await deleteWebhookSubscription(
							bynderClient,
							existingSubscription.bynderWebhookId
						);
					} catch (error) {
						console.error("Failed to delete webhook from Bynder:", error);
					}

					await prisma.webhookSubscription.update({
						where: { id: existingSubscription.id },
						data: { active: false },
					});
				}

				return { success: true, message: "Webhook deactivated" };
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			return { error: errorMessage };
		}
	}

	return { error: "Invalid intent" };
};

export default function WebhooksPage() {
	const {
		shopConfig,
		webhookSubscription,
		stats,
		recentEvents,
		webhookUrl,
		pagination,
	} = useLoaderData<typeof loader>();
	const fetcher = useFetcher();
	const testFetcher = useFetcher();
	const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
	const [statusFilter, setStatusFilter] = useState<
		"all" | "success" | "failed"
	>("all");
	const [assetIdFilter, setAssetIdFilter] = useState("");
	const [copied, setCopied] = useState(false);
	const [selectedEvents, setSelectedEvents] = useState<string[]>([
		"asset.tagged",
		"media.tagged",
	]);

	const isSubmitting = fetcher.state !== "idle";
	const isTesting = testFetcher.state !== "idle";

	const toggleExpand = useCallback((eventId: string) => {
		setExpandedEvents((prev) => {
			const next = new Set(prev);
			if (next.has(eventId)) {
				next.delete(eventId);
			} else {
				next.add(eventId);
			}
			return next;
		});
	}, []);

	const filteredEvents = recentEvents.filter(
		(event: (typeof recentEvents)[number]) => {
			const statusMatch =
				statusFilter === "all" || event.status === statusFilter;
			const assetIdMatch =
				!assetIdFilter ||
				event.assetId?.toLowerCase().includes(assetIdFilter.toLowerCase());
			return statusMatch && assetIdMatch;
		}
	);

	const handleCopyUrl = useCallback(async () => {
		if (!webhookUrl) return;
		try {
			await navigator.clipboard.writeText(webhookUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (error) {
			console.error("Failed to copy URL:", error);
		}
	}, [webhookUrl]);

	const handleTestWebhook = useCallback(() => {
		testFetcher.submit(
			{},
			{ method: "POST", action: "/api/bynder/webhooks/test-endpoint" }
		);
	}, [testFetcher]);

	const toggleEventType = useCallback((eventType: string) => {
		setSelectedEvents((prev) =>
			prev.includes(eventType)
				? prev.filter((e) => e !== eventType)
				: [...prev, eventType]
		);
	}, []);

	if (!shopConfig || !shopConfig.bynderBaseUrl) {
		return (
			<s-page heading="Webhooks">
				<s-section>
					<s-banner tone="warning">
						Please configure Bynder in{" "}
						<s-link href="/app/settings">Settings</s-link> first.
					</s-banner>
				</s-section>
			</s-page>
		);
	}

	const isActive = webhookSubscription?.active || false;

	return (
		<s-page heading="Webhooks">
			{fetcher.data?.success && (
				<s-banner tone="success" dismissible>
					{fetcher.data.message || "Webhook updated successfully!"}
				</s-banner>
			)}
			{fetcher.data?.error && (
				<s-banner tone="critical" dismissible>
					Error:{" "}
					{typeof fetcher.data.error === "string"
						? fetcher.data.error
						: "An error occurred"}
				</s-banner>
			)}

			{/* Webhook Status Section */}
			<s-section heading="Webhook Status">
				<s-stack direction="block" gap="base">
					<s-text>
						When activated, this webhook listens to Bynder for new assets that
						match your sync criteria (defined in Settings) and automatically
						processes them into Shopify using the background job.
					</s-text>

					<s-stack direction="inline" gap="base" alignItems="center">
						<s-text>
							<strong>Status:</strong>
						</s-text>
						<s-badge tone={isActive ? "success" : "critical"}>
							{isActive ? "✓ Active" : "✗ Inactive"}
						</s-badge>
						{stats?.lastSuccessfulEventTime && (
							<s-text color="subdued">
								Last successful event:{" "}
								{new Date(stats.lastSuccessfulEventTime).toLocaleString()}
							</s-text>
						)}
					</s-stack>

					{/* Webhook URL */}
					<s-stack direction="block" gap="small">
						<s-text>
							<strong>Webhook Endpoint URL:</strong>
						</s-text>
						<s-stack direction="inline" gap="base" alignItems="center">
							<s-box
								padding="small"
								borderWidth="base"
								borderRadius="base"
								background="subdued"
							>
								<s-text>{webhookUrl}</s-text>
							</s-box>
							<s-button variant="secondary" onClick={handleCopyUrl}>
								{copied ? "Copied!" : "Copy URL"}
							</s-button>
						</s-stack>
					</s-stack>

					{/* Event Type Selection */}
					{!isActive && (
						<s-stack direction="block" gap="small">
							<s-text>
								<strong>Event Types to Subscribe To:</strong>
							</s-text>
							<s-stack direction="inline" gap="base">
								{["asset.tagged", "media.tagged"].map((eventType) => (
									<s-checkbox
										key={eventType}
										label={eventType}
										checked={selectedEvents.includes(eventType)}
										onChange={() => toggleEventType(eventType)}
									/>
								))}
							</s-stack>
						</s-stack>
					)}

					{/* Action Buttons */}
					<s-stack direction="inline" gap="base">
						<fetcher.Form method="POST">
							<input type="hidden" name="intent" value="toggle_webhook" />
							<input
								type="hidden"
								name="active"
								value={(!isActive).toString()}
							/>
							<input
								type="hidden"
								name="eventTypes"
								value={selectedEvents.join(",")}
							/>
							{isActive ? (
								<s-button
									type="submit"
									variant="secondary"
									tone="critical"
									disabled={isSubmitting}
								>
									{isSubmitting ? "Updating..." : "Deactivate"}
								</s-button>
							) : (
								<s-button
									type="submit"
									variant="primary"
									disabled={isSubmitting}
								>
									{isSubmitting ? "Updating..." : "Activate"}
								</s-button>
							)}
						</fetcher.Form>
						{isActive && (
							<s-button
								variant="secondary"
								onClick={handleTestWebhook}
								disabled={isTesting}
							>
								{isTesting ? "Testing..." : "Test Webhook"}
							</s-button>
						)}
					</s-stack>

					{/* Test Results */}
					{testFetcher.data &&
						(testFetcher.data.success ? (
							<s-banner tone="success" dismissible>
								{testFetcher.data.message ||
									"Webhook test completed successfully!"}
							</s-banner>
						) : (
							<s-banner tone="critical" dismissible>
								Test failed:{" "}
								{typeof testFetcher.data.error === "string"
									? testFetcher.data.error
									: "Unknown error"}
							</s-banner>
						))}

					{/* Subscription Details */}
					{webhookSubscription && (
						<s-box padding="base" background="subdued" borderRadius="base">
							<s-stack direction="block" gap="small">
								<s-text>
									<strong>Subscription Details:</strong>
								</s-text>
								<s-text>
									<strong>Events:</strong> {webhookSubscription.eventType}
								</s-text>
								<s-text>
									<strong>Bynder Webhook ID:</strong>{" "}
									{webhookSubscription.bynderWebhookId}
								</s-text>
								<s-text>
									<strong>Created:</strong>{" "}
									{new Date(webhookSubscription.createdAt).toLocaleString()}
								</s-text>
							</s-stack>
						</s-box>
					)}
				</s-stack>
			</s-section>

			{/* Stats Section */}
			{stats && (
				<s-section heading="Statistics">
					<s-grid
						gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
						gap="base"
					>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-stack direction="block" gap="small-200">
								<s-text color="subdued">Total Events</s-text>
								<s-heading>{stats.totalEvents}</s-heading>
							</s-stack>
						</s-box>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-stack direction="block" gap="small-200">
								<s-text color="subdued">Success Rate</s-text>
								<s-heading>
									{stats.successRate !== null ? `${stats.successRate}%` : "N/A"}
								</s-heading>
							</s-stack>
						</s-box>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-stack direction="block" gap="small-200">
								<s-text color="subdued">Events Last 24h</s-text>
								<s-heading>{stats.eventsLast24h}</s-heading>
							</s-stack>
						</s-box>
						{stats.lastEventTime && (
							<s-box padding="base" borderWidth="base" borderRadius="base">
								<s-stack direction="block" gap="small-200">
									<s-text color="subdued">Last Event</s-text>
									<s-text>
										{new Date(stats.lastEventTime).toLocaleString()}
									</s-text>
								</s-stack>
							</s-box>
						)}
					</s-grid>
				</s-section>
			)}

			{/* Recent Events Section */}
			<s-section heading="Recent Events">
				<s-stack direction="block" gap="base">
					{/* Filters */}
					<s-stack direction="inline" gap="base" alignItems="end">
						<s-button-group>
							<s-button
								variant={statusFilter === "all" ? "primary" : "secondary"}
								onClick={() => setStatusFilter("all")}
							>
								All ({recentEvents.length})
							</s-button>
							<s-button
								variant={statusFilter === "success" ? "primary" : "secondary"}
								onClick={() => setStatusFilter("success")}
							>
								Success ({stats?.successCount || 0})
							</s-button>
							<s-button
								variant={statusFilter === "failed" ? "primary" : "secondary"}
								onClick={() => setStatusFilter("failed")}
							>
								Failed ({stats?.failureCount || 0})
							</s-button>
						</s-button-group>
						<s-text-field
							label="Filter by Asset ID"
							labelAccessibilityVisibility="exclusive"
							value={assetIdFilter}
							onInput={(e) =>
								setAssetIdFilter((e.target as HTMLInputElement).value)
							}
							placeholder="Enter asset ID..."
						/>
					</s-stack>

					{/* Events Table */}
					{filteredEvents.length === 0 ? (
						<s-box padding="large" background="subdued" borderRadius="base">
							<s-text>No webhook events yet.</s-text>
						</s-box>
					) : (
						<s-table>
							<s-table-header-row>
								<s-table-header listSlot="primary">Timestamp</s-table-header>
								<s-table-header>Event Type</s-table-header>
								<s-table-header listSlot="secondary">Asset ID</s-table-header>
								<s-table-header>Status</s-table-header>
								<s-table-header>Actions</s-table-header>
							</s-table-header-row>
							<s-table-body>
								{filteredEvents.map((event: (typeof recentEvents)[number]) => {
									const isExpanded = expandedEvents.has(event.id);
									return (
										<s-table-row key={event.id}>
											<s-table-cell>
												<s-text>
													{new Date(event.createdAt).toLocaleString()}
												</s-text>
											</s-table-cell>
											<s-table-cell>
												<s-badge tone="neutral">{event.eventType}</s-badge>
											</s-table-cell>
											<s-table-cell>
												<s-text>{event.assetId || "-"}</s-text>
											</s-table-cell>
											<s-table-cell>
												<s-badge
													tone={
														event.status === "success" ? "success" : "critical"
													}
												>
													{event.status}
												</s-badge>
											</s-table-cell>
											<s-table-cell>
												<s-button
													variant="tertiary"
													onClick={() => toggleExpand(event.id)}
												>
													{isExpanded ? "Hide" : "Details"}
												</s-button>
												{isExpanded && (
													<s-box
														padding="small"
														background="subdued"
														borderRadius="small"
													>
														<s-stack direction="block" gap="small">
															{event.error && (
																<s-badge tone="critical">
																	Error: {event.error}
																</s-badge>
															)}
															{event.processedAt && (
																<s-text>
																	<strong>Processed:</strong>{" "}
																	{new Date(event.processedAt).toLocaleString()}
																</s-text>
															)}
															<s-text>
																<strong>Payload:</strong>
															</s-text>
															<div
																style={{
																	padding: "8px",
																	backgroundColor:
																		"var(--p-color-bg-surface-secondary)",
																	borderRadius: "4px",
																	overflow: "auto",
																	maxHeight: "200px",
																}}
															>
																<pre style={{ margin: 0, fontSize: "0.75rem" }}>
																	<code>
																		{JSON.stringify(
																			JSON.parse(event.payload),
																			null,
																			2
																		)}
																	</code>
																</pre>
															</div>
														</s-stack>
													</s-box>
												)}
											</s-table-cell>
										</s-table-row>
									);
								})}
							</s-table-body>
						</s-table>
					)}

					{/* Pagination */}
					{pagination && pagination.totalPages > 1 && (
						<s-stack
							direction="inline"
							gap="base"
							justifyContent="space-between"
							alignItems="center"
						>
							<s-text color="subdued">
								Page {pagination.page} of {pagination.totalPages} (
								{pagination.total} total events)
							</s-text>
							<s-stack direction="inline" gap="small">
								<s-button
									variant="secondary"
									href={`/app/webhooks?page=${pagination.page - 1}`}
									disabled={pagination.page <= 1}
								>
									Previous
								</s-button>
								<s-button
									variant="secondary"
									href={`/app/webhooks?page=${pagination.page + 1}`}
									disabled={pagination.page >= pagination.totalPages}
								>
									Next
								</s-button>
							</s-stack>
						</s-stack>
					)}
				</s-stack>
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
