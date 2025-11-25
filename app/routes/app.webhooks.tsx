import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";
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

	// Get webhook subscription (most recent one)
	const webhookSubscription = shopConfig.webhookSubscriptions[0] || null;

	// Get webhook stats (handle case where table doesn't exist yet)
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
		// Get pagination info
		const url = new URL(request.url);
		const page = parseInt(url.searchParams.get("page") || "1", 10);
		const pageSize = 20;
		const skip = (page - 1) * pageSize;

		const totalEventsCount = await prisma.webhookEvent.count({
			where: { shopId: shopConfig.id },
		});

		totalEvents = totalEventsCount;

		successCount = await prisma.webhookEvent.count({
			where: {
				shopId: shopConfig.id,
				status: "success",
			},
		});

		failureCount = await prisma.webhookEvent.count({
			where: {
				shopId: shopConfig.id,
				status: "failed",
			},
		});

		const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
		eventsLast24h = await prisma.webhookEvent.count({
			where: {
				shopId: shopConfig.id,
				createdAt: { gte: last24Hours },
			},
		});

		lastEvent = await prisma.webhookEvent.findFirst({
			where: { shopId: shopConfig.id },
			orderBy: { createdAt: "desc" },
		});

		// Get last successful event for health check
		lastSuccessfulEvent = await prisma.webhookEvent.findFirst({
			where: {
				shopId: shopConfig.id,
				status: "success",
			},
			orderBy: { createdAt: "desc" },
		});

		// Get recent events with pagination
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
		// Table doesn't exist yet (migration not run) - return empty stats
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
				webhookSubscriptions: {
					orderBy: { createdAt: "desc" },
					take: 1,
				},
			},
		});

		if (!shopConfig || !shopConfig.bynderBaseUrl) {
			return { error: "Shop not configured" };
		}

		const existingSubscription = shopConfig.webhookSubscriptions[0];
		const isActivating = formData.get("active") === "true";

		try {
			// Initialize Bynder client
			const bynderClient = BynderClient.createFromEnv(shopConfig.bynderBaseUrl);

			// Construct webhook URL
			const webhookUrl = `${env.SHOPIFY_APP_URL}/api/bynder/webhooks`;

			// Get event types from form (default to asset.tagged, media.tagged)
			const eventTypesInput = formData.get("eventTypes")?.toString() || "";
			const eventTypes =
				eventTypesInput.length > 0
					? eventTypesInput.split(",").map((e) => e.trim())
					: ["asset.tagged", "media.tagged"];

			if (isActivating) {
				// Create or update webhook subscription in Bynder
				let bynderWebhook: {
					id: string;
					url: string;
					events: string[];
					active: boolean;
				};
				if (existingSubscription?.bynderWebhookId) {
					// Update existing webhook in Bynder
					bynderWebhook = await updateWebhookSubscription(
						bynderClient,
						existingSubscription.bynderWebhookId,
						webhookUrl,
						eventTypes
					);
				} else {
					// Create new webhook subscription in Bynder
					bynderWebhook = await createWebhookSubscription(
						bynderClient,
						webhookUrl,
						eventTypes
					);
				}

				// Store in database
				if (existingSubscription) {
					// Update existing subscription
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
					// Create new subscription
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
				// Deactivate webhook
				if (existingSubscription?.active) {
					// Delete from Bynder
					try {
						await deleteWebhookSubscription(
							bynderClient,
							existingSubscription.bynderWebhookId
						);
					} catch (error) {
						console.error("Failed to delete webhook from Bynder:", error);
						// Continue to deactivate in database even if Bynder deletion fails
					}

					// Update in database
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

	const toggleExpand = (eventId: string) => {
		const newExpanded = new Set(expandedEvents);
		if (newExpanded.has(eventId)) {
			newExpanded.delete(eventId);
		} else {
			newExpanded.add(eventId);
		}
		setExpandedEvents(newExpanded);
	};

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

	const handleCopyUrl = async () => {
		if (!webhookUrl) return;
		try {
			await navigator.clipboard.writeText(webhookUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (error) {
			console.error("Failed to copy URL:", error);
		}
	};

	const handleTestWebhook = () => {
		testFetcher.submit(
			{},
			{ method: "POST", action: "/api/bynder/webhooks/test-endpoint" }
		);
	};

	const toggleEventType = (eventType: string) => {
		if (selectedEvents.includes(eventType)) {
			setSelectedEvents(selectedEvents.filter((e) => e !== eventType));
		} else {
			setSelectedEvents([...selectedEvents, eventType]);
		}
	};

	if (!shopConfig || !shopConfig.bynderBaseUrl) {
		return (
			<s-page heading="Web Hook">
				<s-section>
					<s-paragraph>
						Please configure Bynder in{" "}
						<s-link href="/app/settings">Settings</s-link> first.
					</s-paragraph>
				</s-section>
			</s-page>
		);
	}

	const isActive = webhookSubscription?.active || false;

	return (
		<s-page heading="Web Hook">
			{fetcher.data?.success && (
				<s-banner tone="success">
					{fetcher.data.message || "Webhook updated successfully!"}
				</s-banner>
			)}
			{fetcher.data?.error && (
				<s-banner tone="critical">
					Error:{" "}
					{typeof fetcher.data.error === "string"
						? fetcher.data.error
						: "An error occurred"}
				</s-banner>
			)}

			{/* Webhook Activation Section */}
			<s-section heading="Webhook Status">
				<s-stack direction="block" gap="base">
					<s-paragraph>
						When activated, this webhook listens to Bynder for new assets that
						match your sync criteria (defined in Settings) and automatically
						processes them into Shopify using the background job.
					</s-paragraph>

					{/* Status Display */}
					<s-stack direction="inline" gap="base" alignItems="center">
						<s-text>
							<strong>Status:</strong>{" "}
							<span
								style={{
									padding: "0.25rem 0.5rem",
									borderRadius: "4px",
									fontSize: "0.875rem",
									fontWeight: "600",
									backgroundColor: isActive ? "#d4edda" : "#f8d7da",
									color: isActive ? "#155724" : "#721c24",
								}}
							>
								{isActive ? "✓ Active" : "✗ Inactive"}
							</span>
						</s-text>
						{stats?.lastSuccessfulEventTime && (
							<div style={{ fontSize: "0.875rem", color: "#666" }}>
								<s-text>
									Last successful event:{" "}
									{new Date(stats.lastSuccessfulEventTime).toLocaleString()}
								</s-text>
							</div>
						)}
					</s-stack>

					{/* Webhook Endpoint URL with Copy */}
					<s-stack direction="block" gap="base">
						<s-text>
							<strong>Webhook Endpoint URL:</strong>
						</s-text>
						<s-stack direction="inline" gap="base" alignItems="center">
							<div
								style={{
									flex: 1,
									fontFamily: "monospace",
									fontSize: "0.875rem",
									wordBreak: "break-all",
									padding: "0.75rem",
									border: "1px solid #ddd",
									borderRadius: "4px",
								}}
							>
								{webhookUrl}
							</div>
							<s-button
								variant="secondary"
								onClick={handleCopyUrl}
								disabled={copied || !webhookUrl}
							>
								{copied ? "Copied!" : "Copy URL"}
							</s-button>
						</s-stack>
					</s-stack>

					{/* Event Type Selection */}
					{!isActive && (
						<fetcher.Form method="POST">
							<input type="hidden" name="intent" value="toggle_webhook" />
							<input type="hidden" name="active" value="true" />
							<input
								type="hidden"
								name="eventTypes"
								value={selectedEvents.join(",")}
							/>
							<s-stack direction="block" gap="base">
								<s-text>
									<strong>Event Types to Subscribe To:</strong>
								</s-text>
								<s-stack direction="inline" gap="base">
									{["asset.tagged", "media.tagged"].map((eventType) => (
										<label
											key={eventType}
											style={{
												display: "flex",
												alignItems: "center",
												gap: "0.5rem",
												cursor: "pointer",
											}}
										>
											<input
												type="checkbox"
												checked={selectedEvents.includes(eventType)}
												onChange={() => toggleEventType(eventType)}
											/>
											<s-text>{eventType}</s-text>
										</label>
									))}
								</s-stack>
							</s-stack>
						</fetcher.Form>
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
							<s-button
								type="submit"
								variant={isActive ? "secondary" : "primary"}
								disabled={isSubmitting}
							>
								{isSubmitting
									? "Updating..."
									: isActive
										? "Deactivate"
										: "Activate"}
							</s-button>
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
							<s-banner tone="success">
								{testFetcher.data.message ||
									"Webhook test completed successfully!"}
							</s-banner>
						) : (
							<s-banner tone="critical">
								Test failed:{" "}
								{typeof testFetcher.data.error === "string"
									? testFetcher.data.error
									: "Unknown error"}
							</s-banner>
						))}

					{/* Subscription Details */}
					{webhookSubscription && (
						<s-box
							padding="base"
							borderWidth="base"
							borderRadius="base"
							background="subdued"
						>
							<s-stack direction="block" gap="base">
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
					<s-stack direction="inline" gap="base">
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-text>Total Events</s-text>
							<s-heading>{stats.totalEvents}</s-heading>
						</s-box>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-text>Success Rate</s-text>
							<s-heading>
								{stats.successRate !== null ? `${stats.successRate}%` : "N/A"}
							</s-heading>
						</s-box>
						<s-box padding="base" borderWidth="base" borderRadius="base">
							<s-text>Events Last 24h</s-text>
							<s-heading>{stats.eventsLast24h}</s-heading>
						</s-box>
						{stats.lastEventTime && (
							<s-box padding="base" borderWidth="base" borderRadius="base">
								<s-text>Last Event</s-text>
								<s-heading>
									{new Date(stats.lastEventTime).toLocaleString()}
								</s-heading>
							</s-box>
						)}
					</s-stack>
				</s-section>
			)}

			{/* Recent Events Section */}
			<s-section heading="Recent Events">
				<s-stack direction="block" gap="base">
					{/* Filters */}
					<s-stack direction="block" gap="base">
						<s-stack direction="inline" gap="base">
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
						</s-stack>
						<s-text-field
							label="Filter by Asset ID"
							value={assetIdFilter}
							onChange={(e) => {
								const target = e.currentTarget;
								if (target) {
									setAssetIdFilter(target.value);
								}
							}}
							placeholder="Enter asset ID to filter..."
						/>
					</s-stack>

					{/* Events Table */}
					{filteredEvents.length === 0 ? (
						<s-paragraph>No webhook events yet.</s-paragraph>
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
											Timestamp
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
											}}
										>
											Event Type
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
											}}
										>
											Asset ID
										</th>
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
												textAlign: "center",
												fontWeight: "600",
											}}
										>
											Actions
										</th>
									</tr>
								</thead>
								<tbody>
									{filteredEvents.map(
										(event: (typeof recentEvents)[number], index: number) => {
											const isExpanded = expandedEvents.has(event.id);
											return (
												<>
													<tr
														key={event.id}
														style={{
															borderBottom: "1px solid #eee",
															backgroundColor:
																index % 2 === 0 ? "#fff" : "#fafafa",
														}}
													>
														<td
															style={{
																padding: "0.75rem",
																whiteSpace: "nowrap",
															}}
														>
															{new Date(event.createdAt).toLocaleString()}
														</td>
														<td style={{ padding: "0.75rem" }}>
															{event.eventType}
														</td>
														<td style={{ padding: "0.75rem" }}>
															{event.assetId || "-"}
														</td>
														<td style={{ padding: "0.75rem" }}>
															<span
																style={{
																	padding: "0.25rem 0.5rem",
																	borderRadius: "4px",
																	fontSize: "0.75rem",
																	fontWeight: "600",
																	textTransform: "uppercase",
																	backgroundColor:
																		event.status === "success"
																			? "#d4edda"
																			: "#f8d7da",
																	color:
																		event.status === "success"
																			? "#155724"
																			: "#721c24",
																}}
															>
																{event.status}
															</span>
														</td>
														<td
															style={{
																padding: "0.75rem",
																textAlign: "center",
															}}
														>
															<button
																type="button"
																onClick={() => toggleExpand(event.id)}
																style={{
																	background: "none",
																	border: "none",
																	color: "#0066cc",
																	cursor: "pointer",
																	padding: "0.25rem 0.5rem",
																	fontSize: "0.875rem",
																	textDecoration: "underline",
																}}
															>
																{isExpanded ? "Hide Details" : "Show Details"}
															</button>
														</td>
													</tr>
													{isExpanded && (
														<tr
															key={`${event.id}-details`}
															style={{
																backgroundColor: "#f9f9f9",
															}}
														>
															<td colSpan={5} style={{ padding: "1rem" }}>
																<s-stack direction="block" gap="base">
																	{event.error && (
																		<s-box
																			padding="base"
																			borderWidth="base"
																			borderRadius="base"
																			background="subdued"
																		>
																			<s-text tone="critical">
																				<strong>Error:</strong> {event.error}
																			</s-text>
																		</s-box>
																	)}
																	{event.processedAt && (
																		<s-text>
																			<strong>Processed At:</strong>{" "}
																			{new Date(
																				event.processedAt
																			).toLocaleString()}
																		</s-text>
																	)}
																	<s-text>
																		<strong>Payload:</strong>
																	</s-text>
																	<s-box
																		padding="base"
																		borderWidth="base"
																		borderRadius="base"
																		background="subdued"
																	>
																		<pre
																			style={{
																				margin: 0,
																				fontSize: "0.75rem",
																				overflow: "auto",
																				maxHeight: "400px",
																			}}
																		>
																			<code>
																				{JSON.stringify(
																					JSON.parse(event.payload),
																					null,
																					2
																				)}
																			</code>
																		</pre>
																	</s-box>
																</s-stack>
															</td>
														</tr>
													)}
												</>
											);
										}
									)}
								</tbody>
							</table>
						</div>
					)}

					{/* Pagination */}
					{pagination && pagination.totalPages > 1 && (
						<s-stack direction="inline" gap="base" alignItems="center">
							<s-text>
								Page {pagination.page} of {pagination.totalPages} (
								{pagination.total} total events)
							</s-text>
							<s-stack direction="inline" gap="base">
								{pagination.page > 1 && (
									<s-button
										variant="secondary"
										href={`/app/webhooks?page=${pagination.page - 1}`}
									>
										Previous
									</s-button>
								)}
								{pagination.page < pagination.totalPages && (
									<s-button
										variant="secondary"
										href={`/app/webhooks?page=${pagination.page + 1}`}
									>
										Next
									</s-button>
								)}
							</s-stack>
						</s-stack>
					)}
				</s-stack>
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
