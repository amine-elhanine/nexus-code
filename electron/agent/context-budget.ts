// Context budget preparation + auto-compaction, extracted verbatim from
// agent-service.ts (no behavior change): computes the token budget for a run
// and compacts oversized conversation history (with a model summarizer) to
// keep the projected context inside the compaction threshold.
//
// Inputs mirror exactly what agent-service computed inline before the
// extraction; emit/onEvent are passed in so status events keep the same
// shape, ordering, and text as before.

import { computeCompactionThreshold, compactHistory, compactHistoryWithModel, estimateTokens, estimateToolSchemaTokens } from "../context-service.js";
import { formatContextWindow, formatTokenCount } from "../providers.js";
import { skillDirVirtualPath, type SkillInfo } from "../skills-service.js";
import type { HistoryInput } from "../agent-types.js";

export type ContextBudgetInput = {
  modelContextWindow: number;
  modelMaxOutput?: number;
  systemPromptText: string;
  mcpTools: unknown[];
  pluginTools: unknown[];
  /** Full bound tool list (builtin + mcp + plugin). */
  boundTools: unknown[];
  mountedSkillCatalog: SkillInfo[];
  /** Meta-context strings embedded INSIDE the system prompt; estimated here
   * only for diagnostics, never added to promptOverheadTokens (they would
   * double-count against the prompt text). */
  metaContextInputs: Array<string | undefined | null>;
  history: HistoryInput[];
  isSimple: boolean;
  /** Chat model used to summarize history when compaction is needed. */
  llm: { invoke: (input: any, options?: any) => Promise<any> };
  isGeneral: boolean;
  emit: (type: "status", text: string) => void;
  onEvent: (event: { type: "status"; sessionId: string; text: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }) => void;
  sessionId?: string;
};

export type ContextBudgetSummary = {
  compactionThreshold: number;
  outputReserve: number;
  systemPromptTokens: number;
  mcpToolsTokens: number;
  pluginToolsTokens: number;
  systemToolsTokens: number;
  skillsTokens: number;
  metaContextTokens: number;
  promptOverheadTokens: number;
  targetBudget: number;
  estimatedHistoryTokens: number;
  historyBudget: number;
  projectedHistoryTokens: number;
  /** Trimmed history: user/assistant turns, possibly model-compacted. */
  compactedHistory: Array<{ role: "user" | "assistant"; text: string }>;
};

export async function prepareContextBudget(input: ContextBudgetInput): Promise<ContextBudgetSummary> {
  const {
    modelContextWindow, modelMaxOutput, systemPromptText, mcpTools, pluginTools,
    boundTools, mountedSkillCatalog, metaContextInputs, history, isSimple, llm,
    isGeneral, emit, onEvent, sessionId,
  } = input;

  const compactionThreshold = computeCompactionThreshold(modelContextWindow, modelMaxOutput);
  const outputReserve = Math.min(Math.max(modelMaxOutput || 8192, 2048), 32_000);
  const systemPromptTokens = Math.ceil((systemPromptText || "").length / 3.8);
  // Prompt composition for the context breakdown (hover card) and budget math:
  // tool schemas and the skill manifest ride along with every model call but
  // live outside the system prompt text, so estimate them separately. Meta
  // context (memory, rules, repo map, project instructions, plugin context) is
  // embedded INSIDE the system prompt — estimate it from its inputs and
  // subtract, so breakdown rows never double-count.
  const mcpToolsTokens = estimateToolSchemaTokens(mcpTools as any[]);
  const pluginToolsTokens = estimateToolSchemaTokens(pluginTools as any[]);
  const mcpToolSet = new Set<unknown>(mcpTools);
  const pluginToolSet = new Set<unknown>(pluginTools);
  const systemToolsTokens = estimateToolSchemaTokens(boundTools.filter((t) => !mcpToolSet.has(t) && !pluginToolSet.has(t)) as any[]);
  const skillsTokens = mountedSkillCatalog.length
    ? estimateTokens(mountedSkillCatalog.map((s) => `${s.name}\n${s.description}\n${skillDirVirtualPath(s)}`).join("\n")) + mountedSkillCatalog.length * 24
    : 0;
  const metaContextTokens = estimateTokens(metaContextInputs.filter(Boolean).join("\n"));
  const promptOverheadTokens = systemPromptTokens + systemToolsTokens + mcpToolsTokens + pluginToolsTokens + skillsTokens;
  const targetBudget = Math.max(1500, Math.floor(compactionThreshold * 0.55 - promptOverheadTokens - outputReserve));
  const estimatedHistoryTokens = history.reduce((sum, t) => sum + estimateTokens(t.text), 0);
  const historyBudget = targetBudget;
  const projectedHistoryTokens = estimatedHistoryTokens + promptOverheadTokens;

  // Auto context compaction (like Claude Code & Codex):
  // - If conversation history is within safe context bounds (< ~85%), keep full history verbatim
  // - If conversation history reaches or nears the model's context window limit (>= threshold),
  //   automatically compact older history down to targetBudget (~50%), preserving the last 4 turns verbatim.
  let compactedHistory;
  if (projectedHistoryTokens < compactionThreshold && !isSimple) {
    compactedHistory = history
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => ({ role: t.role as "user" | "assistant", text: t.text }));
  } else if (isSimple) {
    compactedHistory = compactHistory(history, Math.min(3000, historyBudget));
  } else {
    const pct = Math.round((projectedHistoryTokens / modelContextWindow) * 100);
    emit("status", `Auto-compacting context (${formatTokenCount(estimatedHistoryTokens)} / ${formatContextWindow(modelContextWindow)} tokens, ~${pct}% capacity) — summarizing history…`);

    compactedHistory = await compactHistoryWithModel(
      history,
      async (prompt) => {
        try {
          const taskAwarePrompt = isGeneral
            ? prompt.replace("coding-session history", "general Home task history").replace("files changed, errors seen", "research findings, decisions, outputs created, errors seen")
            : prompt;
          const res: any = await llm.invoke(taskAwarePrompt);
          const text = typeof res?.content === "string" ? res.content : Array.isArray(res?.content) ? res.content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("\n") : String(res?.content || res?.text || "");
          return text;
        } catch {
          throw new Error("summarizer failed");
        }
      },
      historyBudget
    ).catch(() => compactHistory(history, historyBudget));

    const compactedTokens = compactedHistory.reduce((sum, t) => sum + estimateTokens(t.text), 0);
    const freedTokens = Math.max(0, estimatedHistoryTokens - compactedTokens);

    emit("status", `Context auto-compacted: ${formatTokenCount(estimatedHistoryTokens)} → ${formatTokenCount(compactedTokens)} tokens (${formatTokenCount(freedTokens)} freed)`);
    onEvent({
      type: "status",
      sessionId: sessionId || "",
      text: `Context auto-compacted: ${formatTokenCount(estimatedHistoryTokens)} → ${formatTokenCount(compactedTokens)} tokens (${formatTokenCount(freedTokens)} freed)`,
      usage: {
        inputTokens: compactedTokens,
        outputTokens: 0,
        totalTokens: compactedTokens,
      },
    });
  }

  return {
    compactionThreshold,
    outputReserve,
    systemPromptTokens,
    mcpToolsTokens,
    pluginToolsTokens,
    systemToolsTokens,
    skillsTokens,
    metaContextTokens,
    promptOverheadTokens,
    targetBudget,
    estimatedHistoryTokens,
    historyBudget,
    projectedHistoryTokens,
    compactedHistory,
  };
}
