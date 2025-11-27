import type { JSZipObject } from "jszip";
import JSZip from "jszip";
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
	type ActionFunctionArgs,
	data,
	type LoaderFunctionArgs,
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
}

export default function BulkUpload() {
	const [files, setFiles] = useState<UploadFile[]>([]);
	const [folder, setFolder] = useState("");
	const [tags, setTags] = useState("");
	const [isUploading, setIsUploading] = useState(false);

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
											type: "application/octet-stream", // We might try to detect type, but Shopify handles it mostly
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

	const handleUpload = async () => {
		setIsUploading(true);

		const pendingFiles = files.filter((f) => f.status === "pending");

		for (const fileObj of pendingFiles) {
			// Update status to uploading
			setFiles((prev) =>
				prev.map((f) =>
					f.id === fileObj.id ? { ...f, status: "uploading" } : f
				)
			);

			const formData = new FormData();
			formData.append("file", fileObj.file);
			formData.append("folder", folder);
			formData.append("tags", tags);

			try {
				const response = await fetch("", {
					method: "POST",
					body: formData,
				});

				const result = await response.json();

				if (!response.ok || result.error) {
					throw new Error(result.error || "Upload failed");
				}

				// Update status to success
				setFiles((prev) =>
					prev.map((f) =>
						f.id === fileObj.id ? { ...f, status: "success" } : f
					)
				);
			} catch (error) {
				// Update status to error
				setFiles((prev) =>
					prev.map((f) =>
						f.id === fileObj.id
							? {
									...f,
									status: "error",
									error:
										error instanceof Error ? error.message : "Unknown error",
								}
							: f
					)
				);
			}
		}

		setIsUploading(false);
	};

	const removeFile = (id: string) => {
		setFiles((prev) => prev.filter((f) => f.id !== id));
	};

	const clearCompleted = () => {
		setFiles((prev) => prev.filter((f) => f.status !== "success"));
	};

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

					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1fr",
							gap: "1rem",
							marginBottom: "1rem",
						}}
					>
						<label style={{ display: "block" }}>
							<div style={{ marginBottom: "0.5rem", fontWeight: "bold" }}>
								Folder Location (optional)
							</div>
							<input
								type="text"
								value={folder}
								onChange={(e) => setFolder(e.target.value)}
								placeholder="e.g. campaigns/summer"
								style={{
									width: "100%",
									padding: "0.5rem",
									border: "1px solid #ccc",
									borderRadius: "4px",
								}}
								disabled={isUploading}
							/>
							<div
								style={{
									fontSize: "0.8rem",
									color: "#666",
									marginTop: "0.25rem",
								}}
							>
								Prefix added to filenames
							</div>
						</label>

						<label style={{ display: "block" }}>
							<div style={{ marginBottom: "0.5rem", fontWeight: "bold" }}>
								Tags (optional)
							</div>
							<input
								type="text"
								value={tags}
								onChange={(e) => setTags(e.target.value)}
								placeholder="e.g. campaign, summer-2025"
								style={{
									width: "100%",
									padding: "0.5rem",
									border: "1px solid #ccc",
									borderRadius: "4px",
								}}
								disabled={isUploading}
							/>
							<div
								style={{
									fontSize: "0.8rem",
									color: "#666",
									marginTop: "0.25rem",
								}}
							>
								Comma-separated list
							</div>
						</label>
					</div>

					<div
						{...getRootProps()}
						style={{
							border: "2px dashed #ccc",
							borderRadius: "8px",
							padding: "3rem",
							textAlign: "center",
							cursor: isUploading ? "not-allowed" : "pointer",
							backgroundColor: isDragActive ? "#f0f0f0" : "transparent",
							marginBottom: "1rem",
						}}
					>
						<input {...getInputProps()} disabled={isUploading} />
						{isDragActive ? (
							<p>Drop the files here ...</p>
						) : (
							<p>
								Drag 'n' drop images or ZIP files here, or click to select files
							</p>
						)}
					</div>

					{files.length > 0 && (
						<div style={{ marginBottom: "1rem" }}>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginBottom: "0.5rem",
								}}
							>
								<h3 style={{ fontWeight: "bold" }}>Files ({files.length})</h3>
								<div style={{ display: "flex", gap: "0.5rem" }}>
									<button
										type="button"
										onClick={clearCompleted}
										disabled={
											isUploading || !files.some((f) => f.status === "success")
										}
										style={{
											background: "none",
											border: "none",
											color: "#0070f3",
											cursor: "pointer",
											textDecoration: "underline",
										}}
									>
										Clear Completed
									</button>
									<button
										type="button"
										onClick={() => setFiles([])}
										disabled={isUploading}
										style={{
											background: "none",
											border: "none",
											color: "#d00",
											cursor: "pointer",
											textDecoration: "underline",
										}}
									>
										Clear All
									</button>
								</div>
							</div>

							<div
								style={{
									border: "1px solid #eee",
									borderRadius: "4px",
									maxHeight: "300px",
									overflowY: "auto",
								}}
							>
								{files.map((f) => (
									<div
										key={f.id}
										style={{
											padding: "0.5rem",
											borderBottom: "1px solid #eee",
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											backgroundColor:
												f.status === "success"
													? "#f0fff4"
													: f.status === "error"
														? "#fff5f5"
														: "transparent",
										}}
									>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "0.5rem",
												overflow: "hidden",
											}}
										>
											<span
												style={{
													fontSize: "0.8rem",
													padding: "0.1rem 0.3rem",
													borderRadius: "3px",
													backgroundColor: "#eee",
												}}
											>
												{f.status.toUpperCase()}
											</span>
											<span
												style={{
													whiteSpace: "nowrap",
													overflow: "hidden",
													textOverflow: "ellipsis",
													maxWidth: "300px",
												}}
											>
												{f.file.name}
											</span>
											<span style={{ fontSize: "0.8rem", color: "#999" }}>
												({(f.file.size / 1024).toFixed(1)} KB)
											</span>
										</div>
										<div>
											{f.status === "error" && (
												<span
													style={{
														color: "#d00",
														fontSize: "0.8rem",
														marginRight: "0.5rem",
													}}
													title={f.error}
												>
													Error: {f.error}
												</span>
											)}
											<button
												type="button"
												onClick={() => removeFile(f.id)}
												disabled={isUploading}
												style={{
													background: "none",
													border: "none",
													cursor: "pointer",
													fontSize: "1.2rem",
													lineHeight: 1,
													color: "#999",
												}}
											>
												&times;
											</button>
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					<s-stack direction="inline">
						<s-button
							variant="primary"
							onClick={handleUpload}
							disabled={
								isUploading ||
								files.filter((f) => f.status === "pending").length === 0
							}
						>
							{isUploading
								? "Uploading..."
								: `Upload ${files.filter((f) => f.status === "pending").length} Files`}
						</s-button>
					</s-stack>
				</s-stack>
			</s-section>
		</s-page>
	);
}
