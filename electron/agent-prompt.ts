// System-prompt construction for Code and Home runs, plus Home task
// contract inference. Modularized by task type so prompts stay concise,
// cache-friendly (static prefix first), and tailored to the request.
import type { AgentMemoryContext, AgentMode, AgentTaskKind, HomeArtifactFormat, HomeTaskContract } from "./agent-types.js";
import type { TaskComplexity } from "./task-routing.js";
import {
  classifyCodeTask,
  classifyHomeTask,
  COMPACT_CHART_GRAMMAR,
  COMPACT_HTML_VISUAL_GRAMMAR,
  COMPACT_VISUAL_GUIDE_SMALL,
  COMPACT_WIDGET_GRAMMAR,
  wantsChartOrDiagram,
  wantsHtmlVisual,
  wantsInteractiveWidget,
} from "./prompt-modules.js";

export type PromptHints = {
  request?: string;
  hasGithubMcp?: boolean;
  includeBrowser?: boolean;
  compact?: boolean;
};

function tail(value: string | undefined, cap: number) {
  if (!value) return "";
  return value.length > cap ? `…${value.slice(-cap)}` : value;
}

// Memory strings are collections of whole entries (run summaries, facts),
// not prose: a char tail can start mid-entry and present a truncated
// fragment as a fact. Trim by dropping the OLDEST whole entries until the
// text fits; single-entry overflow falls back to the char tail.
export function tailEntries(value: string | undefined, cap: number): string {
  const text = (value || "").trim();
  if (!text || text.length <= cap) return text;
  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  let used = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const cost = paragraphs[i].length + (kept.length ? 2 : 0);
    if (used + cost > cap) break;
    kept.unshift(paragraphs[i]);
    used += cost;
  }
  if (!kept.length) return tail(text, cap);
  const out = kept.join("\n\n");
  return kept.length < paragraphs.length ? `…[older memory trimmed]\n${out}` : out;
}

const HOME_BUILD_VERB_PATTERN = /\b(create|make|generate|build|write|draft|prepare|produce|export|save|deliver|develop|design|turn|convert|transform|need|want|give\s+me)\b/i;
// Editing an existing file ("edit / update / add to Deck.pptx") is observable
// output too. The verbs are broader, so they only count when a file (extension
// or document noun) is actually named — otherwise "add 2 + 2" would qualify.
const HOME_EDIT_VERB_PATTERN = /\b(edit|update|add|modify|revise|redo|replace|fill|populate|extend|enhance|improve|refresh|change|remove|delete)\b/i;

export function isIdentityOrGreeting(request: string): boolean {
  const text = (request || "").trim().replace(/[.!…]+$/g, "").trim();
  if (!text) return false;
  if (/^(hi|hello|hey|yo|greetings|good (morning|afternoon|evening))\b/i.test(text) && text.length < 80) return true;
  if (/^(who are you|what are you|what can you do|what do you do|help|what are your capabilities|introduce yourself|tell me about yourself)\b/i.test(text) && text.length < 120) return true;
  return false;
}

export function isHomeEditRequest(request: string): boolean {
  const text = (request || "").trim();
  if (!text || !HOME_EDIT_VERB_PATTERN.test(text)) return false;
  return HOME_FORMAT_NAMED_PATTERN.test(text) || /\.(docx|xlsx|pptx?|pdf|csv|odt|ods|odp|tex|txt|md)\b/i.test(text) || /\b(file|document|presentation|slides?|deck|spreadsheet|workbook|report)\b/i.test(text);
}

