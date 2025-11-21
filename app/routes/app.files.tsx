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
		fetcher.submit(
			{ assetId },
			{
				method: "POST",
				action: `/api/sync?assetId=${assetId}`,
			}
		);
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

			{showPicker && (
				<s-modal>
					<BynderPicker
						baseUrl={shopConfig.bynderBaseUrl}
						onAssetSelect={handleAssetSelect}
						onClose={() => setShowPicker(false)}
						mode="SingleSelect"
					/>
				</s-modal>
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
