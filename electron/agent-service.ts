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
import { createSubagentDelegationTool, executeSubagentTask, calculateAgentUsage, type SubagentItem } from "./subagent-service.js";
import { getWorkspaceDiffFiles } from "./diff-service.js";
import { getMcpTools } from "./mcp-service.js";
import { getSkillsConfig } from "./store.js";
import { GLOBAL_SKILLS_ROUTE, PROJECT_SKILLS_DIR, SKILL_SOURCE_PRIORITY, SYSTEM_SKILLS_ROUTE, buildSkillMounts, createSkillFilesTool, globalSkillsDir, listSkills, listSystemSkills, recommendSkills, skillAppliesToMode, skillDirVirtualPath, skillVirtualPath, systemSkillsDir, type SkillInfo, type SkillMode } from "./skills-service.js";
import { compactHistory, compactHistoryWithModel, estimateTokens, StreamUsageTracker } from "./context-service.js";
import { saveArtifact, type ArtifactItem } from "./artifacts-service.js";
import { TrajectoryLogger } from "./trajectory-service.js";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint } from "./rate-limit.js";
import { RunCancelledError, getRunAbortSignal } from "./command-service.js";
import { createHomeMemoryTool, addMemoryFact, removeMemoryFactWithCount, selectRelevantHomeMemory, parseCandidateFacts, shouldExtractMemory, type MemoryCandidate } from "./home-memory-service.js";
import { createHomeTaskJournal, finishHomeTaskJournal, recordHomeTaskAction, saveHomeTaskJournal, type HomeTaskJournal, type HomeTaskPhase } from "./home-task-service.js";
import { selectHomeArtifactCandidates, validateHomeArtifacts } from "./home-artifact-service.js";
import { createCodeTaskJournal, finishCodeTaskJournal, inferCodeTaskContract, loadCodeTaskJournal, parseBlockingReviewFindings, recordCodeTaskAction, recordCodeTaskPlan, saveCodeTaskJournal, type CodeTaskContract, type CodeTaskJournal, type CodeTaskPhase } from "./code-task-service.js";
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
  type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact" | "stream-reset";
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
export { RunCancelledError };

/**
 * Generic contract inferred from a Home request. This deliberately does not
 * classify formats or domains (PDF, courses, reports, etc.). It only captures
 * whether the user asked the agent to produce an observable result and whether
 * research is part of the request. The model remains responsible for deciding
 * what the result should be and how to produce it.
 */
export type HomeTaskContract = {
  expectsOutput: boolean;
  needsResearch: boolean;
};

export function inferHomeTaskContract(request: string): HomeTaskContract {
  const text = (request || "").trim();
  // Polite wrappers ("can you create a report") are requests, not questions:
  // strip them so the creation-verb test sees the actual instruction. Genuine
  // interrogatives ("how do I…", "should I…") still never expect output.
  const stripped = text.replace(/^\s*(?:please|can\s+you|could\s+you|would\s+you|will\s+you)\s+/i, "").trim();
  // "I need to understand…" is intent, not a deliverable; "I need a report" is.
  const expectsOutput =
    /\b(create|make|generate|build|write|draft|prepare|produce|export|save|deliver|develop|design|turn|convert|transform|need|want|give\s+me)\b/i.test(stripped) &&
    !/\b(?:need|want)\s+to\b/i.test(stripped) &&
    !/^\s*(what|why|how|where|when|which|who|should)\b/i.test(stripped);
  const needsResearch = /\b(research|read|docs?|documentation|investigate|look\s+up|find\s+out|compare|sources?|latest|current)\b/i.test(stripped);
  return { expectsOutput, needsResearch };
}

const HOME_FORMAT_NAMED_PATTERN =
  /\.(docx|xlsx|pptx|ppsx|pdf|csv|odt|ods|odp|tex|txt|md)\b|\b(word|excel|powerpoint|ppt|spreadsheet|presentation|slides?|slide\s*deck|document|docs?\b|pdf|latex|resume|cv)\b/i;

/**
 * True when the request explicitly names a file format or document type.
 * Such requests can never use the [[answer-in-chat]] escape: if the user
 * named the format, a file IS the deliverable.
 */
export function homeRequestNamesFileFormat(request: string): boolean {
  return HOME_FORMAT_NAMED_PATTERN.test(request || "");
}

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
const PROJECT_MEMORY_RUN_LOG_CAP = 20;

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

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
export type PackageManager = { name: PackageManagerName; run: string; exec: string; install: string; testFile: (rel: string) => string };

/**
 * Detect the JS/TS package manager from explicit config first, then
 * lockfiles. Order matters: pnpm-lock.yaml / yarn.lock / bun.lock[b] win
 * over package-lock.json so monorepos with multiple lockfiles resolve to
 * the most specific one present.
 */
export function detectPackageManager(projectRoot: string): PackageManager {
  const fallback: PackageManager = {
    name: "npm",
    run: "npm run",
    exec: "npx",
    install: "npm install",
    testFile: (rel: string) => `npm test -- ${rel}`,
  };
  try {
    const root = path.resolve(projectRoot);
    // Explicit override: .nexus/package-manager.json { "name": "pnpm" } or
    // NEXUS_PACKAGE_MANAGER env (useful for tests / containers).
    const envName = (process.env.NEXUS_PACKAGE_MANAGER || "").toLowerCase();
    const overridePath = path.join(root, ".nexus", "package-manager.json");
    let override: string | null = null;
    if (existsSync(overridePath)) {
      try {
        override = String(JSON.parse(readFileSync(overridePath, "utf8"))?.name || "").toLowerCase();
      } catch { /* ignore malformed override */ }
    }
    const pick = (name: string): PackageManager | null => {
      if (name === "pnpm") return { name: "pnpm", run: "pnpm", exec: "pnpm exec", install: "pnpm install", testFile: (rel: string) => `pnpm test -- ${rel}` };
      if (name === "yarn") return { name: "yarn", run: "yarn", exec: "yarn exec", install: "yarn install", testFile: (rel: string) => `yarn test -- ${rel}` };
      if (name === "bun") return { name: "bun", run: "bun run", exec: "bunx", install: "bun install", testFile: (rel: string) => `bun test ${rel}` };
      if (name === "npm") return fallback;
      return null;
    };
    const fromEnv = envName ? pick(envName) : null;
    if (fromEnv) return fromEnv;
    const fromFile = override ? pick(override) : null;
    if (fromFile) return fromFile;
    // package.json packageManager field: "pnpm@9.1.0", "yarn@4", "bun@1".
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pmField = String(JSON.parse(readFileSync(pkgPath, "utf8"))?.packageManager || "").toLowerCase();
        if (pmField.startsWith("pnpm")) return pick("pnpm")!;
        if (pmField.startsWith("yarn")) return pick("yarn")!;
        if (pmField.startsWith("bun")) return pick("bun")!;
        if (pmField.startsWith("npm")) return fallback;
      } catch { /* ignore */ }
    }
    if (existsSync(path.join(root, "pnpm-lock.yaml"))) return pick("pnpm")!;
    if (existsSync(path.join(root, "yarn.lock"))) return pick("yarn")!;
    if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return pick("bun")!;
    return fallback;
  } catch {
    return fallback;
  }
}