export function inferHomeTaskContract(request: string): HomeTaskContract {
  const text = (request || "").trim();
  // Polite wrappers ("can you create a report") are requests, not questions:
  // strip them so the creation-verb test sees the actual instruction. Genuine
  // interrogatives ("how do I…", "should I…") still never expect output.
  const stripped = text.replace(/^\s*(?:please|can\s+you|could\s+you|would\s+you|will\s+you)\s+/i, "").trim();
  const isInterrogative = /^\s*(what|why|how|where|when|which|who|should)\b/i.test(stripped) ||
    /\b(?:need|want)\s+to\s+(?:know|understand|learn|find\s+out|figure\s+out)\b/i.test(stripped);
  // "I need to understand…" is intent, not a deliverable; "I need a report" is.
  const expectsCreate = HOME_BUILD_VERB_PATTERN.test(stripped) && !isInterrogative;
  const expectsEdit = !isInterrogative && HOME_EDIT_VERB_PATTERN.test(stripped) &&
    (HOME_FORMAT_NAMED_PATTERN.test(stripped) || /\.(docx|xlsx|pptx?|pdf|csv|odt|ods|odp|tex|txt|md)\b/i.test(stripped));
  const expectsOutput = expectsCreate || expectsEdit;
  const needsResearch = /\b(research|read|docs?|documentation|investigate|look\s+up|find\s+out|compare|sources?|latest|current)\b/i.test(stripped);
  return { expectsOutput, needsResearch, expectedFormats: expectsOutput ? inferHomeOutputFormats(stripped) : [] };
}

const HOME_OUTPUT_FORMATS: Array<{ format: HomeArtifactFormat; pattern: RegExp }> = [
  { format: "docx", pattern: /\.(?:docx)\b|\b(?:docx|word\s+(?:document|file|report|letter))\b/i },
  { format: "pdf", pattern: /\.(?:pdf)\b|\bpdf\s+(?:file|document|report|version|copy|course|guide|book)\b|\b(?:as|in|to)\s+(?:a\s+)?pdf\b/i },
  { format: "pptx", pattern: /\.(?:pptx?)\b|\b(?:powerpoint|slides?|slide\s+deck|slideshow)\b/i },
  { format: "xlsx", pattern: /\.(?:xlsx?)\b|\b(?:excel\s+(?:file|spreadsheet|workbook)|spreadsheet|workbook)\b/i },
  { format: "tex", pattern: /\.(?:tex)\b|\blatex\s+(?:file|document|report)\b|\b(?:as|in|to)\s+(?:a\s+)?latex\b/i },
  { format: "md", pattern: /\.(?:md|markdown)\b|\bmarkdown\s+(?:file|document|report|note|brief)\b|\b(?:as|in)\s+markdown\b/i },
  { format: "csv", pattern: /\.(?:csv)\b|\bcsv\s+(?:file|export|version)\b|\b(?:as|in|to)\s+(?:a\s+)?csv\b/i },
  { format: "txt", pattern: /\.(?:txt)\b|\b(?:plain\s+text|text)\s+(?:file|document|version)\b|\b(?:as|in)\s+plain\s+text\b/i },
];

/** Infer concrete file formats from the output portion of a creation request. */
export function inferHomeOutputFormats(request: string): HomeArtifactFormat[] {
  const text = (request || "").trim();
  const action = /\b(?:create|make|generate|build|write|draft|prepare|produce|export|save|deliver|convert|turn|need|want|edit|update|add|modify|revise|redo|replace|fill|populate|extend|enhance|improve|refresh|change)\b/i.exec(text);
  if (!action) return [];
  // Drop the subject/topic clause so a format mentioned as the report's topic
  // ("write a report about PDF compression") is not mistaken for its format.
  const outputClause = text.slice(action.index).split(/\b(?:about|regarding|covering|explaining|on the topic of)\b/i, 1)[0].slice(0, 180);
  return HOME_OUTPUT_FORMATS.filter(({ pattern }) => pattern.test(outputClause)).map(({ format }) => format);
}

const HOME_FORMAT_NAMED_PATTERN =
  /\b(?:docx|xlsx|pptx|ppsx|pdf|csv|odt|ods|odp|tex|txt|md)\b|\.(?:docx|xlsx|pptx|ppsx|pdf|csv|odt|ods|odp|tex|txt|md)\b|\b(?:word|excel|powerpoint|ppt|spreadsheet|presentation|slides?|slide\s*deck|document|docs?\b|latex|resume|cv)\b/i;

