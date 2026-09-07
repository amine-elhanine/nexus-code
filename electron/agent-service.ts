import { existsSync, readFileSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createDeepAgent, CompositeBackend, FilesystemBackend } from "deepagents";
import { todoListMiddleware } from "langchain";
import { createChatModel } from "./providers.js";
import { createCodeIntelligenceTools, pickRuntimeCodeTools } from "./code-tools.js";
import { createEditTools, createQuestionTool } from "./edit-tools.js";
import { createBrowserTools } from "./browser-tool.js";
import { agentBrowserService } from "./browser-service.js";
import { getRepoMapSection } from "./repo-map-service.js";
import { createWebSearchTools } from "./websearch-tool.js";
import { discoverProjectRules } from "./rules-service.js";
import { createSubagentDelegationTool, calculateAgentUsage, type SubagentItem } from "./subagent-service.js";
import { getWorkspaceDiffFiles } from "./diff-service.js";
import { getMcpTools } from "./mcp-service.js";
import { getSkillsConfig } from "./store.js";
import { GLOBAL_SKILLS_ROUTE, PROJECT_SKILLS_DIR, globalSkillsDir, listSkills, recommendSkills, skillVirtualPath } from "./skills-service.js";
import { compactHistory, estimateTokens, StreamUsageTracker } from "./context-service.js";
import { saveArtifact, type ArtifactItem } from "./artifacts-service.js";
import { TrajectoryLogger } from "./trajectory-service.js";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint } from "./rate-limit.js";
import type { ProviderConfig } from "./store.js";

export type AgentMode = "plan" | "ask" | "auto";
export type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
export type AgentTurn = { role: "user" | "assistant"; text: string };
// Prior-run tool activity fed back into the next run so it reuses results
// instead of re-reading files. Kept as plain text (not LangChain ToolMessages,
// which require matching tool_call_ids the next run doesn't have).
export type HistoryEventItem = {
  role: "event";
  text: string;
  kind?: string;
  detail?: string;
  plan?: PlanItem[];
  subagent?: { role: string; task: string; status: string };
};
export type HistoryInput = AgentTurn | HistoryEventItem;
export type AgentSettings = { provider?: ProviderConfig; model?: string; apiKey?: string; baseUrl?: string };
export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number | null };
export type AgentEvent = {
  type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact";
  sessionId: string;
  text: string;
  timestamp: string;
  items?: PlanItem[];
  usage?: AgentUsage;
  subagent?: SubagentItem;
  artifact?: ArtifactItem;
  // Truncated tool-result excerpt for tool events. Persisted in the session
  // transcript (unlike token chunks) so the NEXT run can reuse what this run
  // already read — without it every run starts cold and re-reads everything.
  detail?: string;
};
export type AgentMemoryContext = { projectMemory: string; sessionMemory: string };
// "code" = repository work (typecheck/test verification). "general" = the
// Home assistant (documents, spreadsheets, slides, research, everyday
// questions): same tool loop, but no code-project verification and a
// different system prompt.
export type AgentTaskKind = "code" | "general";
export class RunCancelledError extends Error {
  constructor() {
    super("Agent run cancelled by user");
    this.name = "RunCancelledError";
  }
}

// OpenCode-style doom-loop breaker: the model repeating the exact same tool
// call is stuck, not working. Thrown from the stream consumer and converted
// into a resumable partial result at graph.invoke — never retried.
export class DoomLoopError extends Error {
  toolName: string;
  constructor(toolName: string, detail: string) {
    super(`DoomLoop: ${toolName} repeated without progress (${detail})`);
    this.name = "DoomLoopError";
    this.toolName = toolName;
  }
}

// LangGraph recursion budgets per mode. Lowered from the previous
// 60/160/300: unbounded budgets let the model wander on trivial tasks.
// Simple tasks get a tight budget via SIMPLE_TASK_LIMIT instead.
const MODE_LIMITS: Record<AgentMode, number> = { plan: 40, ask: 100, auto: 150 };
// Fast-path budget for single-lookup / single-edit tasks: enough to
// read 1-2 files and write. Note this feeds LangGraph's recursionLimit,
// where one tool call costs several supersteps — keep it >= 50 or trivial
// tasks die with GraphRecursionError instead of finishing.
const SIMPLE_TASK_LIMIT = 50;
const MAX_REPAIRS: Record<AgentMode, number> = { plan: 0, ask: 1, auto: 3 };
const HISTORY_CHAR_CAP = 4000;
const VERIFY_OUTPUT_CAP = 4000;
const MEMORY_ENTRY_CAP = 600;
const PROJECT_MEMORY_RUN_LOG_CAP = 20;

const AgentState = Annotation.Root({
  projectRoot: Annotation<string>(),
  request: Annotation<string>(),
  response: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  verifyFeedback: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  repairs: Annotation<number>({ reducer: (_, value) => value, default: () => 0 }),
  verification: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
  runMessages: Annotation<any[]>({ reducer: (_, value) => value, default: () => [] }),
});

function textFromMessage(message: any) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return message.text ?? "";
}

function chunkText(chunk: any) {
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return "";
}

function tail(value: string | undefined, cap: number) {
  if (!value) return "";
  return value.length > cap ? `…${value.slice(-cap)}` : value;
}

// Usage accounting for streamed runs. Chunk-level extraction and per-invocation
// deduplication live in StreamUsageTracker; totals must be summed across all
// model invocations, not overwritten by the latest one.
class UsageAccumulator {
  private tracker = new StreamUsageTracker();

  noteChunk(chunk: any) {
    this.tracker.noteChunk(chunk);
  }

  addSubagent(usage?: AgentUsage) {
    if (!usage) return;
    // Subagent input/output are complete invocation totals, so they are added
    // directly on top of the parent run's own usage.
    this.tracker.addTotals(usage.inputTokens || 0, usage.outputTokens || 0);
  }

  finalize(modelName: string, fallbackInputEstimate = 0, fallbackOutputEstimate = 0): AgentUsage {
    const inputTokens = this.tracker.inputTokens;
    const outputTokens = this.tracker.outputTokens;
    const sawExactInput = this.tracker.sawExactInput;
    const sawExactOutput = this.tracker.sawExactOutput;
    const finalInput = !sawExactInput && inputTokens === 0 && fallbackInputEstimate > 0 ? fallbackInputEstimate : inputTokens;
    const finalOutput = !sawExactOutput && outputTokens === 0 && fallbackOutputEstimate > 0 ? fallbackOutputEstimate : outputTokens;
    return calculateAgentUsage(finalInput, finalOutput, modelName);
  }
}

export function pickVerificationCommand(projectRoot: string): string | null {
  try {
    const root = path.resolve(projectRoot);
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
      // Named typecheck scripts are the source of truth; `check` scripts often
      // cover more tsconfigs than a bare `tsc --noEmit` would (multiple
      // projects), so prefer them over running tsc directly.
      if (typeof scripts.typecheck === "string") return "npm run typecheck";
      if (typeof scripts.check === "string") return "npm run check";
      if (existsSync(path.join(root, "tsconfig.json"))) return "tsc --noEmit";
      if (typeof scripts.lint === "string") return "npm run lint";
    }

    if (existsSync(path.join(root, "Cargo.toml"))) return "cargo check";
    if (existsSync(path.join(root, "go.mod"))) return "go vet ./...";
    if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "ruff.toml"))) return "ruff check";
    return null;
  } catch {
    return null;
  }
}

/**
 * Opencode-style fast path: for small diffs, lint only the changed files
 * instead of typechecking the whole project. Returns null when no fast
 * scoped check applies (caller falls back to pickVerificationCommand).
 */
