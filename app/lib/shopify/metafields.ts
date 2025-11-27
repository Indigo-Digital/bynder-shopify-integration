import type { AdminApi } from "../types.js";

const METAFIELD_NAMESPACE = "$app:bynder";

export interface BynderMetafields {
	assetId: string;
	permalink: string;
	tags: string[];
	version: number;
	syncedAt: string;
}

/**
 * Create or update Bynder metafields on a Shopify File
 */
export async function setBynderMetafields(
	admin: AdminApi,
	fileId: string,
	metafields: BynderMetafields
): Promise<void> {
	const mutations = [
		{
			namespace: METAFIELD_NAMESPACE,
			key: "asset_id",
			type: "single_line_text_field",
			value: metafields.assetId,
			ownerId: fileId,
		},
		{
			namespace: METAFIELD_NAMESPACE,
			key: "permalink",
			type: "url",
			value: metafields.permalink,
			ownerId: fileId,
		},
		{
			namespace: METAFIELD_NAMESPACE,
			key: "tags",
			type: "list.single_line_text_field",
			value: JSON.stringify(metafields.tags),
			ownerId: fileId,
		},
		{
			namespace: METAFIELD_NAMESPACE,
			key: "version",
			type: "number_integer",
			value: String(metafields.version),
			ownerId: fileId,
		},
		{
			namespace: METAFIELD_NAMESPACE,
			key: "synced_at",
			type: "date_time",
			value: metafields.syncedAt,
			ownerId: fileId,
		},
	];

	const response = await admin.graphql(
		`#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
		{
			variables: {
				metafields: mutations,
			},
		}
	);

	const data = await response.json();
	if (data.data?.metafieldsSet?.userErrors?.length > 0) {
		throw new Error(
			`Failed to set metafields: ${JSON.stringify(data.data.metafieldsSet.userErrors)}`
		);
	}
}

/**
 * Set tags for a file in the $app:bynder namespace
 */
export async function setFileTags(
	admin: AdminApi,
	fileId: string,
	tags: string[]
): Promise<void> {
	const mutations = [
		{
			namespace: METAFIELD_NAMESPACE,
			key: "tags",
			type: "list.single_line_text_field",
			value: JSON.stringify(tags),
			ownerId: fileId,
		},
	];

	const response = await admin.graphql(
		`#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
		{
			variables: {
				metafields: mutations,
			},
		}
	);

	const data = await response.json();
	if (data.data?.metafieldsSet?.userErrors?.length > 0) {
		throw new Error(
			`Failed to set file tags: ${JSON.stringify(data.data.metafieldsSet.userErrors)}`
		);
	}
}

/**
 * Get Bynder metafields from a Shopify File
 */
export async function getBynderMetafields(
	admin: AdminApi,
	fileId: string
): Promise<BynderMetafields | null> {
	const response = await admin.graphql(
		`#graphql
      query getFileMetafields($ownerId: ID!) {
        metafields(ownerId: $ownerId, namespace: "${METAFIELD_NAMESPACE}") {
          edges {
            node {
              namespace
              key
              value
              type
            }
          }
        }
      }
    `,
		{
			variables: {
				ownerId: fileId,
			},
		}
	);

	const data = await response.json();
	const metafields = data.data?.metafields?.edges || [];

	if (metafields.length === 0) {
		return null;
	}

	const metafieldMap = metafields.reduce(
		(
			acc: Record<string, string>,
			edge: { node: { key: string; value: string } }
		) => {
			acc[edge.node.key] = edge.node.value;
			return acc;
		},
		{}
	);

	return {
		assetId: metafieldMap.asset_id || "",
		permalink: metafieldMap.permalink || "",
		tags: metafieldMap.tags ? JSON.parse(metafieldMap.tags) : [],
		version: parseInt(metafieldMap.version || "0", 10),
		syncedAt: metafieldMap.synced_at || new Date().toISOString(),
	};
}
