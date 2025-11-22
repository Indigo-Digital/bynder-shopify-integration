import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { BynderPicker } from "../components/BynderPicker.js";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	// Get synced assets
	const syncedAssets = shopConfig
		? await prisma.syncedAsset.findMany({
				where: { shopId: shopConfig.id },
				orderBy: { syncedAt: "desc" },
				take: 50,
			})
		: [];

	return {
		shop,
		shopConfig,
		syncedAssets,
	};
};

export default function FilesPage() {
	const { shopConfig, syncedAssets } = useLoaderData<typeof loader>();
	const [showPicker, setShowPicker] = useState(false);
	const fetcher = useFetcher();

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
				{syncedAssets.length === 0 ? (
					<s-paragraph>
						No assets synced yet. Click "Import from Bynder" to get started.
					</s-paragraph>
				) : (
					<table>
						<thead>
							<tr>
								<th>Asset ID</th>
								<th>Sync Type</th>
								<th>Synced At</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{syncedAssets.map((asset: (typeof syncedAssets)[number]) => (
								<tr key={asset.id}>
									<td>{asset.bynderAssetId}</td>
									<td>{asset.syncType}</td>
									<td>{new Date(asset.syncedAt).toLocaleString()}</td>
									<td>
										<s-link href={`/app/asset/${asset.id}`}>View</s-link>
									</td>
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