export function pickVerificationCommand(projectRoot: string): string | null {
  try {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
      // Named typecheck scripts are the source of truth; `check` scripts often
      // cover more tsconfigs than a bare `tsc --noEmit` would (multiple
      // projects), so prefer them over running tsc directly.
      if (typeof scripts.typecheck === "string") return `${pm.run} typecheck`;
      if (typeof scripts.check === "string") return `${pm.run} check`;
      if (existsSync(path.join(root, "tsconfig.json"))) return `${pm.exec} --no-install tsc --noEmit`;
      if (typeof scripts.lint === "string") return `${pm.run} lint`;
    }

    if (existsSync(path.join(root, "Cargo.toml"))) return "cargo check";
    if (existsSync(path.join(root, "go.mod"))) return "go vet ./...";
    // JVM: Maven first, then Gradle (wrapper preferred when checked in).
    if (existsSync(path.join(root, "pom.xml"))) return "mvn -q test";
    if (
      existsSync(path.join(root, "build.gradle")) ||
      existsSync(path.join(root, "build.gradle.kts")) ||
      existsSync(path.join(root, "settings.gradle")) ||
      existsSync(path.join(root, "settings.gradle.kts"))
    ) {
      if (process.platform === "win32" && existsSync(path.join(root, "gradlew.bat"))) return "gradlew.bat build";
      if (existsSync(path.join(root, "gradlew"))) return "./gradlew build";
      return "gradle build";
    }
    // .NET: any SDK-style project or solution at the root.
    try {
      const entries = readdirSync(root);
      if (entries.some((name) => /\.(csproj|fsproj|sln)$/i.test(name))) return "dotnet test";
    } catch { /* fall through to Python */ }
    // Python: Django check, then pytest when tests are present, then ruff,
    // then a dependency-free syntax compile as last resort.
    if (existsSync(path.join(root, "manage.py"))) return "python manage.py check";
    if (
      existsSync(path.join(root, "pytest.ini")) ||
      existsSync(path.join(root, "tox.ini")) ||
      existsSync(path.join(root, "tests")) ||
      existsSync(path.join(root, "test"))
    ) return "pytest -q";
    if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "ruff.toml"))) return "ruff check";
    if (
      existsSync(path.join(root, "requirements.txt")) ||
      existsSync(path.join(root, "setup.py")) ||
      existsSync(path.join(root, "setup.cfg")) ||
      existsSync(path.join(root, "Pipfile")) ||
      existsSync(path.join(root, "poetry.lock"))
    ) return "python -m compileall -q .";
    return null;
  } catch {
    return null;
  }
}

/**
 * Project-level verification override. A repository may provide
 * `.nexus/verification.json` with `{ "commands": ["npm run check", "npm test"] }`
 * or the same object under `package.json.nexus.verification`. This keeps the
 * safe heuristics as a fallback while letting projects define their real build
 * and integration gates.
 */
export function pickVerificationCommands(projectRoot: string): string[] {
  try {
    const root = path.resolve(projectRoot);
    const candidates = [path.join(root, ".nexus", "verification.json")];
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg?.nexus?.verification) candidates.push("package.json:nexus.verification");
      for (const candidate of candidates) {
        const raw = candidate === "package.json:nexus.verification" ? pkg.nexus.verification : JSON.parse(readFileSync(candidate, "utf8"));
        const commands = Array.isArray(raw) ? raw : raw?.commands;
        if (Array.isArray(commands)) {
          const valid = commands.filter((command: unknown): command is string => typeof command === "string" && Boolean(command.trim())).map((command) => command.trim()).slice(0, 8);
          if (valid.length) return valid;
        }
      }
    } else if (existsSync(candidates[0])) {
      const raw = JSON.parse(readFileSync(candidates[0], "utf8"));
      const commands = Array.isArray(raw) ? raw : raw?.commands;
      if (Array.isArray(commands)) return commands.filter((command: unknown): command is string => typeof command === "string" && Boolean(command.trim())).map((command) => command.trim()).slice(0, 8);
    }
  } catch { /* invalid configuration falls back to detection */ }
  const fallback = pickVerificationCommand(projectRoot);
  return fallback ? [fallback] : [];
}

/**
 * Finds package-local verification commands for changed files in a workspace.
 * Commands use the package manager's prefix/filter mechanism so the caller
 * can execute them from the repository root without changing process cwd.
 */
