import { existsSync, readFileSync, readdirSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createDeepAgent, CompositeBackend, FilesystemBackend } from "deepagents";
import { todoListMiddleware, createMiddleware } from "langchain";
import { createChatModel } from "./providers.js";
import { createCodeIntelligenceTools, pickRuntimeCodeTools } from "./code-tools.js";
import { createEditTools, createQuestionTool } from "./edit-tools.js";
import { createBrowserTools } from "./browser-tool.js";
import { agentBrowserService } from "./browser-service.js";
import { getRepoMapSection } from "./repo-map-service.js";
import { getProjectIndexSection } from "./project-index-service.js";
import { createWebSearchTools } from "./websearch-tool.js";
import { discoverAllRules, discoverProjectRules } from "./rules-service.js";
import { discoverProjectInstructions } from "./project-instructions.js";
import { expandSlashCommand } from "./custom-commands-service.js";
import { createSubagentDelegationTool, executeSubagentTask, calculateAgentUsage, buildSubagentCatalog, type SubagentItem } from "./subagent-service.js";
import { getWorkspaceDiffFiles } from "./diff-service.js";
import { getMcpTools } from "./mcp-service.js";
import { getHooksConfig, getRulesConfig, getSkillsConfig } from "./store.js";
import { createHooksMiddleware, dispatchHooks, discoverHooks } from "./hooks-service.js";
import { GLOBAL_SKILLS_ROUTE, PROJECT_SKILLS_DIR, SKILL_SOURCE_PRIORITY, SYSTEM_SKILLS_ROUTE, buildSkillMounts, createSkillFilesTool, filterSkillsByMcp, globalSkillsDir, listSkills, listSystemSkills, recommendSkills, skillAppliesToMode, skillDirVirtualPath, skillVirtualPath, systemSkillsDir, type SkillInfo, type SkillMode } from "./skills-service.js";
import { compactHistory, compactHistoryWithModel, estimateTokens, StreamUsageTracker } from "./context-service.js";
import { saveArtifact, type ArtifactItem } from "./artifacts-service.js";
import { TrajectoryLogger } from "./trajectory-service.js";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint } from "./rate-limit.js";
import { RunCancelledError, getRunAbortSignal } from "./command-service.js";
import { requestCommandApproval } from "./approval-service.js";
import { createHomeMemoryTool, addMemoryFact, removeMemoryFactWithCount, selectRelevantHomeMemory, parseCandidateFacts, capMemoryItems, shouldExtractMemory, type MemoryCandidate } from "./home-memory-service.js";
import { createHomeTaskJournal, finishHomeTaskJournal, recordHomeTaskAction, saveHomeTaskJournal, type HomeTaskJournal, type HomeTaskPhase } from "./home-task-service.js";
import { validateHomeArtifactContract } from "./home-artifact-service.js";
import { codeVerificationOutcome, createCodeTaskJournal, finishCodeTaskJournal, inferCodeTaskContract, loadCodeTaskJournal, parseBlockingReviewFindings, recordCodeTaskAction, recordCodeTaskPlan, saveCodeTaskJournal, shouldRunCodeReview, type CodeTaskContract, type CodeTaskJournal, type CodeTaskPhase } from "./code-task-service.js";
import type { ProviderConfig } from "./store.js";

import type { AgentEvent, AgentMemoryContext, AgentMode, AgentSettings, AgentTaskKind, AgentUsage, AttachmentDoc, HistoryInput, HomeTaskContract, PlanItem } from "./agent-types.js";
import type { TaskComplexity } from "./task-routing.js";
import { buildSystemPrompt, homeRequestNamesFileFormat, inferHomeOutputFormats, inferHomeTaskContract } from "./agent-prompt.js";
import { DoomLoopError, loopPreventionMiddleware, toolParameterNormalizationMiddleware } from "./loop-prevention.js";
import { buildVerificationBatch, classifyTaskComplexity, detectPackageManager, findTargetedTests, isContinueRequest, isNewProjectTask, isWebTask, pickAffectedPackageCommands, pickFileScopedVerification, pickVerificationCommands, shouldSkipMcpForTask } from "./task-routing.js";
import { describeToolCall, extractGithubLogin, extractSkillNameFromPath, loadedSkillNamesFromMessages, toolCallSummary, toolResultExcerpt } from "./tool-describe.js";
import { saveLastRunCheckpoint, summarizeCompletedSteps } from "./run-checkpoint.js";
import type { AgentPromptAsset } from "./prompt-assets.js";

// Backward-compatible re-exports: main.ts and tests import these from
// agent-service; the implementations now live in the focused modules above.
export type { AgentMode, PlanItem, AgentTurn, HistoryEventItem, HistoryInput, AgentSettings, AgentUsage, AgentEvent, AgentMemoryContext, AgentTaskKind, HomeTaskContract, AttachmentDoc } from "./agent-types.js";
export { inferHomeTaskContract, inferHomeOutputFormats, homeRequestNamesFileFormat } from "./agent-prompt.js";
export { DoomLoopError, toolParameterNormalizationMiddleware, loopPreventionMiddleware } from "./loop-prevention.js";
export type { PackageManagerName, PackageManager, TaskComplexity } from "./task-routing.js";
export { detectPackageManager, pickVerificationCommand, pickVerificationCommands, pickAffectedPackageCommands, pickFileScopedVerification, findTargetedTests, buildVerificationBatch, classifyTaskComplexity, shouldSkipMcpForTask, isWebTask, isNewProjectTask, isContinueRequest } from "./task-routing.js";
export { extractSkillNameFromPath, loadedSkillNamesFromMessages, describeToolCall, extractGithubLogin, toolResultExcerpt } from "./tool-describe.js";
export type { TaskLedger, RunCheckpoint } from "./run-checkpoint.js";
export { getLastRunCheckpoint, saveLastRunCheckpoint, persistLastRunCheckpoint, loadLastRunCheckpoint, clearLastRunCheckpoint, summarizeCompletedSteps } from "./run-checkpoint.js";

export { RunCancelledError };


type HomeFileSnapshot = Map<string, number>;

async function snapshotHomeFiles(root: string): Promise<HomeFileSnapshot> {
  const snapshot: HomeFileSnapshot = new Map();
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const stat = await fsPromises.stat(full);
        snapshot.set(path.relative(root, full).replace(/\\/g, "/"), stat.mtimeMs);
      } catch { /* best effort */ }
    }
  }
  await walk(root);
  return snapshot;
}

async function findFreshHomeFiles(root: string, baseline: HomeFileSnapshot, startedAt: number): Promise<string[]> {
  const current = await snapshotHomeFiles(root);
  return [...current.entries()]
    .filter(([relative, mtime]) => !baseline.has(relative) || mtime >= startedAt - 1000)
    .map(([relative]) => relative)
    .sort();
}


// LangGraph recursion budgets per mode. Lowered from the previous
// 60/160/300: unbounded budgets let the model wander on trivial tasks.
// LangGraph recursion budgets per mode. Lowered from the previous
// 60/160/300: unbounded budgets let the model wander on trivial tasks.
// Simple tasks get a tight budget via SIMPLE_TASK_LIMIT instead.
const MODE_LIMITS: Record<AgentMode, number> = { plan: 40, ask: 100, auto: 150 };
// Fast-path budget for single-lookup / single-edit tasks: enough to
// read 1-2 files and write. Note this feeds LangGraph's recursionLimit,
// where one tool call costs several supersteps — keep it >= 50 or trivial
// tasks die with GraphRecursionError instead of finishing.
const SIMPLE_TASK_LIMIT = 50;
export const MAX_REPAIRS: Record<AgentMode, number> = { plan: 0, ask: 3, auto: 5 };
const HISTORY_CHAR_CAP = 4000;
const VERIFY_OUTPUT_CAP = 4000;
const MEMORY_ENTRY_CAP = 600;
// Project memory log: newest 20 runs, char-capped as a second bound.
export const PROJECT_MEMORY_RUN_LOG_CAP = 20;
// Session memory log: newest 40 run summaries, 4000 chars.
export const SESSION_MEMORY_ENTRY_CAP = 40;
export const SESSION_MEMORY_CHAR_CAP = 4000;

export function extractDiagnosticFeedback(rawOutput: string, cap = VERIFY_OUTPUT_CAP): string {
  if (!rawOutput) return "";
  const cleaned = rawOutput.trim();
  if (cleaned.length <= cap) return cleaned;

  const lines = cleaned.split(/\r?\n/);
  const isDiagnostic = (line: string) =>
    /(?:error\s+[A-Z0-9]+:|error:|failed:|failure:|exception:|syntaxerror|typeerror|referenceerror|assertionerror|errno\s+\d+|undefined reference|cannot find module|\bFAILED\b)/i.test(line);

  const keyLines: string[] = [];
  for (let i = 0; i < lines.length && keyLines.length < 30; i++) {
    if (isDiagnostic(lines[i])) {
      keyLines.push(lines[i]);
      if (i + 1 < lines.length && lines[i + 1].trim() && !isDiagnostic(lines[i + 1])) {
        keyLines.push(`    ${lines[i + 1].trim()}`);
      }
    }
  }

  const budgetPerSection = Math.floor((cap - 200) / 3);
  const head = cleaned.slice(0, budgetPerSection);
  const tailPart = cleaned.slice(-budgetPerSection);

  if (keyLines.length > 0) {
    const diagnosticSummary = `=== Extracted Diagnostics ===\n${keyLines.slice(0, 20).join("\n")}`.slice(0, budgetPerSection);
    return `${head}\n\n${diagnosticSummary}\n\n…[truncated ${Math.max(0, cleaned.length - budgetPerSection * 2)} chars]…\n\n${tailPart}`;
  }

  const half = Math.floor((cap - 100) / 2);
  return `${cleaned.slice(0, half)}\n\n…[truncated ${Math.max(0, cleaned.length - half * 2)} chars]…\n\n${cleaned.slice(-half)}`;
}

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

// Memory entries are summaries, NOT transcripts: the full answer already
// lives in chat history. Storing verbatim tails of long responses (e.g. a
// 15-row table cut to its last 4 rows) misleads future runs into thinking
// the fragment is the complete fact. These helpers collapse large tables
// and truncate on line boundaries with an explicit marker.
function compactTablesForMemory(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    if (isTableRow) {
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++;
      const blockSize = j - i;
      // Keep small tables verbatim; collapse large ones to a row-count note.
      if (blockSize > 6) {
        const header = lines[i].trim();
        out.push(header);
        out.push(`| …[table with ${blockSize - 2} more rows — see chat transcript for full data]… |`);
        const last = lines[j - 1].trim();
        if (last !== header) out.push(last);
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]);
      }
      i = j;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join("\n");
}

function truncateOnLines(value: string, cap: number): string {
  const compacted = compactTablesForMemory(value.trim());
  if (compacted.length <= cap) return compacted;
  const marker = "\n…[summary truncated — see chat transcript for full details]…\n";
  const budget = cap - marker.length;
  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = budget - headBudget;
  let head = compacted.slice(0, headBudget);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > headBudget * 0.5) head = head.slice(0, headBreak);
  let tailPart = compacted.slice(-tailBudget);
  const tailBreak = tailPart.indexOf("\n");
  if (tailBreak >= 0 && tailBreak < tailBudget * 0.5) tailPart = tailPart.slice(tailBreak + 1);
  return `${head}${marker}${tailPart}`;
}

