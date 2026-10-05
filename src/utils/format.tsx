import React from "react";
import { FileJson, FileCode, FileCode2, FileText, FileImage, FileSpreadsheet, FileArchive, Presentation, File } from "lucide-react";
import type { AgentUsage, SessionRecord, ChatItem } from "../types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function timeLabel(value: string): string {
  return value === "now" ? "now" : new Date(value).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Muted per-type icon tints — IDE convention (VS Code's set includes
// colored type icons), tuned to stay quiet on the dark panels.
const CODE_BLUE = "#5b9bd5";
type IconSpec = { Icon: typeof File; color: string };
const ICON_RULES: Array<{ exts: string[]; spec: IconSpec }> = [
  { exts: ["ts", "tsx", "mts", "cts"], spec: { Icon: FileCode2, color: CODE_BLUE } },
  { exts: ["js", "jsx", "mjs", "cjs"], spec: { Icon: FileCode2, color: "#d3b96a" } },
  { exts: ["py", "pyi", "pyo", "pyc"], spec: { Icon: FileCode2, color: "#64b58f" } },
  { exts: ["json", "jsonc", "json5"], spec: { Icon: FileJson, color: "#c8b45a" } },
  { exts: ["md", "markdown", "mdx"], spec: { Icon: FileText, color: "#8fa6bf" } },
  { exts: ["txt", "toml", "yaml", "yml", "lock", "log", "ini", "cfg", "env"], spec: { Icon: FileText, color: "#8b98a8" } },
  { exts: ["gitignore", "gitattributes"], spec: { Icon: FileText, color: "#e0796f" } },
  { exts: ["html", "htm", "xml", "svg"], spec: { Icon: FileCode, color: "#d38f6a" } },
  { exts: ["css", "scss", "sass", "less"], spec: { Icon: FileCode, color: "#c586c0" } },
  { exts: ["go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cs", "fs", "fsx", "php", "rb", "dart", "sh", "ps1", "bat", "sql", "graphql"], spec: { Icon: FileCode, color: CODE_BLUE } },
  { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff"], spec: { Icon: FileImage, color: "#9bb0c5" } },
  { exts: ["pptx", "ppsx", "ppt"], spec: { Icon: Presentation, color: "#d98066" } },
  { exts: ["xlsx", "xls", "csv", "ods"], spec: { Icon: FileSpreadsheet, color: "#7db88a" } },
  { exts: ["docx", "doc", "odt"], spec: { Icon: FileText, color: "#6f9ec9" } },
  { exts: ["pdf"], spec: { Icon: FileText, color: "#e0796f" } },
  { exts: ["zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "jar"], spec: { Icon: FileArchive, color: "#c9a26b" } },
];

export function fileIcon(file: string) {
  const name = (file.split("/").pop() || file).toLowerCase();
  const dot = name.lastIndexOf(".");
  // ".gitignore"/".env" are dotfiles, not extensionless — classify by name.
  const ext = dot > 0 ? name.slice(dot + 1) : name.startsWith(".") ? name.slice(1) : "";
  for (const rule of ICON_RULES) {
    if (rule.exts.includes(ext)) {
      const { Icon, color } = rule.spec;
      return <Icon size={14} style={{ color }} />;
    }
  }
  return <File size={14} />;
}

export function pushLiveEvent(buckets: Record<string, ChatItem[]>, sessionId: string, item: ChatItem): Record<string, ChatItem[]> {
  return { ...buckets, [sessionId]: [...(buckets[sessionId] || []), item] };
}

export function getSessionUsage(session?: SessionRecord | null): AgentUsage | undefined {
  if (!session) return undefined;
  let inputTokens = session.usage?.inputTokens || 0;
  let outputTokens = session.usage?.outputTokens || 0;
  let totalTokens = session.usage?.totalTokens || 0;
  let costKnown = session.usage?.estimatedCost != null;

  // Aggregate all messages that contain usage info
  let msgInput = 0;
  let msgOutput = 0;
  let msgTotal = 0;
  let msgCost = 0;
  let msgCostKnown = true;
  for (const message of session.messages || []) {
    if (message.usage && message.role === "assistant") {
      msgInput += message.usage.inputTokens || 0;
      msgOutput += message.usage.outputTokens || 0;
      msgTotal += message.usage.totalTokens || 0;
      if (message.usage.estimatedCost == null) msgCostKnown = false;
      else msgCost += message.usage.estimatedCost;
    }
  }

  // If message sum is larger or session.usage was missing/underreported, use the full message aggregate
  if (msgTotal > totalTokens) {
    inputTokens = msgInput;
    outputTokens = msgOutput;
    totalTokens = msgTotal;
    costKnown = msgCostKnown;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: costKnown ? Number(msgCost.toFixed(4)) : null,
    };
  }

  if (totalTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: costKnown ? Number((session.usage?.estimatedCost || 0).toFixed(4)) : null,
    };
  }
  return session.usage;
}
