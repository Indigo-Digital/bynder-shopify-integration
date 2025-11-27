import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
	useFetcher,
	useLoaderData,
	useNavigate,
	useSearchParams,
} from "react-router";
import prisma from "../db.server.js";
import {
	extractBynderTags,
	filterFiles,
	getShopifyFiles,
	type ShopifyFile,
} from "../lib/shopify/files-api.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session, admin } = await authenticate.admin(request);
	const shop = session.shop;

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	// Parse query params
	const url = new URL(request.url);
	const after = url.searchParams.get("after") || undefined;
	const search = url.searchParams.get("search") || undefined;
	const source = (url.searchParams.get("source") || "all") as
		| "all"
		| "bynder"
		| "other";
	const fileType = (url.searchParams.get("type") || "all") as
		| "all"
		| "image"
		| "file";

	// Fetch files from Shopify
	const result = await getShopifyFiles(admin, {
		first: 50,
		...(after ? { after } : {}),
		...(search ? { search } : {}),
		sortKey: "CREATED_AT",
		reverse: true,
	});

	// Apply client-side filters
	const filteredFiles = filterFiles(result.files, {
		source,
		fileType,
	});

	// Extract tags for filter dropdown
	const allTags = extractBynderTags(result.files);

	return {
		shop,
		shopConfig,
		files: filteredFiles,
		allFiles: result.files,
		pageInfo: result.pageInfo,
		filters: {
			search: search || "",
			source,
			fileType,
		},
		allTags,
	};
};

export const action = async ({ request }: ActionFunctionArgs) => {
	const { admin } = await authenticate.admin(request);
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "delete") {
		const fileIds = formData.get("fileIds")?.toString().split(",") || [];

		if (fileIds.length === 0) {
			return { error: "No files selected" };
		}

		try {
			const response = await admin.graphql(
				`#graphql
				mutation fileDelete($fileIds: [ID!]!) {
					fileDelete(fileIds: $fileIds) {
						deletedFileIds
						userErrors {
							field
							message
						}
					}
				}`,
				{
					variables: { fileIds },
				}
			);

			const data = await response.json();

			if (data.data?.fileDelete?.userErrors?.length > 0) {
				return {
					error: data.data.fileDelete.userErrors
						.map((e: { message: string }) => e.message)
						.join(", "),
				};
			}

			return {
				success: true,
				deleted: data.data?.fileDelete?.deletedFileIds?.length || 0,
			};
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : "Delete failed",
			};
		}
	}

	if (intent === "updateAlt") {
		const fileId = formData.get("fileId")?.toString();
		const altText = formData.get("altText")?.toString() || "";

		if (!fileId) {
			return { error: "No file specified" };
		}

		try {
			const response = await admin.graphql(
				`#graphql
				mutation fileUpdate($input: [FileUpdateInput!]!) {
					fileUpdate(files: $input) {
						files {
							id
							alt
						}
						userErrors {
							field
							message
						}
					}
				}`,
				{
					variables: {
						input: [{ id: fileId, alt: altText }],
					},
				}
			);

			const data = await response.json();

			if (data.data?.fileUpdate?.userErrors?.length > 0) {
				return {
					error: data.data.fileUpdate.userErrors
						.map((e: { message: string }) => e.message)
						.join(", "),
				};
			}

			return { success: true };
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : "Update failed",
			};
		}
	}

	return { error: "Invalid action" };
};