function firstMeaningfulLine(value: string, cap: number): string {
  const compacted = compactTablesForMemory(value.trim());
  const line = compacted.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^\|?\s*:?-+:?/.test(l) && l !== "…") || "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
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
    push(text, item.detail || "");
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




function isRecursionLimitError(error: unknown): boolean {
  const text = [error instanceof Error ? error.message : String(error), String((error as any)?.name ?? "")].join(" ");
  return /recursion\s*limit|GRAPH_RECURSION_LIMIT/i.test(text);
}


// Project memory is a rolling log; keep the most recent entries so it cannot
// grow without bound across hundreds of runs.
// Rolling memory logs (project + session) keep WHOLE entries: char-slicing
// cut the oldest entry mid-sentence and left a misleading fragment at the
// top of what the model reads. Entries are separated by `separator`
// ("\n" for the one-line-per-run project log, "\n\n" for session memory).
export function appendEntryLog(
  existing: string | undefined,
  entry: string,
  opts: { maxEntries: number; maxChars: number; separator: string }
): string {
  const parts = (existing || "").split(opts.separator).map((p) => p.trim()).filter(Boolean);
  parts.push(entry.trim());
  let kept = parts.length > opts.maxEntries ? parts.slice(-opts.maxEntries) : parts;
  while (kept.length > 1 && kept.join(opts.separator).length > opts.maxChars) kept = kept.slice(1);
  return kept.join(opts.separator);
}

// Project facts are agent-recorded and deduped, but unbounded counts would
// still creep up over months of use (eviction handled by capMemoryItems).
const MAX_PROJECT_MEMORY_ITEMS = 50;