export function pickFileScopedVerification(projectRoot: string, modifiedFiles: string[]): string | null {
  try {
    if (!modifiedFiles.length || modifiedFiles.length > 5) return null;
    const root = path.resolve(projectRoot);
    const pkgPath = path.join(root, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const devDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const hasEslint = Boolean(devDeps.eslint || typeof pkg.scripts?.lint === "string");
    const quoted = modifiedFiles.map((f) => `"${f.replace(/"/g, "")}"`).join(" ");
    if (hasEslint) return `npx eslint ${quoted}`;
    return null;
  } catch {
    return null;
  }
}

export function findTargetedTests(projectRoot: string, modifiedFiles: string[]): string | null {
  try {
    const root = path.resolve(projectRoot);
    const hasPackageJson = existsSync(path.join(root, "package.json"));
    let hasTestScript = false;
    if (hasPackageJson) {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      hasTestScript = typeof pkg.scripts?.test === "string";
    }

    // Heuristic: check if any modified file has a corresponding test file
    for (const file of modifiedFiles) {
      const parsed = path.parse(file);
      const candidates = [
        path.join(root, parsed.dir, `${parsed.name}.test${parsed.ext}`),
        path.join(root, parsed.dir, `${parsed.name}.spec${parsed.ext}`),
        path.join(root, "test", `${parsed.name}.test${parsed.ext}`),
        path.join(root, "tests", `test_${parsed.name}${parsed.ext}`),
      ];
      for (const cand of candidates) {
        if (existsSync(cand)) {
          const rel = path.relative(root, cand).replace(/\\/g, "/");
          if (hasTestScript) return `npm test -- ${rel}`;
          if (parsed.ext === ".py") return `pytest ${rel}`;
          if (parsed.ext === ".rs") return `cargo test ${parsed.name}`;
          if (parsed.ext === ".go") return `go test ./${path.dirname(rel)}`;
          return null;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function planItemsFromArgs(args: any): PlanItem[] | null {
  if (!args || typeof args !== "object") return null;
  const rawList = Array.isArray(args.items) ? args.items : Array.isArray(args.todos) ? args.todos : Array.isArray(args.plan) ? args.plan : null;
  if (!rawList) return null;
  const items = rawList
    .map((item: any) => {
      if (typeof item === "string") return { content: item, status: "pending" as const };
      const content = String(item?.content || item?.task || item?.title || "").trim();
      const rawStatus = String(item?.status || "pending").toLowerCase();
      const status: PlanItem["status"] = rawStatus === "completed" || rawStatus === "done" ? "completed" : rawStatus === "in_progress" || rawStatus === "active" ? "in_progress" : "pending";
      return { content, status };
    })
    .filter((item: PlanItem) => item.content);
  return items.length ? items : null;
}

// One-line, human-readable detail for a tool call, shown in the activity
// feed (e.g. "read_file · src/App.tsx:1-120", "execute · npm run check").
// Must track the REAL arg schemas: the DeepAgents FilesystemBackend tools
// use snake_case `file_path` (not `filePath`), `apply_patch` takes a single
// `patchText` blob, `ask_user` takes `questions[]`, etc. A generic key scan
// misses those and the UI ends up showing bare `read_file()` / `execute()`.
function shortLine(value: string, max = 90) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function patchFilesSummary(patchText: string): string {
  const files: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\*\s*(?:Add File|Update File|Delete File|Move to)\s*:?\s*(.*)$/i);
    if (m && m[1].trim() && files.length < 4) files.push(m[1].trim());
  }
  if (!files.length) return "";
  const extra = (patchText.match(/^\*\*\*\s*(?:Add File|Update File|Delete File)/gim) || []).length;
  return extra > files.length ? `${files.join(", ")} (+${extra - files.length} more)` : files.join(", ");
}

export function describeToolCall(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Backend tools use `file_path`; custom tools use `filePath`.
  const file = str(args.file_path || args.filePath || args.file || args.path);
  switch (name) {
    case "read_file": {
      if (!file) return "";
      const hasRange = args.offset != null || args.limit != null;
      return hasRange ? `${file}:${args.offset ?? 0}+${args.limit ?? 100}` : file;
    }
    case "write_file":
    case "edit_file":
    case "delete":
      return file;
    case "ls":
      return str(args.path) || "/";
    case "glob": {
      const pattern = str(args.pattern);
      const base = str(args.path);
      return base && base !== "/" ? `${pattern} in ${base}` : pattern;
    }
    case "grep": {
      const pattern = str(args.pattern);
      if (!pattern) return "";
      const scope = str(args.glob || args.path);
      return scope && scope !== "/" ? `"${shortLine(pattern, 60)}" in ${scope}` : `"${shortLine(pattern, 60)}"`;
    }
    case "execute":
      return shortLine(str(args.command), 110);
    case "read_file_range": {
      if (!file) return "";
      return `${file}:${args.startLine ?? 1}-${args.endLine ?? 100}`;
    }
    case "grep_search": {
      const query = str(args.query);
      if (!query) return "";
      const scope = str(args.pathPrefix);
      return scope ? `"${shortLine(query, 60)}" in ${scope}` : `"${shortLine(query, 60)}"`;
    }
    case "find_symbol_definition":
    case "find_symbol_references":
      return str(args.symbol);
    case "get_symbol_outline":
      return file;
    case "apply_patch": {
      const files = patchFilesSummary(str(args.patchText));
      return files || shortLine(str(args.patchText), 60);
    }
    case "ask_user": {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const headers = questions.map((q: any) => str(q?.header || q?.question)).filter(Boolean).slice(0, 3);
      return headers.length ? `needs input: ${shortLine(headers.join(" · "), 90)}` : "";
    }
    case "delegate_task": {
      const role = str(args.role);
      const task = shortLine(str(args.task), 80);
      return role && task ? `[${role}] ${task}` : role || task;
    }
    case "web_search":
      return str(args.query) ? `"${shortLine(str(args.query), 70)}"` : "";
    case "browser_inspect":
      return str(args.url);
    case "browser_fetch_api": {
      const url = str(args.url);
      const method = str(args.method);
      return method && method !== "GET" ? `${method} ${url}` : url;
    }
    default: {
      // Fallback for MCP tools and future tools: scan common key names,
      // including snake_case variants the old scanner missed.
      const parts: string[] = [];
      for (const key of ["file_path", "filePath", "file", "path", "command", "url", "pattern", "query", "symbol", "role", "task"]) {
        const value = (args as any)[key];
        if (typeof value === "string" && value.trim()) {
          parts.push(shortLine(value, 70));
          if (parts.length >= 2) break;
        }
      }
      return parts.join(" · ");
    }
  }
}

function toolCallSummary(call: any) {
  return describeToolCall(call?.name || "", call?.args);
}

// Truncated plain-text excerpt of a LangChain ToolMessage payload for
// transcript persistence. Caps size so one giant grep dump can't bloat every
// future prompt in the session.
export function toolResultExcerpt(content: unknown, cap = 1500): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const o = block as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (typeof o.output === "string") return o.output;
          try {
            return JSON.stringify(o).slice(0, 500);
          } catch {
            return "";
          }
        }
        return "";
      })
      .join("\n");
  } else if (content != null) {
    try {
      text = typeof content === "object" ? JSON.stringify(content) : String(content);
    } catch {
      text = "";
    }
  }
  text = text.trim();
  if (text.length > cap) text = text.slice(0, cap) + `… [truncated ${text.length - cap} chars]`;
  return text;
}

// Builds the "what prior runs already did" context block from persisted
// session events (OpenCode/Pi-style: tool history rides along in-session).
// Call + result pairs are merged, plans expanded, noise (status/usage/
// artifact/token) skipped. Newest-first under the token budget so recent work
// always survives; returns null when there is nothing worth carrying.
export function buildToolContextBlock(items: HistoryInput[] | undefined | null, maxTokens = 4000): string | null {
  if (!items || items.length === 0) return null;
  const maxChars = Math.max(500, maxTokens * 4);
  const PER_ITEM_CAP = 1200;
  const lines: string[] = [];
  // First pass: merge call/result pairs chronologically.
  const push = (head: string, tail = "") => {
    lines.push(tail ? `${head.slice(0, 200)}\n  ↳ ${tail.slice(0, PER_ITEM_CAP)}` : head.slice(0, 200));
  };
  let pendingName: string | null = null;
  for (const item of items) {
    if (item.role !== "event") {
      pendingName = null;
      continue;
    }
    const kind = item.kind || "status";
    if (kind === "status" || kind === "usage" || kind === "token" || kind === "artifact") continue;
    if (kind === "plan" && item.plan?.length) {
      pendingName = null;
      push(`plan: ${item.plan.map((p) => `[${p.status === "completed" ? "x" : " "}] ${p.content}`).join("; ")}`);
      continue;
    }
    if (kind === "error") {
      pendingName = null;
      push(`error: ${item.text}`);
      continue;
    }
    if (kind === "subagent" && item.subagent) {
      pendingName = null;
      push(`subagent [${item.subagent.role}] ${item.subagent.status}: ${item.subagent.task}`.slice(0, 300));
      continue;
    }
    if (kind !== "tool") {
      pendingName = null;
      continue;
    }
    const text = item.text || "";
    if (text.endsWith("✓")) {
      const name = text.slice(0, -1).trim();
      if (pendingName && pendingName.split(" · ")[0] === name && item.detail && lines.length) {
        const idx = lines.length - 1;
        lines[idx] = `${lines[idx].slice(0, 200)}\n  ↳ ${item.detail.slice(0, PER_ITEM_CAP)}`;
      } else if (item.detail) {
        push(name, item.detail);
      }
      pendingName = null;
      continue;
    }
    pendingName = text;
    push(text);
  }
  if (!lines.length) return null;
  // Second pass: newest-first under budget.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > maxChars && kept.length > 0) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
    if (used >= maxChars) break;
  }
  if (!kept.length) return null;
  return (
    `[Session tool history — work already done in this session, newest last. ` +
    `Do NOT re-run these tool calls or re-read these files unless they changed since; build on the results below.]\n` +
    kept.map((l) => `• ${l}`).join("\n")
  );
}

