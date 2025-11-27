import { boundary } from "@shopify/shopify-app-react-router/server";
import type { JSZipObject } from "jszip";
import JSZip from "jszip";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
	type ActionFunctionArgs,
	data,
	type LoaderFunctionArgs,
	useFetcher,
} from "react-router";
import { uploadBufferToShopify } from "../lib/shopify/files.js";
import { setFileTags } from "../lib/shopify/metafields.js";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	await authenticate.admin(request);
	return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
	const { admin, session } = await authenticate.admin(request);
	const formData = await request.formData();

	const file = formData.get("file") as File;
	const folder = (formData.get("folder") as string) || "";
	const tags = (formData.get("tags") as string) || "";

	if (!file) {
		return data({ error: "No file provided" }, { status: 400 });
	}

	try {
		const buffer = Buffer.from(await file.arrayBuffer());
		const originalFilename = file.name;

		const cleanPrefix = folder
			.trim()
			.replace(/^\/+|\/+$/g, "")
			.replace(/\//g, "_");
		const fullPath = cleanPrefix
			? `${cleanPrefix}_${originalFilename}`
			: originalFilename;

		const { fileId, fileUrl } = await uploadBufferToShopify(
			admin,
			buffer,
			file.type,
			fullPath,
			originalFilename,
			session.shop,
			undefined
		);

		if (tags) {
			const tagList = tags
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			if (tagList.length > 0) {
				await setFileTags(admin, fileId, tagList);
			}
		}

		return data({ success: true, fileId, fileUrl });
	} catch (error) {
		console.error("Upload error:", error);
		return data(
			{ error: error instanceof Error ? error.message : "Upload failed" },
			{ status: 500 }
		);
	}
};

interface UploadFile {
	id: string;
	file: File;
	status: "pending" | "uploading" | "success" | "error";
	error?: string;
	shopifyFileId?: string;
}

