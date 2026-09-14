import type { ChatAttachment } from "../types.js";

export const ATTACHMENT_ACCEPT =
  "image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.ppsx,.tex,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.log,.toml";

export function isImageAttachment(attachment: Pick<ChatAttachment, "mimeType" | "name">): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(attachment.name || "");
}

export function attachmentKind(fileName: string): "image" | "pdf" | "docx" | "xlsx" | "pptx" | "markdown" | "text" | "unsupported" {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (["xlsx", "xls", "csv", "tsv"].includes(ext)) return "xlsx";
  if (["pptx", "ppsx", "ppt"].includes(ext)) return "pptx";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["txt", "tex", "json", "yaml", "yml", "xml", "html", "htm", "log", "toml"].includes(ext)) return "text";
  return "unsupported";
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Load raw bytes for an attachment URL (nexus-attachment:// via fetch, or inline data: URL). */
export async function loadAttachmentBytes(attachment: Pick<ChatAttachment, "url" | "name" | "mimeType">): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  if (attachment.url.startsWith("data:")) {
    const match = attachment.url.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/);
    if (!match) throw new Error("Unsupported attachment encoding.");
    const mimeType = (match[1] || attachment.mimeType || "application/octet-stream").toLowerCase();
    const binary = atob(match[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { buffer: bytes.buffer, mimeType };
  }
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error("Attachment file not found.");
  const buffer = await response.arrayBuffer();
  return { buffer, mimeType: attachment.mimeType || response.headers.get("content-type") || "application/octet-stream" };
}
