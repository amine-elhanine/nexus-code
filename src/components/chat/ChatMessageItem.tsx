import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  Bot,
  Terminal,
  Activity,
  X,
  Brain,
  Check,
  Copy,
  Lightbulb,
  Loader2,
  ChevronDown,
  ChevronRight,
  FileText,
  FileCode,
  FileEdit,
  Search,
  Sparkles,
  Globe,
  AlertCircle,
  GitBranch,
  Pencil,
  RotateCcw,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { RichMarkdown } from "../common/RichMarkdown.js";
import { timeLabel } from "../../utils/format.js";
import { isImageAttachment, formatAttachmentSize } from "../../utils/attachments.js";
import { PlanCard } from "./PlanCard.js";
import { SubagentCardView } from "./SubagentCard.js";
import { ArtifactCard } from "./ArtifactCard.js";
import { ErrorBoundary } from "../common/ErrorBoundary.js";
import type { ChatAttachment, ChatItem, ArtifactItem, PlanItem, SubagentItem } from "../../types.js";

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (permissions / non-secure context) — fallback.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export type DeliverableChipItem = {
  filename: string;
  name: string;
  extension: string;
  meta?: string;
};

export function extractDeliverablesFromText(text: string): DeliverableChipItem[] {
  if (!text) return [];
  const results: DeliverableChipItem[] = [];
  const seen = new Set<string>();
  const extGroup = "(?:pptx|ppsx|xlsx|xls|pdf|docx|doc|png|jpg|jpeg|svg|webp|gif|csv|txt|md|html|tex)";

  // 1. Explicit lines with File / Deliverable / Generated / Output / Document / Presentation etc.
  // e.g. **File:** `Attack on Titan Presentation.pptx` (13 slides), File: ElGrande Toto.pptx, Deliverable created: foo.pptx
  const linePattern = new RegExp(
    "(?:^|\\n)[^\\r\\n]*?(?:File|Deliverable(?:\\s+created)?|Generated(?:\\s+file)?|Document|Presentation|Spreadsheet|Report|Output):?(?:\\*\\*)?\\s*:?\\s*[`\"'*]*([^\\r\\n`\"'*()<>]+\\." + extGroup + ")[`\"'*]*(?:\\s*\\(([^)]+)\\))?",
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = linePattern.exec(text)) !== null) {
    const rawPath = m[1].trim();
    const filename = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
    if (!seen.has(filename.toLowerCase())) {
      seen.add(filename.toLowerCase());
      const ext = filename.split(".").pop()?.toLowerCase() || "";
      results.push({
        filename,
        name: filename.replace(/\.[^.]+$/, ""),
        extension: ext,
        meta: m[2]?.trim(),
      });
    }
  }

  // 2. Markdown links: [name.pptx](...) or [Download](name.pptx)
  const linkPattern = new RegExp("\\[([^\\]]+?\\." + extGroup + ")\\]\\([^)]+\\)", "gi");
  while ((m = linkPattern.exec(text)) !== null) {
    const rawPath = m[1].trim();
    const filename = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
    if (!seen.has(filename.toLowerCase())) {
      seen.add(filename.toLowerCase());
      const ext = filename.split(".").pop()?.toLowerCase() || "";
      results.push({
        filename,
        name: filename.replace(/\.[^.]+$/, ""),
        extension: ext,
      });
    }
  }

  // 3. Fallback scan for inline filenames in backticks: `file.pptx` or `file.docx`
  const codePattern = new RegExp("`([^`\\r\\n]+\\." + extGroup + ")`", "gi");
  while ((m = codePattern.exec(text)) !== null) {
    const rawPath = m[1].trim();
    const filename = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
    if (!seen.has(filename.toLowerCase())) {
      seen.add(filename.toLowerCase());
      const ext = filename.split(".").pop()?.toLowerCase() || "";
      results.push({
        filename,
        name: filename.replace(/\.[^.]+$/, ""),
        extension: ext,
      });
    }
  }

  // 4. Bold filenames: **file.pptx** or **financial_summary.xlsx**
  const boldPattern = new RegExp("\\*\\*([^*\\r\\n]+\\." + extGroup + ")\\*\\*", "gi");
  while ((m = boldPattern.exec(text)) !== null) {
    const rawPath = m[1].trim();
    const filename = rawPath.replace(/\\/g, "/").split("/").pop() || rawPath;
    if (!seen.has(filename.toLowerCase())) {
      seen.add(filename.toLowerCase());
      const ext = filename.split(".").pop()?.toLowerCase() || "";
      results.push({
        filename,
        name: filename.replace(/\.[^.]+$/, ""),
        extension: ext,
      });
    }
  }

  return results;
}

