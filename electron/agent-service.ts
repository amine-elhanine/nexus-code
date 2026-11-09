import { existsSync, readFileSync, readdirSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import {
  assistantMsg, userMsg, toolMsg, systemMsg,
  textOf, textJoined, toolCallsOf, toolCallIdOf,
  reviveMessages, type ChatMessage, type ToolCall,
} from "./agentcore/messages.js";
import { runAgentLoop, buildSkillsSection, createTodoTool, StepBudgetExceededError, type AgentLoopEvent, type SkillListing } from "./agentcore/loop.js";
import { CompositeAgentBackend, createSkillBackend, type AgentBackend } from "./agentcore/backend.js";
import { createFilesystemTools } from "./agentcore/builtin-file-tools.js";
import type { ChatClient } from "./agentcore/llm/types.js";
import type { AgentMiddleware } from "./agentcore/middleware.js";
import { normalizeToolCallArgs } from "./loop-prevention.js";
import { createChatModel, resolveModelContextWindow, resolveModelMaxOutput, formatContextWindow, formatTokenCount } from "./providers.js";
import { createCodeIntelligenceTools, pickRuntimeCodeTools } from "./code-tools.js";
import { createEditTools, createQuestionTool } from "./edit-tools.js";
import { createBrowserTools } from "./browser-tool.js";
import { agentBrowserService } from "./browser-service.js";
import { getRepoMapSection } from "./repo-map-service.js";
import { getProjectIndexSection } from "./project-index-service.js";
import { createWebImageSearchTools, createWebSearchTools, createWebVideoSearchTools } from "./websearch-tool.js";
import { chunkThinking } from "./thinking-chunk.js";
import { discoverAllRules, discoverProjectRules } from "./rules-service.js";
import { discoverProjectInstructions } from "./project-instructions.js";
import { expandSlashCommand } from "./custom-commands-service.js";
import { createSubagentDelegationTool, executeSubagentTask, buildSubagentCatalog, type SubagentItem } from "./subagent-service.js";
import { getWorkspaceDiffFiles } from "./diff-service.js";
import { getMcpTools } from "./mcp-service.js";
import { getHooksConfig, getRulesConfig, getSkillsConfig, listProviders } from "./store.js";
import { createHooksMiddleware, dispatchHooks, discoverHooks } from "./hooks-service.js";
import { GLOBAL_SKILLS_ROUTE, PROJECT_SKILLS_DIR, SKILL_SOURCE_PRIORITY, SYSTEM_SKILLS_ROUTE, buildSkillMounts, createSkillFilesTool, filterSkillsByMcp, formatSkillNote, globalSkillsDir, listSkills, listSystemSkills, recommendSkills, selectSkills, skillAppliesToMode, skillDirVirtualPath, systemSkillsDir, type SkillInfo, type SkillMode, type SkillSelection } from "./skills-service.js";
import { createPluginAgentTools } from "./tool-executor.js";
import { collectDynamicPluginContext } from "./plugin-lifecycle.js";
import type { PluginMode } from "./plugin-manifest.js";
import { computeCompactionThreshold, compactHistory, compactHistoryWithModel, estimateTokens, estimateMessagesTokens, estimateMessageTokens, estimateToolSchemaTokens, isContextWindowError, trimRunMessages, trimRunMessagesWithRecoveryBrief } from "./context-service.js";
import { microcompactToolResults, shrinkToBudget, shrinkWithBrief } from "./agent/compaction.js";
import { saveArtifact, type ArtifactItem } from "./artifacts-service.js";
import { TrajectoryLogger } from "./trajectory-service.js";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint, errorSummary, isRateLimitError } from "./rate-limit.js";
import { RunCancelledError, getRunAbortSignal } from "./command-service.js";
import { requestCommandApproval } from "./approval-service.js";
import { createHomeMemoryTool, addMemoryFact, removeMemoryFactWithCount, selectRelevantHomeMemory, parseCandidateFacts, capMemoryItems, shouldExtractMemory, type MemoryCandidate } from "./home-memory-service.js";
import { buildHomeTaskContextSummary, createHomeTaskJournal, finishHomeTaskJournal, isHomeTaskContinuation, loadHomeTaskJournal, recordHomeTaskAction, saveHomeTaskJournal, updateHomeTaskContextSummary, type HomeTaskJournal, type HomeTaskPhase } from "./home-task-service.js";
import { validateHomeArtifactContract, selectHomeArtifactCandidates, createArtifactValidationCache } from "./home-artifact-service.js";
import { inspectDeliverables, planItemEvidence, type DeliverableInspection } from "./deliverable-inspect.js";
import { buildFailoverChain, type FailoverTarget } from "./agent/provider-failover.js";
import { createHomeResearchTool } from "./home-research-agent.js";
import { createDeliverableTool } from "./home-deliverables.js";
import { createImageGenTool } from "./image-gen-tool.js";
import { createBackgroundTools } from "./agent/background-jobs.js";
import { decideHomeVerification, responseHasVisualBlocks, hasChartFences, matchChartFences } from "./agent/verify-home.js";
import { buildCodeTaskContextSummary, codeVerificationOutcome, createCodeTaskJournal, finishCodeTaskJournal, inferCodeTaskContract, loadCodeTaskJournal, parseBlockingReviewFindings, recordCodeTaskAction, recordCodeTaskPlan, saveCodeTaskJournal, shouldRunCodeReview, updateCodeTaskContextSummary, type CodeTaskContract, type CodeTaskJournal, type CodeTaskPhase } from "./code-task-service.js";
import type { ProviderConfig } from "./store.js";

import type { AgentContextBreakdownEntry, AgentEvent, AgentMemoryContext, AgentMode, AgentSettings, AgentTaskKind, AgentUsage, AttachmentDoc, HistoryInput, HomeTaskContract, PlanItem } from "./agent-types.js";
import type { TaskComplexity } from "./task-routing.js";
import { buildSystemPrompt, homeRequestNamesFileFormat, inferHomeOutputFormats, inferHomeTaskContract } from "./agent-prompt.js";
import { DoomLoopError, RESEARCH_BUDGET_BASE, RESEARCH_BUDGET_WITH_RESEARCH, loopPreventionMiddleware, resolveResearchBudget } from "./loop-prevention.js";
import { buildVerificationBatch, classifyTaskComplexity, detectPackageManager, findTargetedTests, isContinueRequest, isNewProjectTask, isWebTask, pickAffectedPackageCommands, pickFileScopedVerification, pickVerificationCommands, readPackageJsonCached, shouldSkipMcpForTask } from "./task-routing.js";
import { describeToolCall, extractGithubLogin, extractSkillNameFromPath, loadedSkillNamesFromMessages, toolCallSummary, toolResultExcerpt } from "./tool-describe.js";
import { saveLastRunCheckpoint, summarizeCompletedSteps } from "./run-checkpoint.js";
import type { AgentPromptAsset } from "./prompt-assets.js";
import { extractDiagnosticFeedback, VERIFY_OUTPUT_CAP, HISTORY_CHAR_CAP, textFromMessage, chunkText, tail, compactTablesForMemory, truncateOnLines, firstMeaningfulLine, flattenToolMessageContent } from "./agent/message-utils.js";
import { planItemsFromArgs, buildToolContextBlock } from "./agent/tool-context.js";
import { UsageAccumulator } from "./agent/usage.js";
import { AgentContextRelaunch, MODE_LIMITS, SIMPLE_TASK_LIMIT, HOME_DELIVERABLE_LIMIT, MAX_AGENT_ERROR_RECOVERIES, MAX_BUDGET_EXTENSIONS, MAX_REPAIRS, isRecursionLimitError } from "./agent/loop-limits.js";
import { cleanupHomeScratchFiles } from "./agent/home-files.js";
import { snapshotHomeFiles, findFreshHomeFiles, SCRATCH_SCRIPT_PATTERN, type HomeFileSnapshot } from "./agent/home-files.js";
import { appendEntryLog, PROJECT_MEMORY_RUN_LOG_CAP, SESSION_MEMORY_ENTRY_CAP, SESSION_MEMORY_CHAR_CAP } from "./agent/memory-log.js";
import { prepareContextBudget } from "./agent/context-budget.js";

// Backward-compatible re-exports: main.ts and tests import these from
// agent-service; the implementations now live in the focused modules above.
export type { AgentMode, PlanItem, AgentTurn, HistoryEventItem, HistoryInput, AgentSettings, AgentUsage, AgentEvent, AgentMemoryContext, AgentTaskKind, HomeTaskContract, AttachmentDoc } from "./agent-types.js";
export { inferHomeTaskContract, inferHomeOutputFormats, homeRequestNamesFileFormat } from "./agent-prompt.js";
export { DoomLoopError, RESEARCH_BUDGET_BASE, RESEARCH_BUDGET_WITH_RESEARCH, resolveResearchBudget, normalizeToolCallArgs, loopPreventionMiddleware } from "./loop-prevention.js";
export type { PackageManagerName, PackageManager, TaskComplexity } from "./task-routing.js";
export { detectPackageManager, pickVerificationCommand, pickVerificationCommands, pickAffectedPackageCommands, pickFileScopedVerification, findTargetedTests, buildVerificationBatch, classifyTaskComplexity, shouldSkipMcpForTask, isWebTask, isProjectRunRequest, isNewProjectTask, isContinueRequest } from "./task-routing.js";
export { extractSkillNameFromPath, loadedSkillNamesFromMessages, describeToolCall, extractGithubLogin, toolResultExcerpt } from "./tool-describe.js";
export type { TaskLedger, RunCheckpoint } from "./run-checkpoint.js";
export { getLastRunCheckpoint, saveLastRunCheckpoint, persistLastRunCheckpoint, loadLastRunCheckpoint, clearLastRunCheckpoint, summarizeCompletedSteps } from "./run-checkpoint.js";
export { extractDiagnosticFeedback } from "./agent/message-utils.js";
export { buildToolContextBlock } from "./agent/tool-context.js";
export { MAX_REPAIRS } from "./agent/loop-limits.js";
export { appendEntryLog, PROJECT_MEMORY_RUN_LOG_CAP, SESSION_MEMORY_ENTRY_CAP, SESSION_MEMORY_CHAR_CAP } from "./agent/memory-log.js";

export { RunCancelledError };

