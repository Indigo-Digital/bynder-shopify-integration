import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;
	const url = new URL(request.url);
	const bynderConnected = url.searchParams.get("bynder_connected") === "true";

	const shopConfig = await prisma.shop.findUnique({
		where: { shop },
	});

	return {
		shop,
		shopConfig,
		bynderConnected,
	};
};

export const action = async ({ request }: ActionFunctionArgs) => {
	const { session } = await authenticate.admin(request);
	const shop = session.shop;
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "update_sync_tags") {
		const syncTags = formData.get("syncTags")?.toString() || "shopify-sync";

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
	const { shopConfig, bynderConnected } = useLoaderData<typeof loader>();
	const fetcher = useFetcher();

	const [syncTags, setSyncTags] = useState(
		shopConfig?.syncTags || "shopify-sync"
	);
	const [bynderBaseUrl, setBynderBaseUrl] = useState(
		shopConfig?.bynderBaseUrl || ""
	);

	const isConnected = !!shopConfig?.bynderAccessToken;
	const isSubmitting = fetcher.state !== "idle";
	const url = new URL(
		typeof window !== "undefined" ? window.location.href : ""
	);
	const updated = url.searchParams.get("updated") === "true";

	return (
		<s-page heading="Bynder Settings">
			{bynderConnected && (
				<s-banner tone="success">Bynder connected successfully!</s-banner>
			)}
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

			<s-section heading="Bynder Connection">
				{isConnected ? (
					<s-stack direction="block" gap="base">
						<s-paragraph>
							Connected to Bynder
							{shopConfig?.bynderBaseUrl && <> ({shopConfig.bynderBaseUrl})</>}
						</s-paragraph>
						<fetcher.Form method="POST" action="/api/bynder/auth">
							<s-button
								variant="secondary"
								type="submit"
								disabled={isSubmitting}
							>
								{isSubmitting ? "Disconnecting..." : "Disconnect"}
							</s-button>
						</fetcher.Form>
					</s-stack>
				) : (
					<s-stack direction="block" gap="base">
						<s-paragraph>
							Connect your Bynder account to enable asset syncing.
						</s-paragraph>
						{!shopConfig?.bynderBaseUrl && (
							<fetcher.Form method="POST">
								<input type="hidden" name="intent" value="update_bynder_url" />
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
										placeholder="https://portal.getbynder.com"
										required
									/>
									<s-button type="submit" disabled={isSubmitting}>
										{isSubmitting ? "Saving..." : "Save Base URL"}
									</s-button>
								</s-stack>
							</fetcher.Form>
						)}
						{shopConfig?.bynderBaseUrl && (
							<s-link href="/api/bynder/auth">
								<s-button disabled={isSubmitting}>Connect to Bynder</s-button>
							</s-link>
						)}
					</s-stack>
				)}
			</s-section>

			<s-section heading="Auto-Sync Configuration">
				<fetcher.Form method="POST">
					<input type="hidden" name="intent" value="update_sync_tags" />
					<s-stack direction="block" gap="base">
						<s-text-field
							label="Sync Tags (comma-separated)"
							value={syncTags}
							onChange={(e) => {
								const target = e.currentTarget;
								if (target) {
									setSyncTags(target.value);
								}
							}}
							name="syncTags"
							required
						/>
						<s-paragraph>
							Assets with these tags will be automatically synced to Shopify
							Files
						</s-paragraph>
						<s-button type="submit" disabled={isSubmitting}>
							{isSubmitting ? "Saving..." : "Save Tags"}
						</s-button>
					</s-stack>
				</fetcher.Form>
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
