import React from "react";
import { FileJson, FileCode, FileCode2, FileText, FileImage, FileSpreadsheet, FileArchive, Presentation, File } from "lucide-react";
import type { AgentUsage, AgentContextUsageSnapshot, SessionRecord, ChatItem } from "../types.js";

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
  let cacheReadTokens = session.usage?.cacheReadTokens || 0;
  let cacheCreationTokens = session.usage?.cacheCreationTokens || 0;

  // Aggregate all messages that contain usage info
  let msgInput = 0;
  let msgOutput = 0;
  let msgTotal = 0;
  let msgCost = 0;
  let msgCostKnown = true;
  let msgCacheRead = 0;
  let msgCacheCreation = 0;
  for (const message of session.messages || []) {
    // Mirrors calculateSessionUsage (store.ts): assistant turns plus terminal
    // error events from failed/cancelled runs, so header totals include burn.
    const countable =
      message.usage &&
      (message.role === "assistant" || ((message as { kind?: string }).kind === "error"));
    if (countable && message.usage) {
      msgInput += message.usage.inputTokens || 0;
      msgOutput += message.usage.outputTokens || 0;
      msgTotal += message.usage.totalTokens || 0;
      if (message.usage.estimatedCost == null) msgCostKnown = false;
      else msgCost += message.usage.estimatedCost;
      if (message.usage.cacheReadTokens) msgCacheRead += message.usage.cacheReadTokens;
      if (message.usage.cacheCreationTokens) msgCacheCreation += message.usage.cacheCreationTokens;
    }
  }

  // If message sum is larger or session.usage was missing/underreported, use the full message aggregate
  if (msgTotal > totalTokens) {
    inputTokens = msgInput;
    outputTokens = msgOutput;
    totalTokens = msgTotal;
    costKnown = msgCostKnown;
    cacheReadTokens = msgCacheRead;
    cacheCreationTokens = msgCacheCreation;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: costKnown ? Number(msgCost.toFixed(4)) : null,
      ...(cacheReadTokens > 0 || cacheCreationTokens > 0 ? { cacheReadTokens, cacheCreationTokens } : {}),
    };
  }

  if (totalTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: costKnown ? Number((session.usage?.estimatedCost || 0).toFixed(4)) : null,
      ...(cacheReadTokens > 0 || cacheCreationTokens > 0 ? { cacheReadTokens, cacheCreationTokens } : {}),
    };
  }
  return session.usage;
}

/**
 * Latest retained-context snapshot emitted by the agent. Unlike call input
 * usage, this represents the context that a later turn will rebuild from.
 */
export function getSessionContextUsage(session?: SessionRecord | null): AgentContextUsageSnapshot | undefined {
  if (!session) return undefined;
  for (let i = (session.messages || []).length - 1; i >= 0; i--) {
    const message = (session.messages || [])[i];
    if (message.context) return {
      inputTokens: message.context.usedTokens,
      outputTokens: 0,
      totalTokens: message.context.usedTokens,
      estimatedCost: null,
      contextWindow: message.context.contextWindow,
      compactionThreshold: message.context.compactionThreshold,
      usedTokens: message.context.usedTokens,
      breakdown: message.context.breakdown,
      cacheInputTokens: message.context.cacheInputTokens,
      cacheReadTokens: message.context.cacheReadTokens,
      cacheCreationTokens: message.context.cacheCreationTokens,
    };
  }
  // Fallback to session usage if context snapshot has not been emitted yet
  const usage = getSessionUsage(session);
  if (usage && usage.totalTokens > 0) {
    const used = usage.inputTokens || usage.totalTokens;
    return {
      usedTokens: used,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimatedCost: usage.estimatedCost,
      cacheInputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    };
  }
  return undefined;
}


export function formatRelativeTime(dateString?: string): string {
  if (!dateString) return "";
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return "";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 4) return `${diffWeeks}w`;
  return `${Math.floor(diffDays / 30)}mo`;
}
