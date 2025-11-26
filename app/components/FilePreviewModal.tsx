import { useEffect } from "react";
import type { ShopifyFileDetails } from "../lib/shopify/file-query.js";

interface FilePreviewModalProps {
	file: ShopifyFileDetails;
	syncedAsset: {
		id: string;
		bynderAssetId: string;
		syncType: string;
		syncedAt: Date;
	};
	shop: string;
	onClose: () => void;
}

export function FilePreviewModal({
	file,
	syncedAsset,
	shop,
	onClose,
}: FilePreviewModalProps) {
	// Handle ESC key to close modal
	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("keydown", handleEscape);
		};
	}, [onClose]);

	// Generate Shopify Files admin URL
	const shopifyFileUrl = `https://admin.shopify.com/store/${shop.replace(
		".myshopify.com",
		""
	)}/content/files/${file.id.replace("gid://shopify/File/", "")}`;

	const bynderLink = file.bynderMetadata?.permalink || null;
	const tags = file.bynderMetadata?.tags || [];
	const version = file.bynderMetadata?.version || null;
	const syncedAt = file.bynderMetadata?.syncedAt
		? new Date(file.bynderMetadata.syncedAt)
		: syncedAsset.syncedAt;

	return (
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
					onClose();
				}
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					onClose();
				}
			}}
			role="dialog"
			aria-modal="true"
			aria-label="File preview"
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
					width: "800px",
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
				{/* Header */}
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
						File Preview
					</h2>
					<button
						type="button"
						onClick={onClose}
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

				{/* Content */}
				<div
					style={{
						flex: 1,
						overflow: "auto",
						padding: "1.5rem",
					}}
				>
					{/* Preview Image/File */}
					<div
						style={{
							marginBottom: "1.5rem",
							display: "flex",
							justifyContent: "center",
							alignItems: "center",
							minHeight: "300px",
							backgroundColor: "#f9fafb",
							borderRadius: "8px",
							overflow: "hidden",
						}}
					>
						{file.thumbnailUrl ? (
							<img
								src={file.thumbnailUrl}
								alt={file.altText || "File preview"}
								style={{
									maxWidth: "100%",
									maxHeight: "500px",
									objectFit: "contain",
								}}
							/>
						) : file.fileUrl ? (
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									gap: "1rem",
									padding: "2rem",
								}}
							>
								<svg
									width="64"
									height="64"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									style={{ color: "#6b7280" }}
								>
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
									<polyline points="14 2 14 8 20 8" />
									<line x1="16" y1="13" x2="8" y2="13" />
									<line x1="16" y1="17" x2="8" y2="17" />
									<polyline points="10 9 9 9 8 9" />
								</svg>
								<a
									href={file.fileUrl}
									target="_blank"
									rel="noopener noreferrer"
									style={{
										color: "#2563eb",
										textDecoration: "none",
										fontWeight: "500",
									}}
								>
									View File
								</a>
							</div>
						) : (
							<div
								style={{
									color: "#6b7280",
									textAlign: "center",
									padding: "2rem",
								}}
							>
								No preview available
							</div>
						)}
					</div>

					{/* Metadata */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(2, 1fr)",
							gap: "1rem",
							marginBottom: "1.5rem",
						}}
					>
						<div>
							<strong style={{ color: "#374151", display: "block" }}>
								Bynder Asset ID
							</strong>
							<span style={{ color: "#6b7280" }}>
								{syncedAsset.bynderAssetId}
							</span>
						</div>

						<div>
							<strong style={{ color: "#374151", display: "block" }}>
								Sync Type
							</strong>
							<span style={{ color: "#6b7280" }}>
								{syncedAsset.syncType}
							</span>
						</div>

						{version !== null && (
							<div>
								<strong style={{ color: "#374151", display: "block" }}>
									Version
								</strong>
								<span style={{ color: "#6b7280" }}>{version}</span>
							</div>
						)}

						<div>
							<strong style={{ color: "#374151", display: "block" }}>
								Synced At
							</strong>
							<span style={{ color: "#6b7280" }}>
								{syncedAt.toLocaleString()}
							</span>
						</div>

						<div>
							<strong style={{ color: "#374151", display: "block" }}>
								File Status
							</strong>
							<span style={{ color: "#6b7280" }}>{file.fileStatus}</span>
						</div>

						<div>
							<strong style={{ color: "#374151", display: "block" }}>
								File Type
							</strong>
							<span style={{ color: "#6b7280" }}>{file.fileType}</span>
						</div>
					</div>

					{/* Tags */}
					{tags.length > 0 && (
						<div style={{ marginBottom: "1.5rem" }}>
							<strong
								style={{
									color: "#374151",
									display: "block",
									marginBottom: "0.5rem",
								}}
							>
								Tags
							</strong>
							<div
								style={{
									display: "flex",
									flexWrap: "wrap",
									gap: "0.5rem",
								}}
							>
								{tags.map((tag) => (
									<span
										key={tag}
										style={{
											backgroundColor: "#e5e7eb",
											color: "#374151",
											padding: "0.25rem 0.75rem",
											borderRadius: "9999px",
											fontSize: "0.875rem",
										}}
									>
										{tag}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Links */}
					<div
						style={{
							display: "flex",
							gap: "1rem",
							paddingTop: "1rem",
							borderTop: "1px solid #e5e7eb",
						}}
					>
						<a
							href={shopifyFileUrl}
							target="_blank"
							rel="noopener noreferrer"
							style={{
								display: "inline-flex",
								alignItems: "center",
								padding: "0.5rem 1rem",
								backgroundColor: "#2563eb",
								color: "white",
								textDecoration: "none",
								borderRadius: "6px",
								fontWeight: "500",
								fontSize: "0.875rem",
							}}
						>
							View in Shopify
						</a>
						{bynderLink && (
							<a
								href={bynderLink}
								target="_blank"
								rel="noopener noreferrer"
								style={{
									display: "inline-flex",
									alignItems: "center",
									padding: "0.5rem 1rem",
									backgroundColor: "#6b7280",
									color: "white",
									textDecoration: "none",
									borderRadius: "6px",
									fontWeight: "500",
									fontSize: "0.875rem",
								}}
							>
								View in Bynder
							</a>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

