import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { BynderAsset } from "../lib/bynder/types.js";

interface AssetBrowserProps {
	onTagSelect: (tag: string) => void;
	existingTags: string[];
	baseUrl: string;
}

export interface AssetsResponse {
	assets: BynderAsset[];
	total: number;
	page: number;
	limit: number;
	hasMore: boolean;
}

type ViewMode = "grid" | "list";

export function AssetBrowser({
	onTagSelect,
	existingTags,
	baseUrl: _baseUrl,
}: AssetBrowserProps) {
	const fetcher = useFetcher<AssetsResponse | { error: string }>();
	const [keyword, setKeyword] = useState("");
	const [searchKeyword, setSearchKeyword] = useState("");
	const [selectedTags, setSelectedTags] = useState<string[]>([]);
	const [assetType, setAssetType] = useState<string>("");
	const [page, setPage] = useState(1);
	const [viewMode, setViewMode] = useState<ViewMode>("grid");
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

	const limit = 24;

	// Debounced search
	useEffect(() => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}

		debounceTimerRef.current = setTimeout(() => {
			setSearchKeyword(keyword);
			setPage(1); // Reset to first page on new search
		}, 500);

		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, [keyword]);

	// Fetch assets when filters change
	useEffect(() => {
		const params = new URLSearchParams();
		if (searchKeyword) {
			params.set("keyword", searchKeyword);
		}
		if (selectedTags.length > 0) {
			params.set("tags", selectedTags.join(","));
		}
		if (assetType) {
			params.set("type", assetType);
		}
		params.set("page", page.toString());
		params.set("limit", limit.toString());

		fetcher.load(`/api/bynder/assets?${params.toString()}`);
	}, [searchKeyword, selectedTags, assetType, page, fetcher.load]);

	const handleTagClick = useCallback(
		(tag: string) => {
			if (!existingTags.includes(tag)) {
				onTagSelect(tag);
			}
		},
		[existingTags, onTagSelect]
	);

	const handleTagFilterToggle = (tag: string) => {
		setSelectedTags((prev) =>
			prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
		);
		setPage(1);
	};

	const assets =
		fetcher.data && "assets" in fetcher.data ? fetcher.data.assets : [];
	const total =
		fetcher.data && "total" in fetcher.data ? fetcher.data.total : 0;
	const hasMore =
		fetcher.data && "hasMore" in fetcher.data ? fetcher.data.hasMore : false;
	const isLoading = fetcher.state === "loading";
	const error =
		fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

	// Extract all unique tags from current assets for filter dropdown
	const allTagsFromAssets = Array.from(
		new Set(assets.flatMap((asset) => asset.tags || []))
	).sort();

	// Get thumbnail URL for an asset
	const getThumbnailUrl = (asset: BynderAsset): string | null => {
		if (asset.thumbnails && Object.keys(asset.thumbnails).length > 0) {
			// Try to get a webimage thumbnail first, then any available thumbnail
			return (
				asset.thumbnails.webimage ||
				asset.thumbnails.thul ||
				Object.values(asset.thumbnails)[0] ||
				null
			);
		}
		return null;
	};

	return (
		<s-stack direction="block" gap="base">
			{/* Search and Filters */}
			<s-stack direction="block" gap="base">
				<s-stack direction="inline" gap="base">
					<s-text-field
						label="Search Assets"
						value={keyword}
						onChange={(e) => {
							const target = e.currentTarget;
							if (target) {
								setKeyword(target.value);
							}
						}}
						placeholder="Search by name or description..."
					/>
					<div>
						<label
							htmlFor="asset-type-select"
							style={{
								display: "block",
								marginBottom: "0.5rem",
								fontWeight: "500",
							}}
						>
							Asset Type
						</label>
						<select
							id="asset-type-select"
							value={assetType}
							onChange={(e) => {
								setAssetType(e.target.value);
								setPage(1);
							}}
							style={{
								padding: "0.5rem",
								borderRadius: "4px",
								border: "1px solid #ccc",
								fontSize: "1rem",
								minWidth: "150px",
							}}
						>
							<option value="">All Types</option>
							<option value="image">Image</option>
							<option value="video">Video</option>
							<option value="document">Document</option>
							<option value="audio">Audio</option>
						</select>
					</div>
					<s-button
						variant="secondary"
						onClick={() => {
							setViewMode(viewMode === "grid" ? "list" : "grid");
						}}
					>
						{viewMode === "grid" ? "List View" : "Grid View"}
					</s-button>
				</s-stack>

				{/* Tag Filters */}
				{allTagsFromAssets.length > 0 && (
					<s-stack direction="block" gap="base">
						<s-text>
							<strong>Filter by Tags:</strong>
						</s-text>
						<div
							style={{
								display: "flex",
								flexWrap: "wrap",
								gap: "0.5rem",
							}}
						>
							{allTagsFromAssets.slice(0, 20).map((tag) => (
								<s-button
									key={tag}
									variant={selectedTags.includes(tag) ? "primary" : "secondary"}
									onClick={() => handleTagFilterToggle(tag)}
								>
									{tag}
								</s-button>
							))}
						</div>
						{selectedTags.length > 0 && (
							<s-button
								variant="tertiary"
								onClick={() => {
									setSelectedTags([]);
									setPage(1);
								}}
							>
								Clear Tag Filters
							</s-button>
						)}
					</s-stack>
				)}
			</s-stack>

			{/* Error State */}
			{error && (
				<s-banner tone="critical">Error loading assets: {error}</s-banner>
			)}

			{/* Loading State */}
			{isLoading && assets.length === 0 && (
				<s-paragraph>Loading assets...</s-paragraph>
			)}

			{/* Results Count */}
			{!isLoading && !error && (
				<s-text>
					<strong>
						{total} asset{total !== 1 ? "s" : ""} found
					</strong>
				</s-text>
			)}

			{/* Assets Display */}
			{!isLoading && !error && assets.length === 0 && (
				<s-paragraph>
					No assets found. Try adjusting your search filters.
				</s-paragraph>
			)}

			{!error && assets.length > 0 && (
				<>
					{viewMode === "grid" ? (
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
								gap: "1rem",
							}}
						>
							{assets.map((asset) => {
								const thumbnailUrl = getThumbnailUrl(asset);
								return (
									<s-box
										key={asset.id}
										padding="base"
										borderWidth="base"
										borderRadius="base"
									>
										<s-stack direction="block" gap="base">
											{thumbnailUrl ? (
												<img
													src={thumbnailUrl}
													alt={asset.name}
													style={{
														width: "100%",
														height: "150px",
														objectFit: "cover",
														borderRadius: "4px",
													}}
												/>
											) : (
												<div
													style={{
														width: "100%",
														height: "150px",
														display: "flex",
														alignItems: "center",
														justifyContent: "center",
														backgroundColor: "#f5f5f5",
													}}
												>
													<s-text>{asset.type || "Asset"}</s-text>
												</div>
											)}
											<s-stack direction="block" gap="small">
												<s-text>
													<strong>{asset.name}</strong>
												</s-text>
												{asset.tags && asset.tags.length > 0 ? (
													<div style={{ marginTop: "0.5rem" }}>
														<span
															style={{
																fontSize: "0.875rem",
																color: "#666",
																marginBottom: "0.25rem",
																display: "block",
															}}
														>
															Tags:
														</span>
														<div
															style={{
																display: "flex",
																flexWrap: "wrap",
																gap: "0.5rem",
															}}
														>
															{asset.tags.map((tag) => (
																<button
																	key={tag}
																	type="button"
																	onClick={() => handleTagClick(tag)}
																	disabled={existingTags.includes(tag)}
																	style={{
																		padding: "0.25rem 0.75rem",
																		borderRadius: "4px",
																		border: "1px solid #ccc",
																		backgroundColor: existingTags.includes(tag)
																			? "#007bff"
																			: "#f8f9fa",
																		color: existingTags.includes(tag)
																			? "#fff"
																			: "#333",
																		cursor: existingTags.includes(tag)
																			? "not-allowed"
																			: "pointer",
																		fontSize: "0.875rem",
																		fontWeight: "500",
																		transition: "all 0.2s",
																	}}
																	onMouseEnter={(e) => {
																		if (!existingTags.includes(tag)) {
																			e.currentTarget.style.backgroundColor =
																				"#e9ecef";
																		}
																	}}
																	onMouseLeave={(e) => {
																		if (!existingTags.includes(tag)) {
																			e.currentTarget.style.backgroundColor =
																				"#f8f9fa";
																		}
																	}}
																>
																	{tag}
																</button>
															))}
														</div>
													</div>
												) : (
													<div style={{ marginTop: "0.5rem" }}>
														<span
															style={{ fontSize: "0.875rem", color: "#666" }}
														>
															Tags: None
														</span>
													</div>
												)}
											</s-stack>
										</s-stack>
									</s-box>
								);
							})}
						</div>
					) : (
						<s-stack direction="block" gap="base">
							{assets.map((asset) => (
								<s-box
									key={asset.id}
									padding="base"
									borderWidth="base"
									borderRadius="base"
								>
									<div
										style={{
											display: "flex",
											gap: "1rem",
											alignItems: "start",
										}}
									>
										{getThumbnailUrl(asset) && (
											<img
												src={getThumbnailUrl(asset) || ""}
												alt={asset.name}
												style={{
													width: "80px",
													height: "80px",
													objectFit: "cover",
													borderRadius: "4px",
												}}
											/>
										)}
										<div style={{ flex: 1 }}>
											<s-stack direction="block" gap="small">
												<s-text>
													<strong>{asset.name}</strong>
												</s-text>
												<s-text>Type: {asset.type || "Unknown"}</s-text>
												{asset.dateModified && (
													<s-text>
														Modified:{" "}
														{new Date(asset.dateModified).toLocaleDateString()}
													</s-text>
												)}
												{asset.tags && asset.tags.length > 0 ? (
													<div style={{ marginTop: "0.5rem" }}>
														<span
															style={{
																fontSize: "0.875rem",
																color: "#666",
																marginBottom: "0.25rem",
																display: "block",
															}}
														>
															Tags:
														</span>
														<div
															style={{
																display: "flex",
																flexWrap: "wrap",
																gap: "0.5rem",
															}}
														>
															{asset.tags.map((tag) => (
																<button
																	key={tag}
																	type="button"
																	onClick={() => handleTagClick(tag)}
																	disabled={existingTags.includes(tag)}
																	style={{
																		padding: "0.25rem 0.75rem",
																		borderRadius: "4px",
																		border: "1px solid #ccc",
																		backgroundColor: existingTags.includes(tag)
																			? "#007bff"
																			: "#f8f9fa",
																		color: existingTags.includes(tag)
																			? "#fff"
																			: "#333",
																		cursor: existingTags.includes(tag)
																			? "not-allowed"
																			: "pointer",
																		fontSize: "0.875rem",
																		fontWeight: "500",
																		transition: "all 0.2s",
																	}}
																	onMouseEnter={(e) => {
																		if (!existingTags.includes(tag)) {
																			e.currentTarget.style.backgroundColor =
																				"#e9ecef";
																		}
																	}}
																	onMouseLeave={(e) => {
																		if (!existingTags.includes(tag)) {
																			e.currentTarget.style.backgroundColor =
																				"#f8f9fa";
																		}
																	}}
																>
																	{tag}
																</button>
															))}
														</div>
													</div>
												) : (
													<div style={{ marginTop: "0.5rem" }}>
														<span
															style={{ fontSize: "0.875rem", color: "#666" }}
														>
															Tags: None
														</span>
													</div>
												)}
											</s-stack>
										</div>
									</div>
								</s-box>
							))}
						</s-stack>
					)}

					{/* Pagination */}
					{(hasMore || page > 1) && (
						<s-stack direction="inline" gap="base">
							<s-button
								variant="secondary"
								disabled={page === 1 || isLoading}
								onClick={() => setPage((p) => Math.max(1, p - 1))}
							>
								Previous
							</s-button>
							<s-text>
								Page {page} of {Math.ceil(total / limit)}
							</s-text>
							<s-button
								variant="secondary"
								disabled={!hasMore || isLoading}
								onClick={() => setPage((p) => p + 1)}
							>
								Next
							</s-button>
						</s-stack>
					)}
				</>
			)}
		</s-stack>
	);
}