export function pickAffectedPackageCommands(projectRoot: string, modifiedFiles: string[]): string[] {
  try {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const commands: string[] = [];
    const seen = new Set<string>();
    for (const modified of modifiedFiles) {
      let directory = path.dirname(path.resolve(root, modified));
      while (directory.startsWith(root) && directory !== path.dirname(root)) {
        const packagePath = path.join(directory, "package.json");
        if (existsSync(packagePath)) {
          const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
          const relative = path.relative(root, directory).replace(/\\/g, "/") || ".";
          const scripts = pkg?.scripts || {};
          for (const name of ["check", "typecheck", "build", "test"]) {
            if (typeof scripts[name] !== "string") continue;
            const command = relative === "."
              ? `${pm.run} ${name}`
              : pm.name === "pnpm"
                ? `pnpm --dir "${relative}" run ${name}`
                : pm.name === "yarn"
                  ? `yarn --cwd "${relative}" run ${name}`
                  : pm.name === "bun"
                    ? `bun --cwd "${relative}" run ${name}`
                    : `npm --prefix "${relative}" run ${name}`;
            if (!seen.has(command)) { seen.add(command); commands.push(command); }
            break;
          }
          break;
        }
        directory = path.dirname(directory);
      }
      if (commands.length >= 8) break;
    }
    return commands.slice(0, 8);
  } catch {
    return [];
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
    const pm = detectPackageManager(root);
    const quoted = modifiedFiles.map((f) => `"${f.replace(/"/g, "")}"`).join(" ");
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const devDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const hasEslint = Boolean(devDeps.eslint || typeof pkg.scripts?.lint === "string");
      if (hasEslint) return `${pm.exec} eslint ${quoted}`;
      return null;
    }
    // Python-only change with a ruff config: lint just the touched files.
    if (
      modifiedFiles.length > 0 &&
      modifiedFiles.every((f) => f.endsWith(".py")) &&
      (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "ruff.toml")))
    ) {
      return `ruff check ${quoted}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function findTargetedTests(projectRoot: string, modifiedFiles: string[]): string | null {
  try {
    const root = path.resolve(projectRoot);
    const pm = detectPackageManager(root);
    const hasPackageJson = existsSync(path.join(root, "package.json"));
    let hasTestScript = false;
    if (hasPackageJson) {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      hasTestScript = typeof pkg.scripts?.test === "string";
    }

    const hasPom = existsSync(path.join(root, "pom.xml"));
    const hasGradle =
      existsSync(path.join(root, "build.gradle")) ||
      existsSync(path.join(root, "build.gradle.kts")) ||
      existsSync(path.join(root, "settings.gradle")) ||
      existsSync(path.join(root, "settings.gradle.kts"));
    let hasDotnet = false;
    try {
      hasDotnet = readdirSync(root).some((name) => /\.(csproj|fsproj|sln)$/i.test(name));
    } catch { /* ignore */ }

    // Heuristic: check if any modified file has a corresponding test file
    for (const file of modifiedFiles) {
      const parsed = path.parse(file);
      const candidates = [
        path.join(root, parsed.dir, `${parsed.name}.test${parsed.ext}`),
        path.join(root, parsed.dir, `${parsed.name}.spec${parsed.ext}`),
        path.join(root, "test", `${parsed.name}.test${parsed.ext}`),
        path.join(root, "tests", `test_${parsed.name}${parsed.ext}`),
      ];
      // Java: Foo.java <-> FooTest.java in the same package or under src/test.
      if (parsed.ext === ".java") {
        candidates.push(
          path.join(root, parsed.dir, `${parsed.name}Test.java`),
          path.join(root, parsed.dir, `Test${parsed.name}.java`),
        );
      }
      for (const cand of candidates) {
        if (existsSync(cand)) {
          const rel = path.relative(root, cand).replace(/\\/g, "/");
          if (hasTestScript) return pm.testFile(rel);
          if (parsed.ext === ".py") return `pytest ${rel}`;
          if (parsed.ext === ".rs") return `cargo test ${parsed.name}`;
          if (parsed.ext === ".go") return `go test ./${path.dirname(rel)}`;
          if (parsed.ext === ".java") {
            const testClass = path.basename(cand, ".java");
            if (hasPom) return `mvn -q -Dtest=${testClass} test`;
            if (hasGradle) return `gradle test --tests "*${testClass}*"`;
          }
          if (parsed.ext === ".cs" && hasDotnet) return "dotnet test";
          return null;
        }
      }
      // .NET without a colocated test file: a test run still validates the change.
      if (parsed.ext === ".cs" && hasDotnet) return "dotnet test";
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

export function extractSkillNameFromPath(filePath: string): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, "/");
  const skillMdMatch = normalized.match(/(?:^|\/)([a-zA-Z0-9_-]+)\/SKILL\.md$/i);
  if (skillMdMatch) return skillMdMatch[1];

  const prefixMatch = normalized.match(/(?:system-skills|global-skills|\.nexus\/skills)\/(?:[a-zA-Z0-9_-]+\/)?([a-zA-Z0-9_-]+)/i);
  if (prefixMatch) {
    const candidate = prefixMatch[1];
    if (!/^SKILL$/i.test(candidate)) return candidate;
  }

  const skillsMatch = normalized.match(/\/skills\/([a-zA-Z0-9_-]+)/i);
  if (skillsMatch && !/^SKILL$/i.test(skillsMatch[1])) return skillsMatch[1];

  return null;
}

/**
 * Skill names already loaded in this run, derived from tool-call history.
 * Used in repair/resume feedback so the model is told exactly which skills
 * need no re-reading (the middleware enforces the same at execution time).
 */
export function loadedSkillNamesFromMessages(messages: any[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const scanArgs = (args: unknown) => {
    if (!args || typeof args !== "object") return;
    const a = args as Record<string, unknown>;
    const file = String(a.file_path || a.filePath || a.file || a.path || "");
    if (!file) return;
    const skill = extractSkillNameFromPath(file);
    if (skill && !seen.has(skill.toLowerCase())) {
      seen.add(skill.toLowerCase());
      names.push(skill);
    }
  };
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    const direct = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(direct)) {
      for (const call of direct) scanArgs((call as { args?: unknown })?.args);
    }
    const extra = (message as { additional_kwargs?: { tool_calls?: unknown } }).additional_kwargs?.tool_calls;
    if (Array.isArray(extra)) {
      for (const call of extra) {
        const fnArgs = (call as { function?: { arguments?: unknown } })?.function?.arguments;
        if (typeof fnArgs === "string") {
          try {
            scanArgs(JSON.parse(fnArgs));
          } catch { /* ignore unparseable */ }
        } else {
          scanArgs((call as { args?: unknown })?.args);
        }
      }
    }
  }
  return names;
}

export function describeToolCall(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Backend tools use `file_path`; custom tools use `filePath`.
  const file = str(args.file_path || args.filePath || args.file || args.path);
  switch (name) {
    case "read_file": {
      if (!file) return "";
      const skill = extractSkillNameFromPath(file);
      if (skill) return `Consulting skill: ${skill}`;
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
      const skill = extractSkillNameFromPath(file);
      if (skill) return `Consulting skill: ${skill}`;
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

// Pulls the `login` out of a GitHub get_me result (JSON string, object, or
// LangChain message content). Returns null when no login is recognizable.
export function extractGithubLogin(raw: unknown): string | null {
  const texts: string[] = [];
  if (typeof raw === "string") texts.push(raw);
  else if (Array.isArray(raw)) {
    for (const block of raw) {
      if (typeof block === "string") texts.push(block);
      else if (block && typeof block === "object") {
        const o = block as Record<string, unknown>;
        if (typeof o.text === "string") texts.push(o.text);
        if (typeof o.login === "string") return o.login;
      }
    }
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.login === "string") return o.login;
    try { texts.push(JSON.stringify(o)); } catch { /* ignore */ }
  }
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).login === "string") {
        return (parsed as Record<string, unknown>).login as string;
      }
    } catch { /* not JSON — fall through to regex */ }
    const match = text.match(/"login"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
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
const LANDING_PAGE_BUILD_PATTERN = /\b(build|create|make|develop|design|generate)\b.{0,80}\b(landing\s*page|marketing\s*page|homepage|portfolio\s*site)\b/i;
// Deliverable builds (slides, docs, spreadsheets) are multi-step projects
// even in one short sentence: read the skill, write a generator script,
// run it, verify the file. Classifying them "simple" caps the run at ~3
// tool calls — the agent burns them all on skill exploration and never acts.
const DOC_BUILD_PATTERN =
  /\b(pdf|presentation|power ?point|pptx?|slide deck|slideshow|slides?|spreadsheet|excel|xlsx?|workbook|word documents?|docx?|latex|document|report)\b/i;
// "Create/write a report/memo/summary" is a document build even without a
// format keyword: research + write + save is multi-step, never a lookup.
const DOC_WRITE_PATTERN =
  /\b(create|make|generate|write|draft)\b.{0,40}\b(report|document|memo|letter|resume|summary|writeup|write-up)\b/i;

/**
 * Pure document builds (slides/docs/sheets via local skills + write_file +
 * execute) virtually never need user MCP servers — but every bound MCP tool
 * (e.g. 26 GitHub tools) inflates each model call and slows flaky endpoints.
 * Skip MCP only when the request shows no research/external-service intent.
 */
export function shouldSkipMcpForTask(request: string): boolean {
  const text = request || "";
  const isBuild = DOC_BUILD_PATTERN.test(text) || DOC_WRITE_PATTERN.test(text) || BUILD_TASK_PATTERN.test(text) || LANDING_PAGE_BUILD_PATTERN.test(text);
  if (!isBuild) return false;
  if (/\b(research|search(ing)?|find|latest|compare|gather|lookup|investigate|github|repos?|issues?|pull request|prs?|gists?|jira|notion|slack|drive|gmail)\b/i.test(text)) return false;
  return true;
}
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
  if (BUILD_TASK_PATTERN.test(text) || CREATE_PROJECT_PATTERN.test(text) || LANDING_PAGE_BUILD_PATTERN.test(text)) return "complex";
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
  "finish",
  "finish the task",
  "finish it up",
  "complete it",
  "keep working",
  "continue now",
  "continue the task",
  "pick up where you left off",
  "pick up from where you left off",
  "pick up where you stopped",
  "pick up from where you stopped",
  "continue from where you stopped",
  "continue from where you left off",
  "ok",
  "okay",
  "sure",
  "go ahead",
  "yes",
  "do it",
  "please do it",
  "proceed please",
];
export function isContinueRequest(request: string): boolean {
  const text = (request || "").trim().replace(/[.!…]+$/g, "").trim().toLowerCase();
  if (!text) return false;
  const bare = text.startsWith("please ") ? text.slice("please ".length).trim() : text;
  const core = bare.endsWith(" please") ? bare.slice(0, -" please".length).trim() : bare;
  if ((CONTINUE_PHRASES as string[]).includes(core)) return true;
  if (/^(?:continue|resume|pick\s+up)\s+(?:from\s+)?where\b.{0,60}$/i.test(core)) return true;
  if (/^(?:continue|resume|keep\s+going|keep\s+working|go\s+ahead)\b.{0,40}$/i.test(core)) return true;
  if (/^(?:ok|okay|sure|yes|do\s+it|proceed)\b.{0,20}$/i.test(core)) return true;
  return false;
}

// Checkpoint of the last run per session: full LangChain message history
// (tool calls + results) plus the working plan. This is what lets a
// follow-up "continue" resume instead of restarting — text history alone
// (user/assistant turns) cannot reconstruct tool state. Kept in memory for
// speed and mirrored to disk (.nexus/run-checkpoints/) so "continue" also
// survives an app restart, when the in-memory map is empty.
export type TaskLedger = {
  updatedAt: string;
  planItems: PlanItem[] | null;
  completedSteps: string[];
  lastDiagnostics: string[];
  changedFiles: string[];
  verification: "none" | "passed" | "failed" | "interrupted";
};
export type RunCheckpoint = { messages: any[]; planItems: PlanItem[] | null; ledger?: TaskLedger };
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
  const ledger = checkpoint.ledger ?? {
    updatedAt: new Date().toISOString(),
    planItems: checkpoint.planItems ?? null,
    completedSteps: summarizeCompletedSteps(messages),
    lastDiagnostics: messages
      .filter((message: any) => message?.type === "tool" || message?.type === "human")
      .map((message: any) => String(message?.content ?? ""))
      .filter((text: string) => /error|failed|diagnostic|verification/i.test(text))
      .slice(-8)
      .map((text: string) => text.slice(-600)),
    changedFiles: [],
    verification: "none",
  };
  const next = { messages, planItems: checkpoint.planItems ?? null, ledger };
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
    ledger: checkpoint.ledger ?? {
      updatedAt: new Date().toISOString(),
      planItems: checkpoint.planItems,
      completedSteps: summarizeCompletedSteps(checkpoint.messages),
      lastDiagnostics: [],
      changedFiles: [],
      verification: "none",
    },
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
    const parsed = JSON.parse(raw) as { planItems?: PlanItem[] | null; messages?: any[]; ledger?: TaskLedger };
    const messages = (parsed.messages || []).map(reviveCheckpointMessage).filter(Boolean);
    if (!messages.length) return null;
    const checkpoint = { messages: sanitizeResumeCheckpoint(messages), planItems: parsed.planItems ?? null, ledger: parsed.ledger };
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

/**
 * Normalizes tool arguments so models passing `filePath` or `path` instead of
 * snake_case `file_path` for DeepAgents filesystem tools (read_file, write_file,
 * edit_file, delete) succeed without validation crashes.
 */
export function toolParameterNormalizationMiddleware() {
  const normalize = (toolCalls: any[]) => {
    if (!Array.isArray(toolCalls)) return;
    for (const tc of toolCalls) {
      if (tc?.args && typeof tc.args === "object") {
        if ("filePath" in tc.args && !("file_path" in tc.args)) {
          tc.args.file_path = tc.args.filePath;
        }
        if ("path" in tc.args && !("file_path" in tc.args)) {
          tc.args.file_path = tc.args.path;
        }
      }
    }
  };

  return createMiddleware({
    name: "toolParameterNormalizationMiddleware",
    wrapModelCall: async (request: any, handler: any) => {
      const response = await handler(request);
      if (response && Array.isArray((response as any).tool_calls)) {
        normalize((response as any).tool_calls);
      }
      return response;
    },
    afterModel: (state: any) => {
      const messages = state?.messages;
      if (!messages || messages.length === 0) return undefined;
      for (const msg of messages) {
        if (msg?.tool_calls) {
          normalize(msg.tool_calls);
        }
      }
      return undefined;
    },
  });
}

/**
 * Loop Prevention Middleware:
 * Detects and breaks repetitive read/inspection tool loops (e.g., repeatedly calling
 * read_file, grep_search, or glob on the same file/target without any edits or modifying commands).
 *
 * Modifying actions (write_file, edit_file, delete, apply_patch, execute) reset inspection tracking.
 *
 * Repetition 2: Injects a proactive steering notice into the tool message advising the model
 *               that the file has not changed, build/tests already passed, and to mark todos completed.
 * Repetition 3+: Blocks execution of the tool, returning an intervention ToolMessage directing the model
 *                to update its todo list and provide its final answer immediately.
 */
export function loopPreventionMiddleware(options: { general?: boolean; outputRequired?: boolean; beforeModify?: () => string | null } = {}) {
  let lastReadSig: string | null = null;
  let consecutiveCount = 0;
  let researchCallCount = 0;
  const inspectionCounts = new Map<string, number>();
  // SKILL.md content never changes mid-run: the first read loads it, every
  // repeat is pure waste (observed as skill→plan→todos→repair→skill testing
  // loops on slow endpoints). Track by skill NAME (not path) so virtual-path
  // variants (/system-skills/x vs system-skills/x) can't dodge the guard.
  const loadedSkills = new Set<string>();

  const isModifying = (name: string) => /^(write_file|edit_file|delete|apply_patch|execute)$/i.test(name);
  const isInspection = (name: string) => /^(read_file|read_file_range|grep_search|glob|ls|view_file|search_code|code_structure|code_symbol)$/i.test(name);
  const isFileRead = (name: string) => /^(read_file|read_file_range)$/i.test(name);
  const isResearchTool = (name: string) => /^(web_search|browser_fetch_api|browser_inspect|search_web|fetch_url)$/i.test(name);

  const normalizePath = (args: any) => {
    if (!args || typeof args !== "object") return "";
    const p = String(args.file_path || args.filePath || args.path || args.file || args.query || args.pattern || "");
    return p.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  };

  return createMiddleware({
    name: "loopPreventionMiddleware",
    wrapToolCall: async (request: any, handler: any) => {
      const toolName = String(request.tool?.name ?? request.toolCall?.name ?? "");
      const args = request.toolCall?.args ?? {};
      const toolCallId = String(request.toolCall?.id ?? "");

      if (isModifying(toolName)) {
        const gate = options.beforeModify?.();
        if (gate) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            status: "error",
            content: gate,
          });
        }
        inspectionCounts.clear();
        lastReadSig = null;
        consecutiveCount = 0;
        researchCallCount = 0;
        return handler(request);
      }

      if (options.general && options.outputRequired && isResearchTool(toolName)) {
        researchCallCount++;
        if (researchCallCount > 8) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            content: "[SUPERVISOR INTERVENTION] The research budget for this task has been reached. Use the evidence already collected and take the next result-producing action. Do not perform another web search or page fetch unless it directly unblocks creation of the requested output.",
          });
        }
      }

      // Skill reads bypass the generic inspection counters (a plan/todos call
      // in between would reset them): first read executes, repeats get a
      // cached steer-forward instead of the file content.
      if (isFileRead(toolName)) {
        const skill = extractSkillNameFromPath(normalizePath(args));
        if (skill) {
          const key = skill.toLowerCase();
          if (loadedSkills.has(key)) {
            return new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              status: "error",
              content: `[SKILL ALREADY LOADED]: Skill '${skill}' is already loaded above — its instructions have not changed. Do NOT re-read any SKILL.md file. Proceed directly: write_file the generator script, execute it, verify the output with ls, then present the result.`,
            });
          }
          const result = await handler(request);
          loadedSkills.add(key);
          return result;
        }
      }

      if (isInspection(toolName)) {
        const target = normalizePath(args);
        const sig = `${toolName}:${target}`;
        const totalCount = (inspectionCounts.get(sig) ?? 0) + 1;
        inspectionCounts.set(sig, totalCount);

        if (sig === lastReadSig) {
          consecutiveCount++;
        } else {
          lastReadSig = sig;
          consecutiveCount = 1;
        }

        // 3rd+ consecutive repetition or 4th total inspection without modifying actions:
        // Intervene and short-circuit! Do NOT re-execute the tool.
        if (consecutiveCount >= 3 || totalCount >= 4) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            status: "error",
            content: `[LOOP PREVENTION NOTICE]: You have already inspected '${target || toolName}' multiple times (${totalCount}x) without making any workspace edits or code changes. The file content has not changed.\n\nCRITICAL INSTRUCTIONS:\n1. Stop inspecting or re-reading files.\n2. If build or tests already passed and required changes are in place, call write_todos to mark remaining in-progress todos as completed.\n3. Output your final response to the user immediately detailing the changes made.`,
          });
        }

        const result = await handler(request);

        // 2nd consecutive repetition or 2nd total inspection of the same target:
        // Append proactive steering notice to guide the model before a hard block.
        if (consecutiveCount === 2 || totalCount === 2) {
          const currentContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
          const nudge = `\n\n[Notice: You already inspected '${target || toolName}'. The content has not changed. Do NOT re-read or inspect this again. If your build or verification passed, update your todo list to completed with write_todos and present your final response now.]`;
          result.content = currentContent + nudge;
        }

        return result;
      }

      return handler(request);
    },
  });
}

function isRecursionLimitError(error: unknown): boolean {
  const text = [error instanceof Error ? error.message : String(error), String((error as any)?.name ?? "")].join(" ");
  return /recursion\s*limit|GRAPH_RECURSION_LIMIT/i.test(text);
}

function todayLine(): string {
  const now = new Date();
  const long = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `Today is ${long} (${now.toISOString().slice(0, 10)}).`;
}

function buildSystemPrompt(mode: AgentMode, projectRoot: string, providerLabel: string, modelName: string, memory: AgentMemoryContext, projectRulesSection: string = "", complexity: TaskComplexity = "complex", isNewProject = false, taskKind: AgentTaskKind = "code", repoMapSection: string = "", homeTaskContract: HomeTaskContract | null = null) {
  const today = todayLine();
  if (taskKind === "general") {
    let general = `You are Nexus Home, a helpful general-purpose assistant. Your workspace folder is exposed at the virtual root / — use paths relative to it (for example report.docx). Files you create land in the user's Nexus folder, where they can download them.

${today} Anchor every relative time expression to it ("last decade", "this year", "recent", "latest").

Project root on host (metadata only): ${projectRoot}
Provider: ${providerLabel} / ${modelName}

The virtual root / is the selected project root. Use relative workspace paths only. Do not invent or use alternate host paths such as C:\\nexus-landing, /nexus-landing, /workspace, or /repo, and never cd outside the selected workspace. Commands already run with the correct cwd. Do not use verbose/debug build flags unless the user explicitly asks for them.

Long-term memory (shared across ALL Home chats — user profile, preferences, recurring context):
${tail(memory.projectMemory, 4000) || "(empty)"}

Session memory (this chat only):
${tail(memory.sessionMemory, 3000) || "(empty)"}

Working rules:
- Visual answers: when a visual would make the answer substantially easier to understand — a comparison, trend, process, hierarchy, timeline, distribution, plan, or spatial relationship — include one chart or diagram alongside the explanation, whatever the kind of question (research, explanation, how-to, analysis, planning). Prefer a chart over a markdown table of the same numbers when the shape matters more than the exact figures; keep prose or a table when a visual would add no clarity. Pick the matching fenced block and copy its syntax exactly, grounding every value in sources or tool output:
    * Relationships, processes, hierarchies, timelines, flows → a mermaid block (flowchart/sequence/timeline syntax).
    * Comparing values across a few categories → a bar block:
      \`\`\`bar
      title "Quarterly revenue"
      y-axis "USD (millions)"
      bar "Q1" 320
      bar "Q2" 410
      bar "Q3" 480
      \`\`\`
    * Trends over an ordered sequence (months, steps, versions) → a line block:
      \`\`\`line
      title "Monthly active users"
      x-axis "Month"
      y-axis "Users"
      point "Jan" 1200
      point "Feb" 1350
      point "Mar" 1310
      \`\`\`
    * Correlation between two numeric variables → a scatter block (here x-axis/y-axis REQUIRE min max):
      \`\`\`scatter
      title "Study hours vs exam score"
      x-axis "Hours" 0 12
      y-axis "Score" 0 100
      point "Ana" 4 71
      \`\`\`
  Keep labels to a few words and 3-8 data points. Do not force a visual when the data is sparse, incomparable, ambiguous, or a chart would add noise — clear prose alone is fine then. Never use ASCII art.
- Answer chit-chat and simple questions directly with zero tool calls — EXCEPT memory saves below, which never count toward any tool budget.
- Long-term memory stores enduring facts about the user, their role, communication style, and tool/format preferences across sessions.
- Memory management: you have access to the manage_memory tool. When the user explicitly asks you to remember something ("remember that...", "keep in mind that...", "my preference is..."), or when they state an enduring personal preference, role, or project context, use manage_memory with action='remember' to persist it to long-term memory. Use action='forget' if they ask to remove or change a prior preference. Do NOT call manage_memory for temporary or transient chat trivia (e.g. "I am eating lunch").
- Saving is YOUR job, never the user's: when someone tells you who they are (name, role, background, education, work, projects), call manage_memory yourself in the SAME run — never reply "tell me to save this and I will remember" or ask them to instruct you. Save first, then briefly confirm what you remembered (e.g. "Noted — I'll remember you're Amine, a master's student in data science & AI.").
- Memories above are summaries, not transcripts: the full answers live in chat history. Never treat a memory fragment as complete data — re-read the chat or re-run the lookup for exact lists, tables, or numbers.
- For research: use web_search first, then read the most promising pages with browser_fetch_api or browser_inspect before stating facts.
- Knowledge freshness: your training data has a cutoff, so treat remembered facts about fast-moving things (model releases, versions, prices, rankings, benchmarks, news) as unverified hypotheses — "latest"/"current"/"best"/"now" answers must come from the web, not memory. Search with the freshness parameter (month or year) and current-year query terms, read the top pages, and check each page's publication date: prefer sources from the last 12 months and discard listicles older than the question's timeframe. Give volatile figures an explicit "as of <date>" marker, and if nothing recent enough can be verified, say so plainly ("I could only verify up to X — newer information may exist") instead of presenting stale data as current. Never invent current prices, versions, or news, and never clip ranges to your training cutoff.
- If the task involves a library, API, or technology you are unsure about — especially anything recently released — research it first: web_search, then read the official docs with browser_inspect. Never invent APIs, import paths, or options; pin the exact version you verified.
    - For any request that asks you to create, prepare, produce, export, write, or transform something, treat the requested result as a completion contract. Decide what concrete output proves completion, create it in the workspace, inspect it, and only then finish.
    - For documents and other artifacts: check the skills in your System Note first — a skill may describe exactly how to build the requested output. Follow it: write the needed draft or generator with write_file, run it with execute, inspect the result, and clean up only throwaway files after successful validation.
    - CRITICAL IN AUTO MODE: Do NOT stop after reading a skill or researching to announce your intent. Once you have enough evidence to act, take the next concrete action that advances the requested result. Never conclude while a declared output is missing or uninspected.
- If a command fails because a tool is missing (python, pip packages), install it or fall back to the closest format you CAN produce, and say so clearly.
- Save finished deliverables with clear file names in the workspace root and end by naming the exact file(s) the user can download.
    - Be efficient: research only while it is producing new evidence. After research, switch to creating or transforming the requested result. Keep answers concise.
- Skills listed in your instructions are mandatory pre-reads: if a skill covers the task, read its SKILL.md first via its exact given path. CRITICAL: SKILL.md contains private operational instructions for YOU, not text for the user. NEVER quote, echo, dump, or output the SKILL.md text, code samples, or numbered lines back to the user. Silently follow its instructions to produce the requested deliverable (e.g. write a generator script with write_file, execute it to create the file, verify it with ls, clean up the script, and deliver the final result). Never browse skill folders (ls/glob of .nexus/skills, /global-skills, /system-skills) to discover skills — the System Note already lists everything available to you.
- If a skill ships helper scripts you must run, copy them into the workspace first with materialize_skill_files, then run them via the returned workspace-relative paths with execute (skill folders are read-only and outside the run directory).
- Never expose secrets.`;
    if (complexity === "simple") {
      general += `\n\nEFFICIENCY MODE (simple task): answer in at most 3 tool calls. Do NOT create a todo list, do NOT delegate to subagents. If no file is needed, answer directly. manage_memory calls are exempt from the budget and must still fire when the user shares identity or preferences.`;
    }
    if (projectRulesSection) {
      general += `\n\n${projectRulesSection}`;
    }
    if (homeTaskContract?.expectsOutput) {
      general += `\n\nTASK CONTRACT: This request asks for an observable result. Decide what output proves completion, create or update it in the workspace, inspect it, and do not finish with a promise or research summary alone.${homeTaskContract.needsResearch ? " Research is allowed, but switch to producing the result once the evidence is sufficient." : ""} ESCAPE HATCH: only when the request is genuinely chat-shaped (a poem, story, explanation, email or letter text, brainstorm — and it names no file format or document type), you may instead deliver the complete answer directly in chat, ending your reply with the exact marker [[answer-in-chat]] on the final line. Never use the marker when a document, file, or export would be the natural deliverable, and never use it to avoid work you have not done.`;
    }
    if (mode === "plan") return `${general}\n\nMODE: PLAN. Investigate and return a structured markdown plan. Writing, editing and command execution are disabled — read and search only.`;
    return `${general}\n\nMODE: ${mode === "auto" ? "AUTO. Work autonomously end to end: research, create, then verify the deliverable exists before finishing." : "ASK. Fulfil the request, keep it focused, and confirm the result before answering."}`;
  }

  let common = `You are Nexus, an advanced autonomous coding agent working on a local repository. The repository is exposed at the virtual root / — use paths relative to the repository root (for example src/App.tsx).

${today} Anchor every relative time expression to it.

Project root on host (metadata only): ${projectRoot}
Provider: ${providerLabel} / ${modelName}

Project memory:
${tail(memory.projectMemory, 2000) || "(empty)"}

Session memory:
${tail(memory.sessionMemory, 3000) || "(empty)"}

Working rules:
- Inspect the relevant code before proposing or making changes; never assume file contents.
- Follow the engineering harness loop: Plan -> Test -> Implement -> Review -> Verify.
- Be efficient: act in at most 3 exploration calls (grep_search/read_file_range) before editing or answering. Read files directly; do not chain outline -> definition -> references -> read for the same symbol. (SKILL.md reads don't count — always check skills first.)
- Never list the repository root (ls /) or run unscoped globs (**/*): they return thousands of entries (node_modules/dist) and stall the run. Always scope to a subdirectory or a narrow pattern like src/**/*.tsx.
- Prefer grep_search with a tight query over browsing; if a listing is truncated, narrow it instead of paging through it.
- For multi-file edits, prefer a single apply_patch call over N sequential writes/edits.
- Never write throwaway verification scripts into the repo (no check-*.js, smoke-test.js, or any scratch files — and never inside .nexus/, which is telemetry storage). Verify with a single inline command instead, then stop: one syntax check plus one smoke run is enough for a small app.
- Use ask_user sparingly (at most once) when genuinely blocked by ambiguity; otherwise proceed with best guess.
- Use browser_inspect or browser_fetch_api ONLY for web/dev-server/API-health tasks. Never use them for plain code edits or explanations. browser_inspect renders the page with JavaScript in the built-in browser session (the user can watch in the Browser tab when headless is off), so prefer it for checking what a running dev server actually renders. To interact with the page (click buttons, fill forms, submit, scroll), use browser_act — snapshot first for element refs, then act on refs.
- If the task involves a library, API, or technology you are unsure about — especially anything recently released — research it first with web_search, then read the official docs with browser_inspect before writing code. Never invent APIs, import paths, or options; pin the exact version you verified.
- Immutability & clean design: prefer pure functions and immutable data transforms over mutation. Keep functions small (<50 lines) and files focused (<800 lines). Never silently swallow errors in empty catch blocks.
- Security-first: zero tolerance for hardcoded API keys, secrets, or credentials. Always parameterize queries against SQL injection and sanitize user inputs against XSS.
- Test-driven development (TDD): for bug fixes or features, write or update tests alongside changes. Verify that tests pass.
- Specialist subagents: use delegate_task for complex isolated tasks (e.g. 'architect' for system design, 'code-reviewer' for quality audits, 'security-reviewer' for vulnerability checks, 'tdd-guide' for test workflows, 'build-error-resolver' for compiler errors, 'refactor-cleaner' for dead code removal). Never delegate simple single-file edits or Q&A. Keep write-capable delegation sequential; use read-only reviewers/researchers for parallel investigation.
- Keep diffs minimal and focused; prefer editing existing files over rewriting them.
- Only use the todo list for tasks with 3+ distinct steps. Skip it entirely for trivial tasks (single question, single-file fix, typo, rename).
- Additional MCP tools (if listed in your tools) come from user-configured MCP servers; prefer them for the capabilities they expose (e.g. search, APIs, external systems). When GitHub MCP tools are available, never ask the user for their GitHub username — the token already identifies them (see the authenticated-user note, or call get_me). To list the user's own repositories: call get_me, then search_repositories with the query 'user:<login>'. Use the login verbatim — exact spelling, no spaces, never the display name. If GitHub rejects the query with 422 on the user: qualifier, call get_me again and retry once with that exact login before reporting failure.
- Skills listed in your instructions are mandatory pre-reads, not options: before exploring or writing code, check whether any skill covers the task and read its SKILL.md first via its exact given path. SKILL.md contains internal instructions for YOU — never output, quote, echo, or dump skill contents to the user. Never browse skill folders (ls/glob of .nexus/skills, /global-skills, /system-skills) to discover skills — the System Note already lists everything available to you.
- If a skill ships helper scripts you must run, copy them into the workspace first with materialize_skill_files, then run them via the returned workspace-relative paths with execute (skill folders are read-only and outside the run directory).
- Never expose secrets.
- Self-review: before finishing, verify that modified code compiles, tests pass, and no unintended edits or secrets were introduced. Once compilation or verification passes (e.g. npm run build succeeds), do NOT repeatedly re-read the source files you just wrote. Update your todo list to completed with write_todos and summarize your work to the user. Report files changed, commands run, and remaining risks.
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
- Finish only when npm run build passes. If the build fails, fix and rebuild — do not hand back a project that does not compile. Once the build passes, conclude your task and report the result. Do NOT loop re-reading files after a successful build.`;
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