export function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  if (!text) return null;
  return (
    <button
      className="pane-action"
      style={{ display: "inline-flex", alignItems: "center" }}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={copied ? "Copied!" : "Copy to clipboard"}
      aria-label={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

export type StepStatus = "pending" | "running" | "completed" | "error";

export type StepCategory =
  | "read"
  | "write"
  | "run"
  | "search"
  | "skill"
  | "browse"
  | "plan"
  | "thinking"
  | "subagent"
  | "artifact"
  | "status"
  | "error";

export interface ParsedStepMeta {
  category: StepCategory;
  badgeLabel: string;
  title: string;
  toolName?: string;
  target?: string;
  displayFile?: string;
  fileExt?: string;
  lineRange?: string;
  command?: string;
  query?: string;
  skill?: string;
  diffStats?: { add: number; del: number };
}

export interface NormalizedStep {
  id: string;
  category: StepCategory;
  badgeLabel: string;
  title: string;
  toolName?: string;
  target?: string;
  displayFile?: string;
  fileExt?: string;
  lineRange?: string;
  diffStats?: { add: number; del: number };
  command?: string;
  query?: string;
  skill?: string;
  detail?: string;
  status: StepStatus;
  timestamp: string;
  plan?: PlanItem[];
  subagent?: SubagentItem;
  artifact?: ArtifactItem;
}

function parseFileTarget(rawTarget: string): {
  cleanPath: string;
  displayFile: string;
  fileExt?: string;
  lineRange?: string;
} {
  let cleanPath = String(rawTarget || "").trim();
  let lineRange: string | undefined;

  const rangeMatch = cleanPath.match(/^(.*?):(\d+)-(\d+)$/);
  if (rangeMatch && rangeMatch[1]) {
    cleanPath = rangeMatch[1];
    lineRange = `#L${rangeMatch[2]}-${rangeMatch[3]}`;
  } else {
    const offsetMatch = cleanPath.match(/^(.*?):(\d+)\+(\d+)$/);
    if (offsetMatch && offsetMatch[1]) {
      const start = Number(offsetMatch[2]) + 1;
      const limit = Number(offsetMatch[3]);
      const end = limit > 0 ? start + limit - 1 : start;
      cleanPath = offsetMatch[1];
      lineRange = `#L${start}-${end}`;
    }
  }

  const normalized = cleanPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const baseName = normalized.split("/").pop() || normalized || cleanPath;
  const extMatch = baseName.match(/\.([a-zA-Z0-9]+)$/);
  const fileExt = extMatch ? extMatch[1].toLowerCase() : undefined;

  return {
    cleanPath,
    displayFile: baseName,
    fileExt,
    lineRange,
  };
}

function getFileBadge(ext?: string): { label: string; className: string } | null {
  if (!ext) return null;
  switch (ext.toLowerCase()) {
    case "ts":
      return { label: "TS", className: "ext-ts" };
    case "tsx":
      return { label: "TSX", className: "ext-ts" };
    case "js":
    case "mjs":
    case "cjs":
      return { label: "JS", className: "ext-js" };
    case "jsx":
      return { label: "JSX", className: "ext-js" };
    case "json":
    case "jsonc":
      return { label: "{}", className: "ext-json" };
    case "py":
      return { label: "PY", className: "ext-py" };
    case "css":
    case "scss":
    case "less":
      return { label: "CSS", className: "ext-css" };
    case "html":
    case "htm":
      return { label: "HTML", className: "ext-html" };
    case "md":
    case "markdown":
      return { label: "MD", className: "ext-md" };
    case "pptx":
    case "docx":
    case "xlsx":
    case "pdf":
    case "tex":
    case "svg":
    case "csv":
      return { label: ext.toUpperCase(), className: "ext-doc" };
    default:
      return null;
  }
}

function computeLineDiffCounts(before: string, after: string): { add: number; del: number } {
  const oldLines = before === "" ? [] : before.split(/\r?\n/);
  const newLines = after === "" ? [] : after.split(/\r?\n/);
  if (oldLines.length === 0) return { add: newLines.length, del: 0 };
  if (newLines.length === 0) return { add: 0, del: oldLines.length };
  if (oldLines.length * newLines.length <= 40000) {
    const m = oldLines.length;
    const n = newLines.length;
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);
    for (let i = 1; i <= m; i++) {
      curr.fill(0);
      for (let j = 1; j <= n; j++) {
        curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      [prev, curr] = [curr, prev];
    }
    const common = prev[n];
    return { add: n - common, del: m - common };
  }
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) || 0) + 1);
  let common = 0;
  for (const line of newLines) {
    const c = counts.get(line) || 0;
    if (c > 0) {
      common++;
      counts.set(line, c - 1);
    }
  }
  return { add: newLines.length - common, del: oldLines.length - common };
}

function computeDiffStatsFromDetail(
  detail?: string,
  category?: StepCategory,
  title?: string,
  toolName?: string
): { add: number; del: number } | undefined {
  if (!detail) return undefined;
  const editMatch = detail.match(
    /\[Target to replace\]:\r?\n([\s\S]*?)\r?\n\r?\n\[Replacement\]:\r?\n([\s\S]*?)(?:\r?\n\r?\n\[(?:Output|Error Output)\]:|$)/
  );
  if (editMatch) {
    return computeLineDiffCounts(editMatch[1], editMatch[2]);
  }
  if (category === "write" || title === "Create file" || toolName === "write_file") {
    const contentMatch = detail.match(/\[Content\]:\r?\n([\s\S]*?)(?:\r?\n\r?\n\[(?:Output|Error Output)\]:|$)/);
    if (contentMatch) {
      const lineCount = contentMatch[1] === "" ? 0 : contentMatch[1].split(/\r?\n/).length;
      return { add: lineCount, del: 0 };
    }
  }
  return undefined;
}

const TRANSIENT_STATUS_PATTERN =
  /^(?:starting (?:home assistant|the (?:notebook )?agent|agent\b)|expanded slash command\b|connected to mcp\b|loaded \d+ plugin tools\b|loaded create_deliverable\b|preparing context\b|(?:agent is )?working on the task\b|writing response\b|synthesizing (?:final )?response\b|entering verification phase\b|saved to memory\b)/i;

function isTransientBoilerplateStatus(text: string, kind?: string): boolean {
  if (kind === "tool" || kind === "thinking" || kind === "error" || kind === "subagent" || kind === "artifact") {
    return false;
  }
  return TRANSIENT_STATUS_PATTERN.test((text || "").trim());
}

