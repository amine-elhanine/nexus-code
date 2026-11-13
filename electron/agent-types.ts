// Shared agent type contracts. Extracted from agent-service.ts so prompt,
// routing, and checkpoint modules can reference them without circular imports.
import type { ArtifactItem } from "./artifacts-service.js";
import type { SubagentItem } from "./subagent-service.js";
import type { ProviderConfig } from "./store.js";

export type AgentMode = "plan" | "ask" | "auto" | "full";
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
export type AgentSettings = { provider?: ProviderConfig; model?: string; apiKey?: string; baseUrl?: string; effort?: string; reasoningEffort?: string; contextWindow?: number; maxOutput?: number };
/**
 * RunProfile (Phase 1 unification): the declarative mode-difference DECISIONS
 * for one run. Instead of `isGeneral` ternaries scattered through tool
 * binding and scope naming, the profile says what a mode IS; a third profile
 * (notebook) becomes data. Code mode's `browser: false` means demand-gated
 * (web-flavored tasks flip it on via wantsBrowser at the binding site).
 */
export type RunProfile = {
  /** Browser/activity scope tag — also the skills/plugins mode. */
  scope: "home" | "code";
  skillsMode: "home" | "code" | "notebook";
  codeIntelligence: boolean;
  browser: boolean;
  webImageSearch: boolean;
  webVideoSearch: boolean;
  subagents: boolean;
  homeDeliverables: boolean;
  /** Shared cross-chat memory tool (manage_memory). */
  sharedMemoryTool: boolean;
  /** apply_patch edit tool (Code-only; Home mutates via backend tools). */
  applyPatch: boolean;
  /** Repo instruction discovery (AGENTS.md/CLAUDE.md) — Code-only. */
  projectInstructions: boolean;
  // ── Regime descriptors (deep RunProfile migration): the remaining
  // mode-difference DECISIONS as data, so runProjectAgent reads the profile
  // instead of branching on taskKind at every call site.
  /** Which contract-inference regime parses the request ("none" = no contract). */
  contract: "home" | "code" | "none";
  /** Which task-journal regime records progress and persists ("none" = none). */
  journal: "home" | "code" | "none";
  /** Supervisor verify regime (home: deliverable-inspection decision core; code: code verify). */
  verify: "home" | "code";
  /** Mid-run provider failover on rate-limit exhaustion (Home-only today). */
  failover: boolean;
  /** Rate-limit retry shape (home: 4 attempts/0 resets/5s base; code: defaults). */
  retry: "home" | "code";
  /** Budget regime (step limits + extension caps + budget ask). */
  budget: "home" | "code";
  /** Memory regime (home: shared cross-chat memory; project: per-project memory). */
  memory: "home" | "project";
};
export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number | null; /** Prompt-cache totals for the run (provider-reported when available). */ cacheReadTokens?: number; cacheCreationTokens?: number };
export type AgentContextBreakdownEntry = { label: string; tokens: number };
export type AgentContextSnapshot = { usedTokens: number; contextWindow: number; compactionThreshold: number; estimated: boolean; breakdown?: AgentContextBreakdownEntry[]; /** Run-cumulative exact input + cache-hit tokens for the hover-card cache rate. */ cacheInputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
export type AgentEvent = {
  type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "context" | "subagent" | "artifact" | "thinking" | "stream-reset";
  sessionId: string;
  text: string;
  timestamp: string;
  items?: PlanItem[];
  usage?: AgentUsage;
  context?: AgentContextSnapshot;
  subagent?: SubagentItem;
  artifact?: ArtifactItem;
  // Truncated tool-result excerpt for tool events. Persisted in the session
  // transcript (unlike token chunks) so the NEXT run can reuse what this run
  // already read — without it every run starts cold and re-reads everything.
  detail?: string;
};
export type AgentMemoryContext = { projectMemory: string; sessionMemory: string; /** Agent-recorded durable facts (project_memory tool, Code mode only). */ facts?: string };
// "code" = repository work (typecheck/test verification). "general" = the
// Home assistant (documents, spreadsheets, slides, research, everyday
// questions): same tool loop, but no code-project verification and a
// different system prompt.
export type AgentTaskKind = "code" | "general";

export type HomeArtifactFormat = "docx" | "pdf" | "pptx" | "xlsx" | "tex" | "md" | "csv" | "txt";

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
  /** Required output extensions when the request clearly names a file format. */
  expectedFormats: HomeArtifactFormat[];
};

export type AttachmentDoc = { name: string; mimeType: string; text: string; truncated: boolean };