/**
 * True when the request explicitly names a file format or document type.
 * Such requests can never use the [[answer-in-chat]] escape: if the user
 * named the format, a file IS the deliverable.
 */
export function homeRequestNamesFileFormat(request: string): boolean {
  return HOME_FORMAT_NAMED_PATTERN.test(request || "");
}

function todayLine(): string {
  const now = new Date();
  const long = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `Today is ${long} (${now.toISOString().slice(0, 10)}).`;
}

export function buildSystemPrompt(
  mode: AgentMode,
  projectRoot: string,
  providerLabel: string,
  modelName: string,
  memory: AgentMemoryContext,
  projectRulesSection: string = "",
  complexity: TaskComplexity = "complex",
  isNewProject = false,
  taskKind: AgentTaskKind = "code",
  repoMapSection: string = "",
  homeTaskContract: HomeTaskContract | null = null,
  subagentCatalog: string = "",
  projectInstructionsSection: string = "",
  pluginContextSection: string = "",
  fullAccess = false,
  promptHints: PromptHints = {}
) {
  const today = todayLine();
  const req = (promptHints.request || "").trim();

  const compact = Boolean(promptHints.compact);

  if (taskKind === "general") {
    const greeting = isIdentityOrGreeting(req);
    const editReq = isHomeEditRequest(req);
    const homeTask = classifyHomeTask({ request: req, contract: homeTaskContract, isGreeting: greeting, isEdit: editReq });

    // Stable static prefix first for provider prompt-cache hits.
    const sections: string[] = [
      `You are Nexus Home, a local-first desktop assistant. Workspace virtual root is \`/\` — use relative paths only (e.g. \`report.docx\`); files saved here are downloadable by the user. Never invent host paths (C:\\..., /Users/..., /workspace) or cd outside the workspace, never write \`.deepagents/\`, and never expose secrets.
${today} Anchor relative dates to it.
Workspace: ${projectRoot} | Model: ${providerLabel} / ${modelName}`,
      compact
        ? `Rules:
1. Paths: relative to workspace root \`/\` only.
2. Skills: if a listed skill fits, call \`read_file\` on its \`SKILL.md\` path first; never dump \`SKILL.md\` verbatim.
3. Research: use \`web_search\` for current facts and cite links as \`[Source](https://...)\`.
4. Completion: finish every step, file, and todo item before answering—never stop mid-task with "I'll do X next".`
        : `Core rules:
- Skills & Self-Improvement: if a skill in the System Note matches what the task does, read its exact \`SKILL.md\` path first before acting. Never quote/dump \`SKILL.md\` text to the user or browse skill folders. Copy helper scripts via \`materialize_skill_files\` before running with \`execute\`. When you discover a repeatable multi-step workflow or domain recipe worth reusing, save or refine it via \`learn_skill\`.
- Memory (\`manage_memory\`): long-term memory holds durable user facts, preferences, and operational lessons (\`category: "lesson"\`) across chats; actively \`search\`/\`list\` memory when relevant, save durable discoveries yourself in the same run (never ask the user to tell you to save), and omit transient chatter. Never treat memory summaries as full transcripts.
- Research & freshness: for current/recent facts, prices, versions, or unfamiliar libraries, use \`web_search\` (+ \`freshness\`) and inspect top sources with \`browser_inspect\` / \`browser_fetch_api\`; cite web claims inline as \`[Source](https://...)\` and mark volatile figures "as of <date>".
- Autonomous completion: keep working through every stage until every requested deliverable and todo item is finished and verified; never stop mid-task with a partial result or "next steps" deferral unless genuinely blocked.`,
    ];

    if (homeTask === "greeting") {
      sections.push(
        `TASK (greeting/identity): reply in 2-4 concise sentences as Nexus Home (research, docs .docx/.pptx/.xlsx/.pdf, workspace edits, durable memory) and suggest one concrete next step. Call no tools unless saving user identity via \`manage_memory\`. Do not emit a bulleted capabilities dump.`
      );
    } else if (homeTask === "edit_file") {
      sections.push(
        `TASK (edit existing file): inspect the existing file first (\`ls\` + \`read_file\` or \`import_attachment\`), preserve its content/design intent, then call \`create_deliverable\` with the SAME filename/extension and complete enriched Markdown (or ONE generator script only if custom template styling requires it). Fix once if \`create_deliverable\` reports issues, then name the saved file.`
      );
    } else if (homeTask === "deliverable") {
      sections.push(
        compact
          ? `TASK (deliverable: ${homeTaskContract?.expectedFormats.join(", ") || "file"}): write thorough Markdown and call \`create_deliverable\`; verify the saved filename before answering.${homeTaskContract?.needsResearch ? " Use `web_search` first if facts are needed." : ""}`
          : `TASK CONTRACT (file deliverable): the user requested a standalone document (${homeTaskContract?.expectedFormats.join(", ") || "file"}). Use \`create_deliverable\` with thorough, well-structured Markdown (include working examples/tables for courses or guides, and 2-4 verified \`web_image_search\` URLs for presentations when helpful). Use a single generator script (\`write_file\` + \`execute\`, then remove throwaway script after \`ls\`) ONLY when custom styling/templates cannot use \`create_deliverable\`. Never write validation scripts (\`validate_*.py\`, \`check_*.js\`) and never conclude with only a promise while the file is missing.${homeTaskContract?.needsResearch ? " Research first while gathering new facts, then produce and verify the file." : ""}`
      );
    } else {
      sections.push(
        `TASK (substantive chat answer): answer directly and completely in chat, enriching comparisons, processes, trends, or entities with native visuals/media where helpful (never write an unrequested \`.md\` file for chat answers or charts). Cite web sources inline as Markdown links \`[Name](https://...)\`.`
      );
    }

    const needWidget = homeTask === "interactive_widget" || wantsInteractiveWidget(req);
    const needHtmlVisual = homeTask === "html_visual" || wantsHtmlVisual(req);
    const needChart = homeTask === "chart_visual" || wantsChartOrDiagram(req);

    // Every substantive Home chat/research answer (not just explicit "chart" keywords)
    // gets proactive visual guidance + exact DSL syntax so Home answers stay visual-rich.
    if (homeTask !== "greeting" && homeTask !== "edit_file" && (homeTask !== "deliverable" || needChart)) {
      sections.push(compact ? COMPACT_VISUAL_GUIDE_SMALL : COMPACT_CHART_GRAMMAR);
    }
    if (needWidget) sections.push(COMPACT_WIDGET_GRAMMAR);
    if (needHtmlVisual) sections.push(COMPACT_HTML_VISUAL_GRAMMAR);

    if (complexity === "simple") {
      sections.push(
        `DIRECT EXECUTION: answer or fulfill the request directly and completely without unnecessary ceremony; verify facts or outputs before finishing.`
      );
    } else if (!compact && homeTask !== "greeting" && homeTask !== "edit_file") {
      sections.push(
        `PLANNING & AUTONOMY: for multi-part tasks, record a concise plan with \`write_todos\` first, update progress as each item completes, delegate heavy isolated research/work via \`research\` or \`delegate_task\`, and keep working until every item is completed and verified.`
      );
    }

    const longCap = compact ? 1200 : 4000;
    const sessCap = compact ? 800 : 3000;
    sections.push(
      `Long-term memory:\n${tailEntries(memory.projectMemory, longCap) || "(empty)"}\n\nSession memory:\n${tailEntries(memory.sessionMemory, sessCap) || "(empty)"}`
    );

    if (projectInstructionsSection) sections.push(compact ? tail(projectInstructionsSection, 1500) : projectInstructionsSection);
    if (subagentCatalog && !compact && homeTask !== "greeting") {
      sections.push(
        `SPECIALIST SUBAGENTS — delegate complex isolated tasks with \`delegate_task(role, task)\` (run read-only roles in parallel, write-capable sequentially):\n${subagentCatalog}`
      );
    }
    if (projectRulesSection) sections.push(compact ? tail(projectRulesSection, 1500) : projectRulesSection);
    if (pluginContextSection) sections.push(compact ? tail(pluginContextSection, 1200) : pluginContextSection);

    if (mode === "plan") {
      sections.push("MODE: PLAN (read/search only — return a structured markdown plan).");
    } else {
      const modeLine = mode === "auto"
        ? "MODE: AUTO. Complete research, creation, and verification autonomously before finishing."
        : "MODE: ASK. Fulfil the request cleanly and confirm before finishing.";
      const fullLine = fullAccess
        ? "\nFULL ACCESS: non-destructive shell/install/git commands run without approval prompts; destructive guardrails remain blocked."
        : "";
      sections.push(`${modeLine}${fullLine}`);
    }
    return sections.join("\n\n");
  }

  // ---- CODE MODE ----
  const codeTask = classifyCodeTask({ request: req, mode, isNewProject, complexity });
  const codeSections: string[] = [
    `You are Nexus, an autonomous coding agent. Workspace virtual root is \`/\` — ALWAYS use relative paths (e.g. \`src/App.tsx\`), never host paths (C:\\..., /Users/..., /home/...), never \`cd\` to project root, never write \`.deepagents/\`, and never expose or hardcode secrets.
${today} Anchor relative dates to it.
Workspace: ${projectRoot} | Model: ${providerLabel} / ${modelName}`,
    compact
      ? `Rules:
1. Search & read first: use \`grep\`/\`glob\` on narrow paths, then \`read_file\` exact lines before editing (never \`ls /\` + \`**/*\`).
2. Minimal safe edits: match exact indentation in \`edit_file\` or write clean complete blocks with \`write_file\`; sanitize untrusted HTML and never hardcode secrets.
3. Skills: if a listed skill matches, read its \`SKILL.md\` first; never paste skill files to the user.
4. Complete & verify: finish all edits and todo items, run the project build/test via \`execute\`, and report verified results—never stop mid-task with "next steps".`
      : `Core engineering rules:
- Inspect relevant implementation, callers, and nearest tests before proposing edits; batch independent reads/searches in parallel.
- Scope searches tightly (\`grep_search\`, narrow globs like \`src/**/*.tsx\`); NEVER run \`ls /\` or \`**/*\`.
- Keep changes minimal and clean (small focused functions, parameterized queries, sanitized outputs, no empty catch blocks). Prefer \`apply_patch\` for multi-file edits.
- Skills: if a skill in the System Note covers the task, read its exact \`SKILL.md\` path first; never output \`SKILL.md\` text or browse skill dirs; copy helper scripts via \`materialize_skill_files\` before \`execute\`.
- Memory (\`project_memory\`) & Self-Improvement (\`learn_skill\`): search/list or record durable build/test commands, conventions, gotchas, decisions, or self-improved lessons (\`category: "lesson"\`) in \`project_memory\`; synthesize repeatable multi-step workflows into reusable skills with \`learn_skill\`; trust recorded facts below instead of re-deriving.
- Autonomous completion & verification: keep working continuously until every planned edit and todo item is finished and verified (never stop mid-task with "next steps" or partial stubs). Never write throwaway check scripts (\`check-*.js\`, \`.nexus/\` scratch); run existing/inline checks once, then report verified files modified, commands run, and test results. Use \`ask_user\` only when genuinely blocked (at most once).`,
  ];

  if (codeTask === "qa_lookup") {
    codeSections.push(
      `TASK (lookup/Q&A — direct mode): inspect the relevant files and symbols needed to answer accurately and completely, and make zero unrequested edits.`
    );
  } else if (codeTask === "review_audit") {
    codeSections.push(
      `TASK (code review/audit): inspect affected boundaries and callers thoroughly; report concrete bugs, security issues, and test gaps ordered by severity with exact \`file:line\` references. Do not modify files unless requested.`
    );
  } else if (codeTask === "bugfix") {
    codeSections.push(
      `TASK (bug fix): locate root cause and callers -> add or update a regression test -> apply the minimal fix -> run targeted checks/tests and confirm pass before finishing.`
    );
  } else if (codeTask === "new_project") {
    codeSections.push(
      `NEW PROJECT deliverable (production quality, not loose static files):
- Default to Vite + React + TypeScript (\`npm create vite\`, \`npm install\`) unless another stack is requested.
- Organize clean \`src/\` components, API client + loading/empty/error states, persisted non-secret settings, \`.env.example\`, and \`README.md\` (prerequisites, install, dev, build).
- Do not stop until \`npm run build\` succeeds cleanly; avoid re-reading files after a passing build.`
    );
  } else if (codeTask === "feature_edit") {
    const planHint = complexity === "simple" || compact
      ? "Keep edits minimal; verify before answering (no `write_todos` needed)."
      : "If 3+ steps, record a concise `write_todos` plan first, then implement -> test -> verify -> mark todos completed.";
    codeSections.push(`TASK (implementation): ${planHint} Do not repeatedly re-read files after verification passes.`);
  }

  if (promptHints.includeBrowser || codeTask === "new_project") {
    codeSections.push(
      `Browser & Dev Server: prefer \`browser_inspect\` to check rendered JS UI and \`browser_act\` (snapshot refs first) for interactions. Starting a dev server auto-opens its local URL in Browser; only call \`browser_act(navigate, openInBrowser=true)\` if no URL was detected. For unfamiliar/recent libraries, verify current docs with \`web_search\` + \`browser_inspect\` before coding.`
    );
  }

  if (promptHints.hasGithubMcp) {
    codeSections.push(
      `GitHub MCP: never ask for the user's username — call \`get_me\` and use the exact \`login\` in queries (\`user:<login>\`; on 422, refresh \`get_me\` once before reporting error).`
    );
  }

  const pmCap = compact ? 900 : 2000;
  const smCap = compact ? 900 : 3000;
  codeSections.push(
    `Project memory:\n${tailEntries(memory.projectMemory, pmCap) || "(empty)"}\n\nProject facts:\n${tailEntries(memory.facts, pmCap) || "(none yet — record lasting discoveries with project_memory)"}\n\nSession memory:\n${tailEntries(memory.sessionMemory, smCap) || "(empty)"}`
  );

  if (projectInstructionsSection) codeSections.push(compact ? tail(projectInstructionsSection, 1500) : projectInstructionsSection);
  if (repoMapSection) codeSections.push(compact ? tail(repoMapSection, 1500) : repoMapSection);
  if (subagentCatalog && !compact) {
    codeSections.push(
      `SPECIALIST SUBAGENTS — delegate complex isolated tasks with \`delegate_task(role, task)\` (never for trivial edits/Q&A; run read-only roles in parallel, write-capable sequentially):\n${subagentCatalog}`
    );
  }
  if (projectRulesSection) codeSections.push(compact ? tail(projectRulesSection, 1500) : projectRulesSection);
  if (pluginContextSection) codeSections.push(compact ? tail(pluginContextSection, 1200) : pluginContextSection);

  if (mode === "plan") {
    codeSections.push(
      "MODE: PLAN. Investigate read-only (no edits/execution) and output `# Objective`, `## Proposed Changes`, `## Risks`, `## Verification Plan`."
    );
  } else {
    const fullAccessLine = fullAccess
      ? "\nFULL ACCESS: shell/installs/git run without approval prompts; destructive guardrails remain blocked (use safe equivalents if denied)."
      : "";
    codeSections.push(
      mode === "auto"
        ? `MODE: AUTO. Plan, implement, and verify autonomously until checks pass.${fullAccessLine}`
        : `MODE: ASK. Implement minimal changes and verify before answering.${fullAccessLine}`
    );
  }
  return codeSections.join("\n\n");
}