export function parseEventText(text: string, kind?: string): ParsedStepMeta {
  const clean = (text || "").trim();

  // 0. Reasoning deltas — a Claude-Code-style thinking step. Checked first so
  // thinking prose that happens to contain "·" or "✓" is never mis-parsed as
  // a tool call. The full reasoning text travels as the step's detail.
  if (kind === "thinking") {
    return {
      category: "thinking",
      badgeLabel: "THINKING",
      title: "Thinking",
    };
  }

  // 1. Skill loading or consulting
  if (/^Consulting skill:\s*(.+)$/i.test(clean) || /^Skill loaded:\s*(.+?)(?:\s*✓)?$/i.test(clean)) {
    const skill = clean.replace(/^(?:Consulting skill:\s*|Skill loaded:\s*)/i, "").replace(/✓$/, "").trim();
    return {
      category: "skill",
      badgeLabel: "SKILL",
      title: "Consult skill",
      skill,
    };
  }

  // 2. Tool calls formatted as "tool_name · arg_summary"
  const toolDotMatch = clean.match(/^([a-zA-Z0-9_-]+)\s*·\s*(.+)$/);
  if (toolDotMatch) {
    const tool = toolDotMatch[1];
    const arg = toolDotMatch[2].trim();

    switch (tool) {
      case "read_file":
      case "read_file_range": {
        const fileInfo = parseFileTarget(arg);
        return {
          category: "read",
          badgeLabel: "READ",
          title: "Read file",
          toolName: tool,
          target: fileInfo.cleanPath,
          displayFile: fileInfo.displayFile,
          fileExt: fileInfo.fileExt,
          lineRange: fileInfo.lineRange,
        };
      }
      case "inspect_artifact": {
        const fileInfo = parseFileTarget(arg);
        return {
          category: "read",
          badgeLabel: "INSPECT",
          title: "Inspect artifact",
          toolName: tool,
          target: fileInfo.cleanPath,
          displayFile: fileInfo.displayFile,
          fileExt: fileInfo.fileExt,
        };
      }
      case "write_file":
      case "create_deliverable": {
        const fileInfo = parseFileTarget(arg);
        return {
          category: "write",
          badgeLabel: tool === "create_deliverable" ? "CREATE" : "WRITE",
          title: "Create file",
          toolName: tool,
          target: fileInfo.cleanPath,
          displayFile: fileInfo.displayFile,
          fileExt: fileInfo.fileExt,
        };
      }
      case "edit_file": {
        const fileInfo = parseFileTarget(arg);
        return {
          category: "write",
          badgeLabel: "EDIT",
          title: "Edit file",
          toolName: tool,
          target: fileInfo.cleanPath,
          displayFile: fileInfo.displayFile,
          fileExt: fileInfo.fileExt,
        };
      }
      case "apply_patch": {
        const fileInfo = parseFileTarget(arg);
        return {
          category: "write",
          badgeLabel: "PATCH",
          title: "Apply patch",
          toolName: tool,
          target: arg,
          displayFile: arg.includes(",") ? arg : fileInfo.displayFile,
          fileExt: arg.includes(",") ? undefined : fileInfo.fileExt,
        };
      }
      case "delete": {
        const fileInfo = parseFileTarget(arg);
        return {
          category: "write",
          badgeLabel: "DEL",
          title: "Delete file",
          toolName: tool,
          target: fileInfo.cleanPath,
          displayFile: fileInfo.displayFile,
          fileExt: fileInfo.fileExt,
        };
      }
      case "execute":
        return {
          category: "run",
          badgeLabel: "BASH",
          title: "Execute command",
          toolName: tool,
          command: arg,
        };
      case "grep":
      case "grep_search":
        return {
          category: "search",
          badgeLabel: "GREP",
          title: "Search code",
          toolName: tool,
          query: arg,
        };
      case "glob":
        return {
          category: "search",
          badgeLabel: "GLOB",
          title: "Find files",
          toolName: tool,
          query: arg,
        };
      case "ls":
        return {
          category: "search",
          badgeLabel: "LIST",
          title: "List directory",
          toolName: tool,
          target: arg,
        };
      case "find_symbol_definition":
      case "find_symbol_references":
      case "get_symbol_outline": {
        const isFile = tool === "get_symbol_outline";
        const fileInfo = isFile ? parseFileTarget(arg) : null;
        return {
          category: "search",
          badgeLabel: "LSP",
          title: "Inspect symbol",
          toolName: tool,
          target: fileInfo ? fileInfo.cleanPath : arg,
          displayFile: fileInfo?.displayFile,
          fileExt: fileInfo?.fileExt,
        };
      }
      case "web_search":
        return {
          category: "browse",
          badgeLabel: "WEB",
          title: "Web search",
          toolName: tool,
          query: arg,
        };
      case "browser_inspect":
      case "browser_fetch_api":
        return {
          category: "browse",
          badgeLabel: "BROWSE",
          title: "Inspect page",
          toolName: tool,
          target: arg,
        };
      case "learn_skill":
        return {
          category: "skill",
          badgeLabel: "SKILL",
          title: "Learn skill",
          toolName: tool,
          skill: arg,
        };
      case "home_memory":
        return {
          category: "status",
          badgeLabel: "MEM",
          title: "Update memory",
          toolName: tool,
          query: arg,
        };
      case "ask_user":
        return {
          category: "status",
          badgeLabel: "ASK",
          title: "Ask user",
          toolName: tool,
          query: arg.replace(/^needs input:\s*/i, ""),
        };
      case "delegate_task": {
        const roleMatch = arg.match(/^\[([^\]]+)\]\s*(.*)$/);
        return {
          category: "subagent",
          badgeLabel: "AGENT",
          title: roleMatch ? `Subagent [${roleMatch[1]}]` : "Subagent task",
          toolName: tool,
          query: roleMatch ? roleMatch[2] : arg,
        };
      }
      default: {
        const looksLikeFile = !/^https?:\/\//i.test(arg) && /\.[a-zA-Z0-9]{1,8}(?::\d+(?:[-+]\d+)?)?$/.test(arg);
        const fileInfo = looksLikeFile ? parseFileTarget(arg) : null;
        return {
          category: "run",
          badgeLabel: tool.toUpperCase().slice(0, 7),
          title: tool,
          toolName: tool,
          target: fileInfo ? fileInfo.cleanPath : arg,
          displayFile: fileInfo?.displayFile,
          fileExt: fileInfo?.fileExt,
          lineRange: fileInfo?.lineRange,
        };
      }
    }
  }

  // 3. Simple tool completion marker like "tool_name ✓"
  const doneMatch = clean.match(/^([a-zA-Z0-9_-]+)\s*✓$/);
  if (doneMatch) {
    const tool = doneMatch[1];
    return {
      category: "run",
      badgeLabel: tool.toUpperCase().slice(0, 7),
      title: `${tool} completed`,
    };
  }

  // 4. Notebook steps
  if (/^working:\s*(.+)$/i.test(clean)) {
    const desc = clean.replace(/^working:\s*/i, "");
    return {
      category: "search",
      badgeLabel: "RERANK",
      title: desc,
    };
  }

  if (/^searching\s+/i.test(clean)) {
    return {
      category: "search",
      badgeLabel: "SEARCH",
      title: clean,
    };
  }

  if (/^synthesizing|^generating/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "STUDIO",
      title: clean,
    };
  }

  if (/^starting the (?:notebook )?agent/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "INIT",
      title: "Starting the agent…",
    };
  }

  if (/^starting home assistant/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "INIT",
      title: "Starting Home Assistant…",
    };
  }

  if (/^starting agent\s*·/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "INIT",
      title: "Starting agent",
      query: clean.replace(/^starting agent\s*·\s*/i, ""),
    };
  }

  if (/^preparing context/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "CTX",
      title: "Preparing context",
      query: clean.replace(/^preparing context\s*·?\s*/i, ""),
    };
  }

  if (/^agent is working on the task$/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "WORK",
      title: "Working on the task",
    };
  }

  if (/^writing response/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "STREAM",
      title: "Synthesizing response…",
    };
  }

  if (kind === "thinking") {
    return {
      category: "thinking",
      badgeLabel: "THINK",
      title: "Thinking",
    };
  }

  if (kind === "error") {
    return {
      category: "error",
      badgeLabel: "ERROR",
      title: clean || "Execution error",
    };
  }

  if (kind === "plan") {
    return {
      category: "plan",
      badgeLabel: "PLAN",
      title: clean || "Working plan",
    };
  }

  if (kind === "subagent") {
    return {
      category: "subagent",
      badgeLabel: "AGENT",
      title: clean || "Subagent task",
    };
  }

  return {
    category: "status",
    badgeLabel: "STEP",
    title: clean || "Agent step",
  };
}