export async function runProjectAgent(options: {
  projectRoot: string;
  telemetryRoot?: string;
  sessionId?: string;
  request: string;
  images?: string[];
  attachments?: string[];
  attachmentDocs?: AttachmentDoc[];
  importableAttachments?: string[];
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
  /** "ask" gates every file mutation (backend + apply_patch + skill files) behind approval UI. */
  editPolicy?: "auto" | "ask";
  /** Agent mode for skill scoping ("home" | "code" | "notebook"). Omit = all skills eligible. */
  skillsMode?: SkillMode;
  /** Callback when the agent updates shared Home long-term memory via manage_memory. */
  onHomeMemoryUpdate?: (mutate: (current: string) => string) => void | Promise<unknown>;
  /** Callback when the agent records durable facts via project_memory (Code runs). */
  onProjectMemoryUpdate?: (mutate: (current: string) => string) => void | Promise<unknown>;
  /** Blocking clarifying-question handler: return the user's answers or null to best-guess. */
  onUserQuestion?: (questions: Array<{ header: string; question: string; options: string[] }>) => Promise<string | null>;
  /** Controlled evaluation only: omit selected prompt assets from this run. */
  disabledPromptAssets?: AgentPromptAsset[];
}) {
  const { projectRoot, telemetryRoot, sessionId, request: rawRequest, images, attachments, attachmentDocs, importableAttachments, settings, memory, history, mode, agentBackend, onEvent, isCancelled, onHomeMemoryUpdate, onProjectMemoryUpdate, onUserQuestion } = options;
  const { resumeMessages, resumePlanItems, resumeNote, skillsMode } = options;
  const disabledAssets = new Set(options.disabledPromptAssets || []);
  const assetsEnabled = (asset: AgentPromptAsset) => !disabledAssets.has(asset);
  const taskKind: AgentTaskKind = options.taskKind ?? "code";
  const isGeneral = taskKind === "general";
  // Slash-command expansion: "/review 123" becomes the command's full prompt
  // template with "123" as its input. Single choke point for every run path
  // (Code IPC, Home IPC, headless CLI). Unknown commands and plain text pass
  // through untouched.
  const request = assetsEnabled("commands")
    ? await expandSlashCommand(rawRequest || "", projectRoot, isGeneral ? "home" : "code").catch(() => rawRequest || "")
    : rawRequest || "";
  const homeTaskContract = isGeneral ? inferHomeTaskContract(request) : null;
  const codeTaskContract = isGeneral ? null : inferCodeTaskContract(request);
  const targetTelemetryRoot = telemetryRoot || projectRoot;
  const signal = sessionId ? getRunAbortSignal(sessionId) : undefined;
  const emit = (type: AgentEvent["type"], text: string, items?: PlanItem[], usage?: AgentUsage, subagent?: SubagentItem, artifact?: ArtifactItem, detail?: string) => {
    if (text || items?.length || usage || subagent || artifact) onEvent({ type, sessionId: sessionId || "", text, timestamp: new Date().toISOString(), items, usage, subagent, artifact, detail });
  };
  if (request !== (rawRequest || "")) {
    const cmdName = (rawRequest || "").trimStart().slice(1).split(/\s/, 1)[0];
    emit("status", `Expanded slash command /${cmdName} into its full prompt template`);
  }

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
  // Fast-path routing: simple tasks get fewer tools, no todo planning and
  // no subagent delegation so one lookup cannot fan out into 10+ steps.
  // Classified BEFORE the parallel setup: the rules loader needs it to skip
  // the bundled standards corpus on trivial tasks.
  const complexity = classifyTaskComplexity(request);
  // A "continue" that resumes prior tool state is never a simple task: it
  // needs the full budget, todo tracking and delegation to finish the job.
  const hasResume = Boolean((resumeMessages && resumeMessages.length) || resumeNote);
  let effectiveComplexity: TaskComplexity = hasResume ? "complex" : complexity;
  let isSimple = effectiveComplexity === "simple";
  const isNewProject = isNewProjectTask(request);
  // Setup I/O (MCP servers, project rules, skills config, repo map) is
  // independent — fetch in parallel instead of serially.
  const [mcpResult, rulesResult, skillsConfig, repoMapSection, projectInstructions] = await Promise.all([
    ((isGeneral || shouldSkipMcpForTask(request) || (taskKind === "code" && !/\b(github|repository|repositories|issue|pull request|slack|notion|web search|latest|research|external)\b/i.test(`${request} ${resumeNote || ""}`)))
      ? Promise.resolve({ tools: [], serverNames: [], warnings: undefined })
      : withSetupTimeout(getMcpTools(), 20000, "MCP servers")).then(
      (r) => ({ ok: true as const, tools: r.tools, serverNames: r.serverNames, warnings: r.warnings }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    // Rules loading: Home runs skip rules entirely; Code runs honor the
    // user-facing toggle, and simple tasks get only the project's own rules —
    // the bundled standards corpus is for real engineering work, not lookups.
    (isGeneral || !assetsEnabled("rules")
      ? Promise.resolve({ hasRules: false, ruleFiles: [], combinedPromptSection: "" })
      : getRulesConfig()
          .then((config) => (config.enabled === false || effectiveComplexity === "simple"
            ? discoverProjectRules(projectRoot)
            : discoverAllRules(projectRoot)))
          .catch(() => ({ hasRules: false, ruleFiles: [], combinedPromptSection: "" }))),
    getSkillsConfig().then((config) => ({ ...config, enabled: config.enabled && assetsEnabled("skills") })),
    // Code runs get a symbol-outline map so the model orients without
    // re-listing the tree every task. Home/doc runs skip it (a documents
    // folder has no useful symbols). Never fails the run.
    (isGeneral
      ? Promise.resolve("")
      : Promise.all([
        getRepoMapSection(projectRoot, request).catch(() => ""),
        getProjectIndexSection(projectRoot, request).catch(() => ""),
      ]).then((sections) => sections.filter(Boolean).join("\n\n"))),
    // AGENTS.md / CLAUDE.md (project + ~/.nexus global): the user's own
    // instruction file loads for every Code run regardless of the rules
    // toggle or task complexity — it is project memory, not the standards
    // corpus. Never fails the run.
    (isGeneral || !assetsEnabled("rules") ? Promise.resolve({ files: [], section: "" }) : discoverProjectInstructions(projectRoot).catch(() => ({ files: [], section: "" }))),
  ]);

  let mcpTools: any[] = [];
  if (mcpResult.ok) {
    mcpTools = mcpResult.tools;
    // Per-server isolation: name the servers that could not be reached so
    // the user knows which tools are missing instead of losing them silently.
    for (const warning of mcpResult.warnings || []) {
      emit("status", `MCP server unreachable — its tools are disabled for this run (${warning})`);
    }
    if (mcpResult.tools.length) {
      // Name the bound tools so the model (and the user in the activity feed)
      // can see exactly which MCP capabilities this run has. Capped: a server
      // with dozens of tools must not bloat every future prompt via history.
      const names = mcpResult.tools.map((t: any) => t?.name).filter((n: unknown): n is string => typeof n === "string" && Boolean(n));
      const shown = names.slice(0, 15).join(", ");
      const extra = names.length > shown.split(", ").length ? ` (+${names.length - 15} more)` : "";
      emit("status", `Connected to MCP · ${mcpResult.tools.length} tool${mcpResult.tools.length === 1 ? "" : "s"} from ${mcpResult.serverNames.join(", ")}: ${shown}${extra}`);
    }
  } else {
    emit("error", `MCP servers could not be reached, continuing without them: ${mcpResult.error instanceof Error ? mcpResult.error.message : String(mcpResult.error)}`);
  }
  // Plan mode is a hard read-only boundary. MCP tools are user-defined and
  // may mutate files or external systems, so none can be safely exposed while
  // the agent is only supposed to investigate and plan.
  if (mode === "plan") mcpTools = [];
  // Pure document builds run on local skills + write_file/execute: binding
  // dozens of unrelated MCP tools only bloats context and destabilizes slow
  // endpoints. Research-flavored builds keep MCP (see shouldSkipMcpForTask).
  else if (shouldSkipMcpForTask(request) && mcpTools.length) {
    mcpTools = [];
    emit("status", "Skipping MCP tools for document build — local skills suffice.");
  }
  // GitHub identity pre-resolution: a token-backed GitHub MCP server already
  // identifies the user, so the model must never ask for a username. Call the
  // server's get_me tool once (read-only) and hand the login to the run as
  // fact. Gated on GitHub-flavored requests so unrelated runs pay nothing.
  // Advisory only — any failure degrades to the old behavior.
  let identityNote: string | null = null;
  // Note: "repositories" must match — repos?\b alone fails on it ("repos"
  // is followed by "i", not a word boundary), hence the repositor alternative.
  if (/github|repositor|\brepos?\b|pull request|\bprs?\b|issues?|gists?/i.test(request)) {
    const meTool = mcpTools.find((t: any) => typeof t?.name === "string" && /^get_me$/i.test(t.name));
    if (meTool && typeof meTool.invoke === "function") {
      try {
        const raw = await withSetupTimeout(Promise.resolve(meTool.invoke({})), 15000, "GitHub identity");
        const login = extractGithubLogin(raw);
        if (login) {
          identityNote = `[Authenticated GitHub user (resolved via the GitHub MCP get_me tool — do NOT ask the user for their username): ${login}]`;
          emit("status", `GitHub identity · ${login}`);
        }
      } catch { /* identity stays unknown; model falls back to tools */ }
    }
  }
  if (rulesResult.hasRules && !isGeneral) {
    emit("status", `Loaded ${rulesResult.ruleFiles.length} project rule file${rulesResult.ruleFiles.length === 1 ? "" : "s"} (${rulesResult.ruleFiles.map((r) => r.filename).join(", ")})`);
  }
  if (projectInstructions.files.length && !isGeneral) {
    emit("status", `Loaded project instructions (${projectInstructions.files.map((f) => f.name).join(", ")})`);
  }

  const runCommand = async (command: string) => {
    try {
      return await Promise.resolve((agentBackend as any)?.execute?.(command));
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), exitCode: 1, truncated: false };
    }
  };

  const skills = skillsConfig.enabled ? [PROJECT_SKILLS_DIR, GLOBAL_SKILLS_ROUTE, SYSTEM_SKILLS_ROUTE] : [];
  let globalSkillsBackend: any = null;
  let systemBackend: any = null;
  if (skills.length) {
    globalSkillsBackend = new FilesystemBackend({ rootDir: globalSkillsDir(), virtualMode: true });
    if (mode === "plan") {
      const refuseSkillWrite = (action: string) => async () => {
        throw new Error(`Plan mode is read-only: skill ${action} is disabled.`);
      };
      globalSkillsBackend.write = refuseSkillWrite("write_file");
      globalSkillsBackend.edit = refuseSkillWrite("edit_file");
      globalSkillsBackend.delete = refuseSkillWrite("delete");
      globalSkillsBackend.execute = refuseSkillWrite("execute");
    }
    // Bundled system skills: always read-only, in every mode including auto.
    try {
      systemBackend = new FilesystemBackend({ rootDir: systemSkillsDir(), virtualMode: true });
      const refuseSystemWrite = (action: string) => async () => {
        throw new Error(`System skills are read-only: ${action} is disabled.`);
      };
      systemBackend.write = refuseSystemWrite("write_file");
      systemBackend.edit = refuseSystemWrite("edit_file");
      systemBackend.delete = refuseSystemWrite("delete");
      systemBackend.execute = refuseSystemWrite("execute");
    } catch { /* no system skills shipped */ }
  }
  const compositeBackend = skills.length
    ? new CompositeBackend(agentBackend as any, buildSkillMounts(globalSkillsBackend, systemBackend))
    : agentBackend;

  // Skill shortlist: the framework injects the full catalog, but models —
  // especially small ones — ignore catalogs. Match deterministically and
  // tell the agent exactly which SKILL.md files to read first. Per-skill mode
  // scoping applies here: only skills enabled for this run's mode are
  // recommended, and skills scoped to other modes are explicitly off-limits.
  let skillNote: string | null = null;
  let eligibleSkillCatalog: SkillInfo[] = [];
  let selectedSkillCatalog: SkillInfo[] = [];
  if (skillsConfig.enabled) {
    try {
      const fullCatalog = [...(await listSkills(projectRoot)), ...(await listSystemSkills().catch(() => []))];
      const catalog = skillsMode ? fullCatalog.filter((s) => skillAppliesToMode(s, skillsMode)) : fullCatalog;
      eligibleSkillCatalog = catalog;
      // MCP-dependent skills stay mounted and materializable, but drop out of
      // recommendations when their server isn't connected (REQUIRED_MCP_SKILLS).
      const recs = recommendSkills(filterSkillsByMcp(catalog, mcpResult.ok ? mcpResult.serverNames : []), request, 3);
      // The framework parses every directory passed in `skills`. Passing the
      // complete catalog makes unrelated skills part of every run and means a
      // malformed/unsupported frontmatter file can fail an otherwise
      // unrelated task. Keep the full catalog available for matching, but
      // mount only the skills selected for this request.
      selectedSkillCatalog = recs;
      const offLimits = skillsMode ? fullCatalog.filter((s) => !skillAppliesToMode(s, skillsMode)) : [];
      const offUser = offLimits.filter((s) => s.source !== "system");
      const offSystemCount = offLimits.length - offUser.length;
      if (recs.length || offLimits.length) {
        const lines = recs.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""} → read ${skillVirtualPath(s)} first`);
        const counts = (["project", "global", "system"] as const)
          .map((source) => `${catalog.filter((s) => s.source === source).length} ${source}`)
          .join(", ");
        skillNote = `[System Note: ${catalog.length} skill(s) installed${skillsMode ? ` for ${skillsMode} mode` : ""} (${counts}). Most relevant to your task:\n${lines.join("\n")}\nIf a skill covers your task, read its SKILL.md BEFORE exploring or writing code. This read is free and does not count against your exploration budget.\nIMPORTANT: SKILL.md contains private operational guidance for YOU. NEVER output, quote, echo, or dump its text or numbered lines to the user. Silently apply the skill to fulfill the user's request.]`;
        if (offUser.length) {
          skillNote += `\n[Skills NOT available in ${skillsMode} mode — do NOT read, follow, or mention them: ${offUser.map((s) => s.name).join(", ")}.]`;
        }
        if (offSystemCount > 0) {
          skillNote += `\n[${offSystemCount} system skill(s) are disabled in ${skillsMode} mode — only use skills listed above.]`;
        }
      }
    } catch { /* skills are advisory — never fail a run */ }
  }
  // Framework skill loading is scoped to eligible skills only: the mounted
  // parent directories would expose every skill to the model regardless of
  // mode, so pass direct per-skill paths instead. Later sources win on name
  // clashes (system < global < project). skillDirVirtualPath is backend-safe:
  // global/system resolve through the composite mounts, project through the
  // workspace backend.
  const skillDirs = selectedSkillCatalog
    .slice()
    .sort((a, b) => SKILL_SOURCE_PRIORITY[b.source] - SKILL_SOURCE_PRIORITY[a.source])
    .map(skillDirVirtualPath);

  // Project hooks (.nexus/hooks.json) behind a global toggle: run:start/end,
  // tool:before (deny-capable) / tool:after, verify:fail. Hook failures are
  // reported, never fatal.
  const hooks = (await getHooksConfig().catch(() => ({ enabled: true }))).enabled
    ? await discoverHooks(projectRoot).catch(() => [])
    : [];
  const hooksMiddleware = hooks.length ? createHooksMiddleware({ projectRoot, hooks, runId: sessionId }) : null;

  const allCodeTools = createCodeIntelligenceTools(projectRoot);
  const wantsBrowser = isWebTask(request);
  let homeResearchToolCalls = 0;
  const beforeHomeResearch = () => {
    if (!isGeneral || !homeTaskContract?.expectsOutput) return null;
    homeResearchToolCalls++;
    if (homeResearchToolCalls > 8) {
      return "[SUPERVISOR INTERVENTION] The research budget for this task has been reached. Use the evidence already collected and take the next result-producing action. Do not perform another web search or page fetch unless it directly unblocks creation of the requested output.";
    }
    return null;
  };
  // Home general runs always get the browser + free web search: research is
  // core to that mode, not an edge case.
  // Edit-approval gate (opt-in via AppSettings.editPolicy or the run options):
  // applied at all three mutation paths — backend write/edit/delete (see
  // getAgentBackend), apply_patch, and materialize_skill_files.
  const editGate = options.editPolicy === "ask"
    ? async (info: { tool: string; files: string[] }) => {
        const decision = await requestCommandApproval({
          runId: sessionId,
          approvalKey: "file-edit",
          command: `${info.tool} ${info.files.slice(0, 5).join(", ")}${info.files.length > 5 ? ` (+${info.files.length - 5} more)` : ""}`,
          cwd: projectRoot,
          reason: "Edit approval is on: file changes wait for your confirmation.",
        });
        return decision === "deny"
          ? `Edit denied by the user: ${info.tool} on ${info.files.join(", ")} was not approved. Do not retry the same change; explain what you intended instead.`
          : null;
      }
    : undefined;
  const browserTools = wantsBrowser || isGeneral
    ? createBrowserTools(projectRoot, {
        agentBrowser: {
          inspect: (url) => agentBrowserService.inspect(url, { sessionId, scope: isGeneral ? "home" : "code" }),
          act: (input) => agentBrowserService.act(input, projectRoot, { sessionId, scope: isGeneral ? "home" : "code" }),
        },
        beforeRead: beforeHomeResearch,
      })
    : [];
  // Browser actions and non-GET API calls can mutate external state. Plan mode
  // may inspect pages, but must not click, fill, navigate, or send requests.
  const safeBrowserTools = mode === "plan"
    ? browserTools.filter((candidate: any) => candidate?.name === "browser_inspect")
    : browserTools;
  // Home general runs always get the browser tools; code runs get them for
  // web-flavored tasks. Web search rides along everywhere (cheap, one tool):
  // researching unfamiliar or recently-released libraries beats hallucinating
  // their APIs. Every search is mirrored into the built-in browser.
  const webSearchTools = createWebSearchTools({
    beforeSearch: beforeHomeResearch,
    // Mirror every search into the built-in browser so it is visible there
    // (Watching follows it live, otherwise the follow banner shows it).
    // Fire-and-forget: results come from the search API, never the mirror.
    onSearch: (_query, url) => {
      void agentBrowserService.visit(url, { sessionId, scope: isGeneral ? "home" : "code" }).catch(() => {});
    },
  });
  const usage = new UsageAccumulator();
  let recursionLimit = isSimple ? SIMPLE_TASK_LIMIT : MODE_LIMITS[mode];
  // Opencode core: ripgrep-like grep + range-read only for simple tasks.
  const codeTools = pickRuntimeCodeTools(allCodeTools, effectiveComplexity);
  // The backend is also read-only in Plan mode, but keep the invariant at the
  // tool-registration boundary too: custom tools must not bypass the backend.
  // importableAttachments covers every file type (images + docs); the legacy
  // attachedImages alias keeps image imports working for older callers.
  const editTools = mode === "plan" ? [] : createEditTools(projectRoot, { attachedImages: attachments, attachedFiles: importableAttachments ?? attachments, beforeEdit: editGate });
  // Skill helper scripts run through the workspace: plan mode stays read-only.
  const skillFilesTools = mode === "plan" || !skillsConfig.enabled ? [] : [createSkillFilesTool(eligibleSkillCatalog, projectRoot, { beforeEdit: editGate })];
  const questionTool = createQuestionTool(async (questions) => {
    emit("status", `Clarifying questions: ${questions.map((q) => q.header).join(", ")}`);
    if (trajectory) {
      void trajectory.log({ source: "MODEL", type: "STATUS", content: questions.map((q) => `${q.header}: ${q.question}`).join("\n") });
    }
    if (onUserQuestion) {
      try {
        return await onUserQuestion(questions);
      } catch {
        return null;
      }
    }
    return null;
  });
  let codePlanReady = Boolean(resumePlanItems?.length);
  const requiresCodePlan = !isGeneral && mode !== "plan" && effectiveComplexity === "complex" && Boolean(codeTaskContract?.expectsChanges);
  const beforeCodeModify = () => requiresCodePlan && !codePlanReady
    ? "[PHASE GATE] This is a complex change request and no execution plan exists yet. Create a concrete todo plan with write_todos first, then implement the first item. Do not edit files before the plan is recorded."
    : null;
  const subagentTool = createSubagentDelegationTool({
    projectRoot,
    provider,
    modelName,
    projectRecord: { id: "current", name: "current", root: projectRoot },
    mcpTools,
    skills: skillDirs,
    skillsBackend: compositeBackend,
    onEvent: (subEvent) => {
      usage.addSubagent(subEvent.subagent.usage);
      emit("subagent", subEvent.type === "subagent_start" ? `Delegated task to ${subEvent.subagent.role} subagent` : subEvent.type === "subagent_finish" ? `Subagent [${subEvent.subagent.role}] completed` : `Subagent working...`, undefined, undefined, subEvent.subagent);
    },
    isCancelled,
    runId: sessionId,
  });

  const homeMemoryTool = isGeneral
    ? [
        createHomeMemoryTool({
          // The mutate callback re-reads the shared memory inside the store's
          // serialized mutation queue — a run-start snapshot wholesale-
          // replaced by a parallel chat would erase this chat's facts.
          onRemember: async (category, fact) => {
            await onHomeMemoryUpdate?.((current) => addMemoryFact(current, category, fact));
            emit("status", `Saved to long-term memory: ${fact}`);
          },
          onForget: async (query) => {
            let removed = 0;
            await onHomeMemoryUpdate?.((current) => {
              const { memory, removed: count } = removeMemoryFactWithCount(current, query);
              removed = count;
              return memory;
            });
            emit("status", removed ? `Removed from long-term memory: ${query}` : `No long-term memory item matched "${query}".`);
            return removed;
          },
        }),
      ]
    : [];

  // Code-mode durable memory (Claude-Code auto-memory parity): the model can
  // explicitly record facts future tasks should know — working build/test
  // commands, conventions, gotchas, decisions — instead of relying only on
  // the automatic work log. Writes go through the store's serialized
  // project-facts queue; the user sees and can forget every entry in the
  // Memory tab.
  const projectMemoryTool =
    !isGeneral && onProjectMemoryUpdate
      ? [
          createHomeMemoryTool({
            name: "project_memory",
            description:
              "Manage durable project memory for THIS repository (survives across sessions and tasks). Call this tool when you learn something future tasks should know: build/test/lint commands that actually work, the user's stated conventions or preferences, architectural decisions and their reasons, environment gotchas (e.g. 'integration tests need DATABASE_URL set'), or corrections to previous assumptions. Category: 'fact' for project truths, 'context' for ongoing goals/decisions, 'preference' for the user's coding preferences, 'profile' for the user's role in the project. Do NOT record transient task details, file listings, tool output, or anything already evident from the code. For action='forget', pass the item's EXACT current wording — paraphrases do not match.",
            onRemember: async (category, fact) => {
              await onProjectMemoryUpdate((current) => capMemoryItems(addMemoryFact(current, category, fact), MAX_PROJECT_MEMORY_ITEMS));
              emit("status", `Saved to project memory: ${fact}`);
            },
            onForget: async (query) => {
              let removed = 0;
              await onProjectMemoryUpdate((current) => {
                const { memory, removed: count } = removeMemoryFactWithCount(current, query);
                removed = count;
                return memory;
              });
              emit("status", removed ? `Removed from project memory: ${query}` : `No project memory item matched "${query}".`);
              return removed;
            },
          }),
        ]
      : [];

  const deepAgent = await createDeepAgent({
    model: llm,
    backend: compositeBackend as any,
    middleware: [
      toolParameterNormalizationMiddleware(projectRoot),
      loopPreventionMiddleware({ general: isGeneral, outputRequired: Boolean(homeTaskContract?.expectsOutput), beforeModify: beforeCodeModify }),
      ...(isSimple ? [] : [todoListMiddleware()]),
      ...(hooksMiddleware ? [hooksMiddleware] : []),
    ],
    tools: isSimple
      ? [...codeTools, ...editTools, ...skillFilesTools, questionTool, ...safeBrowserTools, ...webSearchTools, ...homeMemoryTool, ...projectMemoryTool, ...mcpTools]
      : [...codeTools, ...editTools, ...skillFilesTools, questionTool, ...safeBrowserTools, ...webSearchTools, ...homeMemoryTool, ...projectMemoryTool, ...(assetsEnabled("agents") ? [subagentTool] : []), ...mcpTools],
    skills: skillDirs,
    // Relevance-ranked memory for the prompt: profile/preferences always in,
    // facts and recent activity filtered to the current request so unrelated
    // history never crowds out working context. manage_memory above keeps
    // operating on the FULL memory — only the prompt copy is sliced.
    systemPrompt: buildSystemPrompt(
      mode,
      projectRoot,
      provider.label,
      modelName,
      isGeneral && memory.projectMemory
        ? { projectMemory: selectRelevantHomeMemory(memory.projectMemory, request, 2000), sessionMemory: memory.sessionMemory }
        : memory,
      rulesResult.combinedPromptSection,
      effectiveComplexity,
      isNewProject,
      taskKind,
      repoMapSection,
      homeTaskContract,
      // Full role catalog only where delegate_task is actually bound — simple
      // runs drop the tool, Home runs never mention delegation.
      assetsEnabled("agents") && !isGeneral && effectiveComplexity !== "simple" ? buildSubagentCatalog() : "",
      projectInstructions.section
    ),
  });

  // Context compaction: simple tasks (greetings, single lookups) answer from
  // recent turns with the cheap heuristic — a model summarization call here
  // would add a silent ≤20s stall before the first token. Complex runs get
  // the model-backed summary with a visible status line instead of a gap.
  let compactedHistory;
  if (isSimple) {
    compactedHistory = compactHistory(history, 3000);
  } else {
    if (history.filter((t) => t.role !== "event").length > 6) {
      emit("status", "Summarizing long history…");
    }
    compactedHistory = await compactHistoryWithModel(history, async (prompt) => {
      try {
        const res: any = await llm.invoke(prompt);
        const text = typeof res?.content === "string" ? res.content : Array.isArray(res?.content) ? res.content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("\n") : String(res?.content || res?.text || "");
        return text;
      } catch {
        throw new Error("summarizer failed");
      }
    }).catch(() => compactHistory(history));
  }
  const priorMessages = compactedHistory.map((turn) =>
    turn.role === "assistant"
      ? new AIMessage(tail(turn.text, HISTORY_CHAR_CAP))
      : new HumanMessage(tail(turn.text, HISTORY_CHAR_CAP))
  );

  const imageNote = attachments?.length
    ? `[Attached image context: ${attachments.length} image${attachments.length === 1 ? " is" : "s are"} available, numbered ${attachments.map((_, index) => index).join(", ")}. Treat them as reference material by default. If the requested deliverable needs the actual image file in the project, use import_attached_image with the appropriate index and destination; otherwise do not copy them.]`
    : null;
  // Document attachments arrive pre-extracted (main.ts via notebook parsers):
  // inline them as a context block so the model reads PDFs/Office/TeX without
  // needing a tool round-trip. Import stays opt-in via import_attachment.
  const docNote = attachmentDocs?.length
    ? attachmentDocs.map((doc, index) =>
        `[Attached file ${index + 1}/${attachmentDocs.length}: ${doc.name} (${doc.mimeType || "unknown type"})${doc.truncated ? " — truncated to fit context" : ""}]\n${doc.text}`
      ).join("\n\n")
    : null;
  const importNote = (attachmentDocs?.length || attachments?.length)
    ? `[Attachment imports: ${(attachmentDocs?.length || 0) + (attachments?.length || 0)} file(s) available via import_attachment (index 0..${(attachmentDocs?.length || 0) + (attachments?.length || 0) - 1}: ${[...(attachmentDocs || []).map((d) => d.name), ...(attachments || []).map((_, i) => `image-${i}`)].join(", ")}). Only import when the deliverable needs the actual file in the project; reference content above is already in context.]`
    : null;
  const requestText = [request, identityNote, resumeNote, skillNote, imageNote, docNote, importNote].filter(Boolean).join("\n\n");
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
  // Generic Home supervisor signals. These do not classify the task; they
  // detect whether the run is making observable progress toward its contract.
  let homeReadOnlyStreak = 0;
  let homeActionRepeatCount = 0;
  let homeLastActionSig: string | null = null;
  let lastActiveToolName: string | null = null;
  let lastActiveToolSkill: string | null = null;
  // Latest workspace diff, filled by verify and reused for the walkthrough
  // artifact so a run doesn't pay for the same git diff twice.
  let lastDiffFiles: any[] | null = null;
  // Diff baseline captured BEFORE the agent works. Verify/repair must only
  // cover files THIS run changed: after an interrupted run leaves broken
  // edits behind, a follow-up question ("what does X do?") would otherwise
  // see the stale dirty diff, fail typecheck on the OLD breakage, and go
  // into repair mode on the previous task instead of answering.
  const runStartMs = Date.now();
  let homeJournal: HomeTaskJournal | null = null;
  let homeJournalWrite = Promise.resolve();
  const queueHomeJournalWrite = (next: HomeTaskJournal) => {
    homeJournal = next;
    if (!isGeneral) return;
    homeJournalWrite = homeJournalWrite
      .then(() => saveHomeTaskJournal(projectRoot, next))
      .catch(() => undefined);
  };
  if (isGeneral && sessionId && homeTaskContract) {
    homeJournal = createHomeTaskJournal({
      sessionId,
      goal: request,
      expectsOutput: homeTaskContract.expectsOutput,
      needsResearch: homeTaskContract.needsResearch,
    });
    queueHomeJournalWrite(homeJournal);
  }
  let codeJournal: CodeTaskJournal | null = null;
  let codeJournalWrite = Promise.resolve();
  const queueCodeJournalWrite = (next: CodeTaskJournal) => {
    codeJournal = next;
    if (isGeneral || !sessionId) return;
    codeJournalWrite = codeJournalWrite
      .then(() => saveCodeTaskJournal(projectRoot, next))
      .catch(() => undefined);
  };
  if (!isGeneral && sessionId) {
    const previous = hasResume ? await loadCodeTaskJournal(projectRoot, sessionId) : null;
    queueCodeJournalWrite(createCodeTaskJournal({ sessionId, goal: request, mode, resume: previous }));
  }
  // Terminal journal states must be written however the run ends:
  // cancel/doom/step-budget → interrupted, unexpected crash → failed,
  // repairs exhausted with failing verification → blocked (finish site).
  const finishRunJournals = async (status: "interrupted" | "failed" | "blocked" | "completed") => {
    if (homeJournal) {
      homeJournal = finishHomeTaskJournal(homeJournal, status, status === "completed" ? "complete" : "blocked");
      queueHomeJournalWrite(homeJournal);
    }
    if (codeJournal) {
      codeJournal = finishCodeTaskJournal(codeJournal, status);
      queueCodeJournalWrite(codeJournal);
    }
    await Promise.all([homeJournalWrite, codeJournalWrite]).catch(() => undefined);
  };
  const diffFingerprint = (d: { path: string; additions: number; deletions: number }) => `${d.additions}/${d.deletions}`;
  const initialDiff = new Map<string, string>();
  let initialHomeFiles: HomeFileSnapshot = new Map();
  if (!isGeneral) {
    try {
      const before = await getWorkspaceDiffFiles(projectRoot);
      for (const d of before) initialDiff.set(d.path, diffFingerprint(d));
    } catch { /* baseline is best-effort; verify falls back to full diff */ }
  } else {
    try {
      initialHomeFiles = await snapshotHomeFiles(projectRoot);
    } catch { /* baseline is best-effort */ }
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
  let toolCallCount = 0;
  const withAgentRetry = <T>(operation: () => Promise<T>): Promise<T> =>
    withRateLimitRetry(operation, {
      // A Home research run must not spend several retry windows replaying the
      // same long browse sequence. Preserve the checkpoint and surface a
      // resumable failure quickly instead of silently consuming 20+ minutes.
      maxAttempts: isGeneral ? 4 : undefined,
      maxProgressResets: isGeneral ? 0 : undefined,
      baseDelayMs: isGeneral ? 5_000 : undefined,
      signal,
      prepareAttempt: () => {
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
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
    // A mid-stream retry legitimately re-issues the pruned trailing tool
    // call, so the doom-loop signature must not accumulate across attempts.
    lastToolSig = null;
    toolRepeatCount = 0;
    let finalMessages: any[] = [];
    progress.beginAttempt(runMessages.length);

    let messagesToStream = runMessages;
    if (
      (retryCount > 1 && runMessages.length > priorMessages.length + 1) ||
      (hasResume && retryCount === 1 && runMessages.length > priorMessages.length + 1)
    ) {
      const planNotice = lastPlanItems && lastPlanItems.length > 0
        ? `\nCurrent working plan status:\n${lastPlanItems.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
        : "";
      const ledger = summarizeCompletedSteps(runMessages);
      const ledgerNotice = ledger.length
        ? `\nSteps already DONE (never repeat these — their results are above):\n${ledger.map((s) => `- ${s}`).join("\n")}`
        : "";
      const resumedSkills = loadedSkillNamesFromMessages(runMessages);
      const skillsNotice = resumedSkills.length
        ? `\nSkills already loaded this run (do NOT re-read any SKILL.md — act on the instructions above): ${resumedSkills.join(", ")}`
        : "";
      const resumeNotice = `[System Note: Stream was resumed after pause/interruption. All preceding tool executions and results are recorded above and already complete.${planNotice}${ledgerNotice}${skillsNotice}\n\nIMPORTANT: Do NOT restart from the beginning, do NOT re-create the todo list from scratch, and do NOT repeat already completed tool actions. If builds and code are in place, mark remaining in-progress todos completed and output your final response immediately.]`;
      messagesToStream = [...runMessages, new HumanMessage(resumeNotice)];
    }

    const stream = await (deepAgent as any).stream(
      { messages: messagesToStream },
      { streamMode: ["values", "updates", "messages"], recursionLimit, signal }
    );
    try {
      for await (const item of stream as AsyncIterable<any>) {
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];
        if (streamMode === "values" && Array.isArray(payload?.messages)) {
          finalMessages = payload.messages;
          runMessages = payload.messages;
          progress.noteSuperstep(payload.messages.length);
          continue;
        }
        if (streamMode === "updates" && payload && typeof payload === "object") {
          for (const delta of Object.values<any>(payload)) {
            for (const message of delta?.messages ?? []) {
              if (Array.isArray(message?.tool_calls)) {
                for (const call of message.tool_calls) {
                  toolCallCount++;
                  const name = call?.name || "tool";
                  lastActiveToolName = name;
                  if (name === "read_file" || name === "read_file_range") {
                    const filePath = String(call?.args?.file_path || call?.args?.filePath || call?.args?.file || call?.args?.path || "");
                    lastActiveToolSkill = extractSkillNameFromPath(filePath);
                  } else {
                    lastActiveToolSkill = null;
                  }
                  if (/todo/i.test(name)) {
                    const items = planItemsFromArgs(call.args);
                    if (items) {
                      lastPlanItems = items;
                      if (!isGeneral) {
                        codePlanReady = items.length > 0;
                        if (codeJournal) queueCodeJournalWrite(recordCodeTaskPlan(codeJournal, items));
                      }
                      emit("plan", "Working plan", items);
                    }
                    continue;
                  }
                  const summary = toolCallSummary(call);
                  const isSkillRead = summary.startsWith("Consulting skill: ");
                  const desc = isSkillRead ? summary : (summary ? `${name} · ${summary}` : name);
                  // Doom-loop breaker (opencode DOOM_LOOP_THRESHOLD): the same
                  // tool with identical args 6x in a row is stuck, not working.
                  // loopPreventionMiddleware intercepts and steers at repetition 2 & 3,
                  // so 6x acts as the final safety circuit breaker if model persists.
                  const normalizedCallArgs = { ...call?.args };
                  if (normalizedCallArgs.filePath && !normalizedCallArgs.file_path) {
                    normalizedCallArgs.file_path = normalizedCallArgs.filePath;
                    delete normalizedCallArgs.filePath;
                  }
                  if (typeof normalizedCallArgs.file_path === "string") {
                    normalizedCallArgs.file_path = normalizedCallArgs.file_path.replace(/\\/g, "/").replace(/^\/+/, "");
                  }
                  const sig = `${name}:${JSON.stringify(normalizedCallArgs).slice(0, 500)}`;
                  if (sig === lastToolSig) {
                    toolRepeatCount++;
                  } else {
                    lastToolSig = sig;
                    toolRepeatCount = 1;
                  }
                  if (toolRepeatCount >= 6) {
                    throw new DoomLoopError(name, summary || "identical arguments");
                  }
                  if (isGeneral) {
                    const readOnlyAction = /search|browser|fetch|inspect|read|skill|outline|passage|list/i.test(name);
                    if (sig === homeLastActionSig) homeActionRepeatCount++;
                    else {
                      homeLastActionSig = sig;
                      homeActionRepeatCount = 1;
                    }
                    homeReadOnlyStreak = readOnlyAction ? homeReadOnlyStreak + 1 : 0;
                    if (homeReadOnlyStreak === 7 && homeTaskContract?.expectsOutput) {
                      emit("status", "Supervisor · research/read-only streak detected; the next action must advance the requested result");
                    }
                    if (homeActionRepeatCount === 3 && homeTaskContract?.expectsOutput) {
                      emit("status", "Supervisor · the same action is repeating; change approach or produce an intermediate result");
                    }
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
                const doneLabel = lastActiveToolSkill
                  ? `Skill loaded: ${lastActiveToolSkill} ✓`
                  : `${message.name || lastActiveToolName || "tool"} ✓`;
                emit("tool", doneLabel, undefined, undefined, undefined, undefined, excerpt || undefined);
                if (isGeneral && homeJournal) {
                  const toolName = String(message.name || lastActiveToolName || "tool");
                  const phase: HomeTaskPhase = /search|browser|fetch|inspect|read|skill/i.test(toolName)
                    ? "research"
                    : /write|edit|execute|delete|patch|create/i.test(toolName)
                      ? "execution"
                      : /list|stat|validate|check|test/i.test(toolName)
                        ? "validation"
                        : homeJournal.phase;
                  const readOnlyAction = /search|browser|fetch|inspect|read|skill|outline|passage|list/i.test(toolName);
                  const next = recordHomeTaskAction(homeJournal, {
                    tool: toolName,
                    summary: doneLabel,
                    result: excerpt || undefined,
                    progressed: !readOnlyAction || homeReadOnlyStreak < 7,
                    phase,
                  });
                  queueHomeJournalWrite(next);
                }
                if (!isGeneral && codeJournal) {
                  const toolName = String(message.name || lastActiveToolName || "tool");
                  const phase: CodeTaskPhase = /test|check|diagnostic|lint|build|verify|format/i.test(toolName)
                    ? "verification"
                    : /write|edit|execute|delete|patch|create|move/i.test(toolName)
                      ? "implementation"
                      : codeJournal.phase === "verification" || codeJournal.phase === "review"
                        ? codeJournal.phase
                        : "planning";
                  const readOnlyAction = !/write|edit|execute|delete|patch|create|move|test|check|diagnostic|lint|build|verify|format/i.test(toolName);
                  queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
                    tool: toolName,
                    summary: doneLabel,
                    result: excerpt || undefined,
                    progressed: !readOnlyAction,
                    phase,
                  }));
                }
                progress.noteToolResult();
                if (isGeneral && sessionId) {
                  saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
                }
                if (trajectory) {
                  void trajectory.log({ source: "TOOL", type: "TOOL_RESULT", content: `${message.name || lastActiveToolName || "tool"} finished` });
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
    } catch (error: any) {
      if (finalMessages.length > 0) {
        runMessages = sanitizeResumeCheckpoint(finalMessages);
      }
      const isAbort = error instanceof RunCancelledError || error?.name === "AbortError" || isCancelled() || signal?.aborted;
      if (isAbort) {
        saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
        throw new RunCancelledError();
      }
      throw error;
    }
    if (finalMessages.length > 0) {
      runMessages = finalMessages;
    }
    const finalAnswer = textFromMessage(finalMessages[finalMessages.length - 1]);
    return finalAnswer || (isGeneral ? "I have completed the requested task." : "Agent finished without a textual response.");
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

  if (hooks.length) {
    const startOutcome = await dispatchHooks(projectRoot, hooks, "run:start", { request, mode, projectRoot, runId: sessionId }).catch(() => null);
    if (startOutcome && !startOutcome.ok) {
      emit("status", `run:start hook failed (exit ${startOutcome.exitCode ?? "timeout"}): ${startOutcome.output.slice(0, 200)}`);
    }
  }

  const graph = new StateGraph(AgentState as any)
    .addNode("deep_agent", async (state: any) => {
      if (isCancelled() || signal?.aborted) throw new RunCancelledError();
      const extra = state.verifyFeedback ? [new HumanMessage(state.verifyFeedback)] : [];
      emit("status", state.verifyFeedback ? `Self-healing repair in progress (attempt ${state.repairs || 1} of ${MAX_REPAIRS[mode] ?? 3})` : "Agent is working on the task");
      const answer = await streamDeepAgent(extra);
      return { response: answer, verifyFeedback: "", runMessages };
    })
    .addNode("verify", async (state: any) => {
      if (isCancelled() || signal?.aborted) throw new RunCancelledError();

      if (!isGeneral && codeJournal) {
        queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
          tool: "supervisor",
          summary: "Entering verification phase",
          progressed: true,
          phase: "verification",
        }));
      }

      // Home general runs do not have repository checks. Enforce the generic
      // output contract inferred from the request instead. The model decides
      // what the output should be; the runtime checks observable progress.
      if (isGeneral) {
        const currentRepairs = Number(state.repairs) || 0;
        const maxRepairs = MAX_REPAIRS[mode] ?? 1;
        const wantsDeliverable = Boolean(homeTaskContract?.expectsOutput);
        const freshFiles = wantsDeliverable
          ? await findFreshHomeFiles(projectRoot, initialHomeFiles, runStartMs)
          : [];
        const createdDeliverable = freshFiles.length > 0;
        const artifactContract = await validateHomeArtifactContract(projectRoot, freshFiles, homeTaskContract?.expectedFormats);
        const invalidArtifacts = artifactContract.invalidArtifacts;
        const missingFormats = artifactContract.missingFormats;
        const validatedDeliverable = createdDeliverable && artifactContract.valid;
        // Chat-answer escape: a genuinely chat-shaped request (poem,
        // explanation, email text) that names no file format may be answered
        // directly in chat, marked with [[answer-in-chat]]. The model decides
        // what the deliverable is; the sentinel + substance + no-named-format
        // guardrails keep it from dodging real file work.
        const responseTextTrimmed = String(state.response || "").trimEnd();
        const hasVisualBlocks = /```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)\b/i.test(responseTextTrimmed);
        const chatAnswerDeclared =
          wantsDeliverable &&
          !homeRequestNamesFileFormat(request) &&
          (hasVisualBlocks || (!createdDeliverable && responseTextTrimmed.length >= 200 && /\[\[answer-in-chat\]\]\s*$/i.test(responseTextTrimmed)));
        if (chatAnswerDeclared) {
          if (hasVisualBlocks) {
            // Clean up any unrequested .md/.txt chart dump files created alongside the chat response
            for (let i = freshFiles.length - 1; i >= 0; i--) {
              const file = freshFiles[i];
              if (/\.(md|markdown|txt)$/i.test(file)) {
                try {
                  const content = await fsPromises.readFile(path.join(projectRoot, file), "utf8");
                  if (/```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)\b/i.test(content)) {
                    await fsPromises.unlink(path.join(projectRoot, file)).catch(() => {});
                    freshFiles.splice(i, 1);
                  }
                } catch { /* best effort */ }
              }
            }
          }
          emit("tool", hasVisualBlocks ? "Verification passed · visual charts rendered in chat" : "Verification passed · answered in chat (request names no file format)");
          return { verification: "none" };
        }

        const requestWantsVisuals = /\b(chart|charts|graph|graphs|diagram|diagrams|plot|plots|visual|visuals|visualization)\b/i.test(request);
        const mdFilesWithCharts: Array<{ path: string; charts: string[] }> = [];
        if (!hasVisualBlocks && (!homeRequestNamesFileFormat(request) || requestWantsVisuals)) {
          for (const file of freshFiles) {
            if (/\.(md|markdown|txt)$/i.test(file)) {
              try {
                const content = await fsPromises.readFile(path.join(projectRoot, file), "utf8");
                const chartMatches = content.match(/```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)[\s\S]*?```/gi);
                if (chartMatches?.length) {
                  mdFilesWithCharts.push({ path: file, charts: chartMatches });
                }
              } catch { /* ignore */ }
            }
          }
        }

        if (mdFilesWithCharts.length > 0 && currentRepairs < maxRepairs) {
          emit("tool", "Verification · graphs must be in the chat response, not inside an .md file");
          return {
            verification: "failed",
            repairs: currentRepairs + 1,
            verifyFeedback: `You placed charts/graphs inside ${mdFilesWithCharts.map((f) => f.path).join(", ")}, but graphs must be included DIRECTLY in your chat response so the user can see them rendered on screen! The chat interface natively renders \`\`\`bar, \`\`\`line, \`\`\`scatter, and \`\`\`mermaid blocks. Do not offload them to an .md file. Deliver the complete visual answer with the charts directly in chat now.`,
          };
        }
        const conversationalPromise = /\b(let me|i will|now i'll|i am going to|i'll now|going to write|next step is to)\b.{0,50}\b(write|create|generate|run|execute|build)\b/i.test(state.response || "");

        if (wantsDeliverable && (!createdDeliverable || !validatedDeliverable) && (conversationalPromise || currentRepairs < maxRepairs)) {
          if (currentRepairs < maxRepairs) {
            const validationDetails = [
              ...invalidArtifacts.map((check) => `${check.path} (${check.error || "invalid"})`),
              ...(missingFormats.length ? [`missing requested format${missingFormats.length > 1 ? "s" : ""}: ${missingFormats.map((format) => `.${format}`).join(", ")}`] : []),
            ];
            const validationNote = validationDetails.length
              ? ` Output validation failed: ${validationDetails.join("; ")}.`
              : " No new workspace output was created.";
            emit("tool", `Verification · output check failed.${validationNote}`);
            const failedSkills = loadedSkillNamesFromMessages(runMessages);
            const failedSkillsNote = failedSkills.length
              ? ` Skills already loaded this run — do NOT re-read any SKILL.md (${failedSkills.join(", ")}): go straight to write_file + execute.`
              : "";
            return {
              verification: "failed",
              verifyFeedback: `The request has an observable output contract, but the output is missing or failed validation.${validationNote} You are in AUTO mode: do NOT stop to talk or narrate future steps.${homeReadOnlyStreak >= 7 ? " The supervisor detected a prolonged read-only/research streak. Change strategy now and use the evidence already collected." : ""}${failedSkillsNote} Create or repair the requested result now, then inspect the created path and confirm it is readable. Do not perform another research/read-only action unless it is required to unblock creation.`,
            };
          }
        }

        if (validatedDeliverable) {
          emit("tool", `Verification passed · Deliverable created: ${freshFiles.join(", ")}`);
          return { verification: "passed" };
        }

        return wantsDeliverable
          ? { verification: "failed" }
          : { verification: "none" };
      }

      const currentRepairs = Number(state.repairs) || 0;
      const maxRepairs = MAX_REPAIRS[mode] ?? 1;

      // A denied or timed-out approval is a UI permission decision, not a
      // code problem: report skipped checks instead of sending the model
      // into "fix the dependency setup" repair loops over exit code 126.
      let anyVerificationCheckPassed = false;
      const requiredDeniedCommands: string[] = [];
      const skipIfApprovalDenied = (command: string, res: any, required = true): boolean => {
        if (!res?.approvalDenied) return false;
        if (required) requiredDeniedCommands.push(command);
        emit("tool", `Verification skipped · \`${command}\` was not approved`);
        return true;
      };

      // Diff-first, scoped to THIS run: compare against the baseline taken
      // before the agent worked. Files the run didn't touch (e.g. broken
      // edits left by an earlier interrupted run) must not trigger a
      // repair loop that hijacks a plain question. Q&A runs change zero
      // files, so they skip the typecheck + test cascade entirely.
      const diffFiles = await getWorkspaceDiffFiles(projectRoot);
      lastDiffFiles = diffFiles;
      const runDiff = diffFiles.filter((d) => initialDiff.get(d.path) !== diffFingerprint(d));
      if (runDiff.length === 0) {
        if (codeTaskContract?.expectsChanges && mode !== "plan" && currentRepairs < 1 && currentRepairs < maxRepairs) {
          emit("tool", "Verification · implementation required before completion");
          if (codeJournal) {
            queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
              tool: "supervisor",
              summary: "Blocked completion because the requested change has not been implemented",
              progressed: false,
              phase: "implementation",
            }));
          }
          return {
            verification: "failed",
            repairs: currentRepairs + 1,
            verifyFeedback: `The request asks for a repository change, but this run has not changed any files. Do not finish with an explanation or plan. Implement the smallest correct change now, then run the appropriate verification. If the request is genuinely blocked, state the exact blocker instead of claiming completion. This reminder is sent once — after it, an honest blocker explanation is accepted as the final answer.`,
          };
        }
        return { verification: "none" };
      }
      const changedPaths = runDiff.map((d) => d.path);
      const unfinishedPlan = Boolean(lastPlanItems?.some((item) => item.status !== "completed"));
      // Docs/assets-only diffs never need a typecheck: running a 30s+
      // `npm run check` for a README edit is pure "takes time, does nothing".
      const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|swift|vue|svelte)$/i;
      if (!changedPaths.some((p) => CODE_EXT.test(p))) {
        if (codeTaskContract?.expectsChanges && unfinishedPlan && currentRepairs < maxRepairs) {
          return {
            verification: "failed",
            repairs: currentRepairs + 1,
            verifyFeedback: "The current work unit changed files successfully, but the execution plan still has unfinished items. Continue with the next planned unit and update the todo plan before finishing.",
          };
        }
        return { verification: "passed" };
      }

      // 0. File-scoped fast path (opencode-style): small diffs lint only the
      // changed files. If it passes on a simple task, skip the full project
      // typecheck entirely.
      const scoped = pickFileScopedVerification(projectRoot, changedPaths);
      if (scoped) {
        emit("status", `Verifying changed files with \`${scoped}\``);
        const scopedResult = await runCommand(scoped);
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        const scopedOutput = String((scopedResult as any)?.output ?? "").trim();
        if ((scopedResult as any)?.exitCode !== 0 && !skipIfApprovalDenied(scoped, scopedResult, false)) {
          emit("tool", `Verification failed · ${scoped}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(scopedOutput));
          if (currentRepairs < maxRepairs && scopedOutput) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `The scoped check \`${scoped}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(scopedOutput)}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
        if (!(scopedResult as any)?.approvalDenied) {
          anyVerificationCheckPassed = true;
          emit("tool", `Verification passed · ${scoped}`);
          if (isSimple) return { verification: "passed" };
        }
      }

      // Fresh scaffold: package.json appeared and dependencies were never
      // installed. Install once, then verify with the production build
      // instead of a bare typecheck — a new app must compile before handoff.
      let staticCommand: string | null = null;
      {
        const root = path.resolve(projectRoot);
        const pm = detectPackageManager(root);
        const scaffolded = changedPaths.includes("package.json") && !existsSync(path.join(root, "node_modules"));
        if (scaffolded) {
          emit("status", `Installing dependencies for the new project (${pm.install})`);
          const installResult = await runCommand(pm.install);
          if (isCancelled() || signal?.aborted) throw new RunCancelledError();
          const installOutput = String((installResult as any)?.output ?? "").trim();
          if ((installResult as any)?.exitCode !== 0) {
            if (skipIfApprovalDenied(pm.install, installResult)) {
              // Without dependencies nothing downstream can run: end the
              // verification honestly instead of failing.
              return { verification: "none" };
            }
            emit("tool", `Verification failed · ${pm.install}`);
            if (currentRepairs < maxRepairs && installOutput) {
              return {
                repairs: currentRepairs + 1,
                verifyFeedback: `${pm.install} failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(installOutput)}\n\nFix the dependency setup (package.json, registry access, Node version), then summarize what you changed.`,
              };
            }
            return { verification: "failed" };
          }
          emit("tool", `Dependency installation completed · ${pm.install}`);
          try {
            const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
            if (typeof scripts.build === "string") staticCommand = `${pm.run} build`;
          } catch { /* fall through to default selection */ }
        }
      }

      // 1. Static/build checks. Projects may override the heuristic with
      // .nexus/verification.json or package.json.nexus.verification.commands.
      // P1: run them in parallel (cap 4) instead of serial fail-fast so a
      // typecheck + lint + test trio reports all failures in one repair pass.
      const affectedCommands = pickAffectedPackageCommands(projectRoot, changedPaths);
      const configuredCommands = staticCommand
        ? [staticCommand]
        : affectedCommands.length ? affectedCommands : pickVerificationCommands(projectRoot);
      const pickFormatterCommand = ((): string | null => {
        try {
          const root = path.resolve(projectRoot);
          const pkg = existsSync(path.join(root, "package.json"))
            ? JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
            : null;
          const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
          if (!deps.prettier && typeof pkg?.scripts?.format !== "string") return null;
          if (!changedPaths.some((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/i.test(p))) return null;
          const pmInner = detectPackageManager(root);
          if (typeof pkg?.scripts?.format === "string" && /check/i.test(String(pkg.scripts.format))) return `${pmInner.run} format`;
          if (deps.prettier) return `${pmInner.exec} prettier --check ${changedPaths.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/i.test(p)).slice(0, 5).map((f) => `"${f.replace(/"/g, "")}"`).join(" ")}`;
          return null;
        } catch {
          return null;
        }
      })();
      const verifyBatch = buildVerificationBatch(configuredCommands, pickFormatterCommand);
      if (verifyBatch.length > 1) {
        emit("status", `Verifying changes (${verifyBatch.length} checks in parallel)`);
        const settled = await Promise.allSettled(verifyBatch.map((cmd) => runCommand(cmd)));
        const failures: Array<{ command: string; output: string }> = [];
        settled.forEach((entry, index) => {
          const command = verifyBatch[index];
          if (isCancelled() || signal?.aborted) throw new RunCancelledError();
          if (entry.status === "rejected") {
            failures.push({ command, output: String((entry.reason as Error)?.message || entry.reason) });
            emit("tool", `Verification failed · ${command}`);
          } else {
            const output = String((entry.value as any)?.output ?? "").trim();
            if ((entry.value as any)?.exitCode !== 0) {
              if (skipIfApprovalDenied(command, entry.value, configuredCommands.includes(command))) return;
              failures.push({ command, output });
              emit("tool", `Verification failed · ${command}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(output));
            } else {
              if (configuredCommands.includes(command)) anyVerificationCheckPassed = true;
              emit("tool", `Verification passed · ${command}`);
            }
          }
        });
        if (failures.length > 0) {
          const combined = failures.map((f) => `### ${f.command}\n${extractDiagnosticFeedback(f.output)}`).join("\n\n").slice(0, VERIFY_OUTPUT_CAP);
          if (currentRepairs < maxRepairs) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `Parallel verification failed (${failures.length}/${verifyBatch.length}, repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${combined}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
      } else if (verifyBatch.length > 0) for (const verificationCommand of verifyBatch) {
        const required = configuredCommands.includes(verificationCommand);
        emit("status", `Verifying changes with \`${verificationCommand}\``);
        const result = await runCommand(verificationCommand);
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        const output = String((result as any)?.output ?? "").trim();
        if ((result as any)?.exitCode !== 0) {
          if (skipIfApprovalDenied(verificationCommand, result, required)) continue;
          emit("tool", `Verification failed · ${verificationCommand}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(output));
          if (currentRepairs < maxRepairs && output) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `The verification command \`${verificationCommand}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(output)}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
        if (required) anyVerificationCheckPassed = true;
        emit("tool", `Verification passed · ${verificationCommand}`);
      }

      if (requiredDeniedCommands.length) {
        emit("status", `Verification incomplete — approval was denied for required checks: ${requiredDeniedCommands.join(", ")}`);
        return { verification: "none" };
      }

      // 2. Targeted test detection for modified files (reuse the diff above)
      const targetTestCmd = findTargetedTests(projectRoot, changedPaths);
      if (targetTestCmd) {
        emit("status", `Running targeted test \`${targetTestCmd}\``);
        const testResult = await runCommand(targetTestCmd);
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        const testOutput = String((testResult as any)?.output ?? "").trim();
        if ((testResult as any)?.exitCode !== 0) {
          if (skipIfApprovalDenied(targetTestCmd, testResult, true)) {
            // Skipped, not failed — approval is a user decision.
          } else {
            emit("tool", `Targeted test failed · ${targetTestCmd}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(testOutput));
            if (currentRepairs < maxRepairs && testOutput) {
              return {
                repairs: currentRepairs + 1,
                verifyFeedback: `Targeted test \`${targetTestCmd}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(testOutput)}\n\nFix the code to pass this test.`,
              };
            }
            return { verification: "failed" };
          }
        } else {
          anyVerificationCheckPassed = true;
          emit("tool", `Targeted test passed · ${targetTestCmd}`);
        }
      }

      // Auto mode gets one bounded, read-only review after verification and
      // before completion. Blocking findings return the task to implementation.
      if (shouldRunCodeReview({
        agentsEnabled: assetsEnabled("agents"),
        mode,
        expectsChanges: Boolean(codeTaskContract?.expectsChanges),
        currentRepairs,
        maxRepairs,
      })) {
        emit("status", "Reviewing the completed work with a read-only reviewer…");
        if (codeJournal) {
          queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
            tool: "code-reviewer",
            summary: `Reviewing ${changedPaths.length} changed file${changedPaths.length === 1 ? "" : "s"}`,
            progressed: true,
            phase: "review",
            changedFiles: changedPaths,
          }));
        }
        const review = await executeSubagentTask({
          role: "code-reviewer",
          task: `Review only this run's changes. Changed paths:\n${changedPaths.slice(0, 40).join("\n")}\n\nCheck correctness, regressions, error handling, security, and incomplete acceptance criteria. Report each finding on its own line in exactly this format:\nSEVERITY | path | issue\nwhere SEVERITY is CRITICAL, HIGH, MEDIUM, or LOW. If there are no blocking issues, reply with exactly "No blocking findings." Do not edit files.`,
          projectRoot,
          provider,
          modelName,
          projectRecord: { id: "current", name: "current", root: projectRoot },
          mcpTools: [],
          skills: skillDirs,
          skillsBackend: compositeBackend,
          onEvent: (subEvent) => {
            usage.addSubagent(subEvent.subagent.usage);
            emit("subagent", subEvent.type === "subagent_start" ? "Delegated read-only code review" : subEvent.type === "subagent_finish" ? "Read-only code review completed" : "Code reviewer working…", undefined, undefined, subEvent.subagent);
          },
          isCancelled,
          runId: sessionId,
        });
        // Only explicitly formatted finding lines count as blocking (parser
        // unit-tested in code-task.test.mjs). A bare "CRITICAL"/"HIGH"
        // mention in prose must not trigger a repair loop.
        const blockingFindings = parseBlockingReviewFindings(review);
        if (blockingFindings.length > 0) {
          return {
            verification: "failed",
            repairs: currentRepairs + 1,
            verifyFeedback: `The read-only code review found blocking findings. Fix them before finishing:\n\n${blockingFindings.slice(0, 6).join("\n\n")}\n\nRe-run verification after the fixes.`,
          };
        }
      }

      if (codeTaskContract?.expectsChanges && unfinishedPlan && currentRepairs < maxRepairs) {
        const remaining = lastPlanItems!
          .filter((item) => item.status !== "completed")
          .slice(0, 8)
          .map((item) => `- ${item.content} (${item.status})`)
          .join("\n");
        emit("tool", "Verification · work remains in the execution plan");
        if (codeJournal) {
          queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
            tool: "supervisor",
            summary: "Verification passed for the current work unit; continuing with unfinished plan items",
            progressed: true,
            phase: "implementation",
          }));
        }
        return {
          verification: "failed",
          repairs: currentRepairs + 1,
          verifyFeedback: `The current work unit passed verification, but the execution plan is not complete. Continue with the next unfinished work unit instead of finishing early. Remaining plan items:\n${remaining}\n\nUpdate the todo plan as each unit is completed, then verify again.`,
        };
      }
      return {
        verification: codeVerificationOutcome({
          passedCheck: anyVerificationCheckPassed,
          requiredCheckDenied: requiredDeniedCommands.length > 0,
        }),
      };
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
  // Budget exhaustion is a pause, not a stop: a run that was making progress
  // auto-resumes from the furthest complete superstep with a fresh budget
  // until the task finishes. Bounded by MAX_BUDGET_EXTENSIONS so a wandering
  // model cannot burn API spend forever; the doom-loop breaker and a user
  // cancel still stop the run immediately.
  const MAX_BUDGET_EXTENSIONS = 10;
  let budgetExtensions = 0;
  try {
    result = await graph.invoke({ projectRoot, request }, { recursionLimit: outerLimit, signal });
  } catch (error) {
    let runError: unknown = error;
    for (;;) {
      const isCancel = runError instanceof RunCancelledError || (runError as any)?.name === "AbortError" || isCancelled() || signal?.aborted;
      if (isCancel) {
        saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
        await finishRunJournals("interrupted");
        throw new RunCancelledError();
      }
      const isDoom = runError instanceof DoomLoopError || (runError as any)?.name === "DoomLoopError";
      const isBudget = isRecursionLimitError(runError);
      // Misclassified simple tasks die at the 50-step wall; every budget hit
      // (simple or complex) just extends in place. Tools stay simple-scoped,
      // but the verify node flips to the full cascade via isSimple below.
      if (result !== undefined || !isBudget || isDoom || budgetExtensions >= MAX_BUDGET_EXTENSIONS) break;
      budgetExtensions++;
      if (effectiveComplexity === "simple") {
        effectiveComplexity = "complex";
        isSimple = false;
      }
      recursionLimit = MODE_LIMITS[mode];
      outerLimit = Math.max(recursionLimit, 50);
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      emit("status", `Step budget reached — extending automatically (${budgetExtensions}/${MAX_BUDGET_EXTENSIONS}) and continuing from where the run stopped…`);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: `Recursion limit hit at ${outerLimit}; auto-extended budget ${budgetExtensions}/${MAX_BUDGET_EXTENSIONS}.` });
      // The model must not have to infer that it should continue: the pruned
      // checkpoint can end on a tool result, so say it explicitly.
      runMessages = [...runMessages, new HumanMessage("[System Note: The step budget was extended automatically. All preceding tool actions are complete. Continue the task directly from where it stopped — do not repeat completed steps or re-read files you already inspected.]")];
      try {
        result = await graph.invoke({ projectRoot, request }, { recursionLimit: outerLimit, signal });
      } catch (retryError) {
        runError = retryError;
      }
    }
    if (result === undefined) {
      const retryIsDoom = runError instanceof DoomLoopError || (runError as any)?.name === "DoomLoopError";
      if (!isRecursionLimitError(runError) && !retryIsDoom) {
        // Unexpected run failure: still checkpoint so "continue" resumes THIS
        // task instead of a stale one, and record the journals as failed.
        saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
        await finishRunJournals("failed");
        throw runError;
      }
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      await finishRunJournals("interrupted");
      const planSummary = lastPlanItems?.length
        ? `\n\nWorking plan so far:\n${lastPlanItems.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
        : "";
      const doomTool = retryIsDoom ? (runError as DoomLoopError).toolName || "tool" : null;
      const budgetNote = budgetExtensions > 0
        ? ` I extended the step budget ${budgetExtensions} time${budgetExtensions === 1 ? "" : "s"} automatically before pausing.`
        : "";
      const partial = retryIsDoom
        ? `I got stuck repeating the same ${doomTool} call without making progress, so I stopped instead of looping forever. Progress is checkpointed — say "continue" and I will resume with a different approach.${planSummary}`
        : `I paused because this run used its entire step budget${budgetNote}. Progress is checkpointed — say "continue" and I will resume from where I stopped instead of restarting.${planSummary}`;
      emit("error", retryIsDoom ? `Stuck repeating ${doomTool} — stopped to avoid an infinite loop after ${toolCallCount} tool calls. Say "continue" to resume differently.` : `Step budget exhausted after ${budgetExtensions} automatic extension${budgetExtensions === 1 ? "" : "s"} (${outerLimit} graph steps; ${toolCallCount} tool calls). Progress saved — say "continue" to resume.`);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: retryIsDoom ? `Doom-loop breaker fired on ${doomTool}; checkpoint saved for resume.` : `Recursion limit hit at ${outerLimit} after ${budgetExtensions} extensions; checkpoint saved for resume.` });
      const partialUsage = usage.finalize(modelName, estimatedFallbackInputTokens, 0);
      if (hooks.length) void dispatchHooks(projectRoot, hooks, "run:end", { request, mode, projectRoot, runId: sessionId, verification: "interrupted" }).catch(() => undefined);
      return {
        response: partial,
        verification: "interrupted",
        memoryEntry: `Task: ${tail(request, 200)} | Result: ${retryIsDoom ? `interrupted in a repeated-${doomTool} loop` : "interrupted at step budget"}; resumable via continue. (Details in chat transcript.)`,
        usage: partialUsage,
        artifact: undefined,
        projectMemoryLogEntry: `Interrupted work (${new Date().toISOString().slice(0, 10)}): ${tail(request, 200)}`,
        memoryCandidates: [] as MemoryCandidate[],
        interrupted: true as const,
      };
    }
  }
  // The sentinel is routing information for the verifier, never user-facing
  // content: strip it before the response reaches transcript, memory, or artifacts.
  if (result?.response) {
    result.response = String(result.response).replace(/\s*\[\[answer-in-chat\]\]\s*$/i, "");
  }
  // Never let final prose override an unmet Home output contract. A failed
  // run can still be resumed, but it must be reported as incomplete.
  const homeFreshFiles = isGeneral && homeTaskContract?.expectsOutput
    ? await findFreshHomeFiles(projectRoot, initialHomeFiles, runStartMs)
    : [];

  // Ensure visual charts are in the chat response: if the model placed charts inside an unrequested
  // .md file instead of the response, extract the chart blocks and embed them directly in the chat response.
  if (isGeneral && result?.response) {
    let hasVisualBlocks = /```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)\b/i.test(result.response);
    const requestWantsVisuals = /\b(chart|charts|graph|graphs|diagram|diagrams|plot|plots|visual|visuals|visualization)\b/i.test(request);
    if (!homeRequestNamesFileFormat(request) || requestWantsVisuals) {
      for (let i = homeFreshFiles.length - 1; i >= 0; i--) {
        const file = homeFreshFiles[i];
        if (/\.(md|markdown|txt)$/i.test(file)) {
          try {
            const content = await fsPromises.readFile(path.join(projectRoot, file), "utf8");
            const chartMatches = content.match(/```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)[\s\S]*?```/gi);
            if (chartMatches?.length) {
              if (!hasVisualBlocks) {
                result.response = `${result.response.trim()}\n\n${chartMatches.join("\n\n")}`;
                hasVisualBlocks = true;
              }
              if (!homeRequestNamesFileFormat(request)) {
                await fsPromises.unlink(path.join(projectRoot, file)).catch(() => {});
                homeFreshFiles.splice(i, 1);
              }
            }
          } catch { /* best effort */ }
        }
      }
    }
    if (hasVisualBlocks && !homeRequestNamesFileFormat(request) && result.verification === "failed") {
      result.verification = "none";
    }
  }

  const homeArtifactContract = await validateHomeArtifactContract(projectRoot, homeFreshFiles, homeTaskContract?.expectedFormats);
  const homeInvalidArtifacts = homeArtifactContract.invalidArtifacts;
  const homeMissingFormats = homeArtifactContract.missingFormats;
  if (isGeneral && homeTaskContract?.expectsOutput && result?.verification === "failed") {
    const freshFiles = homeFreshFiles;
    if (freshFiles.length === 0 || homeInvalidArtifacts.length > 0 || homeMissingFormats.length > 0) {
      const details = [
        ...(freshFiles.length === 0 ? ["no new workspace artifact was created"] : []),
        ...homeInvalidArtifacts.map((check) => `${check.path} (${check.error || "invalid"})`),
        ...(homeMissingFormats.length ? [`missing requested format${homeMissingFormats.length > 1 ? "s" : ""}: ${homeMissingFormats.map((format) => `.${format}`).join(", ")}`] : []),
      ];
      const detail = `Output validation failed: ${details.join("; ")}.`;
      result.response = `I could not complete the requested output in this run. ${detail} The work is checkpointed; say "continue" to resume from the last completed step.`;
      emit("error", `Home task incomplete · ${detail}`);
    }
  }
  if (homeJournal) {
    const journalWithOutputs = homeFreshFiles.length
      ? recordHomeTaskAction(homeJournal, {
          tool: "workspace",
          summary: `Detected ${homeFreshFiles.length} output file${homeFreshFiles.length === 1 ? "" : "s"}`,
          progressed: true,
          phase: "validation",
          outputs: homeFreshFiles,
        })
      : homeJournal;
    const status = result?.verification === "failed"
      ? "blocked"
      : result?.verification === "interrupted"
        ? "interrupted"
        : "completed";
    queueHomeJournalWrite(finishHomeTaskJournal(journalWithOutputs, status, status === "completed" ? "complete" : "blocked"));
    await homeJournalWrite;
  }
  if (codeJournal) {
    // Repairs exhausted with verification still failing = blocked on human
    // input, not a crash. Hard failures write "failed" via finishRunJournals.
    queueCodeJournalWrite(finishCodeTaskJournal(codeJournal, result?.verification === "failed" ? "blocked" : "completed"));
    await codeJournalWrite;
  }
  // Checkpoint the completed run so a follow-up "continue" can build on the
  // full tool history, not just the text transcript.
  const ledgerFiles = (lastDiffFiles || []).map((entry: any) => String(entry?.path || entry?.file || "")).filter(Boolean);
  saveLastRunCheckpoint(sessionId, {
    messages: sanitizeResumeCheckpoint(runMessages),
    planItems: lastPlanItems,
    ledger: {
      updatedAt: new Date().toISOString(),
      planItems: lastPlanItems,
      completedSteps: summarizeCompletedSteps(runMessages),
      lastDiagnostics: [String(result?.response || "")].filter((text) => /error|failed|blocked|verification/i.test(text)).slice(-4),
      changedFiles: ledgerFiles,
      verification: result?.verification === "passed" || result?.verification === "failed" || result?.verification === "interrupted" ? result.verification : "none",
    },
  }, targetTelemetryRoot);
  // When no provider reported usage metadata, fall back to character-based
  // estimates for the streamed text so token counts are never zero.
  const fallbackOutputTokens = unaccountedOutputChars > 0 ? Math.max(1, estimateTokens("x".repeat(unaccountedOutputChars))) : 0;
  const finalUsage = usage.finalize(modelName, estimatedFallbackInputTokens, fallbackOutputTokens);
  emit("assistant", result.response, undefined, finalUsage);
  emit("usage", `Token usage · ${finalUsage.totalTokens} tokens${finalUsage.estimatedCost == null ? "" : ` (~$${finalUsage.estimatedCost})`}`, undefined, finalUsage);

  if (hooks.length) {
    const hookEvent = result?.verification === "failed" ? "verify:fail" : "run:end";
    void dispatchHooks(projectRoot, hooks, hookEvent, {
      request, mode, projectRoot, runId: sessionId,
      verification: result?.verification ?? "none",
      response: tail(String(result?.response ?? ""), 2000),
    }).catch(() => undefined);
  }

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

  // Semantic candidates for Home long-term memory: one cheap extraction call
  // proposing durable profile/preference/fact items. Transient data (tables,
  // lists, numbers) is filtered by parseCandidateFacts. Best-effort, never
  // fails the run; main auto-applies them with a visible notice (the user
  // can forget any item in the Memory tab).
  let memoryCandidates: MemoryCandidate[] = [];
  if (isGeneral && mode !== "plan") {
    try {
      const responseText = String(result.response || "");
      const requestText = String(request || "").trim();
      if (shouldExtractMemory(requestText, responseText)) {
        const extractPrompt =
          `Extract durable long-term memory candidates from this assistant turn. ` +
          `Return JSON ONLY: {"candidates":[{"category":"profile|preference|fact|context","fact":"..."}]}. ` +
          `Rules: at most 3 candidates; each fact one sentence, 8-200 chars, enduring (identity, role, lasting preference, stable personal fact, ongoing project goal). ` +
          `NEVER include transient data: greetings, tables, lists, counts, URLs, file names, numbers from tool output, or anything already answered in full. ` +
          `Return {"candidates":[]} when nothing is worth remembering.\n\n` +
          `User: ${requestText.slice(0, 800)}\nAssistant: ${responseText.slice(0, 2500)}`;
        const raw: any = await Promise.race([
          Promise.resolve(llm.invoke(extractPrompt)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("memory extract timeout")), 20000)),
        ]);
        const content = typeof raw?.content === "string"
          ? raw.content
          : Array.isArray(raw?.content)
            ? raw.content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("\n")
            : String(raw?.content || raw?.text || "");
        memoryCandidates = parseCandidateFacts(content);
      }
    } catch { /* extraction is best-effort */ }
  }

  return {
    // Session memory is a compact pointer, NOT a transcript copy: the full
    // answer lives in chat history. Tables/lists are never duplicated here.
    response: result.response as string,
    verification: (result.verification as string) || "none",
    memoryEntry: `Task: ${tail(request, 200)} | Result: ${firstMeaningfulLine(result.response as string, 160)} | Verification: ${(result.verification as string) || "none"} (details in chat transcript)`,
    usage: finalUsage,
    artifact,
    projectMemoryLogEntry: `Recent work (${new Date().toISOString().slice(0, 10)}): ${tail(request, 200)} → ${firstMeaningfulLine(result.response as string, 200)}`,
    memoryCandidates,
  };
}
