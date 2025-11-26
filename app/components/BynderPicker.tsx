import { useEffect, useRef, useState } from "react";

interface BynderPickerProps {
	onAssetSelect: (assetId: string) => void;
	onClose?: () => void;
	baseUrl: string;
	mode?: "SingleSelect" | "MultiSelect";
	assetTypes?: string[];
	autoClose?: boolean;
}

/**
 * Bynder Universal Compact View (UCV) Picker Component
 * Embeds the Bynder widget for asset selection
 */
export function BynderPicker({
	onAssetSelect,
	onClose,
	baseUrl,
	mode = "SingleSelect",
	assetTypes = ["image"],
	autoClose = true,
}: BynderPickerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const widgetRef = useRef<unknown>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		setLoading(true);
		setError(null);

		// Extract portal URL from baseUrl (remove /api suffix if present)
		// Portal URL should be the base Bynder URL without /api
		let portalUrl = baseUrl.trim();
		// Remove trailing slash
		portalUrl = portalUrl.replace(/\/$/, "");
		// Remove /api suffix if present
		portalUrl = portalUrl.replace(/\/api$/, "");

		// Check if script already exists
		const existingScript = document.querySelector(
			'script[src*="bynder-compactview"]'
		) as HTMLScriptElement;

		if (existingScript && window.BynderCompactView) {
			// Script already loaded, initialize immediately
			initializeWidget(portalUrl);
			return;
		}

		// Load Bynder UCV script from CDN
		const script = document.createElement("script");
		script.src =
			"https://ucv.bynder.com/5.0.5/modules/compactview/bynder-compactview-5-latest.js";
		script.async = true;

		script.onload = () => {
			setLoading(false);
			initializeWidget(portalUrl);
		};

		script.onerror = () => {
			setLoading(false);
			setError(
				`Failed to load Bynder picker. Please check your internet connection and try again.`
			);
		};

		document.body.appendChild(script);

		function initializeWidget(portal: string) {
			// Initialize Bynder Compact View
			if (window.BynderCompactView && containerRef.current) {
				try {
					const widget = window.BynderCompactView.open({
						mode,
						assetTypes,
						container: containerRef.current,
						portal: {
							url: portal,
							editable: false, // Limit to single portal
						},
						language: "en_US",
						onSuccess: (assets: Array<{ id: string }>) => {
							if (assets && assets.length > 0 && assets[0]) {
								onAssetSelect(assets[0].id);
								if (autoClose && onClose) {
									onClose();
								}
							}
						},
						onClose: () => {
							if (onClose) {
								onClose();
							}
						},
					});
					widgetRef.current = widget;
					setLoading(false);
				} catch (err) {
					setError(
						`Failed to initialize Bynder picker: ${
							err instanceof Error ? err.message : "Unknown error"
						}`
					);
					setLoading(false);
				}
			} else {
				setError("Bynder Compact View is not available");
				setLoading(false);
			}
		}

		return () => {
			// Cleanup
			if (
				widgetRef.current &&
				typeof widgetRef.current === "object" &&
				widgetRef.current !== null &&
				"close" in widgetRef.current
			) {
				(widgetRef.current as { close: () => void }).close();
			}
			// Don't remove the script as it might be reused
		};
	}, [baseUrl, mode, assetTypes, onAssetSelect, onClose, autoClose]);

	return (
		<div style={{ width: "100%", minHeight: "600px", position: "relative" }}>
			{loading && (
				<div
					style={{
						position: "absolute",
						top: "50%",
						left: "50%",
						transform: "translate(-50%, -50%)",
						textAlign: "center",
					}}
				>
					<p>Loading Bynder picker...</p>
				</div>
			)}
			{error && (
				<div
					style={{
						padding: "2rem",
						textAlign: "center",
						color: "#721c24",
						backgroundColor: "#f8d7da",
						borderRadius: "4px",
						margin: "1rem",
					}}
				>
					<p style={{ margin: 0, fontWeight: "bold" }}>Error</p>
					<p style={{ margin: "0.5rem 0 0 0" }}>{error}</p>
					{onClose && (
						<button
							type="button"
							onClick={onClose}
							style={{
								marginTop: "1rem",
								padding: "0.5rem 1rem",
								backgroundColor: "#721c24",
								color: "white",
								border: "none",
								borderRadius: "4px",
								cursor: "pointer",
							}}
						>
							Close
						</button>
					)}
				</div>
			)}
			<div
				ref={containerRef}
				style={{
					width: "100%",
					minHeight: "600px",
					display: loading || error ? "none" : "block",
				}}
			/>
		</div>
	);
}

// Extend window type for Bynder Compact View v5.x
declare global {
	interface Window {
		BynderCompactView?: {
			open: (config: {
				mode?: "MultiSelect" | "SingleSelect" | "SingleSelectFile";
				assetTypes?: string[];
				container?: HTMLElement;
				portal?: {
					url: string;
					editable?: boolean;
				};
				language?: string;
				onSuccess?: (assets: Array<{ id: string }>) => void;
				onClose?: () => void;
				onLogout?: () => void;
				defaultSearchTerm?: string;
				theme?: unknown;
				assetFieldSelection?: string;
				hideExternalAccess?: boolean;
				selectedAssets?: string[];
				assetFilter?: unknown;
				authentication?: {
					getAccessToken?: () => string;
					hideLogout?: boolean;
				};
			}) => {
				close: () => void;
			};
		};
	}
}
