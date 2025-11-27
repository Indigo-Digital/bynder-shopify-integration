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
import { uploadBufferToShopify } from "../lib/shopify/files";
import { setFileTags } from "../lib/shopify/metafields";
import { authenticate } from "../shopify.server";

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

		// Construct path: folder/filename
		// Ensure folder doesn't have leading/trailing slashes if it exists
		const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
		const fullPath = cleanFolder
			? `${cleanFolder}/${originalFilename}`
			: originalFilename;

		// Upload to Shopify
		const { fileId, fileUrl } = await uploadBufferToShopify(
			admin,
			buffer,
			file.type,
			fullPath,
			originalFilename,
			session.shop,
			undefined // no syncJobId
		);

		// Set tags if present
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

// Tag chip styles
const tagChipStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: "4px",
	padding: "4px 8px",
	backgroundColor: "#e4e5e7",
	borderRadius: "4px",
	fontSize: "13px",
	lineHeight: "16px",
};

const tagRemoveButtonStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: "16px",
	height: "16px",
	padding: 0,
	border: "none",
	background: "none",
	cursor: "pointer",
	borderRadius: "2px",
	color: "#6d7175",
};

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

	// Handle fetcher responses
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

	const addTag = (tag: string) => {
		const trimmed = tag.trim();
		if (trimmed && !tags.includes(trimmed)) {
			setTags([...tags, trimmed]);
		}
		setTagInput("");
	};

	const removeTag = (tagToRemove: string) => {
		setTags(tags.filter((t) => t !== tagToRemove));
	};

	const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			addTag(tagInput);
		} else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
			// Remove last tag when backspace on empty input
			setTags(tags.slice(0, -1));
		}
	};

	const handleTagInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const value = e.target.value;
		// If user types a comma, add the tag
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
	};

	const onDrop = useCallback(async (acceptedFiles: File[]) => {
		const newFiles: UploadFile[] = [];

		for (const file of acceptedFiles) {
			if (file.name.endsWith(".zip")) {
				try {
					const zip = await JSZip.loadAsync(file);

					// Iterate through zip contents
					const promises: Promise<void>[] = [];
					zip.forEach((_relativePath: string, zipEntry: JSZipObject) => {
						if (!zipEntry.dir) {
							promises.push(
								(async () => {
									// Get file content as blob/file
									const content = await zipEntry.async("blob");
									// Create a File object
									const extractedFile = new File(
										[content],
										zipEntry.name.split("/").pop() || zipEntry.name,
										{
											type: "application/octet-stream",
										}
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

	// Process uploads sequentially using the fetcher
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

		// Update status to uploading
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

	// When a file finishes (success or error), upload the next one
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

	const handleUpload = () => {
		setIsUploading(true);
		uploadNextFile();
	};

	const removeFile = (id: string) => {
		setFiles((prev) => prev.filter((f) => f.id !== id));
	};

	const clearCompleted = () => {
		setFiles((prev) => prev.filter((f) => f.status !== "success"));
	};

	const pendingCount = files.filter((f) => f.status === "pending").length;

	return (
		<s-page heading="Bulk Upload">
			<s-section>
				<s-stack direction="block" gap="base">
					<s-banner>
						<p>
							Upload images directly to Shopify Files. You can drop individual
							images or ZIP archives containing images. Optionally specify a
							folder path and tags to assign to all uploaded files.
						</p>
					</s-banner>

					{/* Settings Section */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1fr",
							gap: "16px",
							padding: "16px",
							backgroundColor: "#fafbfb",
							borderRadius: "8px",
							border: "1px solid #e1e3e5",
						}}
					>
						<div>
							<label style={{ display: "block" }}>
								<div
									style={{
										marginBottom: "8px",
										fontWeight: 600,
										fontSize: "14px",
									}}
								>
									Folder Location (optional)
								</div>
								<input
									type="text"
									value={folder}
									onChange={(e) => setFolder(e.target.value)}
									placeholder="e.g. campaigns/summer"
									disabled={isUploading}
									style={{
										width: "100%",
										padding: "8px 12px",
										fontSize: "14px",
										lineHeight: "20px",
										border: "1px solid #8c9196",
										borderRadius: "8px",
										outline: "none",
										boxSizing: "border-box",
									}}
								/>
								<div
									style={{
										marginTop: "4px",
										fontSize: "13px",
										color: "#6d7175",
									}}
								>
									Prefix added to filenames
								</div>
							</label>
						</div>

						<div>
							<div
								style={{
									marginBottom: "8px",
									fontWeight: 600,
									fontSize: "14px",
								}}
							>
								Tags (optional)
							</div>
							<div
								style={{
									display: "flex",
									flexWrap: "wrap",
									gap: "8px",
									padding: "8px 12px",
									minHeight: "40px",
									border: "1px solid #8c9196",
									borderRadius: "8px",
									alignItems: "center",
									backgroundColor: isUploading ? "#fafbfb" : "white",
									boxSizing: "border-box",
								}}
							>
								{tags.map((tag) => (
									<span key={tag} style={tagChipStyle}>
										{tag}
										<button
											type="button"
											onClick={() => removeTag(tag)}
											disabled={isUploading}
											style={tagRemoveButtonStyle}
											aria-label={`Remove ${tag}`}
										>
											<svg
												viewBox="0 0 20 20"
												width="12"
												height="12"
												fill="currentColor"
												aria-hidden="true"
											>
												<path d="M6.707 5.293a1 1 0 0 0-1.414 1.414l3.293 3.293-3.293 3.293a1 1 0 1 0 1.414 1.414l3.293-3.293 3.293 3.293a1 1 0 0 0 1.414-1.414l-3.293-3.293 3.293-3.293a1 1 0 0 0-1.414-1.414l-3.293 3.293-3.293-3.293z" />
											</svg>
										</button>
									</span>
								))}
								<input
									type="text"
									value={tagInput}
									onChange={handleTagInputChange}
									onKeyDown={handleTagKeyDown}
									onBlur={() => tagInput && addTag(tagInput)}
									placeholder={tags.length === 0 ? "Type and press Enter" : ""}
									disabled={isUploading}
									style={{
										flex: 1,
										minWidth: "100px",
										border: "none",
										outline: "none",
										fontSize: "14px",
										lineHeight: "20px",
										padding: 0,
										backgroundColor: "transparent",
									}}
								/>
							</div>
							<div
								style={{
									marginTop: "4px",
									fontSize: "13px",
									color: "#6d7175",
								}}
							>
								Press Enter or comma to add tags
							</div>
						</div>
					</div>

					{/* Dropzone */}
					<div
						{...getRootProps()}
						style={{
							border: "2px dashed #8c9196",
							borderRadius: "8px",
							padding: "40px 20px",
							textAlign: "center",
							cursor: isUploading ? "not-allowed" : "pointer",
							backgroundColor: isDragActive ? "#f1f2f4" : "#fafbfb",
							transition: "background-color 0.2s",
						}}
					>
						<input {...getInputProps()} disabled={isUploading} />
						<div style={{ fontSize: "14px", color: "#202223" }}>
							{isDragActive
								? "Drop the files here..."
								: "Drag & drop images or ZIP files here, or click to select"}
						</div>
						<div
							style={{ fontSize: "13px", color: "#6d7175", marginTop: "8px" }}
						>
							Supports images and ZIP archives
						</div>
					</div>

					{/* File List */}
					{files.length > 0 && (
						<div>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginBottom: "8px",
								}}
							>
								<div style={{ fontWeight: 600, fontSize: "14px" }}>
									Files ({files.length})
								</div>
								<div style={{ display: "flex", gap: "16px" }}>
									{files.some((f) => f.status === "success") && (
										<button
											type="button"
											onClick={clearCompleted}
											disabled={isUploading}
											style={{
												background: "none",
												border: "none",
												color: "#2c6ecb",
												cursor: "pointer",
												fontSize: "14px",
												textDecoration: "underline",
											}}
										>
											Clear Completed
										</button>
									)}
									<button
										type="button"
										onClick={() => setFiles([])}
										disabled={isUploading}
										style={{
											background: "none",
											border: "none",
											color: "#d72c0d",
											cursor: "pointer",
											fontSize: "14px",
											textDecoration: "underline",
										}}
									>
										Clear All
									</button>
								</div>
							</div>

							<div
								style={{
									border: "1px solid #e1e3e5",
									borderRadius: "8px",
									maxHeight: "300px",
									overflowY: "auto",
								}}
							>
								{files.map((f, index) => (
									<div
										key={f.id}
										style={{
											padding: "12px",
											borderBottom:
												index < files.length - 1 ? "1px solid #e1e3e5" : "none",
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											backgroundColor:
												f.status === "success"
													? "#f1f8f5"
													: f.status === "error"
														? "#fef6f6"
														: f.status === "uploading"
															? "#f4f6f8"
															: "white",
										}}
									>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "12px",
												overflow: "hidden",
												flex: 1,
											}}
										>
											<span
												style={{
													fontSize: "11px",
													padding: "2px 6px",
													borderRadius: "4px",
													fontWeight: 600,
													textTransform: "uppercase",
													backgroundColor:
														f.status === "success"
															? "#aee9d1"
															: f.status === "error"
																? "#ffc5c5"
																: f.status === "uploading"
																	? "#a4e8f2"
																	: "#e4e5e7",
													color:
														f.status === "success"
															? "#0d542d"
															: f.status === "error"
																? "#8c0000"
																: f.status === "uploading"
																	? "#003f4f"
																	: "#6d7175",
												}}
											>
												{f.status}
											</span>
											<span
												style={{
													whiteSpace: "nowrap",
													overflow: "hidden",
													textOverflow: "ellipsis",
													fontSize: "14px",
												}}
											>
												{f.file.name}
											</span>
											<span
												style={{
													fontSize: "13px",
													color: "#6d7175",
													flexShrink: 0,
												}}
											>
												{(f.file.size / 1024).toFixed(1)} KB
											</span>
											{f.status === "success" && f.shopifyFileId && (
												<a
													href={`shopify://admin/content/files/${f.shopifyFileId.split("/").pop()}`}
													target="_blank"
													rel="noopener noreferrer"
													style={{
														fontSize: "13px",
														color: "#2c6ecb",
														textDecoration: "none",
														flexShrink: 0,
													}}
												>
													View in Shopify ↗
												</a>
											)}
										</div>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "8px",
											}}
										>
											{f.status === "error" && f.error && (
												<span
													style={{
														color: "#d72c0d",
														fontSize: "13px",
														maxWidth: "200px",
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
													title={f.error}
												>
													{f.error}
												</span>
											)}
											<button
												type="button"
												onClick={() => removeFile(f.id)}
												disabled={isUploading}
												style={{
													background: "none",
													border: "none",
													cursor: isUploading ? "not-allowed" : "pointer",
													padding: "4px",
													borderRadius: "4px",
													color: "#6d7175",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
												}}
												aria-label={`Remove ${f.file.name}`}
											>
												<svg
													viewBox="0 0 20 20"
													width="16"
													height="16"
													fill="currentColor"
													aria-hidden="true"
												>
													<path d="M6.707 5.293a1 1 0 0 0-1.414 1.414l3.293 3.293-3.293 3.293a1 1 0 1 0 1.414 1.414l3.293-3.293 3.293 3.293a1 1 0 0 0 1.414-1.414l-3.293-3.293 3.293-3.293a1 1 0 0 0-1.414-1.414l-3.293 3.293-3.293-3.293z" />
												</svg>
											</button>
										</div>
									</div>
								))}
							</div>
						</div>
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
