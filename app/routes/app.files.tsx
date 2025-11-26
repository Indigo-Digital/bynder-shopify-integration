import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
	useFetcher,
	useLoaderData,
	useNavigate,
	useSearchParams,
} from "react-router";
import { BynderPicker } from "../components/BynderPicker.js";
import { FilePreviewModal } from "../components/FilePreviewModal.js";
import prisma from "../db.server.js";
import type { ShopifyFileDetails } from "../lib/shopify/file-query.js";
import { getShopifyFileDetails } from "../lib/shopify/file-query.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session, admin } = await authenticate.admin(request);
	const shop = session.shop;

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	// Parse query params for pagination and filtering
	const url = new URL(request.url);
	const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
	const limit = Math.min(
		100,
		Math.max(10, parseInt(url.searchParams.get("limit") || "50", 10))
	);
	const skip = (page - 1) * limit;

	// Get synced assets with pagination
	const syncedAssets = shopConfig
		? await prisma.syncedAsset.findMany({
				where: { shopId: shopConfig.id },
				orderBy: { syncedAt: "desc" },
				skip,
				take: limit,
			})
		: [];

	// Get total count for pagination
	const totalCount = shopConfig
		? await prisma.syncedAsset.count({
				where: { shopId: shopConfig.id },
			})
		: 0;

	// Fetch Shopify file details for all synced assets
	let fileDetailsMap = new Map();
	if (syncedAssets.length > 0 && admin) {
		const fileIds = syncedAssets
			.map((asset) => asset.shopifyFileId)
			.filter((id): id is string => Boolean(id));

		if (fileIds.length > 0) {
			try {
				fileDetailsMap = await getShopifyFileDetails(admin, fileIds);
			} catch (error) {
				console.error("Failed to fetch Shopify file details:", error);
				// Continue without file details rather than failing completely
			}
		}
	}

	// Combine synced assets with file details
	const assetsWithDetails = syncedAssets.map((asset) => {
		const fileDetails = fileDetailsMap.get(asset.shopifyFileId) || null;
		return {
			...asset,
			fileDetails,
		};
	});

	return {
		shop,
		shopConfig,
		syncedAssets: assetsWithDetails,
		pagination: {
			page,
			limit,
			total: totalCount,
			totalPages: Math.ceil(totalCount / limit),
		},
	};
};

