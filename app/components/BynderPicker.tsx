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

		// Check if script already exists
		const existingScript = document.querySelector(
			'script[src*="compactview"]'
		) as HTMLScriptElement;

		if (existingScript && window.BynderCompactView) {
			// Script already loaded, initialize immediately
			initializeWidget();
			return;
		}

		// Load Bynder UCV script
		const script = document.createElement("script");
		script.src = `${baseUrl}/api/v4/compactview/?language=en_US`;
		script.async = true;

		script.onload = () => {
			setLoading(false);
			initializeWidget();
		};

		script.onerror = () => {
			setLoading(false);
			setError(
				`Failed to load Bynder picker. Please check your Bynder base URL: ${baseUrl}`
			);
		};

		document.body.appendChild(script);

		function initializeWidget() {
			// Initialize Bynder Compact View
			if (window.BynderCompactView && containerRef.current) {
				try {
					const widget = window.BynderCompactView.open({
						mode,
						assetTypes,
						container: containerRef.current,
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

// Extend window type for Bynder Compact View
declare global {
	interface Window {
		BynderCompactView?: {
			open: (config: {
				mode: string;
				assetTypes: string[];
				container: HTMLElement;
				onSuccess: (assets: Array<{ id: string }>) => void;
				onClose: () => void;
			}) => unknown;
		};
	}
}