export default function BulkUpload() {
	const [files, setFiles] = useState<UploadFile[]>([]);
	const [folder, setFolder] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const [isUploading, setIsUploading] = useState(false);
	const currentUploadIdRef = useRef<string | null>(null);
	const fetcher = useFetcher<{
		success?: boolean;
		error?: string;
		fileId?: string;
	}>();

	useEffect(() => {
		if (
			fetcher.state === "idle" &&
			fetcher.data &&
			currentUploadIdRef.current
		) {
			const uploadId = currentUploadIdRef.current;
			if (fetcher.data.success) {
				const fileId = fetcher.data.fileId;
				setFiles((prev) =>
					prev.map((f) =>
						f.id === uploadId
							? {
									...f,
									status: "success",
									...(fileId && { shopifyFileId: fileId }),
								}
							: f
					)
				);
			} else if (fetcher.data.error) {
				setFiles((prev) =>
					prev.map((f) =>
						f.id === uploadId
							? {
									...f,
									status: "error",
									error: fetcher.data?.error || "Unknown error",
								}
							: f
					)
				);
			}
			currentUploadIdRef.current = null;
		}
	}, [fetcher.state, fetcher.data]);

	const addTag = useCallback(
		(tag: string) => {
			const trimmed = tag.trim();
			if (trimmed && !tags.includes(trimmed)) {
				setTags([...tags, trimmed]);
			}
			setTagInput("");
		},
		[tags]
	);

	const removeTag = useCallback((tagToRemove: string) => {
		setTags((prev) => prev.filter((t) => t !== tagToRemove));
	}, []);

	const handleTagKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				addTag(tagInput);
			} else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
				setTags((prev) => prev.slice(0, -1));
			}
		},
		[addTag, tagInput, tags.length]
	);

	const handleTagInputChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = e.target.value;
			if (value.includes(",")) {
				const parts = value.split(",");
				for (const part of parts) {
					if (part.trim()) {
						addTag(part);
					}
				}
			} else {
				setTagInput(value);
			}
		},
		[addTag]
	);

	const onDrop = useCallback(async (acceptedFiles: File[]) => {
		const newFiles: UploadFile[] = [];

		for (const file of acceptedFiles) {
			if (file.name.endsWith(".zip")) {
				try {
					const zip = await JSZip.loadAsync(file);
					const promises: Promise<void>[] = [];
					zip.forEach((_relativePath: string, zipEntry: JSZipObject) => {
						if (!zipEntry.dir) {
							promises.push(
								(async () => {
									const content = await zipEntry.async("blob");
									const extractedFile = new File(
										[content],
										zipEntry.name.split("/").pop() || zipEntry.name,
										{ type: "application/octet-stream" }
									);
									newFiles.push({
										id: Math.random().toString(36).substring(7),
										file: extractedFile,
										status: "pending",
									});
								})()
							);
						}
					});
					await Promise.all(promises);
				} catch (err) {
					console.error("Failed to unzip:", err);
					alert(`Failed to process ZIP file: ${file.name}`);
				}
			} else {
				newFiles.push({
					id: Math.random().toString(36).substring(7),
					file,
					status: "pending",
				});
			}
		}

		setFiles((prev) => [...prev, ...newFiles]);
	}, []);

	const { getRootProps, getInputProps, isDragActive } = useDropzone({
		onDrop,
		accept: {
			"image/*": [],
			"application/zip": [".zip"],
			"application/x-zip-compressed": [".zip"],
		},
	});

	const uploadNextFile = useCallback(() => {
		const pendingFiles = files.filter((f) => f.status === "pending");
		if (pendingFiles.length === 0) {
			setIsUploading(false);
			return;
		}

		const fileObj = pendingFiles[0];
		if (!fileObj) {
			setIsUploading(false);
			return;
		}

		currentUploadIdRef.current = fileObj.id;

		setFiles((prev) =>
			prev.map((f) => (f.id === fileObj.id ? { ...f, status: "uploading" } : f))
		);

		const formData = new FormData();
		formData.append("file", fileObj.file);
		formData.append("folder", folder);
		formData.append("tags", tags.join(","));

		fetcher.submit(formData, {
			method: "POST",
			encType: "multipart/form-data",
		});
	}, [files, folder, tags, fetcher]);

	useEffect(() => {
		if (
			isUploading &&
			fetcher.state === "idle" &&
			!currentUploadIdRef.current
		) {
			const pendingFiles = files.filter((f) => f.status === "pending");
			if (pendingFiles.length > 0) {
				uploadNextFile();
			} else {
				setIsUploading(false);
			}
		}
	}, [isUploading, fetcher.state, files, uploadNextFile]);

	const handleUpload = useCallback(() => {
		setIsUploading(true);
		uploadNextFile();
	}, [uploadNextFile]);

	const removeFile = useCallback((id: string) => {
		setFiles((prev) => prev.filter((f) => f.id !== id));
	}, []);

	const clearCompleted = useCallback(() => {
		setFiles((prev) => prev.filter((f) => f.status !== "success"));
	}, []);

	const clearAll = useCallback(() => {
		setFiles([]);
	}, []);

	const pendingCount = files.filter((f) => f.status === "pending").length;
	const successCount = files.filter((f) => f.status === "success").length;

	const getStatusTone = (
		status: string
	): "success" | "critical" | "info" | "neutral" => {
		switch (status) {
			case "success":
				return "success";
			case "error":
				return "critical";
			case "uploading":
				return "info";
			default:
				return "neutral";
		}
	};

	return (
		<s-page heading="Bulk Upload">
			<s-section>
				<s-stack direction="block" gap="base">
					<s-banner tone="info">
						Upload images directly to Shopify Files. You can drop individual
						images or ZIP archives containing images. Optionally specify a
						filename prefix and tags to assign to all uploaded files.
					</s-banner>

					{/* Settings Section */}
					<s-box padding="base" background="subdued" borderRadius="base">
						<s-grid gridTemplateColumns="1fr 1fr" gap="base">
							<s-stack direction="block" gap="small">
								<s-text-field
									label="Filename Prefix (optional)"
									value={folder}
									onChange={(e) =>
										setFolder((e.target as HTMLInputElement).value)
									}
									placeholder="e.g. bf2025 or campaign_summer"
									disabled={isUploading}
								/>
								<s-text color="subdued">
									Added to start of filename (e.g., prefix_image.jpg)
								</s-text>
							</s-stack>

							<s-stack direction="block" gap="small">
								<s-text>
									<strong>Tags (optional)</strong>
								</s-text>
								<s-box
									padding="small"
									background={isUploading ? "subdued" : "transparent"}
									borderWidth="base"
									borderRadius="base"
								>
									<s-stack direction="inline" gap="small" alignItems="center">
										{tags.map((tag) => (
											<s-clickable-chip
												key={tag}
												onClick={() => removeTag(tag)}
												disabled={isUploading}
											>
												{tag} ×
											</s-clickable-chip>
										))}
										<input
											type="text"
											value={tagInput}
											onChange={handleTagInputChange}
											onKeyDown={handleTagKeyDown}
											onBlur={() => tagInput && addTag(tagInput)}
											placeholder={
												tags.length === 0 ? "Type and press Enter" : ""
											}
											disabled={isUploading}
											style={{
												flex: 1,
												minWidth: "100px",
												border: "none",
												outline: "none",
												fontSize: "14px",
												lineHeight: "20px",
												padding: "4px",
												backgroundColor: "transparent",
											}}
										/>
									</s-stack>
								</s-box>
								<s-text color="subdued">
									Press Enter or comma to add tags
								</s-text>
							</s-stack>
						</s-grid>
					</s-box>

					{/* Dropzone - using react-dropzone with Polaris-like styling */}
					<div
						{...getRootProps()}
						style={{
							padding: "24px",
							border: "1px dashed var(--p-color-border)",
							borderRadius: "var(--p-border-radius-200)",
							backgroundColor: isDragActive
								? "var(--p-color-bg-surface-secondary)"
								: "transparent",
							cursor: isUploading ? "not-allowed" : "pointer",
							textAlign: "center",
						}}
					>
						<input {...getInputProps()} disabled={isUploading} />
						<s-stack direction="block" gap="small" alignItems="center">
							<s-icon type="upload" size="base" color="subdued" />
							<s-text>
								<strong>
									{isDragActive
										? "Drop the files here..."
										: "Drag & drop images or ZIP files here, or click to select"}
								</strong>
							</s-text>
							<s-text color="subdued">Supports images and ZIP archives</s-text>
						</s-stack>
					</div>

					{/* File List */}
					{files.length > 0 && (
						<s-stack direction="block" gap="small">
							<s-stack
								direction="inline"
								gap="base"
								justifyContent="space-between"
								alignItems="center"
							>
								<s-text>
									<strong>Files ({files.length})</strong>
								</s-text>
								<s-stack direction="inline" gap="base">
									{successCount > 0 && (
										<s-button
											variant="tertiary"
											onClick={clearCompleted}
											disabled={isUploading}
										>
											Clear Completed
										</s-button>
									)}
									<s-button
										variant="tertiary"
										tone="critical"
										onClick={clearAll}
										disabled={isUploading}
									>
										Clear All
									</s-button>
								</s-stack>
							</s-stack>

							<s-box borderWidth="base" borderRadius="base" overflow="hidden">
								{files.map((f, idx) => (
									<div
										key={f.id}
										style={{
											padding: "var(--p-space-200)",
											borderBottom:
												idx < files.length - 1
													? "1px solid var(--p-color-border)"
													: "none",
										}}
									>
										<s-stack
											direction="inline"
											gap="base"
											alignItems="center"
											justifyContent="space-between"
										>
											<s-stack
												direction="inline"
												gap="small"
												alignItems="center"
											>
												{f.status === "uploading" && <s-spinner size="base" />}
												<s-badge tone={getStatusTone(f.status)}>
													{f.status}
												</s-badge>
												<s-text>
													{f.file.name.slice(0, 30)}
													{f.file.name.length > 30 ? "..." : ""}
												</s-text>
												<s-text color="subdued">
													{(f.file.size / 1024).toFixed(1)} KB
												</s-text>
												{f.status === "success" && f.shopifyFileId && (
													<s-link
														href={`shopify://admin/content/files/${f.shopifyFileId.split("/").pop()}`}
														target="_blank"
													>
														View in Shopify ↗
													</s-link>
												)}
											</s-stack>

											<s-stack
												direction="inline"
												gap="small"
												alignItems="center"
											>
												{f.status === "error" && f.error && (
													<s-badge tone="critical">{f.error}</s-badge>
												)}
												<s-button
													variant="tertiary"
													onClick={() => removeFile(f.id)}
													disabled={isUploading}
												>
													Remove
												</s-button>
											</s-stack>
										</s-stack>
									</div>
								))}
							</s-box>
						</s-stack>
					)}

					{/* Upload Button */}
					<s-button
						variant="primary"
						onClick={handleUpload}
						disabled={isUploading || pendingCount === 0}
					>
						{isUploading
							? "Uploading..."
							: `Upload ${pendingCount} File${pendingCount !== 1 ? "s" : ""}`}
					</s-button>
				</s-stack>
			</s-section>
		</s-page>
	);
}

export const headers = boundary.headers;