export default function FilesPage() {
	const { shopConfig, syncedAssets, shop, pagination } =
		useLoaderData<typeof loader>();
	const [showPicker, setShowPicker] = useState(false);
	const [previewAsset, setPreviewAsset] = useState<{
		asset: (typeof syncedAssets)[number];
		file: ShopifyFileDetails;
	} | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedSyncType, setSelectedSyncType] = useState<string>("all");
	const [selectedTag, setSelectedTag] = useState<string>("all");
	const fetcher = useFetcher();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

	// Initialize search from URL params
	useEffect(() => {
		const query = searchParams.get("search") || "";
		const syncType = searchParams.get("syncType") || "all";
		const tag = searchParams.get("tag") || "all";
		setSearchQuery(query);
		setSelectedSyncType(syncType);
		setSelectedTag(tag);
	}, [searchParams]);

	const handleAssetSelect = async (assetId: string) => {
		setShowPicker(false); // Close modal immediately
		fetcher.submit(
			{ assetId },
			{
				method: "POST",
				action: `/api/sync?assetId=${assetId}`,
			}
		);
	};

	// Show success/error messages
	const showSuccess =
		fetcher.data && "success" in fetcher.data && fetcher.data.success;
	const showError = fetcher.data && "error" in fetcher.data;

	// Extract all unique tags and sync types for filters
	const allTags = useMemo(() => {
		const tagSet = new Set<string>();
		syncedAssets.forEach((asset) => {
			if (asset.fileDetails?.bynderMetadata?.tags) {
				asset.fileDetails.bynderMetadata.tags.forEach((tag: string) => {
					tagSet.add(tag);
				});
			}
		});
		return Array.from(tagSet).sort();
	}, [syncedAssets]);

	const allSyncTypes = useMemo(() => {
		const typeSet = new Set<string>();
		syncedAssets.forEach((asset) => {
			typeSet.add(asset.syncType);
		});
		return Array.from(typeSet).sort();
	}, [syncedAssets]);

	// Filter assets based on search and filters
	const filteredAssets = useMemo(() => {
		return syncedAssets.filter((asset) => {
			// Search filter
			if (searchQuery) {
				const query = searchQuery.toLowerCase();
				const matchesId = asset.bynderAssetId.toLowerCase().includes(query);
				const matchesTags =
					asset.fileDetails?.bynderMetadata?.tags?.some((tag: string) =>
						tag.toLowerCase().includes(query)
					) || false;
				if (!matchesId && !matchesTags) {
					return false;
				}
			}

			// Sync type filter
			if (selectedSyncType !== "all" && asset.syncType !== selectedSyncType) {
				return false;
			}

			// Tag filter
			if (
				selectedTag !== "all" &&
				!asset.fileDetails?.bynderMetadata?.tags?.includes(selectedTag)
			) {
				return false;
			}

			return true;
		});
	}, [syncedAssets, searchQuery, selectedSyncType, selectedTag]);

	// Debounced search update to URL
	const updateSearchParams = (updates: Record<string, string>) => {
		const params = new URLSearchParams(searchParams);
		Object.entries(updates).forEach(([key, value]) => {
			if (value && value !== "all") {
				params.set(key, value);
			} else {
				params.delete(key);
			}
		});
		navigate(`?${params.toString()}`, { replace: true });
	};

	const handleSearchChange = (value: string) => {
		setSearchQuery(value);
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}
		debounceTimerRef.current = setTimeout(() => {
			updateSearchParams({ search: value });
		}, 500);
	};

	// Cleanup debounce timer on unmount
	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, []);

	const handleSyncTypeChange = (value: string) => {
		setSelectedSyncType(value);
		updateSearchParams({ syncType: value });
	};

	const handleTagChange = (value: string) => {
		setSelectedTag(value);
		updateSearchParams({ tag: value });
	};

	const handlePageChange = (newPage: number) => {
		const params = new URLSearchParams(searchParams);
		params.set("page", newPage.toString());
		navigate(`?${params.toString()}`);
	};

	const handlePreview = (asset: (typeof syncedAssets)[number]) => {
		if (asset.fileDetails) {
			setPreviewAsset({ asset, file: asset.fileDetails });
		}
	};

	if (!shopConfig || !shopConfig.bynderBaseUrl) {
		return (
			<s-page heading="Bynder Files">
				<s-section>
					<s-paragraph>
						Please configure Bynder connection in{" "}
						<s-link href="/app/settings">Settings</s-link>.
					</s-paragraph>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="Bynder Files">
			<s-button
				slot="primary-action"
				onClick={() => setShowPicker(true)}
				disabled={fetcher.state !== "idle"}
			>
				{fetcher.state !== "idle" ? "Syncing..." : "Import from Bynder"}
			</s-button>

			{showSuccess && (
				<s-banner tone="success">
					Asset imported successfully! Refresh the page to see it in the list.
				</s-banner>
			)}

			{showError && (
				<s-banner tone="critical">
					Error importing asset:{" "}
					{typeof fetcher.data === "object" &&
					fetcher.data !== null &&
					"error" in fetcher.data
						? String(fetcher.data.error)
						: "Unknown error"}
				</s-banner>
			)}

			{showPicker && (
				<div
					style={{
						position: "fixed",
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						backgroundColor: "rgba(0, 0, 0, 0.6)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 10000,
						padding: "1rem",
					}}
					onClick={(e) => {
						if (e.target === e.currentTarget) {
							setShowPicker(false);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setShowPicker(false);
						}
					}}
					role="dialog"
					aria-modal="true"
					aria-label="Select asset from Bynder"
					tabIndex={-1}
				>
					<div
						style={{
							backgroundColor: "white",
							borderRadius: "8px",
							boxShadow:
								"0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
							padding: "0",
							maxWidth: "95vw",
							maxHeight: "95vh",
							width: "900px",
							display: "flex",
							flexDirection: "column",
							overflow: "hidden",
						}}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
							}
						}}
					>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								padding: "1.5rem",
								borderBottom: "1px solid #e5e7eb",
							}}
						>
							<h2
								style={{
									margin: 0,
									fontSize: "1.25rem",
									fontWeight: "600",
									color: "#111827",
								}}
							>
								Select Asset from Bynder
							</h2>
							<button
								type="button"
								onClick={() => setShowPicker(false)}
								style={{
									background: "none",
									border: "none",
									fontSize: "1.5rem",
									cursor: "pointer",
									padding: "0.25rem 0.5rem",
									color: "#6b7280",
									lineHeight: "1",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
								}}
								aria-label="Close"
							>
								×
							</button>
						</div>
						<div
							style={{
								flex: 1,
								overflow: "auto",
								padding: "1.5rem",
								minHeight: "600px",
							}}
						>
							<BynderPicker
								baseUrl={shopConfig.bynderBaseUrl}
								onAssetSelect={handleAssetSelect}
								onClose={() => setShowPicker(false)}
								mode="SingleSelect"
							/>
						</div>
					</div>
				</div>
			)}

			<s-section heading="Synced Assets">
				{/* Search and Filter Bar */}
				{syncedAssets.length > 0 && (
					<div
						style={{
							display: "flex",
							flexWrap: "wrap",
							gap: "1rem",
							marginBottom: "1.5rem",
							padding: "1rem",
							backgroundColor: "#f9fafb",
							borderRadius: "8px",
						}}
					>
						<div style={{ flex: "1 1 300px", minWidth: "200px" }}>
							<label
								htmlFor="search-input"
								style={{
									display: "block",
									marginBottom: "0.5rem",
									fontSize: "0.875rem",
									fontWeight: "500",
									color: "#374151",
								}}
							>
								Search
							</label>
							<input
								id="search-input"
								type="text"
								value={searchQuery}
								onChange={(e) => handleSearchChange(e.target.value)}
								placeholder="Search by asset ID or tags..."
								style={{
									width: "100%",
									padding: "0.5rem 0.75rem",
									border: "1px solid #d1d5db",
									borderRadius: "6px",
									fontSize: "0.875rem",
								}}
							/>
						</div>

						{allSyncTypes.length > 0 && (
							<div style={{ flex: "0 1 150px" }}>
								<label
									htmlFor="sync-type-filter"
									style={{
										display: "block",
										marginBottom: "0.5rem",
										fontSize: "0.875rem",
										fontWeight: "500",
										color: "#374151",
									}}
								>
									Sync Type
								</label>
								<select
									id="sync-type-filter"
									value={selectedSyncType}
									onChange={(e) => handleSyncTypeChange(e.target.value)}
									style={{
										width: "100%",
										padding: "0.5rem 0.75rem",
										border: "1px solid #d1d5db",
										borderRadius: "6px",
										fontSize: "0.875rem",
										backgroundColor: "white",
									}}
								>
									<option value="all">All Types</option>
									{allSyncTypes.map((type) => (
										<option key={type} value={type}>
											{type}
										</option>
									))}
								</select>
							</div>
						)}

						{allTags.length > 0 && (
							<div style={{ flex: "0 1 150px" }}>
								<label
									htmlFor="tag-filter"
									style={{
										display: "block",
										marginBottom: "0.5rem",
										fontSize: "0.875rem",
										fontWeight: "500",
										color: "#374151",
									}}
								>
									Tag
								</label>
								<select
									id="tag-filter"
									value={selectedTag}
									onChange={(e) => handleTagChange(e.target.value)}
									style={{
										width: "100%",
										padding: "0.5rem 0.75rem",
										border: "1px solid #d1d5db",
										borderRadius: "6px",
										fontSize: "0.875rem",
										backgroundColor: "white",
									}}
								>
									<option value="all">All Tags</option>
									{allTags.map((tag) => (
										<option key={tag} value={tag}>
											{tag}
										</option>
									))}
								</select>
							</div>
						)}
					</div>
				)}

				{/* Results count */}
				{syncedAssets.length > 0 && (
					<div
						style={{
							marginBottom: "1rem",
							color: "#6b7280",
							fontSize: "0.875rem",
						}}
					>
						Showing {filteredAssets.length} of {pagination.total} assets
					</div>
				)}

				{/* Assets Table */}
				{syncedAssets.length === 0 ? (
					<s-paragraph>
						No assets synced yet. Click "Import from Bynder" to get started.
					</s-paragraph>
				) : filteredAssets.length === 0 ? (
					<s-paragraph>
						No assets match your filters. Try adjusting your search criteria.
					</s-paragraph>
				) : (
					<>
						<div style={{ overflowX: "auto" }}>
							<table style={{ width: "100%", borderCollapse: "collapse" }}>
								<thead>
									<tr style={{ borderBottom: "2px solid #e5e7eb" }}>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
												color: "#374151",
												fontSize: "0.875rem",
											}}
										>
											Preview
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
												color: "#374151",
												fontSize: "0.875rem",
											}}
										>
											Asset ID
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
												color: "#374151",
												fontSize: "0.875rem",
											}}
										>
											Tags
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
												color: "#374151",
												fontSize: "0.875rem",
											}}
										>
											Sync Type
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
												color: "#374151",
												fontSize: "0.875rem",
											}}
										>
											Synced At
										</th>
										<th
											style={{
												padding: "0.75rem",
												textAlign: "left",
												fontWeight: "600",
												color: "#374151",
												fontSize: "0.875rem",
											}}
										>
											Actions
										</th>
									</tr>
								</thead>
								<tbody>
									{filteredAssets.map(
										(asset: (typeof syncedAssets)[number]) => {
											const fileDetails = asset.fileDetails;
											const thumbnailUrl = fileDetails?.thumbnailUrl;
											const tags = fileDetails?.bynderMetadata?.tags || [];

											return (
												<tr
													key={asset.id}
													style={{
														borderBottom: "1px solid #e5e7eb",
														cursor: fileDetails ? "pointer" : "default",
													}}
													onClick={() => fileDetails && handlePreview(asset)}
												>
													<td style={{ padding: "0.75rem" }}>
														{thumbnailUrl ? (
															<img
																src={thumbnailUrl}
																alt={fileDetails?.altText || "Preview"}
																style={{
																	width: "60px",
																	height: "60px",
																	objectFit: "cover",
																	borderRadius: "4px",
																	border: "1px solid #e5e7eb",
																}}
															/>
														) : (
															<div
																style={{
																	width: "60px",
																	height: "60px",
																	backgroundColor: "#f3f4f6",
																	borderRadius: "4px",
																	display: "flex",
																	alignItems: "center",
																	justifyContent: "center",
																	border: "1px solid #e5e7eb",
																}}
															>
																<svg
																	width="24"
																	height="24"
																	viewBox="0 0 24 24"
																	fill="none"
																	stroke="currentColor"
																	strokeWidth="2"
																	style={{ color: "#9ca3af" }}
																	role="img"
																	aria-label="File icon"
																>
																	<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
																	<polyline points="14 2 14 8 20 8" />
																</svg>
															</div>
														)}
													</td>
													<td style={{ padding: "0.75rem" }}>
														<span
															style={{
																fontFamily: "monospace",
																fontSize: "0.875rem",
															}}
														>
															{asset.bynderAssetId}
														</span>
													</td>
													<td style={{ padding: "0.75rem" }}>
														{tags.length > 0 ? (
															<div
																style={{
																	display: "flex",
																	flexWrap: "wrap",
																	gap: "0.25rem",
																}}
															>
																{tags.slice(0, 3).map((tag: string) => (
																	<span
																		key={tag}
																		style={{
																			backgroundColor: "#e5e7eb",
																			color: "#374151",
																			padding: "0.125rem 0.5rem",
																			borderRadius: "9999px",
																			fontSize: "0.75rem",
																		}}
																	>
																		{tag}
																	</span>
																))}
																{tags.length > 3 && (
																	<span
																		style={{
																			color: "#6b7280",
																			fontSize: "0.75rem",
																		}}
																	>
																		+{tags.length - 3}
																	</span>
																)}
															</div>
														) : (
															<span
																style={{
																	color: "#9ca3af",
																	fontSize: "0.875rem",
																}}
															>
																No tags
															</span>
														)}
													</td>
													<td style={{ padding: "0.75rem" }}>
														<span style={{ fontSize: "0.875rem" }}>
															{asset.syncType}
														</span>
													</td>
													<td style={{ padding: "0.75rem" }}>
														<span style={{ fontSize: "0.875rem" }}>
															{new Date(asset.syncedAt).toLocaleString()}
														</span>
													</td>
													<td style={{ padding: "0.75rem" }}>
														{fileDetails ? (
															<button
																type="button"
																onClick={(e) => {
																	e.stopPropagation();
																	handlePreview(asset);
																}}
																style={{
																	background: "none",
																	border: "none",
																	color: "#2563eb",
																	cursor: "pointer",
																	textDecoration: "underline",
																	fontSize: "0.875rem",
																}}
															>
																Preview
															</button>
														) : (
															<span
																style={{
																	color: "#9ca3af",
																	fontSize: "0.875rem",
																}}
															>
																No details
															</span>
														)}
													</td>
												</tr>
											);
										}
									)}
								</tbody>
							</table>
						</div>

						{/* Pagination */}
						{pagination.totalPages > 1 && (
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginTop: "1.5rem",
									paddingTop: "1rem",
									borderTop: "1px solid #e5e7eb",
								}}
							>
								<div style={{ color: "#6b7280", fontSize: "0.875rem" }}>
									Page {pagination.page} of {pagination.totalPages} (
									{pagination.total} total)
								</div>
								<div style={{ display: "flex", gap: "0.5rem" }}>
									<button
										type="button"
										onClick={() => handlePageChange(pagination.page - 1)}
										disabled={pagination.page <= 1}
										style={{
											padding: "0.5rem 1rem",
											border: "1px solid #d1d5db",
											borderRadius: "6px",
											backgroundColor:
												pagination.page <= 1 ? "#f9fafb" : "white",
											color: pagination.page <= 1 ? "#9ca3af" : "#374151",
											cursor: pagination.page <= 1 ? "not-allowed" : "pointer",
											fontSize: "0.875rem",
										}}
									>
										Previous
									</button>
									<button
										type="button"
										onClick={() => handlePageChange(pagination.page + 1)}
										disabled={pagination.page >= pagination.totalPages}
										style={{
											padding: "0.5rem 1rem",
											border: "1px solid #d1d5db",
											borderRadius: "6px",
											backgroundColor:
												pagination.page >= pagination.totalPages
													? "#f9fafb"
													: "white",
											color:
												pagination.page >= pagination.totalPages
													? "#9ca3af"
													: "#374151",
											cursor:
												pagination.page >= pagination.totalPages
													? "not-allowed"
													: "pointer",
											fontSize: "0.875rem",
										}}
									>
										Next
									</button>
								</div>
							</div>
						)}
					</>
				)}
			</s-section>

			{/* Preview Modal */}
			{previewAsset && (
				<FilePreviewModal
					file={previewAsset.file}
					syncedAsset={{
						id: previewAsset.asset.id,
						bynderAssetId: previewAsset.asset.bynderAssetId,
						syncType: previewAsset.asset.syncType,
						syncedAt: previewAsset.asset.syncedAt,
					}}
					shop={shop}
					onClose={() => setPreviewAsset(null)}
				/>
			)}
		</s-page>
	);
}

export const headers = boundary.headers;
