import type { BynderMediaInfoResponse } from "../bynder/types.js";

/**
 * Sanitize a string for use in file paths
 */
function sanitizeForPath(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Extract date components from ISO date string
 */
function extractDateComponents(dateString: string): {
	year: string;
	month: string;
	day: string;
} {
	try {
		const date = new Date(dateString);
		const year = date.getFullYear().toString();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return { year, month, day };
	} catch {
		return { year: "", month: "", day: "" };
	}
}

/**
 * Find the first tag that matches any of the configured sync tags
 * Falls back to first tag if no match, then "uncategorized" if no tags
 */
function findMatchingTag(assetTags: string[], syncTags: string[]): string {
	if (assetTags.length === 0) {
		return "uncategorized";
	}

	// Find first tag that matches any sync tag
	for (const assetTag of assetTags) {
		if (syncTags.includes(assetTag)) {
			return assetTag;
		}
	}

	// Fallback to first tag
	return assetTags[0] || "uncategorized";
}

/**
 * Replace template placeholders with actual values
 */
export interface TemplateContext {
	asset: BynderMediaInfoResponse;
	syncTags: string[];
}

/**
 * Process a file folder template and replace placeholders with actual values
 *
 * Supported placeholders:
 * - {tag} - First tag matching sync tags, or first tag, or "uncategorized"
 * - {dateCreated:YYYY} - Year from dateCreated
 * - {dateCreated:MM} - Month from dateCreated (01-12)
 * - {dateCreated:DD} - Day from dateCreated (01-31)
 * - {dateModified:YYYY} - Year from dateModified
 * - {dateModified:MM} - Month from dateModified (01-12)
 * - {dateModified:DD} - Day from dateModified (01-31)
 * - {name} - Asset name (sanitized for path)
 * - {type} - Asset type (e.g., "image")
 *
 * @param template - Template string (e.g., "bynder/{tag}/{dateCreated:YYYY}")
 * @param context - Asset info and sync tags
 * @returns Processed folder path
 */
export function processFileFolderTemplate(
	template: string,
	context: TemplateContext
): string {
	const { asset, syncTags } = context;

	// Find matching tag
	const matchingTag = findMatchingTag(asset.tags || [], syncTags);
	const sanitizedTag = sanitizeForPath(matchingTag);

	// Extract date components
	const createdDate = extractDateComponents(asset.dateCreated || "");
	const modifiedDate = extractDateComponents(asset.dateModified || "");

	// Sanitize asset name
	const sanitizedName = sanitizeForPath(asset.name || "asset");

	// Replace placeholders
	let result = template;

	// Tag placeholder
	result = result.replace(/\{tag\}/g, sanitizedTag);

	// DateCreated placeholders
	result = result.replace(/\{dateCreated:YYYY\}/g, createdDate.year);
	result = result.replace(/\{dateCreated:MM\}/g, createdDate.month);
	result = result.replace(/\{dateCreated:DD\}/g, createdDate.day);

	// DateModified placeholders
	result = result.replace(/\{dateModified:YYYY\}/g, modifiedDate.year);
	result = result.replace(/\{dateModified:MM\}/g, modifiedDate.month);
	result = result.replace(/\{dateModified:DD\}/g, modifiedDate.day);

	// Name placeholder
	result = result.replace(/\{name\}/g, sanitizedName);

	// Type placeholder
	result = result.replace(/\{type\}/g, asset.type || "file");

	// Clean up any double slashes or trailing slashes
	result = result.replace(/\/+/g, "/").replace(/\/$/, "");

	return result || "bynder";
}

/**
 * Generate file path using template system
 *
 * @param template - Folder template (e.g., "bynder/{tag}/{dateCreated:YYYY}")
 * @param originalFilename - Original filename
 * @param context - Asset info and sync tags
 * @param filenamePrefix - Optional prefix for filename
 * @param filenameSuffix - Optional suffix for filename
 * @returns Full file path including folder and filename
 */
export function generateFilePath(
	template: string | null | undefined,
	originalFilename: string,
	context: TemplateContext,
	filenamePrefix?: string | null,
	filenameSuffix?: string | null
): string {
	// Use default template if none provided
	const folderTemplate = template || "bynder/{tag}";

	// Generate folder path
	const folderPath = processFileFolderTemplate(folderTemplate, context);

	// Apply filename prefix/suffix
	let filename = originalFilename;
	if (filenamePrefix) {
		filename = `${filenamePrefix}${filename}`;
	}
	if (filenameSuffix) {
		const extIndex = filename.lastIndexOf(".");
		if (extIndex > 0) {
			const nameWithoutExt = filename.substring(0, extIndex);
			const ext = filename.substring(extIndex);
			filename = `${nameWithoutExt}${filenameSuffix}${ext}`;
		} else {
			filename = `${filename}${filenameSuffix}`;
		}
	}

	// Combine folder path and filename
	return `${folderPath}/${filename}`;
}