function getCategoryIcon(category: StepCategory, size = 11) {
  switch (category) {
    case "read":
      return <FileText size={size} />;
    case "write":
      return <FileEdit size={size} />;
    case "run":
      return <Terminal size={size} />;
    case "search":
      return <Search size={size} />;
    case "skill":
      return <Sparkles size={size} />;
    case "browse":
      return <Globe size={size} />;
    case "plan":
      return <Brain size={size} />;
    case "thinking":
      return <Lightbulb size={size} />;
    case "subagent":
      return <Bot size={size} />;
    case "artifact":
      return <FileCode size={size} />;
    case "error":
      return <AlertCircle size={size} />;
    default:
      return <Activity size={size} />;
  }
}

function formatTarget(target: string): string {
  if (target.length <= 42) return target;
  const parts = target.split("/");
  if (parts.length > 2) {
    return `${parts[0]}/…/${parts[parts.length - 1]}`;
  }
  return target.slice(0, 40) + "…";
}

function getActionVerb(title: string, isRunning: boolean): string {
  if (!isRunning) {
    switch (title) {
      case "Execute command":
        return "Ran";
      case "Read file":
        return "Analyzed";
      case "Inspect artifact":
        return "Inspected";
      case "Create file":
        return "Created";
      case "Edit file":
      case "Apply patch":
        return "Edited";
      case "Delete file":
        return "Deleted";
      case "Search code":
        return "Searched";
      case "Find files":
        return "Found files";
      case "List directory":
        return "Listed";
      case "Inspect symbol":
        return "Inspected";
      case "Web search":
        return "Searched web";
      case "Inspect page":
        return "Browsed";
      case "Consult skill":
        return "Consulted skill";
      case "Learn skill":
        return "Learned skill";
      case "Update memory":
        return "Updated memory";
      case "Thinking":
        return "Thought";
      default:
        return title;
    }
  }

  switch (title) {
    case "Execute command":
      return "Running";
    case "Read file":
      return "Analyzing";
    case "Inspect artifact":
      return "Inspecting";
    case "Create file":
      return "Creating";
    case "Edit file":
    case "Apply patch":
      return "Editing";
    case "Delete file":
      return "Deleting";
    case "Search code":
      return "Searching";
    case "Find files":
      return "Finding files";
    case "List directory":
      return "Listing";
    case "Inspect symbol":
      return "Inspecting";
    case "Web search":
      return "Searching web";
    case "Inspect page":
      return "Browsing";
    case "Consult skill":
      return "Consulting skill";
    case "Learn skill":
      return "Learning skill";
    case "Update memory":
      return "Updating memory";
    case "Thinking":
      return "Thinking";
    default:
      return title;
  }
}

function computeStepsSummary(steps: NormalizedStep[]): string {
  let reads = 0;
  let writes = 0;
  let runs = 0;
  let searches = 0;
  let skills = 0;

  for (const s of steps) {
    if (s.category === "read") reads++;
    else if (s.category === "write") writes++;
    else if (s.category === "run") runs++;
    else if (s.category === "search") searches++;
    else if (s.category === "skill") skills++;
  }

  const parts: string[] = [];
  if (reads) parts.push(`read ${reads} file${reads > 1 ? "s" : ""}`);
  if (writes) parts.push(`edited ${writes} file${writes > 1 ? "s" : ""}`);
  if (runs) parts.push(`ran ${runs} command${runs > 1 ? "s" : ""}`);
  if (searches) parts.push(`searched ${searches} time${searches > 1 ? "s" : ""}`);
  if (skills) parts.push(`used ${skills} skill${skills > 1 ? "s" : ""}`);

  if (parts.length === 0) return "";
  return parts.slice(0, 2).join(", ");
}

