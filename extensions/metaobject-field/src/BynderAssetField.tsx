import {
	BlockStack,
	Button,
	reactExtension,
	Text,
} from "@shopify/ui-extensions-react/admin";
import { useState } from "react";

// biome-ignore lint/suspicious/noExplicitAny: Extension target type not available in current types
export default reactExtension("admin.settings.action.render" as any, () => (
	<BynderAssetField />
));

function BynderAssetField() {
	const [showPicker, setShowPicker] = useState(false);
	const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

	// Note: This is a simplified version
	// In a real implementation, you would:
	// 1. Embed the Bynder Universal Compact View widget
	// 2. Handle asset selection
	// 3. Store the selected asset ID in the metaobject field
	// 4. Validate that the asset is synced to Shopify Files

	return (
		<BlockStack>
			<Text>Bynder Asset Field</Text>
			<Button onPress={() => setShowPicker(true)}>Select Bynder Asset</Button>
			{showPicker && (
				<BlockStack>
					<Text>Bynder picker would be embedded here</Text>
					<Button
						onPress={() => {
							setSelectedAssetId("example-asset-id");
							setShowPicker(false);
						}}
					>
						Select Asset
					</Button>
					<Button onPress={() => setShowPicker(false)}>Cancel</Button>
				</BlockStack>
			)}
			{selectedAssetId && <Text>Selected Asset: {selectedAssetId}</Text>}
		</BlockStack>
	);
}