export type AttachmentDoc = { name: string; mimeType: string; text: string; truncated: boolean };

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
  /** Agent mode for skill scoping ("home" | "code" | "notebook"). Omit = all skills eligible. */
  skillsMode?: SkillMode;
  /** Callback when the agent updates shared Home long-term memory via manage_memory. */
  onHomeMemoryUpdate?: (mutate: (current: string) => string) => void | Promise<unknown>;
  /** Blocking clarifying-question handler: return the user's answers or null to best-guess. */
  onUserQuestion?: (questions: Array<{ header: string; question: string; options: string[] }>) => Promise<string | null>;
}) {
  const { projectRoot, telemetryRoot, sessionId, request, images, attachments, attachmentDocs, importableAttachments, settings, memory, history, mode, agentBackend, onEvent, isCancelled, onHomeMemoryUpdate, onUserQuestion } = options;
  const { resumeMessages, resumePlanItems, resumeNote, skillsMode } = options;
  const taskKind: AgentTaskKind = options.taskKind ?? "code";
  const isGeneral = taskKind === "general";
  const homeTaskContract = isGeneral ? inferHomeTaskContract(request) : null;
  const codeTaskContract = isGeneral ? null : inferCodeTaskContract(request);
  const targetTelemetryRoot = telemetryRoot || projectRoot;
  const signal = sessionId ? getRunAbortSignal(sessionId) : undefined;
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
    ((isGeneral || shouldSkipMcpForTask(request) || (taskKind === "code" && !/\b(github|repository|repositories|issue|pull request|slack|notion|web search|latest|research|external)\b/i.test(`${request} ${resumeNote || ""}`)))
      ? Promise.resolve({ tools: [], serverNames: [], warnings: undefined })
      : withSetupTimeout(getMcpTools(), 20000, "MCP servers")).then(
      (r) => ({ ok: true as const, tools: r.tools, serverNames: r.serverNames, warnings: r.warnings }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    (isGeneral ? Promise.resolve({ hasRules: false, ruleFiles: [], combinedPromptSection: "" }) : discoverAllRules(projectRoot)),
    getSkillsConfig(),
    // Code runs get a symbol-outline map so the model orients without
    // re-listing the tree every task. Home/doc runs skip it (a documents
    // folder has no useful symbols). Never fails the run.
    (isGeneral
      ? Promise.resolve("")
      : Promise.all([
        getRepoMapSection(projectRoot, request).catch(() => ""),
        getProjectIndexSection(projectRoot, request).catch(() => ""),
      ]).then((sections) => sections.filter(Boolean).join("\n\n"))),
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
      const recs = recommendSkills(catalog, request, 3);
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
  // The backend is also read-only in Plan mode, but keep the invariant at the
  // tool-registration boundary too: custom tools must not bypass the backend.
  // importableAttachments covers every file type (images + docs); the legacy
  // attachedImages alias keeps image imports working for older callers.
  const editTools = mode === "plan" ? [] : createEditTools(projectRoot, { attachedImages: attachments, attachedFiles: importableAttachments ?? attachments });
  // Skill helper scripts run through the workspace: plan mode stays read-only.
  const skillFilesTools = mode === "plan" || !skillsConfig.enabled ? [] : [createSkillFilesTool(eligibleSkillCatalog, projectRoot)];
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

  const deepAgent = await createDeepAgent({
    model: llm,
    backend: compositeBackend as any,
    middleware: isSimple
      ? [toolParameterNormalizationMiddleware(), loopPreventionMiddleware({ general: isGeneral, outputRequired: Boolean(homeTaskContract?.expectsOutput), beforeModify: beforeCodeModify })]
      : [toolParameterNormalizationMiddleware(), loopPreventionMiddleware({ general: isGeneral, outputRequired: Boolean(homeTaskContract?.expectsOutput), beforeModify: beforeCodeModify }), todoListMiddleware()],
    tools: isSimple
      ? [...codeTools, ...editTools, ...skillFilesTools, questionTool, ...safeBrowserTools, ...webSearchTools, ...homeMemoryTool, ...mcpTools]
      : [...codeTools, ...editTools, ...skillFilesTools, questionTool, ...safeBrowserTools, ...webSearchTools, ...homeMemoryTool, subagentTool, ...mcpTools],
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
      homeTaskContract
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
      maxAttempts: isGeneral ? 2 : undefined,
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
        const artifactCandidates = selectHomeArtifactCandidates(freshFiles);
        const artifactChecks = artifactCandidates.length
          ? await validateHomeArtifacts(projectRoot, artifactCandidates)
          : [];
        const invalidArtifacts = artifactChecks.filter((check) => !check.valid);
        const validatedDeliverable = createdDeliverable && invalidArtifacts.length === 0;
        // Chat-answer escape: a genuinely chat-shaped request (poem,
        // explanation, email text) that names no file format may be answered
        // directly in chat, marked with [[answer-in-chat]]. The model decides
        // what the deliverable is; the sentinel + substance + no-named-format
        // guardrails keep it from dodging real file work.
        const responseTextTrimmed = String(state.response || "").trimEnd();
        const chatAnswerDeclared =
          wantsDeliverable &&
          !createdDeliverable &&
          !homeRequestNamesFileFormat(request) &&
          responseTextTrimmed.length >= 200 &&
          /\[\[answer-in-chat\]\]\s*$/i.test(responseTextTrimmed);
        if (chatAnswerDeclared) {
          emit("tool", "Verification passed · answered in chat (request names no file format)");
          return { verification: "none" };
        }
        const conversationalPromise = /\b(let me|i will|now i'll|i am going to|i'll now|going to write|next step is to)\b.{0,50}\b(write|create|generate|run|execute|build)\b/i.test(state.response || "");

        if (wantsDeliverable && (!createdDeliverable || !validatedDeliverable) && (conversationalPromise || currentRepairs < maxRepairs)) {
          if (currentRepairs < maxRepairs) {
            const validationNote = invalidArtifacts.length
              ? ` Output validation failed: ${invalidArtifacts.map((check) => `${check.path} (${check.error || "invalid"})`).join(", ")}.`
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
      let anyCheckRan = false;
      const deniedCommands: string[] = [];
      const skipIfApprovalDenied = (command: string, res: any): boolean => {
        if (!res?.approvalDenied) return false;
        deniedCommands.push(command);
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
        if ((scopedResult as any)?.exitCode !== 0 && !skipIfApprovalDenied(scoped, scopedResult)) {
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
          anyCheckRan = true;
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
          anyCheckRan = true;
          emit("tool", `Verification passed · ${pm.install}`);
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
      const verifyBatch = [...configuredCommands.slice(0, 4)];
      if (pickFormatterCommand && !verifyBatch.includes(pickFormatterCommand)) verifyBatch.push(pickFormatterCommand);
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
              if (skipIfApprovalDenied(command, entry.value)) return;
              failures.push({ command, output });
              emit("tool", `Verification failed · ${command}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(output));
            } else {
              anyCheckRan = true;
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
        if (deniedCommands.length && !anyCheckRan) return { verification: "none" };
      } else for (const verificationCommand of configuredCommands) {
        emit("status", `Verifying changes with \`${verificationCommand}\``);
        const result = await runCommand(verificationCommand);
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        const output = String((result as any)?.output ?? "").trim();
        if ((result as any)?.exitCode !== 0) {
          if (skipIfApprovalDenied(verificationCommand, result)) continue;
          emit("tool", `Verification failed · ${verificationCommand}`, undefined, undefined, undefined, undefined, extractDiagnosticFeedback(output));
          if (currentRepairs < maxRepairs && output) {
            return {
              repairs: currentRepairs + 1,
              verifyFeedback: `The verification command \`${verificationCommand}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(output)}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
            };
          }
          return { verification: "failed" };
        }
        anyCheckRan = true;
        emit("tool", `Verification passed · ${verificationCommand}`);
      }

      // 2. Targeted test detection for modified files (reuse the diff above)
      const targetTestCmd = findTargetedTests(projectRoot, changedPaths);
      if (targetTestCmd) {
        emit("status", `Running targeted test \`${targetTestCmd}\``);
        const testResult = await runCommand(targetTestCmd);
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        const testOutput = String((testResult as any)?.output ?? "").trim();
        if ((testResult as any)?.exitCode !== 0) {
          if (skipIfApprovalDenied(targetTestCmd, testResult)) {
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
          anyCheckRan = true;
          emit("tool", `Targeted test passed · ${targetTestCmd}`);
        }
      }

      // Auto mode gets one bounded, read-only review after verification and
      // before completion. Blocking findings return the task to implementation.
      if (mode === "auto" && codeTaskContract?.expectsChanges && currentRepairs < maxRepairs) {
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
      if (deniedCommands.length && !anyCheckRan) {
        emit("status", `Verification skipped — approval was denied for: ${deniedCommands.join(", ")}`);
        return { verification: "none" };
      }
      return { verification: verifyBatch.length || scoped || targetTestCmd ? "passed" : "none" };
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
    result = await graph.invoke({ projectRoot, request }, { recursionLimit: outerLimit, signal });
  } catch (error) {
    const isCancel = error instanceof RunCancelledError || (error as any)?.name === "AbortError" || isCancelled() || signal?.aborted;
    if (isCancel) {
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      await finishRunJournals("interrupted");
      throw new RunCancelledError();
    }
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
        result = await graph.invoke({ projectRoot, request }, { recursionLimit: outerLimit, signal });
      } catch (retryError) {
        error = retryError;
        if (error instanceof RunCancelledError || (error as any)?.name === "AbortError" || isCancelled() || signal?.aborted) {
          saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
          await finishRunJournals("interrupted");
          throw new RunCancelledError();
        }
      }
    }
    if (result === undefined) {
      const retryIsDoom = error instanceof DoomLoopError || (error as any)?.name === "DoomLoopError";
      if (!isRecursionLimitError(error) && !retryIsDoom) {
        // Unexpected run failure: still checkpoint so "continue" resumes THIS
        // task instead of a stale one, and record the journals as failed.
        saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
        await finishRunJournals("failed");
        throw error;
      }
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      await finishRunJournals("interrupted");
      const planSummary = lastPlanItems?.length
        ? `\n\nWorking plan so far:\n${lastPlanItems.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
        : "";
      const doomTool = retryIsDoom ? (error as DoomLoopError).toolName || "tool" : null;
      const partial = retryIsDoom
        ? `I got stuck repeating the same ${doomTool} call without making progress, so I stopped instead of looping forever. Progress is checkpointed — say "continue" and I will resume with a different approach.${planSummary}`
        : `I hit the step budget before finishing. Progress is checkpointed — say "continue" and I will resume from where I stopped instead of restarting.${planSummary}`;
      emit("error", retryIsDoom ? `Stuck repeating ${doomTool} — stopped to avoid an infinite loop after ${toolCallCount} tool calls. Say "continue" to resume differently.` : `Step budget reached (${outerLimit} graph steps; ${toolCallCount} tool calls). Progress saved — say "continue" to resume.`);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: retryIsDoom ? `Doom-loop breaker fired on ${doomTool}; checkpoint saved for resume.` : `Recursion limit hit at ${outerLimit}; checkpoint saved for resume.` });
      const partialUsage = usage.finalize(modelName, estimatedFallbackInputTokens, 0);
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
  const homeArtifactChecks = homeFreshFiles.length
    ? await validateHomeArtifacts(projectRoot, selectHomeArtifactCandidates(homeFreshFiles))
    : [];
  const homeInvalidArtifacts = homeArtifactChecks.filter((check) => !check.valid);
  if (isGeneral && homeTaskContract?.expectsOutput && result?.verification === "failed") {
    const freshFiles = homeFreshFiles;
    if (freshFiles.length === 0 || homeInvalidArtifacts.length > 0) {
      const detail = freshFiles.length === 0
        ? "No new workspace artifact was created."
        : `Output validation failed: ${homeInvalidArtifacts.map((check) => `${check.path} (${check.error || "invalid"})`).join(", ")}.`;
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