function normalizeActivityEvents(
  events: ChatItem[],
  running: boolean,
  currentText?: string
): NormalizedStep[] {
  const steps: NormalizedStep[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    // Plans are rendered in the sliding plan drawer above the text area, not in the steps timeline
    if (event.kind === "plan") {
      continue;
    }
    // Telemetry-only events never render as steps: context snapshots and
    // usage rows have no user-facing action (context snapshots even carry
    // empty text, which used to surface as junk "Agent step" rows).
    if (event.kind === "context" || event.kind === "usage" || event.kind === "stream-reset" || event.kind === "assistant") {
      continue;
    }
    // Filter noisy internal startup / plumbing status rows from the step timeline;
    // their active phase is reflected in the group header while running.
    if (isTransientBoilerplateStatus(event.text || "", event.kind)) {
      continue;
    }

    const isError = event.kind === "error";
    const isSubagent = event.kind === "subagent" && Boolean(event.subagent);
    const isArtifact = Boolean(event.artifact);
    const isDoneMarker = Boolean(event.text && /✓$/.test(event.text.trim()));

    // Merge matching completion markers (e.g. "execute ✓", "read_file ✓") into previous tool step
    if (isDoneMarker && steps.length > 0) {
      const doneTool = (event.text || "").replace(/✓$/, "").trim();
      let targetStep: NormalizedStep | null = null;
      for (let s = steps.length - 1; s >= 0; s--) {
        const candidate = steps[s];
        if (candidate.category === "thinking") continue;
        const matches =
          (Boolean(doneTool) && (
            (candidate.toolName && candidate.toolName.toLowerCase() === doneTool.toLowerCase()) ||
            candidate.title.toLowerCase().includes(doneTool.toLowerCase()) ||
            candidate.badgeLabel.toLowerCase() === doneTool.toLowerCase() ||
            (candidate.command && doneTool === "execute")
          )) ||
          (doneTool.startsWith("Skill loaded:") && candidate.category === "skill") ||
          (candidate.status === "running");
        if (matches) {
          targetStep = candidate;
          break;
        }
      }
      if (!targetStep) {
        targetStep = steps[steps.length - 1];
      }
      if (targetStep) {
        targetStep.status = "completed";
        if (event.detail) {
          targetStep.detail = event.detail;
          targetStep.diffStats =
            computeDiffStatsFromDetail(event.detail, targetStep.category, targetStep.title, targetStep.toolName) ??
            targetStep.diffStats;
        } else if (!targetStep.detail && event.text) {
          targetStep.detail = event.text;
        }
        continue;
      }
    }

    // Consecutive subagent events for the SAME subagent merge into ONE step
    // card: progress/thinking deltas (which re-send the full item) update the
    // existing card in place instead of spawning a noisy row per event.
    if (isSubagent && steps.length > 0) {
      const prev = steps[steps.length - 1];
      if (prev.category === "subagent" && prev.subagent?.id && prev.subagent.id === event.subagent?.id) {
        prev.subagent = event.subagent;
        if (running && i === events.length - 1) {
          prev.status = event.subagent?.status === "failed" ? "error" : event.subagent?.status === "completed" ? "completed" : "running";
        } else if (event.subagent?.status === "failed") {
          prev.status = "error";
        }
        continue;
      }
    }

    const parsed = parseEventText(event.text, event.kind);

    let category: StepCategory = parsed.category;
    let badgeLabel = parsed.badgeLabel;
    let title = parsed.title;
    let target = parsed.target;
    let displayFile = parsed.displayFile;
    let fileExt = parsed.fileExt;
    if (isError) {
      category = "error";
      badgeLabel = "ERROR";
    } else if (isSubagent) {
      category = "subagent";
      badgeLabel = "AGENT";
    } else if (isArtifact && event.artifact) {
      category = "artifact";
      badgeLabel = "ARTIFACT";
      const artPath = event.artifact.path || event.artifact.filename || event.artifact.name || "";
      if (artPath && !target) {
        const fileInfo = parseFileTarget(artPath);
        target = fileInfo.cleanPath;
        displayFile = fileInfo.displayFile;
        fileExt = fileInfo.fileExt;
        title = "Created";
      }
    }

    const isLastEvent = i === events.length - 1;
    let status: StepStatus = "completed";
    if (isError) {
      status = "error";
    } else if (running && isLastEvent && !isDoneMarker && !currentText?.startsWith("Writing response")) {
      status = "running";
    }

    // Expandable detail rules:
    // - structured detail (tool result excerpts, args details) wins
    // - thinking/artifact/subagent/error rows fall back to event text
    // - tool rows fall back to command / target / query if detail not yet received
    const cleanText = (event.text || "").trim();
    const rawDetail = (event.detail || "").trim();
    const structuredDetail = rawDetail && rawDetail !== cleanText ? event.detail : undefined;
    const fallbackDetail = parsed.command
      ? `$ ${parsed.command}`
      : target
        ? `Path: ${target}`
        : parsed.query
          ? `Query: ${parsed.query}`
          : cleanText || undefined;
    const initialDetail = structuredDetail ?? (category === "thinking" || isError || isArtifact ? cleanText : fallbackDetail);
    const eventTimestamp = event.createdAt || new Date().toISOString();

    // Merge consecutive thinking steps (e.g. when filtered status events separated deltas)
    if (category === "thinking" && steps.length > 0 && steps[steps.length - 1].category === "thinking") {
      const prev = steps[steps.length - 1];
      const nextDetail = (initialDetail || "").trim();
      if (nextDetail && prev.detail !== nextDetail) {
        prev.detail = prev.detail ? `${prev.detail}\n\n${nextDetail}` : nextDetail;
      }
      prev.status = status;
      prev.timestamp = eventTimestamp;
      continue;
    }

    const diffStats = computeDiffStatsFromDetail(initialDetail, category, title, parsed.toolName);

    steps.push({
      id: `${eventTimestamp}-${i}`,
      category,
      badgeLabel,
      title,
      toolName: parsed.toolName,
      target,
      displayFile,
      fileExt,
      lineRange: parsed.lineRange,
      diffStats,
      command: parsed.command,
      query: parsed.query,
      skill: parsed.skill,
      detail: initialDetail,
      status,
      timestamp: eventTimestamp,
      plan: event.plan,
      subagent: event.subagent,
      artifact: event.artifact,
    });
  }

  return steps;
}

