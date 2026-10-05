// Shared agent type contracts. Extracted from agent-service.ts so prompt,
// routing, and checkpoint modules can reference them without circular imports.
import type { ArtifactItem } from "./artifacts-service.js";
import type { SubagentItem } from "./subagent-service.js";
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
export type AgentMemoryContext = { projectMemory: string; sessionMemory: string; /** Agent-recorded durable facts (project_memory tool, Code mode only). */ facts?: string };
// "code" = repository work (typecheck/test verification). "general" = the
// Home assistant (documents, spreadsheets, slides, research, everyday
// questions): same tool loop, but no code-project verification and a
// different system prompt.
export type AgentTaskKind = "code" | "general";

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

export type AttachmentDoc = { name: string; mimeType: string; text: string; truncated: boolean };
