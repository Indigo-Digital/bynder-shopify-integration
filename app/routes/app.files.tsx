import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export default function SyncedAssetsPage() {
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

	const handleAssetSelect = useCallback(
		async (assetId: string) => {
			setShowPicker(false);
			const encodedAssetId = encodeURIComponent(assetId);
			fetcher.submit(
				{ assetId },
				{
					method: "POST",
					action: `/api/sync?assetId=${encodedAssetId}`,
				}
			);
		},
		[fetcher]
	);

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

			if (selectedSyncType !== "all" && asset.syncType !== selectedSyncType) {
				return false;
			}

			if (
				selectedTag !== "all" &&
				!asset.fileDetails?.bynderMetadata?.tags?.includes(selectedTag)
			) {
				return false;
			}

			return true;
		});
	}, [syncedAssets, searchQuery, selectedSyncType, selectedTag]);

	const updateSearchParams = useCallback(
		(updates: Record<string, string>) => {
			const params = new URLSearchParams(searchParams);
			Object.entries(updates).forEach(([key, value]) => {
				if (value && value !== "all") {
					params.set(key, value);
				} else {
					params.delete(key);
				}
			});
			navigate(`?${params.toString()}`, { replace: true });
		},
		[navigate, searchParams]
	);

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchQuery(value);
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
			debounceTimerRef.current = setTimeout(() => {
				updateSearchParams({ search: value });
			}, 500);
		},
		[updateSearchParams]
	);

	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, []);

	const handleSyncTypeChange = useCallback(
		(value: string) => {
			setSelectedSyncType(value);
			updateSearchParams({ syncType: value });
		},
		[updateSearchParams]
	);

	const handleTagChange = useCallback(
		(value: string) => {
			setSelectedTag(value);
			updateSearchParams({ tag: value });
		},
		[updateSearchParams]
	);

	const handlePageChange = useCallback(
		(newPage: number) => {
			const params = new URLSearchParams(searchParams);
			params.set("page", newPage.toString());
			navigate(`?${params.toString()}`);
		},
		[navigate, searchParams]
	);

	const handlePreview = useCallback((asset: (typeof syncedAssets)[number]) => {
		if (asset.fileDetails) {
			setPreviewAsset({ asset, file: asset.fileDetails });
		}
	}, []);

	if (!shopConfig || !shopConfig.bynderBaseUrl) {
		return (
			<s-page heading="Synced Assets">
				<s-section>
					<s-banner tone="warning">
						Please configure Bynder connection in{" "}
						<s-link href="/app/settings">Settings</s-link>.
					</s-banner>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="Synced Assets">
			<s-button
				slot="primary-action"
				onClick={() => setShowPicker(true)}
				disabled={fetcher.state !== "idle"}
			>
				{fetcher.state !== "idle" ? "Syncing..." : "Import from Bynder"}
			</s-button>

			{/* Info Banner */}
			<s-banner tone="info">
				This page shows assets synced from Bynder and tracked in the database.
				For all files in Shopify, use the{" "}
				<s-link href="/app/file-manager">File Manager</s-link>.
			</s-banner>

			{showSuccess && (
				<s-banner tone="success" dismissible>
					Asset imported successfully! Refresh the page to see it in the list.
				</s-banner>
			)}

			{showError && (
				<s-banner tone="critical" dismissible>
					Error importing asset:{" "}
					{typeof fetcher.data === "object" &&
					fetcher.data !== null &&
					"error" in fetcher.data
						? String(fetcher.data.error)
						: "Unknown error"}
				</s-banner>
			)}

			{showPicker && (
				<BynderPicker
					baseUrl={shopConfig.bynderBaseUrl}
					onAssetSelect={handleAssetSelect}
					onClose={() => setShowPicker(false)}
					mode="SingleSelect"
				/>
			)}

			<s-section heading="Bynder-Synced Assets">
				{/* Filter Bar using Polaris components */}
				{syncedAssets.length > 0 && (
					<s-stack direction="block" gap="base">
						<s-stack direction="inline" gap="base" alignItems="end">
							<s-search-field
								label="Search"
								placeholder="Search by asset ID or tags..."
								value={searchQuery}
								onInput={(e) =>
									handleSearchChange((e.target as HTMLInputElement).value)
								}
							/>

							{allSyncTypes.length > 0 && (
								<s-select
									label="Sync Type"
									value={selectedSyncType}
									onChange={(e) =>
										handleSyncTypeChange((e.target as HTMLSelectElement).value)
									}
								>
									<option value="all">All Types</option>
									{allSyncTypes.map((type) => (
										<option key={type} value={type}>
											{type}
										</option>
									))}
								</s-select>
							)}

							{allTags.length > 0 && (
								<s-select
									label="Tag"
									value={selectedTag}
									onChange={(e) =>
										handleTagChange((e.target as HTMLSelectElement).value)
									}
								>
									<option value="all">All Tags</option>
									{allTags.map((tag) => (
										<option key={tag} value={tag}>
											{tag}
										</option>
									))}
								</s-select>
							)}
						</s-stack>

						<s-text color="subdued">
							Showing {filteredAssets.length} of {pagination.total} assets
						</s-text>
					</s-stack>
				)}

				{/* Assets Table */}
				{syncedAssets.length === 0 ? (
					<s-box padding="large" background="subdued" borderRadius="base">
						<s-stack direction="block" gap="base" alignItems="center">
							<s-text>No assets synced yet.</s-text>
							<s-button onClick={() => setShowPicker(true)}>
								Import from Bynder
							</s-button>
						</s-stack>
					</s-box>
				) : filteredAssets.length === 0 ? (
					<s-box padding="large" background="subdued" borderRadius="base">
						<s-text>
							No assets match your filters. Try adjusting your search criteria.
						</s-text>
					</s-box>
				) : (
					<>
						<s-table>
							<s-table-header-row>
								<s-table-header listSlot="primary">Preview</s-table-header>
								<s-table-header listSlot="secondary">Asset ID</s-table-header>
								<s-table-header>Tags</s-table-header>
								<s-table-header>Sync Type</s-table-header>
								<s-table-header>Synced At</s-table-header>
								<s-table-header>Actions</s-table-header>
							</s-table-header-row>
							<s-table-body>
								{filteredAssets.map((asset: (typeof syncedAssets)[number]) => {
									const fileDetails = asset.fileDetails;
									const thumbnailUrl = fileDetails?.thumbnailUrl;
									const tags = fileDetails?.bynderMetadata?.tags || [];

									return (
										<s-table-row
											key={asset.id}
											clickDelegate={`preview-${asset.id}`}
										>
											<s-table-cell>
												{thumbnailUrl ? (
													<s-thumbnail
														src={thumbnailUrl}
														alt={fileDetails?.altText || "Preview"}
														size="small"
													/>
												) : (
													<s-box
														minInlineSize="40px"
														minBlockSize="40px"
														background="subdued"
														borderRadius="small"
													>
														<s-stack
															alignItems="center"
															justifyContent="center"
															blockSize="40px"
														>
															<s-icon type="file" color="subdued" />
														</s-stack>
													</s-box>
												)}
											</s-table-cell>
											<s-table-cell>
												<s-text>{asset.bynderAssetId}</s-text>
											</s-table-cell>
											<s-table-cell>
												{tags.length > 0 ? (
													<s-stack direction="inline" gap="small-200">
														{tags.slice(0, 2).map((tag: string) => (
															<s-chip key={tag} color="base">
																{tag}
															</s-chip>
														))}
														{tags.length > 2 && (
															<s-text color="subdued">
																+{tags.length - 2}
															</s-text>
														)}
													</s-stack>
												) : (
													<s-text color="subdued">No tags</s-text>
												)}
											</s-table-cell>
											<s-table-cell>
												<s-badge tone="neutral">{asset.syncType}</s-badge>
											</s-table-cell>
											<s-table-cell>
												<s-text>
													{new Date(asset.syncedAt).toLocaleDateString()}
												</s-text>
											</s-table-cell>
											<s-table-cell>
												{fileDetails ? (
													<s-button
														id={`preview-${asset.id}`}
														variant="tertiary"
														onClick={() => handlePreview(asset)}
													>
														Preview
													</s-button>
												) : (
													<s-text color="subdued">No details</s-text>
												)}
											</s-table-cell>
										</s-table-row>
									);
								})}
							</s-table-body>
						</s-table>

						{/* Pagination using Polaris */}
						{pagination.totalPages > 1 && (
							<s-stack
								direction="inline"
								gap="base"
								justifyContent="space-between"
								alignItems="center"
								padding="base"
							>
								<s-text color="subdued">
									Page {pagination.page} of {pagination.totalPages} (
									{pagination.total} total)
								</s-text>
								<s-stack direction="inline" gap="small">
									<s-button
										variant="secondary"
										onClick={() => handlePageChange(pagination.page - 1)}
										disabled={pagination.page <= 1}
									>
										Previous
									</s-button>
									<s-button
										variant="secondary"
										onClick={() => handlePageChange(pagination.page + 1)}
										disabled={pagination.page >= pagination.totalPages}
									>
										Next
									</s-button>
								</s-stack>
							</s-stack>
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
