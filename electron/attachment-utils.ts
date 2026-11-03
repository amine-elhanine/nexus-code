// Attachment URL helpers shared by IPC routes and the custom protocol.
// Extracted from the old main.ts mega-file; no behavior change.

import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

// Attachment URLs are host-style (nexus-attachment://<hash>.png), so the file
// name lives in the hostname — pathname is empty. basename() alone resolves
// to "" (the attachments directory itself), whose fetch rejects with
// ERR_FILE_NOT_FOUND and crashes the main process uncaught.
export function attachmentFileName(attachmentUrl: string): string {
  const parsed = new URL(attachmentUrl);
  const candidate = path.basename(parsed.pathname) || parsed.hostname || "";
  // Never allow traversal no matter what the renderer sends.
  return path.basename(candidate);
}

// The model APIs need a fetchable URL for images: nexus-attachment:// is a
// renderer-only scheme. Convert saved attachments back to inline base64
// data URLs before they go anywhere near a provider.
export const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  tex: "text/x-tex",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  log: "text/plain",
  toml: "text/plain",
};
export const ATTACHMENT_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
  "text/x-tex": "tex",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/yaml": "yaml",
  "application/xml": "xml",
  "text/html": "html",
};

export function attachmentMimeForFileName(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return ATTACHMENT_MIME_BY_EXT[ext] || "application/octet-stream";
}

export async function resolveImageForModel(imageUrl: string): Promise<string> {
  if (!imageUrl.startsWith("nexus-attachment://")) return imageUrl;
  const fileName = attachmentFileName(imageUrl);
  if (!fileName) throw new Error("Invalid attachment URL.");
  const filePath = path.join(app.getPath("userData"), "attachments", fileName);
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const mime = ATTACHMENT_MIME_BY_EXT[ext] || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// Raw bytes for any attachment URL (nexus-attachment:// file or inline
// data: URL). Used to extract document text for the model and to let the
// agent import non-image files into the project.
export async function resolveAttachmentBytes(attachmentUrl: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  if (attachmentUrl.startsWith("data:")) {
    const match = attachmentUrl.match(/^data:([^;,]+)?(?:;[^;,=]+=[^;,]+)*;base64,([\s\S]+)$/);
    if (!match) throw new Error("Unsupported attachment encoding.");
    const mimeType = (match[1] || "application/octet-stream").toLowerCase();
    const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    const ext = ATTACHMENT_EXT_BY_MIME[mimeType] || "bin";
    return { buffer, fileName: `attachment.${ext}`, mimeType };
  }
  if (attachmentUrl.startsWith("nexus-attachment://")) {
    const fileName = attachmentFileName(attachmentUrl);
    if (!fileName) throw new Error("Invalid attachment URL.");
    const filePath = path.join(app.getPath("userData"), "attachments", fileName);
    const buffer = await fs.readFile(filePath);
    return { buffer, fileName, mimeType: attachmentMimeForFileName(fileName) };
  }
  throw new Error("Unsupported attachment URL.");
}