export type TaskComplexity = "simple" | "complex";

const COMPLEX_TASK_PATTERN =
  /\b(refactor|migrate|redesign|overhaul|multi[- ]?step|all files|entire (codebase|project|app|repo)|codebase-wide|end[- ]to[- ]end|from scratch)\b/i;
// Building something new from zero is a multi-file project even when the
// request is one short sentence ("build me an app..."). Single-file creates
// ("create a file/component/function") stay simple.
const BUILD_TASK_PATTERN =
  /\b(build|building|rebuild|scaffold|scaffolding|bootstrap|bootstrapping|launch|launching|set\s+up\s+a\s+new)\b/i;
const CREATE_PROJECT_PATTERN =
  /\b(create|creating|make|making|develop|developing|generate|generating|build|building|launch|launching|start)\b.{0,40}\b(app|application|website|site|platform|portal|hub|project|dashboard|chat\s*app|web\s*app)\b/i;
// Deliverable builds (slides, docs, spreadsheets) are multi-step projects
// even in one short sentence: read the skill, write a generator script,
// run it, verify the file. Classifying them "simple" caps the run at ~3
// tool calls — the agent burns them all on skill exploration and never acts.
const DOC_BUILD_PATTERN =
  /\b(presentation|power ?point|pptx?|slide deck|slideshow|slides?|spreadsheet|excel|xlsx?|workbook|word documents?|docx?|latex)\b/i;
// "Create/write a report/memo/summary" is a document build even without a
// format keyword: research + write + save is multi-step, never a lookup.
const DOC_WRITE_PATTERN =
  /\b(create|make|generate|write|draft)\b.{0,40}\b(report|document|memo|letter|resume|summary|writeup|write-up)\b/i;
const WEB_TASK_PATTERN = /\b(localhost|127\.0\.0\.1|https?:\/\/|web ?(app|page|server)|browser|api .*(health|endpoint)|dev server)\b/i;
// Edit verbs: the request wants the code changed, not explained.
const EDIT_VERB_PATTERN =
  /\b(fix|implement|add|change|update|create|delete|remove|write|move|rename|migrate|debug|resolve|handle|support|enable|wire|integrate|replace)\b/i;
// Bug language: debugging is never a 3-call lookup — it needs
// reproduce + locate + fix + verify, so it must never route simple.
const BUG_PATTERN =
  /\b(bug|error|failing|failed|broken|crash|issue|wrong|exception|stack|traceback|doesn'?t work|not working)\b/i;

/** Heuristic router: trivial lookups / single edits skip planning, delegation and full verification. */
export function classifyTaskComplexity(request: string): TaskComplexity {
  const text = (request || "").trim();
  if (!text) return "simple";
  // Pure questions are lookups, not projects — even long ones. Only promote
  // when the text carries explicit edit verbs.
  if (/^(what|where|which|how\s+(does|do|is|are|can)|why|explain|describe|show|list|tell\s+me)\b/i.test(text) &&
    !/\b(fix|implement|add|change|refactor|update|create|delete|remove|write|move|rename|migrate)\b/i.test(text)) {
    return "simple";
  }
  if (COMPLEX_TASK_PATTERN.test(text)) return "complex";
  if (BUILD_TASK_PATTERN.test(text) || CREATE_PROJECT_PATTERN.test(text)) return "complex";
  if (DOC_BUILD_PATTERN.test(text)) return "complex";
  if (DOC_WRITE_PATTERN.test(text)) return "complex";
  // Debugging always needs reproduce + locate + fix + verify: never simple.
  if (BUG_PATTERN.test(text) && EDIT_VERB_PATTERN.test(text)) return "complex";
  // An edit verb with any scope signal is real work, not a lookup: two files,
  // a non-trivial description, pasted code/traces, or verify/test language.
  const fileMentions = (text.match(/[\w\-./]+\.\w{1,5}/g) || []).length;
  const hasPastedContext = /```/.test(text) || /^\s*at\s+\S+.*:\d+/m.test(text) || /\b(Error|Exception|Traceback)\s*:/.test(text);
  if (
    EDIT_VERB_PATTERN.test(text) &&
    (fileMentions >= 2 ||
      text.length > 120 ||
      hasPastedContext ||
      /\b(verify|test|tests|check)\b/i.test(text))
  ) {
    return "complex";
  }
  // Long multi-sentence briefs are real projects, not quick tasks.
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  if (text.length > 350 || (sentences.length >= 3 && text.length > 180)) return "complex";
  // Explicit multi-file / multi-stage signals.
  if (fileMentions >= 3) return "complex";
  if (/\b(and then|then verify|step \d|first .* then)\b/i.test(text) && text.length > 120) return "complex";
  return "simple";
}

export function isWebTask(request: string): boolean {
  return WEB_TASK_PATTERN.test(request || "");
}

/** True when the user wants a brand-new project scaffolded, not an edit. */
export function isNewProjectTask(request: string): boolean {
  const text = (request || "").trim();
  if (!text) return false;
  // Explicit existing-project signals win over build verbs: "add a dashboard
  // to this repo" is an edit inside the workspace, not a greenfield scaffold
  // (which would nest a fresh Vite app + npm install into the current repo).
  if (/\b(into|in)\s+(this|the|our|my)\s+(repo|repository|project|codebase|app)\b/i.test(text)) return false;
  if (/\bexisting\s+(repo|repository|project|codebase|app)\b/i.test(text)) return false;
  return BUILD_TASK_PATTERN.test(text) || CREATE_PROJECT_PATTERN.test(text);
}

// A resume is ONLY a bare continue command ("continue", "please continue",
// "continue from where you stopped"). The old start-anchored `\b` match
// treated genuine new tasks as resumes: "Finish the login page" or
// "Proceed with checkout" injected the previous run's checkpoint plus a
// "do NOT restart, proceed with the next unfinished step" order — so the
// agent ignored the new request and kept working on the old task.
const CONTINUE_PHRASES = [
  "continue",
  "resume",
  "go on",
  "proceed",
  "keep going",
  "carry on",
  "finish it",
  "complete it",
];
export function isContinueRequest(request: string): boolean {
  const text = (request || "").trim().replace(/[.!…]+$/g, "").trim().toLowerCase();
  if (!text) return false;
  const bare = text.startsWith("please ") ? text.slice("please ".length).trim() : text;
  const core = bare.endsWith(" please") ? bare.slice(0, -" please".length).trim() : bare;
  if ((CONTINUE_PHRASES as string[]).includes(core)) return true;
  // "continue from where you stopped / left off" — still anchored at the
  // start and length-capped, so a question like "how do I continue from
  // where I left off?" does NOT match.
  return /^continue\s+from\s+where\b.{0,60}$/i.test(text);
}

// Checkpoint of the last run per session: full LangChain message history
// (tool calls + results) plus the working plan. This is what lets a
// follow-up "continue" resume instead of restarting — text history alone
// (user/assistant turns) cannot reconstruct tool state. Kept in memory for
// speed and mirrored to disk (.nexus/run-checkpoints/) so "continue" also
// survives an app restart, when the in-memory map is empty.
export type RunCheckpoint = { messages: any[]; planItems: PlanItem[] | null };
const lastRunStore = new Map<string, RunCheckpoint>();

export function getLastRunCheckpoint(sessionId: string | undefined): RunCheckpoint | null {
  if (!sessionId) return null;
  return lastRunStore.get(sessionId) ?? null;
}

function countToolCalls(messages: any[]): number {
  let count = 0;
  for (const m of messages || []) {
    if (Array.isArray(m?.tool_calls)) count += m.tool_calls.length;
  }
  return count;
}

export function saveLastRunCheckpoint(sessionId: string | undefined, checkpoint: RunCheckpoint, telemetryRoot?: string): void {
  if (!sessionId) return;
  const messages = (checkpoint.messages || []).slice(-100);
  const next = { messages, planItems: checkpoint.planItems ?? null };
  // A run that did no tool work (pure Q&A) must not clobber the checkpoint
  // of the previous working run — otherwise a later "continue" would resume
  // from the small talk instead of the interrupted task.
  const existing = lastRunStore.get(sessionId);
  if (existing && countToolCalls(messages) === 0 && countToolCalls(existing.messages) > 0) return;
  lastRunStore.set(sessionId, next);
  if (telemetryRoot) {
    void persistLastRunCheckpoint(telemetryRoot, sessionId).catch(() => { /* best effort */ });
  }
}

function runCheckpointPath(telemetryRoot: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(telemetryRoot, ".nexus", "run-checkpoints", `${safe}.json`);
}

function truncateForDisk(value: unknown, cap = 1500): unknown {
  if (typeof value === "string") {
    return value.length > cap ? `${value.slice(0, cap)}\n…[truncated for checkpoint storage]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateForDisk(v, cap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === "content" ? truncateForDisk(v, cap) : v;
    return out;
  }
  return value;
}

const CHECKPOINT_TYPE_BY_CLASS: Record<string, string> = {
  HumanMessage: "human",
  AIMessage: "ai",
  ToolMessage: "tool",
  SystemMessage: "system",
};

function serializeCheckpointMessage(message: any): unknown {
  try {
    const json = typeof message?.toJSON === "function" ? message.toJSON() : message;
    if (!json || typeof json !== "object") return null;
    const data = json as { type?: string; id?: unknown; kwargs?: unknown };
    // LangChain toJSON uses { type: "constructor", id: [..., "AIMessage"] } —
    // the message kind lives in the trailing id segment, not in `type`.
    const className = Array.isArray(data.id) ? String(data.id[data.id.length - 1]) : "";
    const type = CHECKPOINT_TYPE_BY_CLASS[className] ?? (typeof data.type === "string" && ["human", "ai", "tool", "system"].includes(data.type) ? data.type : null);
    if (!type) return null;
    return { type, kwargs: truncateForDisk(data.kwargs ?? {}) };
  } catch {
    return null;
  }
}

export async function persistLastRunCheckpoint(telemetryRoot: string, sessionId: string): Promise<void> {
  const checkpoint = lastRunStore.get(sessionId);
  if (!checkpoint || !telemetryRoot) return;
  const filePath = runCheckpointPath(telemetryRoot, sessionId);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    planItems: checkpoint.planItems,
    messages: checkpoint.messages.slice(-80).map(serializeCheckpointMessage).filter(Boolean),
  };
  await fsPromises.writeFile(filePath, JSON.stringify(payload), "utf8");
}