export default function FileManagerPage() {
	const { shopConfig, files, pageInfo, filters, allTags } =
		useLoaderData<typeof loader>();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const fetcher = useFetcher();

	// Selection state
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [showDeleteModal, setShowDeleteModal] = useState(false);
	const [editingFile, setEditingFile] = useState<ShopifyFile | null>(null);
	const [editAltText, setEditAltText] = useState("");

	// Local filter state
	const [searchInput, setSearchInput] = useState(filters.search);
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

	const isLoading = fetcher.state !== "idle";

	// Handle selection
	const toggleSelection = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const selectAll = useCallback(() => {
		setSelectedIds(new Set(files.map((f) => f.id)));
	}, [files]);

	const clearSelection = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	// Counts
	const bynderCount = useMemo(
		() => files.filter((f) => f.bynderMetadata).length,
		[files]
	);
	const selectedCount = selectedIds.size;

	// Handle filter changes
	const updateFilter = useCallback(
		(key: string, value: string) => {
			const params = new URLSearchParams(searchParams);
			if (value && value !== "all") {
				params.set(key, value);
			} else {
				params.delete(key);
			}
			// Reset pagination when filter changes
			params.delete("after");
			navigate(`?${params.toString()}`);
		},
		[navigate, searchParams]
	);

	const handleSearch = useCallback(() => {
		updateFilter("search", searchInput);
	}, [searchInput, updateFilter]);

	// Handle pagination
	const handleNextPage = useCallback(() => {
		if (pageInfo.endCursor) {
			const params = new URLSearchParams(searchParams);
			params.set("after", pageInfo.endCursor);
			navigate(`?${params.toString()}`);
		}
	}, [navigate, pageInfo.endCursor, searchParams]);

	// Handle delete
	const handleDelete = useCallback(() => {
		if (selectedIds.size === 0) return;

		fetcher.submit(
			{
				intent: "delete",
				fileIds: Array.from(selectedIds).join(","),
			},
			{ method: "POST" }
		);
		setShowDeleteModal(false);
		setSelectedIds(new Set());
	}, [fetcher, selectedIds]);

	// Handle alt text edit
	const handleStartEdit = useCallback((file: ShopifyFile) => {
		setEditingFile(file);
		setEditAltText(file.alt || "");
	}, []);

	const handleSaveAlt = useCallback(() => {
		if (!editingFile) return;

		fetcher.submit(
			{
				intent: "updateAlt",
				fileId: editingFile.id,
				altText: editAltText,
			},
			{ method: "POST" }
		);
		setEditingFile(null);
	}, [editingFile, editAltText, fetcher]);

	if (!shopConfig) {
		return (
			<s-page heading="File Manager">
				<s-section>
					<s-banner tone="warning">
						Please configure your connection in{" "}
						<s-link href="/app/settings">Settings</s-link> first.
					</s-banner>
				</s-section>
			</s-page>
		);
	}

	return (
		<s-page heading="File Manager" inlineSize="large">
			{/* Primary action - only show when files selected */}
			{selectedCount > 0 && (
				<s-button-group slot="primary-action">
					<s-button
						variant="primary"
						tone="critical"
						onClick={() => setShowDeleteModal(true)}
						disabled={isLoading}
					>
						Delete Selected ({selectedCount})
					</s-button>
				</s-button-group>
			)}

			{/* Success/Error Banners */}
			{fetcher.data && "success" in fetcher.data && fetcher.data.success && (
				<s-banner tone="success" dismissible>
					{"deleted" in fetcher.data
						? `Successfully deleted ${fetcher.data.deleted} file(s)`
						: "Changes saved successfully"}
				</s-banner>
			)}
			{fetcher.data && "error" in fetcher.data && (
				<s-banner tone="critical" dismissible>
					Error: {fetcher.data.error}
				</s-banner>
			)}

			<s-section>
				{/* Filter Bar */}
				<s-stack direction="block" gap="base">
					<s-stack direction="inline" gap="base" alignItems="end">
						<s-text-field
							label="Search files"
							labelAccessibilityVisibility="exclusive"
							placeholder="Search by filename..."
							value={searchInput}
							onInput={(e) => {
								const target = e.target as HTMLInputElement;
								setSearchInput(target.value);
								// Auto-search on input for better UX
								if (debounceTimerRef.current) {
									clearTimeout(debounceTimerRef.current);
								}
								debounceTimerRef.current = setTimeout(() => {
									handleSearch();
								}, 500);
							}}
						/>
						<s-select
							label="Source"
							value={filters.source}
							onChange={(e) =>
								updateFilter("source", (e.target as HTMLSelectElement).value)
							}
						>
							<option value="all">All Sources</option>
							<option value="bynder">Bynder Only ({bynderCount})</option>
							<option value="other">Non-Bynder</option>
						</s-select>
						<s-select
							label="Type"
							value={filters.fileType}
							onChange={(e) =>
								updateFilter("type", (e.target as HTMLSelectElement).value)
							}
						>
							<option value="all">All Types</option>
							<option value="image">Images</option>
							<option value="file">Documents</option>
						</s-select>
						<s-button variant="secondary" onClick={handleSearch}>
							Search
						</s-button>
					</s-stack>

					{/* Selection controls */}
					{files.length > 0 && (
						<s-stack direction="inline" gap="base" alignItems="center">
							<s-checkbox
								label="Select all"
								checked={selectedCount === files.length && files.length > 0}
								indeterminate={
									selectedCount > 0 && selectedCount < files.length
								}
								onChange={() => {
									if (selectedCount === files.length) {
										clearSelection();
									} else {
										selectAll();
									}
								}}
							/>
							<s-text color="subdued">
								{files.length} files • {selectedCount} selected
							</s-text>
							{allTags.length > 0 && (
								<s-text color="subdued">
									• {allTags.length} Bynder tags found
								</s-text>
							)}
						</s-stack>
					)}
				</s-stack>
			</s-section>

			{/* Files Grid */}
			<s-section heading="Files">
				{files.length === 0 ? (
					<s-box padding="large" background="subdued" borderRadius="base">
						<s-stack direction="block" gap="base" alignItems="center">
							<s-text>No files found matching your criteria.</s-text>
							<s-button variant="secondary" href="/app/sync">
								Sync from Bynder
							</s-button>
						</s-stack>
					</s-box>
				) : (
					<>
						{/* Grid Layout */}
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
								gap: "var(--p-space-400)",
							}}
						>
							{files.map((file) => {
								const isSelected = selectedIds.has(file.id);
								return (
									<button
										type="button"
										key={file.id}
										onClick={() => toggleSelection(file.id)}
										style={{
											borderRadius: "var(--p-border-radius-200)",
											border: `1px solid var(${isSelected ? "--p-color-border-emphasis" : "--p-color-border"})`,
											backgroundColor: isSelected
												? "var(--p-color-bg-surface-secondary)"
												: "transparent",
											padding: "var(--p-space-200)",
											cursor: "pointer",
											textAlign: "left",
											width: "100%",
										}}
									>
										<s-stack direction="block" gap="small">
											{/* Checkbox and actions row */}
											<s-stack
												direction="inline"
												gap="small"
												justifyContent="space-between"
												alignItems="center"
											>
												<s-checkbox
													label=""
													accessibilityLabel={`Select ${file.filename}`}
													checked={selectedIds.has(file.id)}
													onChange={(e) => {
														e.stopPropagation();
														toggleSelection(file.id);
													}}
												/>
												{file.bynderMetadata && (
													<s-badge tone="info" size="base">
														Bynder
													</s-badge>
												)}
											</s-stack>

											{/* Thumbnail */}
											<s-box
												minBlockSize="120px"
												background="subdued"
												borderRadius="small"
												overflow="hidden"
											>
												{file.thumbnailUrl ? (
													<s-image
														src={file.thumbnailUrl}
														alt={file.alt || file.filename || "File preview"}
														aspectRatio="1/1"
														objectFit="cover"
													/>
												) : (
													<s-stack
														direction="block"
														alignItems="center"
														justifyContent="center"
														blockSize="120px"
													>
														<s-icon type="file" size="base" color="subdued" />
													</s-stack>
												)}
											</s-box>

											{/* File info */}
											<s-stack direction="block" gap="small-200">
												<s-text>
													{(file.filename || "Untitled").slice(0, 25)}
													{(file.filename || "").length > 25 ? "..." : ""}
												</s-text>
												<s-stack direction="inline" gap="small-200">
													<s-badge
														tone={
															file.fileStatus === "READY"
																? "success"
																: "warning"
														}
														size="base"
													>
														{file.fileStatus}
													</s-badge>
													{file.fileSize && (
														<s-text color="subdued">
															{(file.fileSize / 1024).toFixed(0)} KB
														</s-text>
													)}
												</s-stack>
												{/* Quick actions */}
												<s-stack direction="inline" gap="small-200">
													<s-button
														variant="tertiary"
														onClick={(e) => {
															e.stopPropagation();
															handleStartEdit(file);
														}}
													>
														Edit Alt
													</s-button>
													{file.fileUrl && (
														<s-link
															href={file.fileUrl}
															target="_blank"
															onClick={(e) => e.stopPropagation()}
														>
															View
														</s-link>
													)}
												</s-stack>
											</s-stack>
										</s-stack>
									</button>
								);
							})}
						</div>

						{/* Pagination */}
						{(pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
							<s-stack
								direction="inline"
								gap="base"
								justifyContent="center"
								padding="base"
							>
								<s-button
									variant="secondary"
									onClick={handleNextPage}
									disabled={!pageInfo.hasNextPage || isLoading}
								>
									{isLoading ? "Loading..." : "Load More"}
								</s-button>
							</s-stack>
						)}
					</>
				)}
			</s-section>

			{/* Delete Confirmation Modal */}
			{showDeleteModal && (
				<s-modal
					heading="Delete Files"
					size="small"
					onHide={() => setShowDeleteModal(false)}
				>
					<s-stack direction="block" gap="base" padding="base">
						<s-paragraph>
							Are you sure you want to delete {selectedCount} file
							{selectedCount !== 1 ? "s" : ""}? This action cannot be undone.
						</s-paragraph>
						<s-stack direction="inline" gap="base" justifyContent="end">
							<s-button
								variant="secondary"
								onClick={() => setShowDeleteModal(false)}
							>
								Cancel
							</s-button>
							<s-button
								variant="primary"
								tone="critical"
								onClick={handleDelete}
								disabled={isLoading}
							>
								{isLoading ? "Deleting..." : "Delete"}
							</s-button>
						</s-stack>
					</s-stack>
				</s-modal>
			)}

			{/* Edit Alt Text Modal */}
			{editingFile && (
				<s-modal
					heading="Edit Alt Text"
					size="small"
					onHide={() => setEditingFile(null)}
				>
					<s-stack direction="block" gap="base" padding="base">
						<s-text-field
							label="Alt Text"
							value={editAltText}
							onChange={(e) =>
								setEditAltText((e.target as HTMLInputElement).value)
							}
							placeholder="Describe this image for accessibility"
						/>
						<s-stack direction="inline" gap="base" justifyContent="end">
							<s-button
								variant="secondary"
								onClick={() => setEditingFile(null)}
							>
								Cancel
							</s-button>
							<s-button
								variant="primary"
								onClick={handleSaveAlt}
								disabled={isLoading}
							>
								{isLoading ? "Saving..." : "Save"}
							</s-button>
						</s-stack>
					</s-stack>
				</s-modal>
			)}
		</s-page>
	);
}

export const headers = boundary.headers;
