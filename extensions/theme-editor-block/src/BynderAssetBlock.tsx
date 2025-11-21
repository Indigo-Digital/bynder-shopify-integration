import {
	BlockStack,
	Button,
	Modal,
	reactExtension,
	Text,
} from "@shopify/ui-extensions-react/checkout";
import { useState } from "react";

export default reactExtension("purchase.checkout.block.render", () => (
	<BynderAssetBlock />
));

function BynderAssetBlock() {
	const [showPicker, setShowPicker] = useState(false);
	const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

	// Note: This is a simplified version
	// In a real implementation, you would:
	// 1. Fetch the Bynder picker component
	// 2. Handle asset selection
	// 3. Store the selected asset ID in block settings
	// 4. Render the asset in the theme

	return (
		<BlockStack>
			<Text>Bynder Asset Block</Text>
			<Button onPress={() => setShowPicker(true)}>Select Bynder Asset</Button>
			{showPicker && (
				<Modal
					id="bynder-picker"
					title="Select Bynder Asset"
					onClose={() => setShowPicker(false)}
				>
					<Text>Bynder picker would be embedded here</Text>
					<Button
						onPress={() => {
							setSelectedAssetId("example-asset-id");
							setShowPicker(false);
						}}
					>
						Select Asset
					</Button>
				</Modal>
			)}
			{selectedAssetId && <Text>Selected Asset: {selectedAssetId}</Text>}
		</BlockStack>
	);
}