function StepItemView({
  step,
  isExpanded,
  onToggle,
  onOpenArtifact,
}: {
  step: NormalizedStep;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
}) {
  const isRunning = step.status === "running";
  const isError = step.status === "error";
  const displayTitle = getActionVerb(step.title, isRunning);
  const fileBadge = step.fileExt ? getFileBadge(step.fileExt) : null;

  const detailText = useMemo(() => {
    if (step.detail && step.detail.trim().length > 0) {
      return step.detail.trim();
    }
    const lines: string[] = [];
    if (step.command) lines.push(`$ ${step.command}`);
    if (step.target) lines.push(`Path: ${step.target}`);
    if (step.query) lines.push(`Query: ${step.query}`);
    if (step.skill) lines.push(`Skill: ${step.skill}`);
    if (isRunning) {
      lines.push(lines.length > 0 ? "\n[Running... in progress]" : "Executing in progress…");
    } else if (lines.length > 0) {
      lines.push("\n[Output]: Completed successfully with no output");
    } else {
      lines.push(step.title || "Step completed");
    }
    return lines.join("\n");
  }, [step.detail, step.command, step.target, step.query, step.skill, step.title, isRunning]);

  return (
    <div className={`agent-timeline-step ${step.status}`}>
      <div className={`step-card ${step.status} ${isExpanded ? "expanded" : ""}`}>
        <div
          className="step-card-header"
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          title={isExpanded ? "Click to collapse" : "Click to inspect"}
        >
          <span className={`step-title-text ${isRunning ? "running" : ""} ${isError ? "error" : ""}`}>
            <span className={`step-verb ${isRunning ? "running" : ""}`}>{displayTitle}</span>

            {fileBadge && (
              <span className={`step-file-badge ${fileBadge.className}`}>{fileBadge.label}</span>
            )}

            {(step.displayFile || step.target) && (
              <span className="step-target-name" title={step.target || step.displayFile}>
                {step.displayFile || formatTarget(step.target!)}
              </span>
            )}

            {step.lineRange && (
              <span className="step-line-range">{step.lineRange}</span>
            )}

            {step.diffStats && (
              <span className="step-diff-stats">
                <span className="add">+{step.diffStats.add}</span>
                <span className="del">-{step.diffStats.del}</span>
              </span>
            )}

            {step.command && (
              <code className="step-command-inline" title={step.command}>
                {step.command}
              </code>
            )}

            {step.query && (
              <span className="step-query-inline" title={step.query}>
                {step.query}
              </span>
            )}

            {step.skill && (
              <span className="step-skill-inline" title={step.skill}>
                {step.skill}
              </span>
            )}
          </span>

          <span className={`step-expand-icon ${isExpanded ? "open" : ""}`}>
            <ChevronRight size={11} />
          </span>
        </div>

        {isExpanded && (
          <div className="step-card-details">
            {step.artifact && (
              <div className="step-embed-card">
                <ArtifactCard
                  artifact={step.artifact}
                  onClick={() => onOpenArtifact?.(step.artifact!)}
                />
              </div>
            )}

            {step.subagent && (
              <div className="step-embed-card">
                <SubagentCardView subagent={step.subagent} timestamp={step.timestamp} />
              </div>
            )}

            {step.plan && step.plan.length > 0 && (
              <div className="step-embed-card">
                <PlanCard plan={step.plan} createdAt={step.timestamp} />
              </div>
            )}

            {detailText && (
              <div className={`step-detail-container ${isError ? "error-detail" : ""} ${step.category === "thinking" ? "thinking-detail" : ""}`}>
                <div className="step-detail-header">
                  <span className="step-detail-label">
                    {step.category === "thinking" ? (
                      <Lightbulb size={10} />
                    ) : step.category === "run" ? (
                      <Terminal size={10} />
                    ) : isError ? (
                      <AlertCircle size={10} />
                    ) : (
                      <FileText size={10} />
                    )}
                    {isError ? "Error trace" : step.category === "thinking" ? "Reasoning" : "Command & Output"}
                  </span>
                  <CopyTextButton text={detailText} />
                </div>
                <pre className={`step-detail-pre ${step.category === "thinking" ? "thinking-detail-pre" : ""}`}>{detailText}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ActivityGroupView({
  events,
  running,
  currentText,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
}: {
  events: ChatItem[];
  running: boolean;
  currentText?: string;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
}) {
  const steps = useMemo(
    () => normalizeActivityEvents(events, running, currentText),
    [events, running, currentText]
  );

  const hasError = useMemo(
    () => events.some((e) => e.kind === "error") || steps.some((s) => s.status === "error"),
    [events, steps]
  );

  const latestStatusText = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.kind === "status" && ev.text?.trim()) {
        return ev.text.trim().replace(/\s*·.*$/, "").trim();
      }
    }
    return "";
  }, [events]);

  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const isGroupExpanded = userExpanded !== null ? userExpanded : (running || hasError);

  const [expandedStepIds, setExpandedStepIds] = useState<Record<string, boolean>>({});
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!running || !isGroupExpanded || !timelineRef.current) return;
    timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [running, isGroupExpanded, steps.length]);

  const toggleStep = (id: string) => {
    setExpandedStepIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const activeStep = steps.find((s) => s.status === "running") || steps[steps.length - 1];

  const workedLabel = useMemo(() => {
    if (running || !steps.length) return null;
    const start = Date.parse(steps[0].timestamp);
    const end = Date.parse(steps[steps.length - 1].timestamp);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "Worked for a moment";
    const totalSeconds = Math.max(1, Math.round((end - start) / 1000));
    if (totalSeconds < 60) return `Worked for ${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `Worked for ${minutes}m ${seconds}s` : `Worked for ${minutes}m`;
  }, [running, steps]);

  // Never render a "Completed 0 agent steps" ghost row when a block had only
  // context/plan/transient-plumbing events and zero real agent steps.
  if (!running && steps.length === 0 && !hasError) {
    return null;
  }

  let headerTitle = "Worked for a moment";
  if (running) {
    if (currentText) {
      headerTitle = currentText;
    } else if (activeStep) {
      const verb = getActionVerb(activeStep.title, true);
      const target = activeStep.displayFile || activeStep.target || activeStep.command || activeStep.skill || activeStep.query;
      headerTitle = target ? `${verb} ${formatTarget(target)}` : `${verb}…`;
    } else if (latestStatusText) {
      headerTitle = latestStatusText;
    } else {
      headerTitle = "Working…";
    }
  } else if (hasError) {
    headerTitle = workedLabel ? `${workedLabel} · issue detected` : "Agent encountered an issue";
  } else if (workedLabel) {
    headerTitle = workedLabel;
  } else {
    const summarySuffix = computeStepsSummary(steps);
    const count = steps.length;
    headerTitle = `Completed ${count} ${count === 1 ? "step" : "steps"}${
      summarySuffix ? ` (${summarySuffix})` : ""
    }`;
  }

  const isWritingResponse = running && Boolean(currentText?.startsWith("Writing response"));
  const showBody = isGroupExpanded && (steps.length > 0 || isWritingResponse);
  const summaryTooltip = running
    ? undefined
    : (() => {
        const summarySuffix = computeStepsSummary(steps);
        return summarySuffix ? `${steps.length} steps — ${summarySuffix}` : `${steps.length} steps`;
      })();

  return (
    <div
      className={`activity-group ${
        running ? "running" : hasError ? "error" : "completed"
      }`}
    >
      <button
        type="button"
        className="activity-group-summary"
        onClick={() => setUserExpanded(!isGroupExpanded)}
        title={summaryTooltip}
      >
        {running && steps.length === 0 && (
          <Loader2 size={11} className="spin activity-group-spinner" />
        )}

        {hasError && !running && (
          <span className="activity-group-icon">
            <AlertCircle size={12} />
          </span>
        )}

        <span className="activity-group-title">
          <span className={running ? "running-label" : ""}>{headerTitle}</span>
        </span>

        {(steps.length > 0 || isWritingResponse) && (
          <span className={`activity-group-chevron ${isGroupExpanded ? "open" : ""}`}>
            <ChevronRight size={12} />
          </span>
        )}
      </button>

      {showBody && (
        <div className="activity-group-body">
          {steps.length > 0 && (
            <div className="agent-stepper-timeline" ref={timelineRef}>
              {steps.map((step) => {
                const isStepExpanded = Boolean(expandedStepIds[step.id]);
                return (
                  <StepItemView
                    key={step.id}
                    step={step}
                    isExpanded={isStepExpanded}
                    onToggle={() => toggleStep(step.id)}
                    onOpenArtifact={onOpenArtifact}
                  />
                );
              })}
            </div>
          )}

          {isWritingResponse && (
            <div className="agent-working-bar">
              <Loader2 size={11} className="spin" />
              <span>Writing response…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-message error boundary: one malformed message (bad chart spec, hostile
// markdown, plugin widget crash) previously killed the ENTIRE transcript view
// — there was a single boundary around the whole view stage. The wrapper
// degrades just that one message to a compact error row; ChatItemViewInner
// stays untouched below.
export function ChatItemView(props: Parameters<typeof ChatItemViewInner>[0]) {
  return (
    <ErrorBoundary variant="inline" label={`message #${props.index ?? "?"}`}>
      <ChatItemViewInner {...props} />
    </ErrorBoundary>
  );
}

function ChatItemViewInner({
  message,
  index,
  artifacts,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
  onEditMessage,
  onForkChat,
  onRegenerate,
}: {
  message: ChatItem;
  index?: number;
  artifacts?: ArtifactItem[];
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
  onEditMessage?: (index: number, text: string) => void;
  onForkChat?: (index: number) => void;
  onRegenerate?: (index: number) => void;
}) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const deliverables = useMemo<ArtifactItem[]>(() => {
    if (message.role !== "assistant") return [];
    const seen = new Set<string>();
    const list: ArtifactItem[] = [];

    const norm = (fn: string) => fn.trim().replace(/^.*[\\/]/, "").toLowerCase();

    // 1. Artifacts produced in this turn (rich with file size, metadata)
    if (artifacts && artifacts.length > 0) {
      for (const art of artifacts) {
        const key = norm(art.filename || art.name || art.path || art.id || "");
        if (key && !seen.has(key)) {
          seen.add(key);
          list.push(art);
        }
      }
    }

    // 2. Deliverables mentioned in assistant prose (deduplicated by filename)
    if (message.text) {
      const fromText = extractDeliverablesFromText(message.text);
      for (const item of fromText) {
        const key = norm(item.filename || item.name);
        if (key && !seen.has(key)) {
          seen.add(key);
          list.push({
            id: item.filename,
            sessionId: "",
            name: item.name,
            filename: item.filename,
            path: item.filename,
            content: "",
            status: "completed",
            userFacing: true,
            requestFeedback: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          });
        }
      }
    }

    return list;
  }, [message.role, message.text, message.createdAt, artifacts]);

  if (message.artifact) {
    return (
      <div className="chat-artifact-single-wrap">
        <ArtifactCard
          artifact={message.artifact}
          onClick={() => onOpenArtifact?.(message.artifact!)}
        />
      </div>
    );
  }
  if (message.role === "event" && message.kind === "subagent" && message.subagent) {
    return <SubagentCardView subagent={message.subagent} timestamp={message.createdAt} />;
  }
  if (message.role === "event" && message.kind === "plan") {
    return null;
  }
  // Telemetry-only events (context snapshots, usage rows, stream resets) are
  // machinery, not activity — never render them as transcript rows.
  if (message.role === "event" && (message.kind === "context" || message.kind === "usage" || message.kind === "stream-reset")) {
    return null;
  }
  if (message.role === "event" && message.kind === "thinking") {
    // Reasoning block (Claude-Code-style): italic reasoning prose only — the
    // accumulated text already lives in detail, so skip the plain-text body.
    return (
      <div className="chat-event-row thinking">
        <span className="step-category-pill mini thinking">
          <Lightbulb size={10} />
          THINKING
        </span>
        <div className="chat-event-body">
          {(message.detail || message.text) && (
            <pre className="chat-event-detail thinking-detail-pre">{message.detail || message.text}</pre>
          )}
        </div>
        <time>{timeLabel(message.createdAt)}</time>
      </div>
    );
  }
  if (message.role === "event") {
    const parsed = parseEventText(message.text, message.kind);
    return (
      <div className={`chat-event-row ${message.kind || parsed.category}`}>
        <span className={`step-category-pill mini ${parsed.category}`}>
          {getCategoryIcon(parsed.category, 10)}
          {parsed.badgeLabel}
        </span>
        <div className="chat-event-body">
          <p>
            {message.text}
          </p>
          {message.detail && (
            <pre className="chat-event-detail">{message.detail}</pre>
          )}
        </div>
        <time>{timeLabel(message.createdAt)}</time>
      </div>
    );
  }
  return (
    <div className={`chat-message ${message.role}`}>
      <div className="chat-author">
        {message.role === "assistant" ? (
          <>
            <span className="agent-avatar">
              <Bot size={13} />
            </span>{" "}
            Nexus
          </>
        ) : (
          <>
            <span className="you-avatar">ME</span> You
          </>
        )}
        <time>{timeLabel(message.createdAt)}</time>
      </div>
      {message.images && message.images.length > 0 && (
        <div className="chat-message-images">
          {message.images.map((img, idx) => (
            <button key={idx} className="chat-attached-image-button" onClick={() => onOpenImage?.(img)} title="Open attached image">
              <img src={img} alt="Attached screenshot" className="chat-attached-img" />
            </button>
          ))}
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className="chat-message-images">
          {message.attachments
            .filter((attachment) => !isImageAttachment(attachment))
            .map((attachment, idx) => (
              <button
                key={`${attachment.name}-${idx}`}
                className="chat-attached-file-button"
                onClick={() => onOpenAttachment?.(attachment)}
                title={`${attachment.name} — click to preview`}
              >
                <FileText size={13} />
                <span className="chat-attached-file-name">{attachment.name}</span>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </button>
            ))}
        </div>
      )}
      {deliverables.length > 0 && (
        <div className="chat-message-deliverables-strip">
          {deliverables.map((item) => (
            <ArtifactCard
              key={item.filename || item.id}
              artifact={item}
              onClick={() => onOpenArtifact?.(item)}
            />
          ))}
        </div>
      )}
      <RichMarkdown source={message.text} className="chat-message-text" />
      {message.role === "user" && (
        <div className="message-actions-bar">
          <CopyTextButton text={message.text} />
          {onEditMessage && typeof index === "number" && (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => onEditMessage(index, message.text)}
              title="Edit & retry from this message"
            >
              <Pencil size={12} />
              <span>Edit</span>
            </button>
          )}
          {onForkChat && typeof index === "number" && (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => onForkChat(index)}
              title="Fork chat from here into a new branch"
            >
              <GitBranch size={12} />
              <span>Fork</span>
            </button>
          )}
        </div>
      )}
      {message.role === "assistant" && Boolean(message.text?.trim()) && (
        <div className="message-actions-bar">
          <CopyTextButton text={message.text} />
          {onRegenerate && typeof index === "number" && (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => onRegenerate(index)}
              title="Regenerate response from this turn"
            >
              <RotateCcw size={12} />
              <span>Regenerate</span>
            </button>
          )}
          {onForkChat && typeof index === "number" && (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => onForkChat(index)}
              title="Fork chat from here into a new branch"
            >
              <GitBranch size={12} />
              <span>Fork</span>
            </button>
          )}
          <span className="msg-action-divider" />
          <button
            type="button"
            className={`msg-action-btn feedback-up ${feedback === "up" ? "active" : ""}`}
            onClick={() => setFeedback((prev) => (prev === "up" ? null : "up"))}
            title="Helpful response"
            aria-label="Helpful response"
          >
            <ThumbsUp size={12} />
          </button>
          <button
            type="button"
            className={`msg-action-btn feedback-down ${feedback === "down" ? "active" : ""}`}
            onClick={() => setFeedback((prev) => (prev === "down" ? null : "down"))}
            title="Needs improvement"
            aria-label="Needs improvement"
          >
            <ThumbsDown size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export function StreamingAssistantMessage({
  text,
  onOpenArtifact,
}: {
  text: string;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
}) {
  if (!text) return null;
  const deliverables = extractDeliverablesFromText(text);

  return (
    <div className="chat-message assistant streaming">
      <div className="chat-author">
        <span className="agent-avatar">
          <Bot size={13} />
        </span>{" "}
        Nexus
        <time>{timeLabel(new Date().toISOString())}</time>
      </div>

      {deliverables.length > 0 && (
        <div className="chat-message-deliverables-strip">
          {deliverables.map((item) => (
            <ArtifactCard
              key={item.filename}
              artifact={{
                id: item.filename,
                sessionId: "",
                name: item.name,
                filename: item.filename,
                path: item.filename,
                content: "",
                status: "completed",
                userFacing: true,
                requestFeedback: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }}
              metaText={item.meta}
              onClick={() => onOpenArtifact?.({
                id: item.filename,
                sessionId: "",
                name: item.name,
                filename: item.filename,
                path: item.filename,
                content: "",
                status: "completed",
                userFacing: true,
                requestFeedback: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              })}
            />
          ))}
        </div>
      )}

      <RichMarkdown source={text} className="chat-message-text" />
    </div>
  );
}