function reviveCheckpointMessage(stored: any): any | null {
  try {
    if (!stored || typeof stored !== "object" || !stored.type) return null;
    const kwargs = (stored.kwargs ?? {}) as any;
    switch (stored.type) {
      case "human": return new HumanMessage(kwargs);
      case "ai": return new AIMessage(kwargs);
      case "tool": return new ToolMessage(kwargs);
      case "system": return new SystemMessage(kwargs);
      default: return null;
    }
  } catch {
    return null;
  }
}

export async function loadLastRunCheckpoint(telemetryRoot: string, sessionId: string | undefined): Promise<RunCheckpoint | null> {
  if (!sessionId) return null;
  const inMemory = lastRunStore.get(sessionId);
  if (inMemory) return inMemory;
  try {
    const raw = await fsPromises.readFile(runCheckpointPath(telemetryRoot, sessionId), "utf8");
    const parsed = JSON.parse(raw) as { planItems?: PlanItem[] | null; messages?: any[] };
    const messages = (parsed.messages || []).map(reviveCheckpointMessage).filter(Boolean);
    if (!messages.length) return null;
    const checkpoint = { messages: sanitizeResumeCheckpoint(messages), planItems: parsed.planItems ?? null };
    lastRunStore.set(sessionId, checkpoint);
    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * Deterministic record of finished tool work, derived from message history:
 * every model tool call that has a matching tool result. Weak models often
 * ignore "do not repeat completed steps" after a retry/continue because the
 * raw history is long — an explicit ledger ("- read_file src/App.tsx")
 * survives where prose instructions don't.
 */
export function summarizeCompletedSteps(messages: any[], max = 25): string[] {
  type Step = { id: string | null; desc: string; done: boolean };
  const steps: Step[] = [];
  const byId = new Map<string, Step>();
  for (const message of messages || []) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      const desc = describeToolCall(call?.name || "tool", call?.args) || (call?.name || "tool");
      const label = `${call?.name || "tool"} · ${desc}`;
      const step: Step = { id: typeof call?.id === "string" ? call.id : null, desc: label, done: false };
      steps.push(step);
      if (step.id) byId.set(step.id, step);
      else step.done = true; // result-less shape: can't match, count as seen
    }
    const resultId = (message as any)?.tool_call_id;
    if (typeof resultId === "string" && byId.has(resultId)) {
      byId.get(resultId)!.done = true;
    }
  }
  return steps.filter((s) => s.done).map((s) => s.desc).slice(-max);
}

export function clearLastRunCheckpoint(sessionId: string | undefined): void {
  if (!sessionId) return;
  lastRunStore.delete(sessionId);
}

function isRecursionLimitError(error: unknown): boolean {
  const text = [error instanceof Error ? error.message : String(error), String((error as any)?.name ?? "")].join(" ");
  return /recursion\s*limit|GRAPH_RECURSION_LIMIT/i.test(text);
}

function buildSystemPrompt(mode: AgentMode, projectRoot: string, providerLabel: string, modelName: string, memory: AgentMemoryContext, projectRulesSection: string = "", complexity: TaskComplexity = "complex", isNewProject = false, taskKind: AgentTaskKind = "code", repoMapSection: string = "") {
  if (taskKind === "general") {
    let general = `You are Nexus Home, a helpful general-purpose assistant. Your workspace folder is exposed at the virtual root / — use paths relative to it (for example report.docx). Files you create land in the user's Nexus folder, where they can download them.

Project root on host (metadata only): ${projectRoot}
Provider: ${providerLabel} / ${modelName}

Project memory:
${tail(memory.projectMemory, 2000) || "(empty)"}

Session memory:
${tail(memory.sessionMemory, 3000) || "(empty)"}

Working rules:
- Answer chit-chat and simple questions directly with zero tool calls.
- For research: use web_search first, then read the most promising pages with browser_fetch_api or browser_inspect before stating facts. Never invent current prices, versions, or news.
- If the task involves a library, API, or technology you are unsure about — especially anything recently released — research it first: web_search, then read the official docs with browser_inspect. Never invent APIs, import paths, or options; pin the exact version you verified.
- For documents: check installed skills first — a skill may describe exactly how to build the requested file (Word, PowerPoint, Excel, LaTeX). Follow it: write a script (e.g. Python) with write_file and run it with execute, then verify the output file exists with ls. Once the deliverable is verified, delete the throwaway generator script with the delete tool so only the requested file(s) remain in the Nexus folder.
- If a command fails because a tool is missing (python, pip packages), install it or fall back to the closest format you CAN produce, and say so clearly.
- Save finished deliverables with clear file names in the workspace root and end by naming the exact file(s) the user can download.
- Be efficient: at most 3 exploration calls before acting. Keep answers concise.
- Skills listed in your instructions are mandatory pre-reads: if a skill covers the task, read its SKILL.md first.
- Never expose secrets.`;
    if (complexity === "simple") {
      general += `\n\nEFFICIENCY MODE (simple task): answer in at most 3 tool calls. Do NOT create a todo list, do NOT delegate to subagents. If no file is needed, answer directly.`;
    }
    if (projectRulesSection) {
      general += `\n\n${projectRulesSection}`;
    }
    if (mode === "plan") return `${general}\n\nMODE: PLAN. Investigate and return a structured markdown plan. Writing, editing and command execution are disabled — read and search only.`;
    return `${general}\n\nMODE: ${mode === "auto" ? "AUTO. Work autonomously end to end: research, create, then verify the deliverable exists before finishing." : "ASK. Fulfil the request, keep it focused, and confirm the result before answering."}`;
  }

  let common = `You are Nexus, an advanced autonomous coding agent working on a local repository. The repository is exposed at the virtual root / — use paths relative to the repository root (for example src/App.tsx).

Project root on host (metadata only): ${projectRoot}
Provider: ${providerLabel} / ${modelName}

Project memory:
${tail(memory.projectMemory, 2000) || "(empty)"}

Session memory:
${tail(memory.sessionMemory, 3000) || "(empty)"}

Working rules:
- Inspect the relevant code before proposing or making changes; never assume file contents.
- Be efficient: act in at most 3 exploration calls (grep_search/read_file_range) before editing or answering. Read files directly; do not chain outline -> definition -> references -> read for the same symbol. (SKILL.md reads don't count — always check skills first.)
- Never list the repository root (ls /) or run unscoped globs (**/*): they return thousands of entries (node_modules/dist) and stall the run. Always scope to a subdirectory or a narrow pattern like src/**/*.tsx.
- Prefer grep_search with a tight query over browsing; if a listing is truncated, narrow it instead of paging through it.
- For multi-file edits, prefer a single apply_patch call over N sequential writes/edits.
- Never write throwaway verification scripts into the repo (no check-*.js, smoke-test.js, or any scratch files — and never inside .nexus/, which is telemetry storage). Verify with a single inline command instead, then stop: one syntax check plus one smoke run is enough for a small app.
- Use ask_user sparingly (at most once) when genuinely blocked by ambiguity; otherwise proceed with best guess.
- Use browser_inspect or browser_fetch_api ONLY for web/dev-server/API-health tasks. Never use them for plain code edits or explanations. browser_inspect renders the page with JavaScript in the built-in browser session (the user can watch in the Browser tab when headless is off), so prefer it for checking what a running dev server actually renders. To interact with the page (click buttons, fill forms, submit, scroll), use browser_act — snapshot first for element refs, then act on refs.
- If the task involves a library, API, or technology you are unsure about — especially anything recently released — research it first with web_search, then read the official docs with browser_inspect before writing code. Never invent APIs, import paths, or options; pin the exact version you verified.
- delegate_task is a last resort for genuinely independent multi-file work. Never delegate simple lookups, single-file edits, or Q&A — doing so multiplies steps.
- Keep diffs minimal and focused; prefer editing existing files over rewriting them.
- Only use the todo list for tasks with 3+ distinct steps. Skip it entirely for trivial tasks (single question, single-file fix, typo, rename).
- Additional MCP tools (if listed in your tools) come from user-configured MCP servers; prefer them for the capabilities they expose (e.g. search, APIs, external systems).
- Skills listed in your instructions are mandatory pre-reads, not options: before exploring or writing code, check whether any skill covers the task and read its SKILL.md first.
- Never expose secrets.
- Finish by reporting files changed, commands run, and remaining risks.
${repoMapSection ? `\n${repoMapSection}` : ""}`;

  // New-project builds must come out production-ready (Claude-Code bar), not
  // as loose static files: real toolchain, installable deps, persisted
  // settings, streaming chat, error states, and a green build before stopping.
  if (isNewProject && mode !== "plan") {
    common += `\n\nNEW WEB PROJECT warm-up: the user wants a brand-new application, not an edit. Deliver production-grade work:
- Default stack is Vite + React + TypeScript unless the request names another. Scaffold with the official starter (npm create vite), then npm install. Never hand-roll a toolchain with loose .html/.css/.js files when a framework scaffold applies.
- Structure: src/ components (Chat, Settings, MessageList...), a small api client module for the OpenAI-compatible endpoint, styles co-located or in one stylesheet, .env.example for base URL / key / model names.
- Settings page: provider base URL, API key, and model selectable, persisted to localStorage, loaded on start. Never hardcode secrets.
- Chat: streaming responses via fetch to /chat/completions (SSE), with loading, empty, and error states (bad key, network failure, non-200 with body excerpt). No dead buttons — every control must work.
- README.md with prerequisites, setup (npm install), dev (npm run dev), and build (npm run build) instructions.
- Finish only when npm run build passes. If the build fails, fix and rebuild — do not hand back a project that does not compile.`;
  }

  if (complexity === "simple") {
    common += `\n\nEFFICIENCY MODE (simple task): answer in at most 3 tool calls. Do NOT create a todo list, do NOT delegate to subagents, do NOT run verification commands yourself. Read at most 2 files besides any SKILL.md, then act and stop. If no file change is needed, answer directly with zero or one lookup.`;
  }

  if (projectRulesSection) {
    common += `\n\n${projectRulesSection}`;
  }

  if (mode === "plan") return `${common}\n\nMODE: PLAN. Investigate the repository and return a structured markdown implementation plan with sections: # Objective, ## Proposed Changes, ## Risks, ## Verification Plan. Writing, editing, deleting and command execution are disabled — gather information with read, search, and symbol tools only, and do not attempt to change anything.`;
  if (mode === "auto") return `${common}\n\nMODE: AUTO. Work autonomously end to end: plan, implement, then verify with the available checks. If a check fails, fix your changes before finishing.`;
  return `${common}\n\nMODE: ASK. Implement the requested change, keep it minimal, and verify with the available checks before answering.`;
}

