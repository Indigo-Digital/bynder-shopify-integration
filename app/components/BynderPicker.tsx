import { useEffect, useRef } from "react";

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

	useEffect(() => {
		if (!containerRef.current) return;

		// Load Bynder UCV script
		const script = document.createElement("script");
		script.src = `${baseUrl}/api/v4/compactview/?language=en_US`;
		script.async = true;

		script.onload = () => {
			// Initialize Bynder Compact View
			if (window.BynderCompactView && containerRef.current) {
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
			}
		};

		document.body.appendChild(script);

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
			if (script.parentNode) {
				script.parentNode.removeChild(script);
			}
		};
	}, [baseUrl, mode, assetTypes, onAssetSelect, onClose, autoClose]);

	return <div ref={containerRef} style={{ width: "100%", height: "600px" }} />;
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