// Usage accounting for streamed runs was extracted to ./agent/usage.ts.

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
  /** Final usedTokens from the session's previous run: seeds the meter before
   * the provider reports exact tokens, so the bar never drops back to the
   * text-only estimate on a new request. */
  previousContextTokens?: number | null;
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
  /**
   * Home runs only: receive extracted long-term-memory candidates OFF the
   * run's critical path. When provided, the post-run extraction LLM call
   * (up to ~20s) is detached — the run returns immediately after the answer
   * is complete and the callback applies candidates in the background.
   * Without it, extraction stays inline and candidates are returned in the
   * result payload (headless/eval behavior).
   */
  onMemoryCandidates?: (candidates: MemoryCandidate[]) => Promise<void>;
  /** Controlled evaluation only: omit selected prompt assets from this run. */
  disabledPromptAssets?: AgentPromptAsset[];
}) {
  const { projectRoot, telemetryRoot, sessionId, request: rawRequest, images, attachments, attachmentDocs, importableAttachments, settings, memory, history, agentBackend, onEvent, isCancelled, onHomeMemoryUpdate, onProjectMemoryUpdate, onUserQuestion, onMemoryCandidates } = options;
  // Full Access mode runs every non-denied command without approval prompts.
  // Behaviorally it IS Auto (verify loop, walkthrough artifact, auto-repair),
  // so the mode is normalized for all the generic branches below — only the
  // recursion budget and the system prompt distinguish it.
  const requestedMode = options.mode;
  const fullAccess = requestedMode === "full";
  const mode: AgentMode = fullAccess ? "auto" : requestedMode;
  const { resumeMessages, resumePlanItems, resumeNote, skillsMode, previousContextTokens } = options;
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
  const homeTaskContinuation = isGeneral && isHomeTaskContinuation(request);
  const codeTaskContract = isGeneral ? null : inferCodeTaskContract(request);
  const targetTelemetryRoot = telemetryRoot || projectRoot;
  const signal = sessionId ? getRunAbortSignal(sessionId) : undefined;
  const emit = (type: AgentEvent["type"], text: string, items?: PlanItem[], usage?: AgentUsage, subagent?: SubagentItem, artifact?: ArtifactItem, detail?: string, context?: AgentEvent["context"]) => {
    if (text || items?.length || usage || subagent || artifact || context) onEvent({ type, sessionId: sessionId || "", text, timestamp: new Date().toISOString(), items, usage, subagent, artifact, detail, context });
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
  const effort = settings.effort || settings.reasoningEffort;
  emit("status", `Starting agent · ${provider.label} / ${modelName}${effort ? ` (${effort} effort)` : ""} · ${mode} mode`);
  let llm: ChatClient = await createChatModel(provider, modelName, { reasoningEffort: effort });

  // Mid-run provider failover (Home only): when the active provider exhausts
  // its rate-limit retry budget mid-run, the run swaps to the next configured
  // provider instead of pausing. The checkpointed transcript is
  // provider-agnostic, so only the chat model changes. Ordered by provider
  // list; providers without a usable key are skipped.
  const failoverChain: FailoverTarget[] = isGeneral
    ? await listProviders().then((all) => buildFailoverChain(provider, all)).catch(() => [])
    : [];
  let failoverIndex = 0;

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
  // Home is a presentation-oriented agent. A substantive question needs room
  // to research, collect visual evidence, and compose the full answer rather
  // than being routed through the text-only quick-lookup path. Greetings and
  // short acknowledgements remain lightweight.
  const homeNeedsVisualResponse = isGeneral && Boolean(request.trim()) &&
    !/^(?:hi|hello|hey|thanks?|thank you|ok(?:ay)?|yes|no|good morning|good evening)[!.\s]*$/i.test(request.trim());
  // A "continue" that resumes prior tool state is never a simple task: it
  // needs the full budget, todo tracking and delegation to finish the job.
  const hasResume = Boolean((resumeMessages && resumeMessages.length) || resumeNote);
  let effectiveComplexity: TaskComplexity = hasResume || homeNeedsVisualResponse ? "complex" : complexity;
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
    // folder has no useful symbols). Simple runs skip it too: question-shaped
    // and one-file tasks orient with read/grep directly, and the repo map +
    // project index ride EVERY model call of the run as prompt payload.
    // Never fails the run.
    (isGeneral || effectiveComplexity === "simple"
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
  // Started as a detached promise here and awaited only at prompt assembly:
  // it used to add its full latency (up to 15s) serially to setup, but it is
  // independent of skill scanning / tool assembly, which now overlap it.
  let identityNote: string | null = null;
  // Note: "repositories" must match — repos?\b alone fails on it ("repos"
  // is followed by "i", not a word boundary), hence the repositor alternative.
  const identityNotePromise: Promise<string | null> =
    /github|repositor|\brepos?\b|pull request|\bprs?\b|issues?|gists?/i.test(request)
      ? (async () => {
          const meTool = mcpTools.find((t: any) => typeof t?.name === "string" && /^get_me$/i.test(t.name));
          if (!meTool || typeof meTool.execute !== "function") return null;
          try {
            const raw = await withSetupTimeout(Promise.resolve(meTool.execute({})), 15000, "GitHub identity");
            const login = extractGithubLogin(raw);
            if (login) {
              emit("status", `GitHub identity · ${login}`);
              return `[Authenticated GitHub user (resolved via the GitHub MCP get_me tool — do NOT ask the user for their username): ${login}]`;
            }
          } catch { /* identity stays unknown; model falls back to tools */ }
          return null;
        })()
      : Promise.resolve(null);
  if (rulesResult.hasRules && !isGeneral) {
    emit("status", `Loaded ${rulesResult.ruleFiles.length} project rule file${rulesResult.ruleFiles.length === 1 ? "" : "s"} (${rulesResult.ruleFiles.map((r) => r.filename).join(", ")})`);
  }
  if (projectInstructions.files.length && !isGeneral) {
    emit("status", `Loaded project instructions (${projectInstructions.files.map((f) => f.name).join(", ")})`);
  }

  let codeJournal: CodeTaskJournal | null = null;
  let codeJournalWrite = Promise.resolve();
  const queueCodeJournalWrite = (next: CodeTaskJournal) => {
    codeJournal = updateCodeTaskContextSummary(next);
    if (isGeneral || !sessionId) return;
    const snapshot = codeJournal;
    codeJournalWrite = codeJournalWrite
      .then(() => saveCodeTaskJournal(projectRoot, snapshot))
      .catch(() => undefined);
  };
  const runCommand = async (command: string) => {
    try {
      const result = await Promise.resolve((agentBackend as any)?.execute?.(command));
      if (!isGeneral && codeJournal?.phase === "verification") {
        const exitCode = Number((result as any)?.exitCode);
        queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
          tool: "verification",
          summary: `${exitCode === 0 ? "Passed" : (result as any)?.approvalDenied ? "Approval denied" : "Failed"}: ${command}`,
          result: String((result as any)?.output ?? "").slice(-700) || undefined,
          progressed: exitCode === 0,
          phase: "verification",
          verification: { command, passed: exitCode === 0, output: String((result as any)?.output ?? "").slice(-1200) || undefined },
        }));
      }
      return result;
    } catch (error) {
      const result = { output: error instanceof Error ? error.message : String(error), exitCode: 1, truncated: false };
      if (!isGeneral && codeJournal?.phase === "verification") {
        queueCodeJournalWrite(recordCodeTaskAction(codeJournal, {
          tool: "verification",
          summary: `Failed: ${command}`,
          result: result.output.slice(-700),
          progressed: false,
          phase: "verification",
          verification: { command, passed: false, output: result.output.slice(-1200) },
        }));
      }
      return result;
    }
  };

  const skills = skillsConfig.enabled ? [PROJECT_SKILLS_DIR, GLOBAL_SKILLS_ROUTE, SYSTEM_SKILLS_ROUTE] : [];
  let globalSkillsBackend: AgentBackend | null = null;
  let systemBackend: AgentBackend | null = null;
  if (skills.length) {
    globalSkillsBackend = createSkillBackend({
      rootDir: globalSkillsDir(),
      id: "global-skills",
      readOnly: mode === "plan",
      readOnlyReason: `Plan mode is read-only: skill writes disabled`,
    });
    // Bundled system skills: always read-only, in every mode including auto.
    try {
      systemBackend = createSkillBackend({
        rootDir: systemSkillsDir(),
        id: "system-skills",
        readOnly: true,
        readOnlyReason: "System skills are read-only",
      });
    } catch { /* no system skills shipped */ }
  }
  let compositeBackend: AgentBackend = agentBackend as AgentBackend;
  if (skills.length) {
    const composite = new CompositeAgentBackend({ rootDir: projectRoot, id: `workspace-composite-${sessionId || "run"}` });
    for (const [prefix, mountBackend] of Object.entries(buildSkillMounts(globalSkillsBackend, systemBackend))) {
      composite.mount(prefix, mountBackend);
    }
    compositeBackend = composite;
  }

  // Skill catalog: tell the agent about every skill installed for this mode,
  // best match first, and let it read the one that fits. Keyword matching
  // only orders the list — it never decides what the agent gets to see,
  // because "generate me a presentation" shares almost no tokens with a
  // pptx skill's description while being exactly that skill's job. Models —
  // especially small ones — also skip catalogs, so the System Note repeats
  // the same list with read paths and marks the likely matches READ FIRST.
  // Per-skill mode scoping applies throughout: only skills enabled for this
  // run's mode are advertised, and skills scoped to other modes are
  // explicitly off-limits.
  let skillNote: string | null = null;
  let eligibleSkillCatalog: SkillInfo[] = [];
  let mountedSkillCatalog: SkillInfo[] = [];
  const skillListings: SkillListing[] = [];
  if (skillsConfig.enabled) {
    try {
      const fullCatalog = [...(await listSkills(projectRoot)), ...(await listSystemSkills().catch(() => []))];
      const modeEligible = skillsMode ? fullCatalog.filter((s) => skillAppliesToMode(s, skillsMode)) : fullCatalog;
      // MCP-dependent skills stay mounted and materializable, but drop out of
      // the shortlist when their server isn't connected (REQUIRED_MCP_SKILLS).
      const selection = selectSkills(modeEligible, request);
      eligibleSkillCatalog = selection.catalog;
      // The framework lists every directory passed in `skills` and skips
      // malformed frontmatter per file (it never throws), so mounting the
      // whole eligible catalog is safe — and it is what puts the full list in
      // the system message instead of only the lexical matches.
      mountedSkillCatalog = selection.catalog;
      for (const skill of mountedSkillCatalog) skillListings.push({ name: skill.name, description: skill.description, path: skillDirVirtualPath(skill) });
      const offLimits = skillsMode ? fullCatalog.filter((s) => !skillAppliesToMode(s, skillsMode)) : [];
      const forced = selection.forced || [];
      const forcedNames = new Set(forced.map((s) => s.name.toLowerCase()));
      const recs = recommendSkills(filterSkillsByMcp(selection.catalog, mcpResult.ok ? mcpResult.serverNames : []), request, 3);
      const combinedRecommended = [
        ...forced,
        ...recs.filter((s) => !forcedNames.has(s.name.toLowerCase())),
      ].slice(0, Math.max(forced.length, 3));
      const selectionForNote: SkillSelection = {
        catalog: selection.catalog,
        recommended: combinedRecommended,
        forced: selection.forced,
      };
      skillNote =
        formatSkillNote(selectionForNote, {
          modeLabel: skillsMode,
          offLimits,
          offLimitsSystemCount: offLimits.length - offLimits.filter((s) => s.source !== "system").length,
        }) || null;
    } catch { /* skills are advisory — never fail a run */ }
  }
  // Framework skill loading is scoped to eligible skills only: the mounted
  // parent directories would expose every skill to the model regardless of
  // mode, so pass direct per-skill paths instead. Sources are ordered
  // project < global < system so the framework's "(higher priority)" marker
  // keeps meaning "later wins". skillDirVirtualPath is backend-safe:
  // global/system resolve through the composite mounts, project through the
  // workspace backend.
  const skillDirs = mountedSkillCatalog
    .slice()
    .sort((a, b) => SKILL_SOURCE_PRIORITY[b.source] - SKILL_SOURCE_PRIORITY[a.source])
    .map(skillDirVirtualPath);

  // Project hooks (.nexus/hooks.json) behind a global toggle: run:start/end,
  // tool:before (deny-capable) / tool:after, verify:fail. Hook failures are
  // reported, never fatal. Plugin hooks honor their manifest `modes`.
  const hooks = (await getHooksConfig().catch(() => ({ enabled: true }))).enabled
    ? await discoverHooks(projectRoot, skillsMode).catch(() => [])
    : [];
  const hooksMiddleware = createHooksMiddleware({ projectRoot, hooks, runId: sessionId });

  const wantsBrowser = isWebTask(request);
  // Adaptive research budget: tasks that need the latest docs/facts get room
  // to browse (20), produce-from-local-context tasks get a tight budget (8)
  // so the agent switches to creating. Non-deliverable tasks are unbudgeted.
  // Enforced SOLELY by loopPreventionMiddleware (isResearchTool covers
  // web_search, web_image_search, and the browser tools): the old
  // beforeSearch/beforeRead closure counted the same calls a second time,
  // halving the effective budget and duplicating the intervention message.
  // Home general runs always get the browser + free web search: research is
  // core to that mode, not an edge case.
  // Edit-approval gate (opt-in via AppSettings.editPolicy or the run options):
  // applied at all three mutation paths — backend write/edit/delete (see
  // getAgentBackend), apply_patch, and materialize_skill_files. Full Access
  // mode never asks: mutations run like any other command (guardrail deny
  // lists still apply).
  const editGate = options.editPolicy === "ask" && !fullAccess
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
  const allCodeTools = createCodeIntelligenceTools(projectRoot, { readOnly: mode === "plan", beforeEdit: editGate });
  const browserTools = wantsBrowser || isGeneral
    ? createBrowserTools(projectRoot, {
        agentBrowser: {
          inspect: (url) => agentBrowserService.inspect(url, { sessionId, scope: isGeneral ? "home" : "code" }),
          act: (input) => agentBrowserService.act(input, projectRoot, { sessionId, scope: isGeneral ? "home" : "code", openInBrowser: input.openInBrowser }),
        },
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
    // Mirror every search into the built-in browser so it is visible there
    // (Watching follows it live, otherwise the follow banner shows it).
    // Fire-and-forget: results come from the search API, never the mirror.
    onSearch: (_query, url) => {
      void agentBrowserService.visit(url, { sessionId, scope: isGeneral ? "home" : "code" }).catch(() => {});
    },
  });
  // Home can search for illustrative image results and embed selected ones
  // in its Markdown response. Image lookups are charged to the same research
  // cap by loopPreventionMiddleware (isResearchTool).
  const webImageSearchTools = isGeneral
    ? createWebImageSearchTools({
        onSearch: (_query, url) => {
          void agentBrowserService.visit(url, { sessionId, scope: isGeneral ? "home" : "code" }).catch(() => {});
        },
      })
    : [];
  const webVideoSearchTools = isGeneral ? createWebVideoSearchTools({}) : [];
  const usage = new UsageAccumulator();
  let recursionLimit = isSimple
    ? SIMPLE_TASK_LIMIT
    : (isGeneral && homeTaskContract?.expectsOutput)
      ? HOME_DELIVERABLE_LIMIT
      : MODE_LIMITS[fullAccess ? "full" : mode];
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
  // Plan phase gate for complex work applies to BOTH modes: Code change
  // requests, and Home requests whose contract expects an observable output
  // (document, dataset, multi-part deliverable). Chat-shaped Home questions
  // (research, explanations) are exempt — no todo plan needed there.
  let initialHomeFiles: HomeFileSnapshot = new Map();
  // Memoizes jszip/pdf-parse validation results per (path, size, mtime) for
  // the three Home validation sites below (loop gate, verify node,
  // recursion short-circuit) so a deliverable is fully parsed at most once
  // per (re)write instead of on every modify tool call.
  const homeArtifactCache = isGeneral ? createArtifactValidationCache(projectRoot) : null;
  if (isGeneral) {
    try {
      initialHomeFiles = await snapshotHomeFiles(projectRoot);
    } catch { /* baseline is best effort */ }
  }

  // Plan phase gate for complex work: Code changes require a plan gate.
  // Home tasks require a plan gate ONLY when multiple deliverables are expected.
  // Single-deliverable Home tasks (e.g. 1 pptx/docx deck) should generate directly without forcing multi-phase todos.
  const requiresPlanGate =
    mode !== "plan" &&
    effectiveComplexity === "complex" &&
    Boolean(
      isGeneral
        ? (homeTaskContract?.expectsOutput && (homeTaskContract?.expectedFormats?.length ?? 0) > 1)
        : codeTaskContract?.expectsChanges
    );
  const beforeCodeModify = () => requiresPlanGate && !codePlanReady
    ? "[PHASE GATE] This is a complex request and no execution plan exists yet. Create a concrete todo plan with write_todos first, then implement the first item. Do not produce the deliverable before the plan is recorded."
    : null;

  const checkDeliverableReady = async () => {
    if (!isGeneral || !homeTaskContract?.expectsOutput || !homeArtifactCache) return null;
    const currentFresh = await findFreshHomeFiles(projectRoot, initialHomeFiles, runStartMs);
    if (!currentFresh.length) return null;
    const contract = await homeArtifactCache.contract(currentFresh, homeTaskContract?.expectedFormats);
    if (contract.valid) {
      return {
        ready: true,
        files: currentFresh,
        summary: `verified format(s): ${(homeTaskContract?.expectedFormats || []).join(", ") || "document"}`,
      };
    }
    return null;
  };
  const subagentTool = createSubagentDelegationTool({
    projectRoot,
    provider,
    modelName,
    projectRecord: { id: "current", name: "current", root: projectRoot },
    mcpTools,
    skills: skillDirs,
    skillListings,
    skillsBackend: compositeBackend,
    fullAccess,
    onEvent: (subEvent) => {
      usage.addSubagent(subEvent.subagent.usage);
      emit("subagent", subEvent.type === "subagent_start" ? `Delegated task to ${subEvent.subagent.role} subagent` : subEvent.type === "subagent_finish" ? `Subagent [${subEvent.subagent.role}] completed` : `Subagent working...`, undefined, undefined, subEvent.subagent);
    },
    isCancelled,
    runId: sessionId,
  });

  // Home research firewall (G2): one `research` tool that runs broad research
  // in a fresh-context read-only subagent and returns a bounded digest, so
  // dozens of search results never flood the main conversation (the Tokyo
  // Ghoul failure class). Bound for non-simple Home runs only.
  const homeResearchTool =
    isGeneral && !isSimple && effectiveComplexity !== "simple"
      ? [
          createHomeResearchTool({
            projectRoot,
            provider,
            modelName,
            reasoningEffort: effort,
            researchTools: [...webSearchTools, ...webImageSearchTools, ...webVideoSearchTools, ...safeBrowserTools.filter((candidate: any) => candidate?.name === "browser_inspect")],
            onEvent: (subEvent) => {
              usage.addSubagent(subEvent.subagent.usage);
              emit("subagent", subEvent.type === "subagent_start" ? "Delegated research to a fresh-context subagent" : subEvent.type === "subagent_finish" ? "Research subagent completed" : "Research subagent working...", undefined, undefined, subEvent.subagent);
            },
            onUsage: (subUsage) => usage.addSubagent(subUsage),
            isCancelled,
            runId: sessionId,
          }),
        ]
      : [];

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

  const activePluginMode: PluginMode = (skillsMode as PluginMode) || (isGeneral ? "home" : "code");
  const pluginTools = createPluginAgentTools({
    mode: activePluginMode,
    runId: sessionId,
    projectRoot,
    signal,
    requestApproval: async (summary: string) => {
      const decision = await requestCommandApproval({
        runId: sessionId,
        approvalKey: `plugin-tool:${summary}`,
        command: summary,
        cwd: projectRoot,
        reason: `A plugin requested execution of sensitive tool: ${summary}`,
      });
      return decision !== "deny";
    },
  });

  if (pluginTools.length > 0) {
    const names = pluginTools.map((t: any) => t?.name).filter(Boolean);
    const shown = names.slice(0, 10).join(", ");
    const extra = names.length > 10 ? ` (+${names.length - 10} more)` : "";
    emit("status", `Loaded ${pluginTools.length} plugin tool${pluginTools.length === 1 ? "" : "s"}: ${shown}${extra}`);
  }

  const dynamicPluginContext = await collectDynamicPluginContext({
    mode: activePluginMode,
    projectRoot,
  }).catch(() => "");

  // Hoisted so the context breakdown can measure the meta-context share (the
  // memory/rules/repo-map sections embedded inside the system prompt).
  const promptMemory = isGeneral && memory.projectMemory
    ? { projectMemory: selectRelevantHomeMemory(memory.projectMemory, request, 4000), sessionMemory: memory.sessionMemory, facts: memory.facts }
    : memory;
  // Full role catalog only where delegate_task is actually bound — simple
  // runs drop the tool, Home runs never mention delegation.
  const subagentCatalogText = assetsEnabled("agents") && !isGeneral && effectiveComplexity !== "simple" ? buildSubagentCatalog(projectRoot) : "";
  const systemPromptText = buildSystemPrompt(
    mode,
    projectRoot,
    provider.label,
    modelName,
    promptMemory,
    rulesResult.combinedPromptSection,
    effectiveComplexity,
    isNewProject,
    taskKind,
    repoMapSection,
    homeTaskContract,
    subagentCatalogText,
    projectInstructions.section,
    dynamicPluginContext,
    fullAccess
  );

  // Background execution (G4): long builds/installs/dev-servers start without
  // blocking the turn; the model collects results via job_status. Same
  // policy/approval pipeline as the foreground execute tool. Not in plan mode
  // (read-only).
  const backgroundTools = mode === "plan"
    ? []
    : createBackgroundTools({ projectRoot, runId: sessionId, fullAccess });

  // Deterministic deliverable engine (Home): standard document formats render
  // from the model's Markdown CONTENT — no model-authored Python, no pip, no
  // one-shot script risk. Small models write content, not code.
  const homeDeliverableTool = isGeneral
    ? [createDeliverableTool({
        projectRoot,
        request,
        runId: sessionId,
        beforeEdit: editGate ? (info) => editGate(info) : undefined,
        onArtifact: (art) => {
          emit("artifact", `Generated deliverable ${art.filename}`, undefined, undefined, undefined, art);
        },
      })]
    : [];
  // Neural image generation (OpenAI/Imagen) — bound only when the run's
  // provider can actually serve an image endpoint.
  const imageGenTool = (() => {
    if (!isGeneral) return [];
    try {
      const genTool = createImageGenTool({ projectRoot, provider, beforeEdit: editGate ? (info) => editGate(info) : undefined });
      return genTool ? [genTool] : [];
    } catch {
      return [];
    }
  })();
  const builtinTools = [...codeTools, ...editTools, ...skillFilesTools, questionTool, ...safeBrowserTools, ...webSearchTools, ...webImageSearchTools, ...webVideoSearchTools, ...homeResearchTool, ...homeMemoryTool, ...projectMemoryTool, ...backgroundTools, ...homeDeliverableTool, ...imageGenTool];
  if (homeDeliverableTool.length) {
    emit("status", "Loaded create_deliverable · deterministic docx/pptx/xlsx/pdf/tex rendering from Markdown content");
  }
  // Agent-core filesystem tools over the composite backend (deepagents
  // built-ins port) + todo planning (todoListMiddleware parity): planning is
  // dropped on the simple-task fast path, like the old middleware.
  const filesystemTools = createFilesystemTools(compositeBackend);
  const todoTools = isSimple ? [] : [createTodoTool()];
  const loopSystemPrompt = `${systemPromptText}${buildSkillsSection(skillListings, skills.length ? [PROJECT_SKILLS_DIR, GLOBAL_SKILLS_ROUTE, SYSTEM_SKILLS_ROUTE] : undefined)}`;
  const boundTools = [...filesystemTools, ...builtinTools, ...(assetsEnabled("agents") && !isSimple ? [subagentTool] : []), ...todoTools, ...mcpTools, ...pluginTools];

  // Agent construction is a closure so mid-run provider failover can rebuild
  // the graph around a new chat model — everything else (backend, tools,
  // prompt) is provider-independent and shared.
  // Agent middleware (agentcore contract): loop prevention rides wrapToolCall;
  // tool-argument normalization runs inside the loop via normalizeArgs; the
  // todo plan is a plain write_todos tool (todoListMiddleware parity); hooks
  // enforcement rides wrapToolCall too.
  const agentMiddlewares: AgentMiddleware[] = [
    loopPreventionMiddleware({
      general: isGeneral,
      outputRequired: Boolean(homeTaskContract?.expectsOutput),
      needsResearch: homeTaskContract?.needsResearch,
      beforeModify: beforeCodeModify,
      checkDeliverableReady,
    }),
    ...(hooksMiddleware ? [hooksMiddleware] : []),
  ];

  // Basename fallback: stored windows are keyed by bare model names
  // (e.g. "qwen3-coder") while OpenRouter-style ids carry a prefix
  // ("openai/gpt-5.5"). resolveModelContextWindow already handles basename
  // matching; the stored-config check must match that behavior too.
  const modelBasename = (modelName || "").includes("/") ? modelName.split("/").pop()! : (modelName || "");
  const modelContextWindow =
    settings.contextWindow ??
    provider.modelContextWindows?.[modelName] ??
    provider.modelContextWindows?.[modelBasename] ??
    resolveModelContextWindow(provider.id, modelName, provider);

  const modelMaxOutput =
    settings.maxOutput ??
    provider.modelMaxOutputs?.[modelName] ??
    provider.modelMaxOutputs?.[modelBasename] ??
    resolveModelMaxOutput(provider.id, modelName, provider);

  // Context budget + auto-compaction: computed in agent/context-budget.ts
  // (extracted verbatim; no behavior change). All downstream budget/breakdown
  // consumers use the destructured values below.
  const contextBudget = await prepareContextBudget({
    modelContextWindow,
    modelMaxOutput,
    systemPromptText,
    mcpTools,
    pluginTools,
    boundTools,
    mountedSkillCatalog,
    metaContextInputs: [
      promptMemory.projectMemory,
      promptMemory.sessionMemory,
      promptMemory.facts,
      rulesResult.combinedPromptSection,
      repoMapSection,
      projectInstructions.section,
      subagentCatalogText,
      dynamicPluginContext,
    ],
    history,
    isSimple,
    llm,
    isGeneral,
    emit,
    onEvent: (e) => onEvent({
      type: "status",
      sessionId: e.sessionId,
      text: e.text,
      timestamp: new Date().toISOString(),
      usage: { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, totalTokens: e.usage.totalTokens, estimatedCost: null },
    }),
    sessionId,
  });
  const { compactedHistory, promptOverheadTokens, compactionThreshold, outputReserve } = contextBudget;
  const { systemPromptTokens, mcpToolsTokens, pluginToolsTokens, systemToolsTokens, skillsTokens, metaContextTokens } = contextBudget;
  const { targetBudget, estimatedHistoryTokens, historyBudget, projectedHistoryTokens } = contextBudget;
  const priorMessages: ChatMessage[] = compactedHistory.map((turn) =>
    turn.role === "assistant"
      ? assistantMsg(tail(turn.text, HISTORY_CHAR_CAP))
      : userMsg(tail(turn.text, HISTORY_CHAR_CAP))
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
  let homeRecoveryContext = "";
  if (isGeneral && sessionId && homeTaskContinuation) {
    const priorHomeTask = await loadHomeTaskJournal(projectRoot, sessionId);
    if (priorHomeTask && priorHomeTask.status !== "completed") {
      homeRecoveryContext = priorHomeTask.contextSummary || buildHomeTaskContextSummary(priorHomeTask);
    }
  }
  // GitHub identity note resolved here (fire-and-forget until now) so its
  // latency overlapped skill scanning and tool assembly instead of adding to
  // setup serially.
  identityNote = await identityNotePromise;
  const requestText = [request, homeRecoveryContext, identityNote, resumeNote, skillNote, imageNote, docNote, importNote].filter(Boolean).join("\n\n");
  let initialHumanMessage: ChatMessage;
  if (images && images.length > 0) {
    const contentParts: any[] = [{ type: "text", text: requestText }];
    for (const img of images) {
      contentParts.push({ type: "image", url: img });
    }
    initialHumanMessage = userMsg(contentParts);
  } else {
    initialHumanMessage = userMsg(requestText);
  }

  const estimatedFallbackInputTokens = Math.max(
    1,
    Math.round(
      (priorMessages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) + request.length + 1500) / 4
    )
  );

  let runMessages: ChatMessage[] = [...priorMessages, initialHumanMessage];
  // Same-session tool memory (OpenCode/Pi-style): when this run starts
  // WITHOUT a full checkpoint behind it, fold the session's recent tool
  // activity (calls + truncated results, plans, errors) into a context block
  // so the model reuses prior reads instead of re-reading the same files.
  // Resume runs skip this — their checkpoint already carries full tool
  // messages and the block would only duplicate them.
  if (!resumeMessages?.length) {
    const toolContext = buildToolContextBlock(history);
    if (toolContext) runMessages = [...priorMessages, userMsg(toolContext), initialHumanMessage];
  }
  // Cross-run resume: seed the conversation with the previous run's full
  // tool history so "continue" proceeds instead of restarting. Prune any
  // trailing unanswered tool calls the same way mid-stream retries do.
  if (resumeMessages && resumeMessages.length) {
    const clean = sanitizeResumeCheckpoint([...resumeMessages]);
    runMessages = [...clean, initialHumanMessage] as ChatMessage[];
    if (hasResume) emit("status", `Resuming prior run · ${clean.length} checkpointed message(s) restored`);
  }

  // Real run-start context budget: the old estimate only summed persisted
  // turn texts and ignored the (large) system prompt, tool schemas, tool
  // results and image/attachment payloads — so runs started over budget and
  // 4xx'd at the first model call with no compaction. Estimate the ACTUAL
  // payload (system prompt + every message, tool-call args included) and
  // trim older history when it approaches the window.
  const contextMessageBudget = Math.max(1500, compactionThreshold - promptOverheadTokens - outputReserve);
  // Composition of the outgoing prompt payload, largest category first with
  // Messages pinned last (even at 0) — the hover-card breakdown. Shares are
  // computed against the row total in the renderer.
  // Per-run token-estimate memo: LangGraph emits the FULL message array on
  // every superstep ("values" mode), and the meter + relaunch projection
  // re-estimated every message each time — O(n) per superstep, O(n²) per run.
  // Message objects are immutable and reused across supersteps, so a WeakMap
  // estimate makes the repeated scans O(n) total. A recreated object simply
  // misses the cache and is estimated as before.
  const messageTokensMemo = new WeakMap<object, number>();
  const estimateMessageTokensMemo = (message: any): number => {
    if (message && typeof message === "object") {
      const hit = messageTokensMemo.get(message);
      if (hit !== undefined) return hit;
      const tokens = estimateMessageTokens(message);
      messageTokensMemo.set(message, tokens);
      return tokens;
    }
    return estimateMessageTokens(message);
  };
  const estimateMessagesTokensMemo = (messages: any[]): number =>
    (messages || []).reduce((sum, m) => sum + estimateMessageTokensMemo(m), 0);
  const contextBreakdown = (messages: any[]): AgentContextBreakdownEntry[] => {
    const rows = [
      { label: "System tools", tokens: systemToolsTokens },
      ...(mcpTools.length ? [{ label: "MCP tools", tokens: mcpToolsTokens }] : []),
      ...(pluginTools.length ? [{ label: "Plugin tools", tokens: pluginToolsTokens }] : []),
      { label: "System prompt", tokens: Math.max(0, systemPromptTokens - metaContextTokens) },
      ...(mountedSkillCatalog.length ? [{ label: "Skills", tokens: skillsTokens }] : []),
      ...(metaContextTokens > 0 ? [{ label: "Meta context", tokens: metaContextTokens }] : []),
    ].filter((row) => row.tokens > 0);
    rows.sort((a, b) => b.tokens - a.tokens);
    rows.push({ label: "Messages", tokens: estimateMessagesTokensMemo(messages) });
    return rows;
  };
  const currentContext = (messages: any[]) => {
    const estimatedTokens = promptOverheadTokens + estimateMessagesTokensMemo(messages);
    // Keep the session's context meter on the same retained-context scale the
    // automatic trigger uses (no output reserve on either side), so compaction
    // fires exactly when the meter reads the threshold. Exact provider input
    // belongs to this invocation only, while the next user request will also
    // restore prior history.
    const exactInputTokens = usage.hasObservedInputTokens ? usage.observedInputTokens : 0;
    // Carry the session's previous run's final context: the text-only estimate
    // misses large tool-result payloads, so without this the meter visibly
    // drops on every new request until the provider reports exact tokens.
    const carriedTokens = previousContextTokens && previousContextTokens > 0 ? previousContextTokens : 0;
    // Run-cumulative cache accounting for the hover card: hit rate =
    // cacheRead / cacheInput (provider-reported; absent when unsupported).
    const runInputTokens = usage.cumulativeInputTokens;
    const cacheReadTokens = usage.cacheReadTokens;
    const cacheCreationTokens = usage.cacheCreationTokens;
    const withCache = runInputTokens > 0 && (cacheReadTokens > 0 || cacheCreationTokens > 0);
    return {
      usedTokens: Math.max(estimatedTokens, exactInputTokens, carriedTokens),
      contextWindow: modelContextWindow,
      compactionThreshold,
      estimated: exactInputTokens <= 0,
      breakdown: contextBreakdown(messages),
      ...(withCache ? {
        cacheInputTokens: runInputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      } : {}),
    };
  };
  const emitContext = (messages: any[], compacted = false) => {
    const snapshot = currentContext(messages);
    if (compacted) snapshot.usedTokens = Math.max(estimateMessagesTokensMemo(messages), Math.min(snapshot.usedTokens, compactionThreshold));
    emit("context", "", undefined, undefined, undefined, undefined, undefined, snapshot);
  };
  if (!isSimple && runMessages.length > 0) {
    const initialTokens = estimateMessagesTokensMemo(runMessages);
    if (promptOverheadTokens + initialTokens >= compactionThreshold) {
      const pct = Math.round(((promptOverheadTokens + initialTokens) / Math.max(1, modelContextWindow)) * 100);
      emit("status", `Context near limit at start (~${pct}% of ${formatContextWindow(modelContextWindow)}) — condensing earlier context…`);
      if (contextMessageBudget <= 1500) {
        throw new Error(
          `Model context window (${formatContextWindow(modelContextWindow)}) is too small for this run even after compaction — the system prompt plus output reserve need more headroom. Pick a model with a larger context window or increase the context limit in Settings → Providers.`
        );
      }
      runMessages = shrinkToBudget(runMessages, contextMessageBudget).messages;
      const afterTokens = estimateMessagesTokensMemo(runMessages);
      const freedTokens = Math.max(0, initialTokens - afterTokens);
      emit("status", `Context condensed: ~${formatTokenCount(initialTokens)} → ~${formatTokenCount(afterTokens)} tokens (${formatTokenCount(freedTokens)} freed)`);
    }
  }
  emitContext(runMessages, estimatedHistoryTokens >= compactionThreshold);
  let lastPlanItems: PlanItem[] | null = resumePlanItems ?? null;
  if (hasResume && resumePlanItems && resumePlanItems.length > 0) {
    emit("plan", "Resumed working plan", resumePlanItems);
  }
  let retryCount = 0;
  let lastCheckpointSaveMs = 0;
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
    homeJournal = updateHomeTaskContextSummary(next);
    if (!isGeneral) return;
    const snapshot = homeJournal;
    homeJournalWrite = homeJournalWrite
      .then(() => saveHomeTaskJournal(projectRoot, snapshot))
      .catch(() => undefined);
  };
  if (isGeneral && sessionId && homeTaskContract) {
    const previous = homeTaskContinuation ? await loadHomeTaskJournal(projectRoot, sessionId) : null;
    homeJournal = previous && previous.status !== "completed"
      ? { ...previous, status: "active", completedAt: undefined }
      : createHomeTaskJournal({
          sessionId,
          goal: request,
          expectsOutput: homeTaskContract.expectsOutput,
          needsResearch: homeTaskContract.needsResearch,
        });
    if (previous && previous.status !== "completed") {
      homeJournal = {
        ...homeJournal,
        goal: previous.goal,
        expectsOutput: previous.expectsOutput || homeTaskContract.expectsOutput,
        needsResearch: previous.needsResearch || homeTaskContract.needsResearch,
      };
    }
    queueHomeJournalWrite(homeJournal);
  }
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
  if (!isGeneral) {
    try {
      const before = await getWorkspaceDiffFiles(projectRoot);
      for (const d of before) initialDiff.set(d.path, diffFingerprint(d));
    } catch { /* baseline is best-effort; verify falls back to full diff */ }
  } else if (!initialHomeFiles.size) {
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
    progress.beginAttempt(runMessages.length);

    // Provider-safety boundary: tool results must be string-content on the
    // wire (see flattenToolMessageContent). Runs once per stream attempt, so
    // legacy tool messages from resumes AND failovers are all normalized
    // before the provider ever sees them. (Fresh loop results are
    // string-only by construction.)
    let messagesToStream: ChatMessage[] = runMessages;
    const wireMessages = flattenToolMessageContent(messagesToStream);
    if (wireMessages.flattened > 0) {
      runMessages = wireMessages.messages;
      messagesToStream = runMessages;
      if (retryCount === 1) {
        emit("status", `Normalized ${wireMessages.flattened} structured tool result(s) to plain text${wireMessages.omittedImages ? ` (${wireMessages.omittedImages} inline image(s) referenced by path instead)` : ""} for provider compatibility`);
      }
    }
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
      messagesToStream = [...runMessages, userMsg(resumeNotice)];
    }
    void messagesToStream;

    // Loop step budget: the old LangGraph recursionLimit counted supersteps
    // (model node + tool node per call, so ~2-3 supersteps per tool call);
    // the self-built loop counts model invocations, so the same ceiling maps
    // to roughly half.
    const stepBudget = Math.max(8, Math.ceil(recursionLimit / 2));
    let sawToolCalls = false;
    let finalAnswer = "";

    for await (const event of runAgentLoop({
      client: llm,
      system: loopSystemPrompt,
      messages: runMessages,
      tools: boundTools,
      middleware: agentMiddlewares,
      stepBudget,
      signal,
      runId: sessionId,
      normalizeArgs: (call) => normalizeToolCallArgs(call, projectRoot),
      onEvent: (event: AgentLoopEvent) => {
        if (isCancelled() || signal?.aborted) throw new RunCancelledError();
        if (event.type === "token") {
          // Counted only as a fallback; finalize ignores it when the
          // provider reported exact output usage.
          unaccountedOutputChars += event.delta.length;
          emit("token", event.delta);
        } else if (event.type === "thinking") {
          emit("thinking", event.delta);
        } else if (event.type === "usage") {
          usage.noteUsage(event.usage);
        } else if (event.type === "tool_call") {
          handleToolCallEvent(event.call);
        } else if (event.type === "tool_result") {
          sawToolCalls = true;
          handleToolResultEvent(event.call, event.result, event.isError);
        } else if (event.type === "step") {
          emitContext(event.messages);
          // Mid-run context pressure (Claude-Code-style): the run only grows,
          // so when EITHER the provider-reported input of the last model call
          // OR the projected next request crosses the threshold, the next call
          // is expected to fail. Stop at this consistent step boundary,
          // condense, and relaunch — tool results already committed are kept.
          if (!isSimple) {
            const projectedTokens = promptOverheadTokens + estimateMessagesTokensMemo(event.messages);
            const measuredTokens = usage.observedInputTokens;
            if (measuredTokens >= compactionThreshold || projectedTokens >= compactionThreshold) {
              throw new AgentContextRelaunch(
                `measured ${formatTokenCount(measuredTokens)}, projected ${formatTokenCount(projectedTokens)} >= threshold ${formatTokenCount(compactionThreshold)}`
              );
            }
          }
        } else if (event.type === "done") {
          finalAnswer = event.answer;
          emitContext(event.messages);
        }
      },
    })) {
      void event;
    }

    // Silent SSE failure (seen with OpenRouter): the provider can return an
    // error payload INSIDE a 200 response and the stream simply ends — no
    // exception, and the final answer carries neither text nor tool calls.
    // That must never be fabricated into a canned "success": raise it as a
    // transient "empty response" error so withAgentRetry re-attempts the
    // stream, and if retries exhaust, the run fails honestly instead.
    if (!finalAnswer && sawToolCalls) {
      // The model did the tool work but its final turn arrived without text
      // (gateway dialect or a silent stream cut). Recover the last non-empty
      // assistant message from the transcript before giving up — the answer
      // often exists there even when the done event carried none.
      for (let i = runMessages.length - 1; i >= 0; i--) {
        const m = runMessages[i];
        if (m?.role !== "assistant") continue;
        const recovered = textJoined(m).trim();
        if (recovered) { finalAnswer = recovered; break; }
      }
    }
    if (!finalAnswer) {
      // Honest failure (retried by withAgentRetry, checkpoint preserved) —
      // never fabricate a canned "completed" response over missing output.
      throw new Error(`Provider returned an empty response (silent stream failure): the final model message has no text${sawToolCalls ? " after tool execution" : " and no tool calls"} after ${runMessages.length} messages.`);
    }
    return finalAnswer;
  };

  // Per-event handling for tool calls/results (single emission now — the old
  // seenToolCallIds/seenToolResultIds dedup sets existed for LangGraph
  // superstep replays, which the self-built loop does not emit).
  const handleToolCallEvent = (call: ToolCall) => {
    toolCallCount++;
    const name = call?.name || "tool";
    lastActiveToolName = name;
    if (name === "read_file" || name === "read_file_range") {
      const filePath = String((call?.args as any)?.file_path || (call?.args as any)?.filePath || (call?.args as any)?.file || (call?.args as any)?.path || "");
      lastActiveToolSkill = extractSkillNameFromPath(filePath);
    } else {
      lastActiveToolSkill = null;
    }
    if (/todo|plan/i.test(name)) {
      const items = planItemsFromArgs(call.args);
      if (items) {
        lastPlanItems = items;
        codePlanReady = items.length > 0;
        if (!isGeneral && codeJournal) queueCodeJournalWrite(recordCodeTaskPlan(codeJournal, items));
        emit("plan", "Working plan", items);
      }
      return;
    }
    const summary = toolCallSummary(call);
    const isSkillRead = summary.startsWith("Consulting skill: ");
    const desc = isSkillRead ? summary : (summary ? `${name} · ${summary}` : name);
    // Doom-loop breaker (opencode DOOM_LOOP_THRESHOLD): the same
    // tool with identical args 6x in a row is stuck, not working.
    // loopPreventionMiddleware intercepts and steers at repetition 2 & 3,
    // so 6x acts as the final safety circuit breaker if model persists.
    const normalizedCallArgs = { ...((call?.args as any) || {}) };
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
  };

  const handleToolResultEvent = (call: ToolCall, result: string, isError: boolean) => {
    void call;
    const excerpt = isError ? "" : toolResultExcerpt(result);
    const doneLabel = lastActiveToolSkill
      ? `Skill loaded: ${lastActiveToolSkill} ✓`
      : `${lastActiveToolName || "tool"} ✓`;
    emit("tool", doneLabel, undefined, undefined, undefined, undefined, excerpt || undefined);
    if (isGeneral && homeJournal) {
      const toolName = String(lastActiveToolName || "tool");
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
      const toolName = String(lastActiveToolName || "tool");
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
      const now = Date.now();
      if (now - lastCheckpointSaveMs > 2000) {
        lastCheckpointSaveMs = now;
        saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages) as ChatMessage[], planItems: lastPlanItems }, targetTelemetryRoot);
      }
    }
    if (trajectory) {
      void trajectory.log({ source: "TOOL", type: "TOOL_RESULT", content: `${lastActiveToolName || "tool"} finished` });
    }
  };


  const streamDeepAgent = async (extra: ChatMessage[]) => {
    if (extra.length > 0) {
      runMessages = [...runMessages, ...extra];
    }
    // Context-window recovery loop. Context-length errors are not transient —
    // the provider would reject the same payload forever — so instead of
    // propagating them (or wastefully retrying via rate-limit backoff) the
    // transcript is condensed and the stream relaunched with the condensation
    // note. Real usage data from the previous attempt (AgentContextRelaunch)
    // is the preferred trigger; message-shaped provider errors are the
    // fallback for providers that never report usage mid-stream.
    let relaunches = 0;
    // Self-healing error recovery (automated "continue"): when an attempt
    // still fails after the transient-error backoff machinery is exhausted —
    // a provider 400, a deserialization error, repeated stream termination —
    // feed the error back into the run as a system note and continue from the
    // last complete superstep. The agent corrects itself instead of pausing
    // the run and waiting for the user to type "continue". Bounded so a
    // hard-broken provider cannot burn API spend forever; the checkpointed
    // pause remains the honest terminal state after these passes.
    let errorRecoveries = 0;
    for (;;) {
      // L0 microcompaction at every attempt boundary: stale tool RESULTS are
      // the bulk of a long transcript (the Tokyo Ghoul failure class). Clearing
      // them before each stream attempt keeps the retry/resume/continue payload
      // small without losing any recent context — the newest user turns keep
      // verbatim results, older ones become bounded stubs (ZCode-style).
      const preAttemptTokens = estimateMessagesTokensMemo(runMessages);
      if (preAttemptTokens > contextMessageBudget * 0.5) {
        const micro = microcompactToolResults(runMessages);
        if (micro.cleared > 0) {
          runMessages = micro.messages;
          emit("status", `Microcompacted ${micro.cleared} old tool result(s) — ~${formatTokenCount(Math.round(micro.charsFreed / 3.8))} tokens freed from the attempt payload`);
          if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: `Microcompact: ${micro.cleared} tool results cleared, ~${micro.charsFreed} chars freed` }).catch(() => {});
        }
      }
      try {
        return await withAgentRetry(consumeStream);
      } catch (error: any) {
        const cancelled = error instanceof RunCancelledError || error?.name === "AbortError" || isCancelled() || signal?.aborted;
        if (cancelled) throw error;
        const relaunchRequested = error instanceof AgentContextRelaunch || isContextWindowError(error);
        // Mid-run provider failover (Home): withAgentRetry only throws a
        // rate-limit/overload error after its retry budget is exhausted, so
        // reaching here means the provider is persistently failing. Swap to
        // the next configured provider and resume from the transcript instead
        // of pausing the whole run. Context-window errors are excluded — they
        // are the condensation path's job and switching providers won't help
        // if the failure is payload size.
        if (isGeneral && !relaunchRequested && !isRecursionLimitError(error) && isRateLimitError(error) && failoverIndex < failoverChain.length) {
          const target = failoverChain[failoverIndex];
          failoverIndex++; // consumed whether or not the swap succeeds
          emit("status", `${provider.label} keeps failing after retries (${errorSummary(error).slice(0, 120)}) — failing over to ${target.config.label} / ${target.model}…`);
          if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: `Provider failover ${failoverIndex}/${failoverChain.length}: ${provider.label} -> ${target.config.label} / ${target.model}` }).catch(() => {});
          let swapped = false;
          try {
            const nextClient = await createChatModel(target.config, target.model, { reasoningEffort: effort });
            llm = nextClient;
            swapped = true;
          } catch (swapError) {
            // Swap failed (bad key, dead base URL): fall through to the
            // generic recovery pass on the original provider; the next
            // rate-limit failure will try the next candidate in the chain.
            emit("status", `Failover to ${target.config.label} failed (${errorSummary(swapError).slice(0, 120)}) — continuing recovery on the original provider`);
          }
          if (swapped) {
            runMessages = [
              ...runMessages,
              userMsg(
                `[System Note: The previous model provider kept failing (${errorSummary(error)}). The run switched to ${target.config.label} / ${target.model}. All tool executions and results above are complete — continue the task from where it stopped. Do NOT restart from the beginning, do NOT re-create the todo list, and do NOT repeat already completed tool actions.]`
              ),
            ];
            continue;
          }
        }
        if (!relaunchRequested || isSimple || runMessages.length <= 2) {
          // Recursion-limit errors are handled by the outer budget-extension
          // loop (bounded, with its own partial-result path) — never recover
          // them here. Beyond that: automated self-correction passes.
          if (!isRecursionLimitError(error) && errorRecoveries < MAX_AGENT_ERROR_RECOVERIES) {
            errorRecoveries++;
            emit(
              "status",
              `Hit an error (${errorSummary(error)}) — recovering automatically and continuing (recovery ${errorRecoveries} of ${MAX_AGENT_ERROR_RECOVERIES})…`
            );
            if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: `Auto-recovery ${errorRecoveries}/${MAX_AGENT_ERROR_RECOVERIES}: ${errorSummary(error)}` });
            // Brief, abort-aware backoff before re-invoking the stream.
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
              }, 3_000);
              const onAbort = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                reject(new RunCancelledError());
              };
              if (signal) signal.addEventListener("abort", onAbort, { once: true });
            });
            runMessages = [
              ...runMessages,
              userMsg(
                `[System Note: The previous attempt failed with: ${errorSummary(error)}. Continue the task from where it stopped — do not repeat completed steps or re-read files you already inspected. If one specific tool call, image payload or file caused the failure, take a different approach to achieve the same goal.]`
              ),
            ];
            continue;
          }
          throw error;
        }
        if (relaunches >= 3) {
          throw new Error(
            `Context window exhausted after ${relaunches} condensation passes. The current task leaves too little room for the model to keep working — try a model with a larger context window.`
          );
        }
        relaunches++;
        const preTokens = estimateMessagesTokensMemo(runMessages);
        if (contextMessageBudget <= 1500) {
          throw new Error(
            `Model context window (${formatContextWindow(modelContextWindow)}) is too small for this run even after context condensation — the system prompt plus output reserve need more headroom. Pick a model with a larger context window or adjust the context limit in Settings → Providers.`
          );
        }
        emit(
          "status",
          `Context window reached${error instanceof AgentContextRelaunch ? "" : ` (${error?.message?.slice(0, 120) || "provider reported an over-limit payload"})`} — condensing earlier context and resuming…`
        );
        // Graduated degradation (shrink ladder): microcompact old tool
        // results first, then boundary-trim, then clip/drop tool outputs —
        // each level only runs if the previous one didn't free enough room.
        let compactLevel = "trim";
        if (isGeneral && homeJournal) {
          // Keep the task ledger in context after transcript condensation. It
          // is runtime-generated from completed tool results and bounded, so
          // the model can continue without trusting an earlier assistant claim.
          const shrunk = shrinkWithBrief(
            runMessages,
            contextMessageBudget,
            updateHomeTaskContextSummary(homeJournal).contextSummary,
          );
          runMessages = shrunk.messages;
          compactLevel = shrunk.level;
        } else if (!isGeneral && codeJournal) {
          await codeJournalWrite;
          const shrunk = shrinkWithBrief(
            runMessages,
            contextMessageBudget,
            buildCodeTaskContextSummary(codeJournal),
          );
          runMessages = shrunk.messages;
          compactLevel = shrunk.level;
        } else {
          const shrunk = shrinkToBudget(runMessages, contextMessageBudget);
          runMessages = shrunk.messages;
          compactLevel = shrunk.level;
        }
        const condensedTokens = estimateMessagesTokensMemo(runMessages);
        emit("status", `Condensed via ${compactLevel} — freeing the deepest tier that fit the budget`);
        emitContext(runMessages);
        const nextProjected = promptOverheadTokens + condensedTokens;
        if (nextProjected >= compactionThreshold) {
          throw new Error(
            `Context condensation could not free enough room (projected ~${formatTokenCount(nextProjected)} of ${formatContextWindow(modelContextWindow)} tokens). Use a model with a larger context window.`
          );
        }
        emit("status", `Context condensed: ~${formatTokenCount(preTokens)} → ~${formatTokenCount(condensedTokens)} tokens — resuming the run from the condensed checkpoint`);
        continue;
      }
    }
  };

  // Single-loop (opencode-style): the old "brief" node was a wasted superstep.
  // Context prep is a plain status emit before the graph runs.
  const briefMsg = `Preparing context · ${history.length} prior turn${history.length === 1 ? "" : "s"} · ${mode} mode · ${effectiveComplexity}${hasResume ? " · resumed" : ""}`;
  emit("status", briefMsg);
  if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: briefMsg });

  const startOutcome = await dispatchHooks(projectRoot, hooks, "run:start", { request, mode, projectRoot, runId: sessionId }).catch(() => null);
  if (startOutcome && !startOutcome.ok) {
    emit("status", `run:start hook failed (exit ${startOutcome.exitCode ?? "timeout"}): ${startOutcome.output.slice(0, 200)}`);
  }

  let codeReviewsDone = 0;
  // Supervisor nodes as plain functions (the old 2-node StateGraph had no
  // checkpointer and only wired deep_agent -> verify -> deep_agent, so a
  // while-loop is a 1:1 replacement).
  const runDeepAgentNode = async (verifyFeedback: string): Promise<string> => {
    if (isCancelled() || signal?.aborted) throw new RunCancelledError();
    const extra = verifyFeedback ? [userMsg(verifyFeedback)] : [];
    emit("status", verifyFeedback ? `Self-healing repair in progress (attempt 1 of ${MAX_REPAIRS[mode] ?? 3})` : "Agent is working on the task");
    const answer = await streamDeepAgent(extra);
    return answer;
  };
  const runVerifyNode = async (stateResponse: string, stateRepairs: number) => {
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
      // Decision logic lives in agent/verify-home.ts (pure, unit-tested) —
      // this node owns only I/O: file discovery, validation, inspection,
      // chart-dump cleanup, event emission.
      if (isGeneral) {
        const currentRepairs = Number(stateRepairs) || 0;
        const maxRepairs = MAX_REPAIRS[mode] ?? 1;
        const wantsDeliverable = Boolean(homeTaskContract?.expectsOutput);
        const freshFiles = wantsDeliverable
          ? await findFreshHomeFiles(projectRoot, initialHomeFiles, runStartMs)
          : [];
        const createdDeliverable = freshFiles.length > 0;
        const artifactContract = await homeArtifactCache!.contract(freshFiles, homeTaskContract?.expectedFormats);
        const validatedDeliverable = createdDeliverable && artifactContract.valid;
        // Content-level inspection on top of structure validation: a valid
        // package with placeholder titles / thin text / no topical coverage
        // must fail with TARGETED feedback, not get announced as done.
        // Structurally-valid candidates are inspected even when the contract
        // has missing formats or invalid siblings, so one repair round sees
        // every failure class at once instead of discovering them one at a
        // time (each discovery otherwise costs a full deep_agent round-trip).
        const validCandidates = artifactContract.checks.filter((check) => check.valid).map((check) => check.path);
        const contentInspections: DeliverableInspection[] = validCandidates.length
          ? await inspectDeliverables(projectRoot, validCandidates, request)
          : [];
        const responseTextTrimmed = String(stateResponse || "").trimEnd();
        const hasVisualBlocks = responseHasVisualBlocks(responseTextTrimmed);
        const requestWantsVisuals = /\b(chart|charts|graph|graphs|diagram|diagrams|plot|plots|visual|visuals|visualization)\b/i.test(request);
        const mdFilesWithCharts: Array<{ path: string }> = [];
        // Contents cached during the scan so the chat-answer cleanup below can
        // decide chart-dump deletion without re-reading the same files.
        const mdContents = new Map<string, string>();
        if (!hasVisualBlocks && (!homeRequestNamesFileFormat(request) || requestWantsVisuals)) {
          for (const file of freshFiles) {
            if (/\.(md|markdown|txt)$/i.test(file)) {
              try {
                const content = await fsPromises.readFile(path.join(projectRoot, file), "utf8");
                mdContents.set(file, content);
                if (matchChartFences(content).length) mdFilesWithCharts.push({ path: file });
              } catch { /* ignore */ }
            }
          }
        }
        const decision = decideHomeVerification({
          request,
          response: String(stateResponse || ""),
          currentRepairs,
          maxRepairs,
          wantsDeliverable,
          freshFiles,
          createdDeliverable,
          artifactValid: artifactContract.valid,
          invalidArtifacts: artifactContract.invalidArtifacts,
          missingFormats: artifactContract.missingFormats,
          contentInspections,
          mdFilesWithCharts,
          planItems: lastPlanItems,
          evidenceActions: [
            ...(homeJournal?.actions ?? []).filter((action) => action.progressed).map((action) => `${action.summary} ${action.result ?? ""}`),
            // Deliverable CONTENT is the strongest plan evidence: an item whose
            // topic words appear inside an inspected artifact is satisfied even
            // when the filename doesn't match ("Create the Troy deck" vs
            // deck.pptx).
            ...contentInspections.map((inspection) => inspection.metrics.textSample),
          ],
          homeReadOnlyStreak,
          failedSkillNames: loadedSkillNamesFromMessages(runMessages),
        });
        emit("tool", decision.telemetry);
        switch (decision.outcome) {
          case "chat-answer": {
            if (decision.hasVisualBlocks) {
              // Clean up any unrequested .md/.txt chart dump files created
              // alongside the chat response. The scan above only ran when the
              // response had NO visual blocks, so its cache is empty here —
              // fall back to reading the file (same as the original behavior).
              for (let i = freshFiles.length - 1; i >= 0; i--) {
                const file = freshFiles[i];
                if (/\.(md|markdown|txt)$/i.test(file)) {
                  let chartDump = mdContents.has(file) ? hasChartFences(mdContents.get(file) || "") : null;
                  if (chartDump === null) {
                    try {
                      chartDump = hasChartFences(await fsPromises.readFile(path.join(projectRoot, file), "utf8"));
                    } catch { chartDump = false; }
                  }
                  if (chartDump) {
                    await fsPromises.unlink(path.join(projectRoot, file)).catch(() => {});
                    freshFiles.splice(i, 1);
                  }
                }
              }
            }
            return { verification: "none" };
          }
          case "failed-charts":
          case "failed-content":
          case "failed-plan":
            return { verification: "failed", repairs: decision.repairs, verifyFeedback: decision.verifyFeedback };
          case "failed-structure":
            // Structure failures increment repairs like every other failure:
            // unbounded structure retries (the old contract) let a model that
            // never produces a file cycle until the recursion limit. When
            // MAX_REPAIRS is exhausted with no valid output, the decision
            // falls through to failed-terminal and the run ends honestly.
            return { verification: "failed", repairs: decision.repairs, verifyFeedback: decision.verifyFeedback };
          case "passed":
          case "passed-with-warnings":
            return { verification: "passed" };
          case "failed-terminal":
            return { verification: "failed" };
          case "none":
            return { verification: "none" };
        }
      }

      const currentRepairs = Number(stateRepairs) || 0;
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
      // Same gate as beforeModify: complex Code change requests and complex
      // Home output contracts push unfinished-plan continuation at verify.
      const planGateActive = Boolean(isGeneral ? homeTaskContract?.expectsOutput : codeTaskContract?.expectsChanges);
      // Docs/assets-only diffs never need a typecheck: running a 30s+
      // `npm run check` for a README edit is pure "takes time, does nothing".
      const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|swift|vue|svelte)$/i;
      if (!changedPaths.some((p) => CODE_EXT.test(p))) {
        if (planGateActive && unfinishedPlan && currentRepairs < maxRepairs) {
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
      // Repair evidence: name the run's own changed files so the model fixes
      // its work directly instead of re-exploring the repo to find where the
      // error paths live.
      const changedFilesNote = changedPaths.length
        ? `\n\nFiles changed in this run: ${changedPaths.slice(0, 12).join(", ")}${changedPaths.length > 12 ? ` (+${changedPaths.length - 12} more)` : ""}. Fix the failures in these files (or in what they import) — do not restart exploration.`
        : "";
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
              verifyFeedback: `The scoped check \`${scoped}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(scopedOutput)}${changedFilesNote}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
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
          const scripts = readPackageJsonCached(root)?.scripts ?? {};
          if (typeof scripts.build === "string") staticCommand = `${pm.run} build`;
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
          const pkg = readPackageJsonCached(root);
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
              verifyFeedback: `Parallel verification failed (${failures.length}/${verifyBatch.length}, repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${combined}${changedFilesNote}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
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
              verifyFeedback: `The verification command \`${verificationCommand}\` failed (self-healing repair attempt ${currentRepairs + 1} of ${maxRepairs}):\n\n${extractDiagnosticFeedback(output)}${changedFilesNote}\n\nFix these failures with minimal, focused changes, then summarize what you changed.`,
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
      const changedFilesCount = changedPaths.length;
      const changedLinesApprox = (diffFiles || []).reduce((acc: number, f: any) => acc + (Number(f?.insertions || 0) + Number(f?.deletions || 0)), 0);
      const isHighImpact = changedPaths.some((p: string) => /auth|security|payment|migration|schema|secret|token|gateway/i.test(p));
      if (shouldRunCodeReview({
        agentsEnabled: assetsEnabled("agents"),
        mode,
        expectsChanges: Boolean(codeTaskContract?.expectsChanges),
        currentRepairs,
        maxRepairs,
        changedFiles: changedFilesCount,
        changedLines: changedLinesApprox,
        highImpact: isHighImpact,
        reviewsDone: codeReviewsDone,
      })) {
        codeReviewsDone++;
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
          skillListings,
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

      if (planGateActive && unfinishedPlan && currentRepairs < maxRepairs) {
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
  };

  const runSupervisor = async (initialFeedback = ""): Promise<{ response: string; verification: string }> => {
    let answer = await runDeepAgentNode(initialFeedback);
    if (mode === "plan") return { response: answer, verification: "none" };
    let repairs = 0;
    for (;;) {
      if (isCancelled() || signal?.aborted) throw new RunCancelledError();
      const verdict = (await runVerifyNode(answer, repairs)) as { verification?: string; repairs?: number; verifyFeedback?: string };
      if (verdict?.verifyFeedback) {
        repairs = Number(verdict.repairs ?? repairs + 1);
        answer = await runDeepAgentNode(verdict.verifyFeedback);
        continue;
      }
      return { response: answer, verification: String(verdict?.verification ?? "none") };
    }
  };

  // The outer graph only has 2 nodes, but LangGraph's default invoke limit
  // is 25 — pass an explicit budget and turn a limit hit into a resumable
  // partial result instead of a hard GraphRecursionError.
  // The old LangGraph invoke limit (outerLimit) is gone — budget enforcement
  // now happens inside runAgentLoop (StepBudgetExceededError), which
  // isRecursionLimitError recognizes.
  let outerLimit = recursionLimit;
  let result: any;
  // Budget exhaustion is a pause, not a stop: a run that was making progress
  // auto-resumes from the furthest complete superstep with a fresh budget
  // until the task finishes. Bounded by MAX_BUDGET_EXTENSIONS so a wandering
  // model cannot burn API spend forever; the doom-loop breaker and a user
  // cancel still stop the run immediately.
  const maxBudgetExtensions = isGeneral ? MAX_BUDGET_EXTENSIONS.home : MAX_BUDGET_EXTENSIONS.code;
  let budgetExtensions = 0;
  // G9: one user-sanctioned extra extension via the structured question UI,
  // asked exactly once when the automatic budget is exhausted.
  let budgetAskUsed = false;
  try {
    result = await runSupervisor();
  } catch (error) {
    let runError: unknown = error;
    // Failed/cancelled runs still burned provider tokens (streamed chunks,
    // subagent totals). Finalize the accumulator and stash it on the thrown
    // error so IPC callers can persist it — otherwise session totals only
    // ever grow on successful runs.
    const attachFailureUsage = (err: unknown): unknown => {
      if (err && typeof err === "object" && !(err as { usage?: unknown }).usage) {
        try {
          const fallbackOutput = unaccountedOutputChars > 0 ? Math.max(1, estimateTokens("x".repeat(unaccountedOutputChars))) : 0;
          (err as { usage?: unknown }).usage = usage.finalize(modelName, estimatedFallbackInputTokens, fallbackOutput);
        } catch { /* usage must never break the error path */ }
      }
      return err;
    };
    // One-shot wrap-up for the deliverable-ready short-circuit: if the wrap-up
    // invoke itself hits the recursion limit, fall back to the canned response
    // instead of looping wrap-up → limit → wrap-up forever.
    let wrapUpUsed = false;
    for (;;) {
      const isCancel = runError instanceof RunCancelledError || (runError as any)?.name === "AbortError" || isCancelled() || signal?.aborted;
      if (isCancel) {
        saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
        await finishRunJournals("interrupted");
        throw attachFailureUsage(new RunCancelledError());
      }
      const isDoom = runError instanceof DoomLoopError || (runError as any)?.name === "DoomLoopError";
      const isBudget = isRecursionLimitError(runError);
      if (result !== undefined || !isBudget || isDoom) break;

      // Deliverable-ready short-circuit on recursion limit:
      // If the requested deliverable already exists on disk and passes artifact contract validation,
      // do not auto-extend another 80-150 steps of endless QA/tweaking. Complete the run cleanly.
      if (isGeneral && homeTaskContract?.expectsOutput) {
        try {
          const fresh = await findFreshHomeFiles(projectRoot, initialHomeFiles, runStartMs);
          if (fresh.length > 0) {
            const contract = await homeArtifactCache!.contract(fresh, homeTaskContract?.expectedFormats);
            if (contract.valid) {
              emit("status", "Deliverable verified on disk — completing run without unnecessary budget extension.");
              // The contract only knows THAT files exist — not whether they
              // answer the request. Never fabricate the final response here:
              // the canned file list once announced unrelated leftovers
              // ("generate_ml_course.py…") as "the requested deliverable".
              // Ask the model to wrap up through the graph instead, so the
              // answer is honest and the verify node still gates it.
              if (!wrapUpUsed) {
                wrapUpUsed = true;
                emit("status", "Asking the agent to wrap up and summarize the verified deliverable…");
                try {
                  result = await runSupervisor("[System Note: Your step budget was reached, but your deliverable has been verified complete on disk. Do NOT continue working and do NOT run any more tools. Produce your final user-facing response NOW: answer the original request directly and briefly state what was created and where.]");
                  if (!String((result as any)?.response || "").trim()) throw new Error("empty wrap-up response");
                } catch { /* fall through to the canned response below */ }
              }
              // Scratch helpers are deleted either way; the canned fallback
              // must not list files that no longer exist.
              await cleanupHomeScratchFiles(projectRoot, fresh).catch(() => {});
              if (!result || !String((result as any)?.response || "").trim()) {
                const kept = fresh.filter((file) => !SCRATCH_SCRIPT_PATTERN.test(path.basename(file)));
                result = {
                  verification: "passed",
                  response: `I have generated and verified the requested deliverable: ${(kept.length ? kept : fresh).join(", ")}.`,
                };
              }
              break;
            }
          }
        } catch { /* best effort */ }
      }

      if (budgetExtensions >= maxBudgetExtensions) {
        // G9/G13: instead of silently pausing at the hard cap, ask once —
        // the user can sanction another extension or take over. Unavailable
        // bridge or dismiss = the checkpointed pause (previous behavior).
        if (!budgetAskUsed && isGeneral && onUserQuestion) {
          budgetAskUsed = true;
          saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
          emit("status", "Step budget exhausted — asking how to proceed…");
          const answer = await onUserQuestion([{
            header: "Step budget",
            question: `This run has used its step budget and was auto-extended ${maxBudgetExtensions}× (${toolCallCount} tool calls so far). How should I proceed?`,
            options: ["Extend the budget again and continue", "Stop here (progress is checkpointed)"],
          }]).catch(() => null);
          if (!answer || !/extend/i.test(answer)) break;
          emit("status", "Budget extended by user — continuing…");
        } else {
          break;
        }
      }
      budgetExtensions++;
      if (effectiveComplexity === "simple") {
        effectiveComplexity = "complex";
        isSimple = false;
      }
      // Delta extension instead of a full budget reset: the old reset restored
      // the complete mode limit every time, so a run at 149/150 auto steps
      // could wander for up to 4×150 before pausing. A consumed budget earns
      // a bounded continuation window; the deliverable-ready short-circuit
      // and the user-ask path still cover genuinely larger remaining work.
      recursionLimit = isGeneral ? 40 : 60;
      outerLimit = Math.max(recursionLimit, 50);
      saveLastRunCheckpoint(sessionId, { messages: sanitizeResumeCheckpoint(runMessages), planItems: lastPlanItems }, targetTelemetryRoot);
      emit("status", `Step budget reached — extending automatically (${budgetExtensions}/${maxBudgetExtensions}) and continuing from where the run stopped…`);
      if (trajectory) await trajectory.log({ source: "SYSTEM", type: "STATUS", content: `Recursion limit hit at ${outerLimit}; auto-extended budget ${budgetExtensions}/${maxBudgetExtensions}.` });
      // The model must not have to infer that it should continue: the pruned
      // checkpoint can end on a tool result, so say it explicitly.
      runMessages = [...runMessages, userMsg("[System Note: The step budget was extended automatically. All preceding tool actions are complete. Continue the task directly from where it stopped — do not repeat completed steps or re-read files you already inspected.]")];
      try {
        result = await runSupervisor();
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
        throw attachFailureUsage(runError);
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
      void dispatchHooks(projectRoot, hooks, "run:end", { request, mode, projectRoot, runId: sessionId, verification: "interrupted" }).catch(() => undefined);
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
  const homeFreshFiles = isGeneral
    ? await findFreshHomeFiles(projectRoot, initialHomeFiles, runStartMs)
    : [];

  // Ensure visual charts and graph images are in the chat response:
  // 1) If the model placed charts inside an unrequested .md file instead of the response, extract and embed them.
  // 2) If the model generated fresh image files (e.g. via python matplotlib chart_*.png) that are not embedded in chat,
  //    embed them directly with descriptive titles so the user sees the visual evidence alongside the answers.
  if (isGeneral && result?.response) {
    let hasVisualBlocks =
      /```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)\b/i.test(result.response) ||
      /!\[[^\]]*\]\([^)]+\.(png|jpe?g|svg|webp|gif)\)/i.test(result.response);
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

      // Check for fresh image files produced during the run (e.g. chart_*.png, plot.svg, etc.)
      const freshImages = homeFreshFiles.filter((f) => /\.(png|jpe?g|svg|webp|gif)$/i.test(f));
      if (freshImages.length > 0) {
        const unreferencedImages: string[] = [];
        for (const img of freshImages) {
          const basename = path.basename(img);
          const isEmbedded =
            result.response.includes(`](${img})`) ||
            result.response.includes(`](${basename})`) ||
            result.response.includes(`](./${basename})`) ||
            result.response.includes(`](/${basename})`);
          if (!isEmbedded) {
            unreferencedImages.push(img);
          }
        }

        if (unreferencedImages.length > 0) {
          const imageEmbeds = unreferencedImages.map((img) => {
            const base = path.basename(img);
            const rawName = base.replace(/\.[^/.]+$/, "");
            const cleanTitle = rawName.replace(/[_-]+/g, " ").replace(/^(chart|plot|graph)\s+/i, "").trim();
            const title = cleanTitle
              ? cleanTitle.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") + " Chart"
              : "Visual Evidence";
            return `![${title}](${img})`;
          }).join("\n\n");

          result.response = `${result.response.trim()}\n\n### Visual Evidence & Charts\n\n${imageEmbeds}`;
          hasVisualBlocks = true;
        }
      }
    }
    if (hasVisualBlocks && !homeRequestNamesFileFormat(request) && result.verification === "failed") {
      result.verification = "none";
    }
  }

  const homeArtifactContract = homeArtifactCache
    ? await homeArtifactCache.contract(homeFreshFiles, homeTaskContract?.expectedFormats)
    : await validateHomeArtifactContract(projectRoot, homeFreshFiles, homeTaskContract?.expectedFormats);
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
  if (lastPlanItems && lastPlanItems.length > 0) {
    const hasIncomplete = lastPlanItems.some((p) => p.status !== "completed");
    if (hasIncomplete) {
      lastPlanItems = lastPlanItems.map((p) => ({ ...p, status: "completed" as const }));
      emit("plan", "Plan completed", lastPlanItems);
    }
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
  const finalContext = currentContext(runMessages);
  emit("assistant", result.response, undefined, finalUsage, undefined, undefined, undefined, finalContext);
  emit("usage", `Token usage · ${finalUsage.totalTokens} tokens${finalUsage.estimatedCost == null ? "" : ` (~$${finalUsage.estimatedCost})`}`, undefined, finalUsage);

  if (isGeneral && result?.verification !== "failed") {
    await cleanupHomeScratchFiles(projectRoot, homeFreshFiles).catch(() => {});
  }
  const hookEvent = result?.verification === "failed" ? "verify:fail" : "run:end";
  void dispatchHooks(projectRoot, hooks, hookEvent, {
    request, mode, projectRoot, runId: sessionId,
    verification: result?.verification ?? "none",
    response: tail(String(result?.response ?? ""), 2000),
  }).catch(() => undefined);

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
      } else if (isGeneral && homeFreshFiles && homeFreshFiles.length > 0) {
        for (const file of homeFreshFiles) {
          const ext = path.extname(file).toLowerCase();
          if ([".pptx", ".xlsx", ".docx", ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".csv", ".txt", ".md"].includes(ext)) {
            const fileName = path.basename(file);
            const deliverableArtifact: ArtifactItem = {
              id: `${sessionId}_${fileName}`,
              sessionId,
              name: fileName,
              filename: fileName,
              path: file,
              content: "",
              status: "completed",
              userFacing: true,
              requestFeedback: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            if (!artifact) artifact = deliverableArtifact;
            emit("artifact", `Generated deliverable ${fileName}`, undefined, undefined, undefined, deliverableArtifact);
          }
        }
      }
    } catch { /* ignore artifact save errors */ }
  }

  // Semantic candidates for Home long-term memory: one cheap extraction call
  // proposing durable profile/preference/fact items. Transient data (tables,
  // lists, numbers) is filtered by parseCandidateFacts. Best-effort, never
  // fails the run; main auto-applies them with a visible notice (the user
  // can forget any item in the Memory tab).
  // When onMemoryCandidates is provided (Home IPC), the call runs DETACHED:
  // it is independent of the answer the user is waiting on, and awaiting it
  // here delayed transcript persistence and cleanup by up to 20s on slow
  // providers. Without a callback (headless/eval) extraction stays inline.
  let memoryCandidates: MemoryCandidate[] = [];
  const extractMemoryCandidates = async (): Promise<MemoryCandidate[]> => {
    const responseText = String(result.response || "");
    const requestText = String(request || "").trim();
    if (!shouldExtractMemory(requestText, responseText)) return [];
    const extractPrompt =
      `Extract durable long-term memory candidates from this assistant turn. ` +
      `Return JSON ONLY: {"candidates":[{"category":"profile|preference|fact|context","fact":"..."}]}. ` +
      `Rules: at most 3 candidates; each fact one sentence, 8-200 chars, enduring (identity, role, lasting preference, stable personal fact, ongoing project goal). ` +
      `NEVER include transient data: greetings, tables, lists, counts, URLs, file names, numbers from tool output, or anything already answered in full. ` +
      `Return {"candidates":[]} when nothing is worth remembering.\n\n` +
      `User: ${requestText.slice(0, 800)}\nAssistant: ${responseText.slice(0, 2500)}`;
    const raw: string = await Promise.race([
      llm.complete({ messages: [userMsg(extractPrompt)], temperature: 0.1 }).then((r) => r.text),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("memory extract timeout")), 20000)),
    ]);
    return parseCandidateFacts(raw);
  };
  if (isGeneral && mode !== "plan" && onMemoryCandidates) {
    const runIdForLog = sessionId;
    void extractMemoryCandidates()
      .then((candidates) => (candidates.length ? onMemoryCandidates(candidates) : undefined))
      .catch((error) => {
        if (runIdForLog) trajectory?.log({ source: "SYSTEM", type: "STATUS", content: `Background memory extraction skipped: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
      });
  } else if (isGeneral && mode !== "plan") {
    try {
      memoryCandidates = await extractMemoryCandidates();
    } catch { /* extraction is best-effort */ }
  }

  return {
    // Session memory is a compact pointer, NOT a transcript copy: the full
    // answer lives in chat history. Tables/lists are never duplicated here.
    response: result.response as string,
    context: finalContext,
    verification: (result.verification as string) || "none",
    memoryEntry: `Task: ${tail(request, 200)} | Result: ${firstMeaningfulLine(result.response as string, 160)} | Verification: ${(result.verification as string) || "none"} (details in chat transcript)`,
    usage: finalUsage,
    artifact,
    projectMemoryLogEntry: `Recent work (${new Date().toISOString().slice(0, 10)}): ${tail(request, 200)} → ${firstMeaningfulLine(result.response as string, 200)}`,
    memoryCandidates,
  };
}