// Project memory is a rolling log; keep the most recent entries so it cannot
// grow without bound across hundreds of runs.
function appendMemoryLog(existing: string | undefined, entry: string): string {
  const lines = (existing || "").split("\n").filter(Boolean);
  lines.push(entry);
  return lines.slice(-PROJECT_MEMORY_RUN_LOG_CAP).join("\n");
}

export async function runProjectAgent(options: {
  projectRoot: string;
  telemetryRoot?: string;
  sessionId?: string;
  request: string;
  images?: string[];
  settings: AgentSettings;
  memory: AgentMemoryContext;
  history: HistoryInput[];
  mode: AgentMode;
  agentBackend: unknown;
  onEvent: (event: AgentEvent) => void;
  isCancelled: () => boolean;
  resumeMessages?: any[] | null;
  resumePlanItems?: PlanItem[] | null;
  resumeNote?: string | null;
  taskKind?: AgentTaskKind;
}) {
  const { projectRoot, telemetryRoot, sessionId, request, images, settings, memory, history, mode, agentBackend, onEvent, isCancelled } = options;
  const { resumeMessages, resumePlanItems, resumeNote } = options;
  const taskKind: AgentTaskKind = options.taskKind ?? "code";
  const isGeneral = taskKind === "general";
  const targetTelemetryRoot = telemetryRoot || projectRoot;
  const emit = (type: AgentEvent["type"], text: string, items?: PlanItem[], usage?: AgentUsage, subagent?: SubagentItem, artifact?: ArtifactItem, detail?: string) => {
    if (text || items?.length || usage || subagent || artifact) onEvent({ type, sessionId: sessionId || "", text, timestamp: new Date().toISOString(), items, usage, subagent, artifact, detail });
  };

  const trajectory = sessionId ? new TrajectoryLogger(targetTelemetryRoot, sessionId) : null;
  if (trajectory) {
    await trajectory.init();
    await trajectory.log({ source: "USER", type: "USER_INPUT", content: request });
  }

  const provider = settings.provider ?? {
    id: "default",
    label: "OpenAI",
    provider: "openai",
    apiKey: settings.apiKey || process.env.OPENAI_API_KEY || "",
    baseUrl: settings.baseUrl,
    models: [settings.model || process.env.OPENAI_MODEL || "gpt-4.1-mini"],
  };
  const modelName = settings.model || provider.models[0] || "";
  if (!modelName) {
    emit("error", "No model selected for this session. Configure a provider and model first.");
    throw new Error("Missing model");
  }
  if (!provider.apiKey && provider.provider !== "ollama" && provider.provider !== "custom") {
    emit("error", `No API key configured for ${provider.label}. Add it in Providers.`);
    throw new Error("Missing model API key");
  }
  if (!agentBackend) {
    emit("error", "No workspace backend is available for this project.");
    throw new Error("Missing workspace backend");
  }
  emit("status", `Starting agent · ${provider.label} / ${modelName} · ${mode} mode`);
  const llm = await createChatModel(provider, modelName);

  // An MCP stdio server that never answers must not wedge the run: bound
  // the whole setup fetch, MCP included, so a dead server degrades to
  // "continuing without MCP" instead of an eternal spinner.
  const withSetupTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
    ]);
  // Setup I/O (MCP servers, project rules, skills config, repo map) is
  // independent — fetch in parallel instead of serially.
  const [mcpResult, rulesResult, skillsConfig, repoMapSection] = await Promise.all([
    withSetupTimeout(getMcpTools(), 20000, "MCP servers").then(
      (r) => ({ ok: true as const, tools: r.tools, serverNames: r.serverNames }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    discoverProjectRules(projectRoot),
    getSkillsConfig(),
    // Code runs get a symbol-outline map so the model orients without
    // re-listing the tree every task. Home/doc runs skip it (a documents
    // folder has no useful symbols). Never fails the run.
    (isGeneral ? Promise.resolve("") : getRepoMapSection(projectRoot).catch(() => "")),
  ]);

  let mcpTools: any[] = [];
  if (mcpResult.ok) {
    mcpTools = mcpResult.tools;
    if (mcpResult.tools.length) emit("status", `Connected to MCP · ${mcpResult.tools.length} tool${mcpResult.tools.length === 1 ? "" : "s"} from ${mcpResult.serverNames.join(", ")}`);
  } else {
    emit("error", `MCP servers could not be reached, continuing without them: ${mcpResult.error instanceof Error ? mcpResult.error.message : String(mcpResult.error)}`);
  }
  if (rulesResult.hasRules) {
    emit("status", `Loaded ${rulesResult.ruleFiles.length} project rule file${rulesResult.ruleFiles.length === 1 ? "" : "s"} (${rulesResult.ruleFiles.map((r) => r.filename).join(", ")})`);
  }

  const runCommand = async (command: string) => {
    try {
      return await Promise.resolve((agentBackend as any)?.execute?.(command));
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), exitCode: 1, truncated: false };
    }
  };

  const skills = skillsConfig.enabled ? [PROJECT_SKILLS_DIR, GLOBAL_SKILLS_ROUTE] : [];
  const compositeBackend = skills.length
    ? new CompositeBackend(agentBackend as any, { [GLOBAL_SKILLS_ROUTE]: new FilesystemBackend({ rootDir: globalSkillsDir(), virtualMode: true }) })
    : agentBackend;

  // Skill shortlist: the framework injects the full catalog, but models —
  // especially small ones — ignore catalogs. Match deterministically and
  // tell the agent exactly which SKILL.md files to read first.
  let skillNote: string | null = null;
  if (skillsConfig.enabled) {
    try {
      const catalog = await listSkills(projectRoot);
      const recs = recommendSkills(catalog, request, 3);
      if (recs.length) {
        const lines = recs.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""} → read ${skillVirtualPath(s)} first`);
        skillNote = `[System Note: ${catalog.length} skill(s) installed. Most relevant to your task:\n${lines.join("\n")}\nIf a skill covers your task, read its SKILL.md BEFORE exploring or writing code. This read is free and does not count against your exploration budget.]`;
      }
    } catch { /* skills are advisory — never fail a run */ }
  }

  const allCodeTools = createCodeIntelligenceTools(projectRoot);
  const wantsBrowser = isWebTask(request);
  // Home general runs always get the browser + free web search: research is
  // core to that mode, not an edge case.
  const browserTools = wantsBrowser || isGeneral
    ? createBrowserTools(projectRoot, {
        agentBrowser: {
          inspect: (url) => agentBrowserService.inspect(url),
          act: (input) => agentBrowserService.act(input, projectRoot),
        },
      })
    : [];
  // Home general runs always get the browser tools; code runs get them for
  // web-flavored tasks. Web search rides along everywhere (cheap, one tool):
  // researching unfamiliar or recently-released libraries beats hallucinating
  // their APIs. Every search is mirrored into the built-in browser.
  const webSearchTools = createWebSearchTools({
    // Mirror every search into the built-in browser so it is visible there
    // (Watching follows it live, otherwise the follow banner shows it).
    // Fire-and-forget: results come from the search API, never the mirror.
    onSearch: (_query, url) => {
      void agentBrowserService.visit(url).catch(() => {});
    },
  });
  const usage = new UsageAccumulator();
  // Fast-path routing: simple tasks get fewer tools, no todo planning and
  // no subagent delegation so one lookup cannot fan out into 10+ steps.
  const complexity = classifyTaskComplexity(request);
  // A "continue" that resumes prior tool state is never a simple task: it
  // needs the full budget, todo tracking and delegation to finish the job.
  const hasResume = Boolean((resumeMessages && resumeMessages.length) || resumeNote);
  let effectiveComplexity: TaskComplexity = hasResume ? "complex" : complexity;
  let isSimple = effectiveComplexity === "simple";
  const isNewProject = isNewProjectTask(request);
  let recursionLimit = isSimple ? SIMPLE_TASK_LIMIT : MODE_LIMITS[mode];
  // Opencode core: ripgrep-like grep + range-read only for simple tasks.
  const codeTools = pickRuntimeCodeTools(allCodeTools, effectiveComplexity);
  const editTools = createEditTools(projectRoot);
  const questionTool = createQuestionTool((questions) => {
    emit("status", `Clarifying questions: ${questions.map((q) => q.header).join(", ")}`);
    if (trajectory) {
      void trajectory.log({ source: "MODEL", type: "STATUS", content: questions.map((q) => `${q.header}: ${q.question}`).join("\n") });
    }
  });
  const subagentTool = createSubagentDelegationTool({
    projectRoot,
    provider,
    modelName,
    projectRecord: { id: "current", name: "current", root: projectRoot },
    mcpTools,
    skills,
    skillsBackend: compositeBackend,
    onEvent: (subEvent) => {
      usage.addSubagent(subEvent.subagent.usage);
      emit("subagent", subEvent.type === "subagent_start" ? `Delegated task to ${subEvent.subagent.role} subagent` : subEvent.type === "subagent_finish" ? `Subagent [${subEvent.subagent.role}] completed` : `Subagent working...`, undefined, undefined, subEvent.subagent);
    },
    isCancelled,
    runId: sessionId,
  });

  const deepAgent = await createDeepAgent({
    model: llm,
    backend: compositeBackend as any,
    middleware: isSimple ? [] : [todoListMiddleware()],
    tools: isSimple
      ? [...codeTools, ...editTools, questionTool, ...browserTools, ...webSearchTools, ...mcpTools]
      : [...codeTools, ...editTools, questionTool, ...browserTools, ...webSearchTools, subagentTool, ...mcpTools],
    skills,
    systemPrompt: buildSystemPrompt(mode, projectRoot, provider.label, modelName, memory, rulesResult.combinedPromptSection, effectiveComplexity, isNewProject, taskKind, repoMapSection),
  });

  // Apply context compaction on history
  const compactedHistory = compactHistory(history);
  const priorMessages = compactedHistory.map((turn) =>
    turn.role === "assistant"
      ? new AIMessage(tail(turn.text, HISTORY_CHAR_CAP))
      : new HumanMessage(tail(turn.text, HISTORY_CHAR_CAP))
  );

  const requestText = [request, resumeNote, skillNote].filter(Boolean).join("\n\n");
  let initialHumanMessage: HumanMessage;
  if (images && images.length > 0) {
    const contentParts: any[] = [{ type: "text", text: requestText }];
    for (const img of images) {
      contentParts.push({
        type: "image_url",
        image_url: { url: img },
      });
    }
    initialHumanMessage = new HumanMessage({ content: contentParts });
  } else {
    initialHumanMessage = new HumanMessage(requestText);
  }

  const estimatedFallbackInputTokens = Math.max(
    1,
    Math.round(
      (priorMessages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) + request.length + 1500) / 4
    )
  );

  let runMessages: any[] = [...priorMessages, initialHumanMessage];
  // Same-session tool memory (OpenCode/Pi-style): when this run starts
  // WITHOUT a full checkpoint behind it, fold the session's recent tool
  // activity (calls + truncated results, plans, errors) into a context block
  // so the model reuses prior reads instead of re-reading the same files.
  // Resume runs skip this — their checkpoint already carries full tool
  // messages and the block would only duplicate them.
  if (!resumeMessages?.length) {
    const toolContext = buildToolContextBlock(history);
    if (toolContext) runMessages = [...priorMessages, new HumanMessage(toolContext), initialHumanMessage];
  }
  // Cross-run resume: seed the conversation with the previous run's full
  // tool history so "continue" proceeds instead of restarting. Prune any
  // trailing unanswered tool calls the same way mid-stream retries do.
  if (resumeMessages && resumeMessages.length) {
    const clean = sanitizeResumeCheckpoint([...resumeMessages]);
    runMessages = [...clean, initialHumanMessage];
    if (hasResume) emit("status", `Resuming prior run · ${clean.length} checkpointed message(s) restored`);
  }
  let lastPlanItems: PlanItem[] | null = resumePlanItems ?? null;
  let retryCount = 0;
  let unaccountedOutputChars = 0;
  // Doom-loop tracker: consecutive identical tool-call signatures.
  let lastToolSig: string | null = null;
  let toolRepeatCount = 0;
  // Latest workspace diff, filled by verify and reused for the walkthrough
  // artifact so a run doesn't pay for the same git diff twice.
  let lastDiffFiles: any[] | null = null;
  // Diff baseline captured BEFORE the agent works. Verify/repair must only
  // cover files THIS run changed: after an interrupted run leaves broken
  // edits behind, a follow-up question ("what does X do?") would otherwise
  // see the stale dirty diff, fail typecheck on the OLD breakage, and go
  // into repair mode on the previous task instead of answering.
  const diffFingerprint = (d: { path: string; additions: number; deletions: number }) => `${d.additions}/${d.deletions}`;
  const initialDiff = new Map<string, string>();
  if (!isGeneral) {
    try {
      const before = await getWorkspaceDiffFiles(projectRoot);
      for (const d of before) initialDiff.set(d.path, diffFingerprint(d));
    } catch { /* baseline is best-effort; verify falls back to full diff */ }
  }

  // Provider rate limits (especially free tiers) surface as 429 errors, and long
  // streams occasionally die on dropped connections or server overload. A
  // bounded retry with exponential backoff rides those out instead of losing
  // completed work; only transient errors are retried. The attempt counter
  // tracks failures WITHOUT progress: when an attempt completed supersteps
  // before dying, the next failure is treated as a fresh incident and the
  // countdown starts over. Mid-stream failures keep the checkpoint they
  // reached, so each retry resumes instead of restarting the task.
  const progress = createProgressTracker();
  const withAgentRetry = <T>(operation: () => Promise<T>): Promise<T> =>
    withRateLimitRetry(operation, {
      prepareAttempt: () => {
        if (isCancelled()) throw new RunCancelledError();
      },
      madeProgress: () => progress.madeProgress(),
      onRetry: ({ delayMs, attempt, maxAttempts, kind, reason, reset }) => {
        const status = reset
          ? `Recovered from a mid-run error (${reason}) — resuming from checkpoint in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${maxAttempts})`
          : `${kind === "rate-limit" ? "Rate limited by the provider" : "Connection problem — stream interrupted"} (${reason}) · retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${maxAttempts})`;
        emit("status", status);
      },
    });

  const consumeStream = async () => {
    retryCount++;
    let finalMessages: any[] = [];
    progress.beginAttempt(runMessages.length);

    let messagesToStream = runMessages;
    if (retryCount > 1 && runMessages.length > priorMessages.length + 1) {
      const planNotice = lastPlanItems && lastPlanItems.length > 0
        ? `\nCurrent working plan status:\n${lastPlanItems.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
        : "";
      const ledger = summarizeCompletedSteps(runMessages);
      const ledgerNotice = ledger.length
        ? `\nSteps already DONE (never repeat these — their results are above):\n${ledger.map((s) => `- ${s}`).join("\n")}`
        : "";
      const resumeNotice = `[System Note: Stream was resumed after temporary provider interruption. All preceding tool executions and results are recorded above and already complete.${planNotice}${ledgerNotice}\n\nIMPORTANT: Do NOT restart from the beginning, do NOT re-create the todo list from scratch, and do NOT repeat already completed tool actions. Proceed directly with the next unfinished task.]`;
      messagesToStream = [...runMessages, new HumanMessage(resumeNotice)];
    }

    const stream = await (deepAgent as any).stream(
      { messages: messagesToStream },
      { streamMode: ["values", "updates", "messages"], recursionLimit }
    );
    try {
      for await (const item of stream as AsyncIterable<any>) {
        if (isCancelled()) throw new RunCancelledError();
        const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];
        if (streamMode === "values" && Array.isArray(payload?.messages)) {
          finalMessages = payload.messages;
          progress.noteSuperstep(payload.messages.length);
          continue;
        }
        if (streamMode === "updates" && payload && typeof payload === "object") {
          for (const delta of Object.values<any>(payload)) {
            for (const message of delta?.messages ?? []) {
              if (Array.isArray(message?.tool_calls)) {
                for (const call of message.tool_calls) {
                  const name = call?.name || "tool";
                  if (/todo/i.test(name)) {
                    const items = planItemsFromArgs(call.args);
                    if (items) {
                      lastPlanItems = items;
                      emit("plan", "Working plan", items);
                    }
                    continue;
                  }
                  const summary = toolCallSummary(call);
                  const desc = summary ? `${name} · ${summary}` : name;
                  // Doom-loop breaker (opencode DOOM_LOOP_THRESHOLD): the same
                  // tool with identical args 3x in a row is stuck, not working.
                  const sig = `${name}:${JSON.stringify(call?.args ?? {}).slice(0, 500)}`;
                  if (sig === lastToolSig) {
                    toolRepeatCount++;
                  } else {
                    lastToolSig = sig;
                    toolRepeatCount = 1;
                  }
                  if (toolRepeatCount >= 3) {
                    throw new DoomLoopError(name, summary || "identical arguments");
                  }
                  emit("tool", desc);
                  if (trajectory) {
                    void trajectory.log({ source: "TOOL", type: "TOOL_CALL", content: desc, tool_calls: [{ name, args: call.args }] });
                  }
                }
              }
              if (message?.type === "tool") {
                // Persist a truncated result excerpt alongside the ✓ marker so
                // future runs in this session can reuse what was already read
                // instead of re-reading the same files. The UI renders only
                // the short text; detail travels in the transcript + history.
                const excerpt = toolResultExcerpt((message as { content?: unknown })?.content);
                emit("tool", `${message.name || "tool"} ✓`, undefined, undefined, undefined, undefined, excerpt || undefined);
                progress.noteToolResult();
                if (trajectory) {
                  void trajectory.log({ source: "TOOL", type: "TOOL_RESULT", content: `${message.name || "tool"} finished` });
                }
              }
            }
          }
          continue;
        }
        if (streamMode === "messages") {
          const [chunk] = Array.isArray(payload) ? payload : [payload];
          usage.noteChunk(chunk);

          const text = chunkText(chunk);
          if (text) {
            // Counted only as a fallback; finalize ignores it when the
            // provider reported exact output usage.
            unaccountedOutputChars += text.length;
            emit("token", text);
          }
        }
      }
    } catch (error) {
      // The stream died mid-run (rate limit, dropped connection). Keep the
      // furthest complete superstep as the resume checkpoint so the next
      // attempt continues from where this one stopped instead of redoing the
      // whole task. Trailing unanswered tool calls are pruned: providers
      // reject a checkpoint whose tool calls never produced results.
      if (finalMessages.length > 0) {
        runMessages = sanitizeResumeCheckpoint(finalMessages);
      }
      throw error;
    }
    if (finalMessages.length > 0) {
      runMessages = finalMessages;
    }
    return textFromMessage(finalMessages[finalMessages.length - 1]) || "Agent finished without a textual response.";
  };

  const streamDeepAgent = async (extra: HumanMessage[]) => {
    if (extra.length > 0) {
      runMessages = [...runMessages, ...extra];
    }
    return withAgentRetry(consumeStream);
  };

  // Single-loop (opencode-style): the old "brief" node was a wasted superstep.
  // Context prep is a plain status emit before the graph runs.
  const briefMsg = `Preparing context · ${history.length} prior turn${history.length === 1 ? "" : "s"} · ${mode} mode · ${effectiveComplexity}${hasResume ? " · resumed" : ""}`;
  emit("status", briefMsg);
  if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: briefMsg });

  const graph = new StateGraph(AgentState as any)
    .addNode("deep_agent", async (state: any) => {
      if (isCancelled()) throw new RunCancelledError();
      const extra = state.verifyFeedback ? [new HumanMessage(state.verifyFeedback)] : [];
      emit("status", state.verifyFeedback ? "Repairing verification failures" : "Agent is working on the task");
      const answer = await streamDeepAgent(extra);
      return { response: answer, verifyFeedback: "", runMessages };
    })
    .addNode("verify", async (state: any) => {
      if (isCancelled()) throw new RunCancelledError();

      // Home general runs produce documents, not code projects — there is
      // no typecheck/test cascade to run. The agent verifies its own
      // deliverable (ls the file) before finishing.
      if (isGeneral) return { verification: "none" };

      const currentRepairs = Number(state.repairs) || 0;
      const maxRepairs = MAX_REPAIRS[mode] ?? 1;

      // Diff-first, scoped to THIS run: compare against the baseline taken
      // before the agent worked. Files the run didn't touch (e.g. broken
      // edits left by an earlier interrupted run) must not trigger a
      // repair loop that hijacks a plain question. Q&A runs change zero
      // files, so they skip the typecheck + test cascade entirely.
      const diffFiles = await getWorkspaceDiffFiles(projectRoot);
      lastDiffFiles = diffFiles;
      const runDiff = diffFiles.filter((d) => initialDiff.get(d.path) !== diffFingerprint(d));
      if (runDiff.length === 0) {
        return { verification: "none" };
      }
      const changedPaths = runDiff.map((d) => d.path);
      // Docs/assets-only diffs never need a typecheck: running a 30s+
      // `npm run check` for a README edit is pure "takes time, does nothing".
      const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|swift|vue|svelte)$/i;
      if (!changedPaths.some((p) => CODE_EXT.test(p))) {
        return { verification: "passed" };
      }

      // 0. File-scoped fast path (opencode-style): small diffs lint only the
      // changed files. If it passes on a simple task, skip the full project
      // typecheck entirely.
      const scoped = pickFileScopedVerification(projectRoot, changedPaths);
      if (scoped) {
        emit("status", `Verifying changed files with \`${scoped}\``);
        const scopedResult = await runCommand(scoped);
        if (isCancelled()) throw new RunCancelledError();
        const scopedOutput = String((scopedResult as any)?.output ?? "").trim();
        if ((scopedResult as any)?.exitCode !== 0) {
          emit("tool", `Verification failed · ${scoped}`);
          if (currentRepairs < maxRepairs && scopedOutput) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `The scoped check \`${scoped}\` failed (repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${tail(scopedOutput, VERIFY_OUTPUT_CAP)}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
        emit("tool", `Verification passed · ${scoped}`);
        if (isSimple) return { verification: "passed" };
      }

      // Fresh scaffold: package.json appeared and dependencies were never
      // installed. Install once, then verify with the production build
      // instead of a bare typecheck — a new app must compile before handoff.
      let staticCommand: string | null = null;
      {
        const root = path.resolve(projectRoot);
        const scaffolded = changedPaths.includes("package.json") && !existsSync(path.join(root, "node_modules"));
        if (scaffolded) {
          emit("status", "Installing dependencies for the new project (npm install)");
          const installResult = await runCommand("npm install");
          if (isCancelled()) throw new RunCancelledError();
          const installOutput = String((installResult as any)?.output ?? "").trim();
          if ((installResult as any)?.exitCode !== 0) {
            emit("tool", "Verification failed · npm install");
            if (currentRepairs < maxRepairs && installOutput) {
              return {
                repairs: currentRepairs + 1,
                verifyFeedback: `npm install failed (repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${tail(installOutput, VERIFY_OUTPUT_CAP)}\n\nFix the dependency setup (package.json, registry access, Node version), then summarize what you changed.`,
              };
            }
            return { verification: "failed" };
          }
          emit("tool", "Verification passed · npm install");
          try {
            const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
            if (typeof scripts.build === "string") staticCommand = "npm run build";
          } catch { /* fall through to default selection */ }
        }
      }

      // 1. Static checks cascade (typecheck -> check -> tsc -> lint -> multi-language)
      const command = staticCommand ?? pickVerificationCommand(projectRoot);
      if (command) {
        emit("status", `Verifying changes with \`${command}\``);
        const result = await runCommand(command);
        if (isCancelled()) throw new RunCancelledError();
        const output = String((result as any)?.output ?? "").trim();
        if ((result as any)?.exitCode !== 0) {
          emit("tool", `Verification failed · ${command}`);
          if (currentRepairs < maxRepairs && output) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `The verification command \`${command}\` failed (repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${tail(output, VERIFY_OUTPUT_CAP)}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
        emit("tool", `Verification passed · ${command}`);
      }

      // 2. Targeted test detection for modified files (reuse the diff above)
      const targetTestCmd = findTargetedTests(projectRoot, changedPaths);
      if (targetTestCmd) {
        emit("status", `Running targeted test \`${targetTestCmd}\``);
        const testResult = await runCommand(targetTestCmd);
        if (isCancelled()) throw new RunCancelledError();
        const testOutput = String((testResult as any)?.output ?? "").trim();
        if ((testResult as any)?.exitCode !== 0) {
          emit("tool", `Targeted test failed · ${targetTestCmd}`);
          if (currentRepairs < maxRepairs && testOutput) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `Targeted test \`${targetTestCmd}\` failed (repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${tail(testOutput, VERIFY_OUTPUT_CAP)}\n\nFix the code to pass this test.`,
            };
          }
          return { verification: "failed" };
        }
        emit("tool", `Targeted test passed · ${targetTestCmd}`);
      }

      return { verification: command || scoped || targetTestCmd ? "passed" : "none" };
    })
    .addEdge(START, "deep_agent")
    .addConditionalEdges("deep_agent", () => (mode === "plan" ? "end" : "verify"), { verify: "verify", end: END })
    .addConditionalEdges("verify", (state: any) => (state.verifyFeedback ? "deep_agent" : "end"), { deep_agent: "deep_agent", end: END })
    .compile();

  // The outer graph only has 2 nodes, but LangGraph's default invoke limit
  // is 25 — pass an explicit budget and turn a limit hit into a resumable
  // partial result instead of a hard GraphRecursionError.
  let outerLimit = Math.max(recursionLimit, 50);
  let result: any;
  let escalated = false;
  try {
    result = await graph.invoke({ projectRoot, request }, { recursionLimit: outerLimit });
  } catch (error) {
    const isDoom = error instanceof DoomLoopError || (error as any)?.name === "DoomLoopError";
    const isBudget = isRecursionLimitError(error);
    // Misclassified simple tasks die at the 50-step wall even though the run
    // was making progress. Escalate once to the full mode budget and continue
    // in place instead of forcing the user to say "continue". The step
    // history (runMessages) is already checkpointed above, so the retry
    // resumes where the run stopped. Tools stay simple-scoped, but the
    // verify node flips to the full cascade via isSimple below.
    if (isBudget && !isDoom && effectiveComplexity === "simple" && !escalated) {
      escalated = true;
      effectiveComplexity = "complex";
      isSimple = false;
      recursionLimit = MODE_LIMITS[mode];
      outerLimit = Math.max(recursionLimit, 50);
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      emit("status", `Simple budget exhausted at ${SIMPLE_TASK_LIMIT} steps — escalating to full budget (${outerLimit} steps) and continuing…`);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: `Simple-task budget hit at ${SIMPLE_TASK_LIMIT}; auto-escalated to complex budget ${outerLimit}.` });
      try {
        result = await graph.invoke({ projectRoot, request }, { recursionLimit: outerLimit });
      } catch (retryError) {
        error = retryError;
      }
    }
    if (result === undefined) {
      const retryIsDoom = error instanceof DoomLoopError || (error as any)?.name === "DoomLoopError";
      if (!isRecursionLimitError(error) && !retryIsDoom) throw error;
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      const planSummary = lastPlanItems?.length
        ? `\n\nWorking plan so far:\n${lastPlanItems.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
        : "";
      const doomTool = retryIsDoom ? (error as DoomLoopError).toolName || "tool" : null;
      const partial = retryIsDoom
        ? `I got stuck repeating the same ${doomTool} call without making progress, so I stopped instead of looping forever. Progress is checkpointed — say "continue" and I will resume with a different approach.${planSummary}`
        : `I hit the step budget before finishing. Progress is checkpointed — say "continue" and I will resume from where I stopped instead of restarting.${planSummary}`;
      emit("error", retryIsDoom ? `Stuck repeating ${doomTool} — stopped to avoid an infinite loop. Say "continue" to resume differently.` : `Step budget reached (${outerLimit} steps). Progress saved — say "continue" to resume.`);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: retryIsDoom ? `Doom-loop breaker fired on ${doomTool}; checkpoint saved for resume.` : `Recursion limit hit at ${outerLimit}; checkpoint saved for resume.` });
      const partialUsage = usage.finalize(modelName, estimatedFallbackInputTokens, 0);
      return {
        response: partial,
        verification: "interrupted",
        memoryEntry: `Task: ${request}\nOutcome: ${retryIsDoom ? `interrupted in a repeated-${doomTool} loop` : "interrupted at step budget"}; resumable via continue.\nVerification: interrupted`,
        usage: partialUsage,
        artifact: undefined,
        projectMemoryLogEntry: `Interrupted work (${new Date().toISOString().slice(0, 10)}): ${tail(request, 200)}`,
        interrupted: true as const,
      };
    }
  }
  // Checkpoint the completed run so a follow-up "continue" can build on the
  // full tool history, not just the text transcript.
  saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
  // When no provider reported usage metadata, fall back to character-based
  // estimates for the streamed text so token counts are never zero.
  const fallbackOutputTokens = unaccountedOutputChars > 0 ? Math.max(1, estimateTokens("x".repeat(unaccountedOutputChars))) : 0;
  const finalUsage = usage.finalize(modelName, estimatedFallbackInputTokens, fallbackOutputTokens);
  emit("assistant", result.response, undefined, finalUsage);
  emit("usage", `Token usage · ${finalUsage.totalTokens} tokens${finalUsage.estimatedCost == null ? "" : ` (~$${finalUsage.estimatedCost})`}`, undefined, finalUsage);

  if (trajectory) {
    await trajectory.log({ source: "MODEL", type: "PLANNER_RESPONSE", content: result.response, usage: finalUsage });
  }

  // Automatic Artifact Generation:
  // In Plan mode -> save implementation_plan.md
  // In Auto mode with file changes -> save walkthrough.md
  let artifact: ArtifactItem | undefined;
  if (sessionId) {
    try {
      if (mode === "plan") {
        artifact = await saveArtifact(targetTelemetryRoot, sessionId, "implementation_plan.md", result.response, {
          status: "pending_approval",
          requestFeedback: true,
          name: "Implementation Plan",
        });
        emit("artifact", `Generated Implementation Plan`, undefined, undefined, undefined, artifact);
      } else if (mode === "auto") {
        const diffFiles = lastDiffFiles ?? await getWorkspaceDiffFiles(projectRoot);
        if (diffFiles.length > 0) {
          const changedSummary = `### Files Modified (${diffFiles.length})\n` + diffFiles.map((d) => `- \`${d.path}\` (+${d.additions} / -${d.deletions})`).join("\n");
          const walkthroughContent = `# Walkthrough - ${request.slice(0, 60)}\n\n## Changes Summary\n${changedSummary}\n\n## Verification\nStatus: **${result.verification}**\n\n## Outcome\n${result.response}`;
          artifact = await saveArtifact(targetTelemetryRoot, sessionId, "walkthrough.md", walkthroughContent, {
            status: "completed",
            requestFeedback: false,
            name: "Walkthrough Report",
          });
          emit("artifact", `Generated Walkthrough Report`, undefined, undefined, undefined, artifact);
        }
      }
    } catch { /* ignore artifact save errors */ }
  }

  return {
    response: result.response as string,
    verification: (result.verification as string) || "none",
    memoryEntry: `Task: ${request}\nOutcome: ${tail(result.response, MEMORY_ENTRY_CAP)}\nVerification: ${(result.verification as string) || "none"}`,
    usage: finalUsage,
    artifact,
    projectMemoryLogEntry: `Recent work (${new Date().toISOString().slice(0, 10)}): ${tail(request, 200)}`,
  };
}
