import { userMsg, textOf } from "./agentcore/messages.js";
import { schemaToText } from "./agentcore/zod-schema.js";
import { z as zodV4 } from "zod";

/**
 * Calculates the auto-compaction threshold for a model's context window:
 * a flat 85% of the window. The 15% completion headroom is what the trigger
 * leaves for the in-flight call; a rare overflow past that is recovered by
 * the context-window-error path (compact + relaunch), so max output tokens
 * are not additionally reserved here. `maxOutput` is kept in the signature
 * for call-site compatibility but no longer moves the threshold.
 */
export function computeCompactionThreshold(contextWindow: number, _maxOutput?: number): number {
  const ctx = Math.max(4096, contextWindow || 128_000);
  return Math.floor(ctx * 0.85);
}

export type CompactTurn = {
  role: "user" | "assistant";
  text: string;
};

export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  // Standard approximation: ~4 characters per token for English/Code
  return Math.max(1, Math.round(text.length / 3.8));
}

/**
 * Providers surface an exhausted context window under many shapes (OpenAI's
 * "maximum context length", Anthropic's "prompt is too long", Gemini's input
 * token count, gateway "payload too large" 413s). These errors are NOT
 * transient — retrying unchanged would fail again — so callers must compact
 * and resume instead.
 */
const CONTEXT_WINDOW_PATTERN =
  /context[_\s-]?(length|window|limit)|maximum context length|prompt (is |exceeds|too )?(too |the )?long|prompt_too_long|too many tokens|input token count|token(s)? limit|exceed(ed|s)? the maximum|maximum number of tokens allowed|context_length_exceeded|reduce the (length|size)|conversation is too long|maximum request length|payload too large|\b413\b/i;

export function isContextWindowError(error: unknown): boolean {
  if (!error) return false;
  const parts = [
    error instanceof Error ? error.message : String(error),
    String((error as any)?.name ?? ""),
    String((error as any)?.code ?? ""),
    String((error as any)?.status ?? ""),
    (() => {
      try { return JSON.stringify((error as any)?.error ?? (error as any)?.body ?? ""); } catch { return ""; }
    })(),
  ].join(" ");
  return CONTEXT_WINDOW_PATTERN.test(parts);
}

/** Rough token estimate of a single agent message (content + tool-call args). */
export function estimateMessageTokens(message: any): number {
  if (!message) return 0;
  const content = message.content ?? message.text ?? "";
  let chars = 0;
  if (typeof content === "string") chars = content.length;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") chars += part.length;
      else if (part?.text) chars += String(part.text).length;
      else if (part?.url || part?.image_url?.url) chars += String(part.url ?? part.image_url?.url).length;
      else chars += JSON.stringify(part).length;
    }
  }
  let tokens = Math.ceil(chars / 3.8);
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    try { tokens += Math.ceil(JSON.stringify(call?.args ?? {}).length / 3.8) + 8; } catch { tokens += 24; }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: any[]): number {
  return (messages || []).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

void zodV4;
void textOf;

/** Rough token estimate of tool DEFINITIONS as providers receive them with
 *  every model call (name + description + parameter schema). */
export function estimateToolSchemaTokens(tools: any[]): number {
  return (tools || []).reduce((sum, tool) => {
    if (!tool) return sum;
    const schema = tool?.schema ?? tool?.parameters ?? tool?.lc_kwargs?.schema ?? null;
    const chars = String(tool?.name ?? "").length + String(tool?.description ?? "").length + schemaToText(schema).length + 24;
    return sum + Math.max(8, Math.ceil(chars / 3.8));
  }, 0);
}

const messageKind = (message: any): string => (
  message?.role
  || (typeof message?.type === "string" && ["user", "assistant", "tool", "system"].includes(message.type) ? message.type : "")
  || (Array.isArray(message?.toolCalls) && message.toolCalls.length ? "assistant" : "")
);

/**
 * Group boundaries of a run message list. Cutting the transcript at any of
 * these indices keeps the Anthropic/OpenAI tool-calling contract intact:
 * an assistant message with toolCalls is never separated from its tool
 * results, and the remaining transcript never opens with an orphan result.
 */
function runMessageGroupStarts(messages: any[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const kind = messageKind(messages[i]);
    const extendsPrior = kind === "tool" || (kind === "assistant" && Array.isArray(messages[i]?.toolCalls) && messages[i].toolCalls.length > 0);
    if (!extendsPrior) starts.push(i);
  }
  if (starts[0] !== 0) starts.unshift(0);
  return starts.length ? starts : [0];
}

function contentTextOf(message: any): string {
  const content = message?.content ?? message?.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : String(part?.text ?? "")).trim()).filter(Boolean).join("\n");
  }
  return "";
}

/**
 * Deterministic run-history compaction. Always keeps the FIRST group (the
 * original request), drops the oldest middle groups until the suffix fits the
 * budget, and replaces what was dropped with a compact digest message. If a
 * single huge message still overflows, its content is truncated from the front
 * (results/answers end with the most relevant tail). Pure and synchronous —
 * run it at every attempt boundary; the budget is measured in estimated
 * message tokens and must already reserve room for the system prompt.
 */
export function trimRunMessages(messages: any[], budgetTokens: number): any[] {
  const list = (messages || []).filter(Boolean);
  if (list.length <= 2) return list;
  const starts = runMessageGroupStarts(list);
  if (starts.length === 1) {
    // Whole transcript is one group — can't cut at a boundary; keep intact.
    return list;
  }

  const suffixTokens = (idx: number) => estimateMessagesTokens(list.slice(idx));
  // Smallest droppable start (s > 0) whose suffix fits keeps the most context.
  let keepFrom = -1;
  for (const s of starts) {
    if (s === 0) continue;
    if (suffixTokens(s) <= budgetTokens) { keepFrom = s; break; }
  }
  if (keepFrom === -1) keepFrom = starts[starts.length - 1];

  // The digest must always carry the original request (group 0) verbatim.
  const dropped = list.slice(0, keepFrom);
  const digestParts = dropped.map((m) => contentTextOf(m).slice(0, 500)).filter(Boolean);
  let digest = `[Condensed earlier work — the original request is included below in context]\n` + digestParts.join("\n").replace(/\n{3,}/g, "\n\n");
  if (digest.length > 4000) digest = `${digest.slice(0, 3400)}\n… [${digestParts.length} earlier entries condensed]`;
  const summary: any = userMsg(digest);
  const result = [summary, ...list.slice(keepFrom)];

  // Last resort: the remaining suffix itself overflows (one giant tool result).
  let total = estimateMessagesTokens(result);
  for (let i = 1; i < result.length && total > budgetTokens; i++) {
    const tokens = estimateMessageTokens(result[i]);
    if (!tokens) continue;
    const text = contentTextOf(result[i]);
    if (text && text.length > 4096) {
      const capChars = Math.max(0, Math.floor((budgetTokens - estimateMessagesTokens(result.slice(i + 1))) * 3.8));
      const truncated = text.length > capChars ? `…${text.slice(-capChars)}` : text;
      result[i].content = truncated;
      total = estimateMessagesTokens(result);
    }
  }
  return result;
}

/** Compact a run transcript while carrying a bounded durable task brief forward. */
export function trimRunMessagesWithRecoveryBrief(messages: any[], recoveryBrief: string, budgetTokens: number): any[] {
  const compacted = trimRunMessages(messages, budgetTokens);
  if (!recoveryBrief?.trim()) return compacted;
  const brief = userMsg(recoveryBrief.trim());
  return trimRunMessages([...compacted, brief], budgetTokens);
}

export type StreamUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

// Run usage accounting. Each model invocation reports ONE final usage object
// from its protocol adapter (the adapters know each provider's wire shape —
// usage_metadata soup and the per-message-id cumulative-collapse dance are
// gone). Totals simply sum across invocations; subagent usage is added via
// addTotals.
export class StreamUsageTracker {
  private invocationInputTokens = 0;
  private invocationOutputTokens = 0;
  private invocationCacheReadTokens = 0;
  private invocationCacheCreationTokens = 0;
  private maxObservedInputTokens = 0;
  sawExactInput = false;
  sawExactOutput = false;

  /**
   * Largest single-invocation input token count seen so far. Because context
   * only grows during a run, this is the best available measurement of the
   * CURRENT request size — the number that must fit the context window.
   */
  get lastObservedInputTokens(): number {
    return this.maxObservedInputTokens;
  }

  noteUsage(usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null): void {
    if (!usage) return;
    const inputTokens = Number(usage.inputTokens ?? 0);
    const outputTokens = Number(usage.outputTokens ?? 0);
    if (!inputTokens && !outputTokens) return;
    if (inputTokens > 0) {
      this.sawExactInput = true;
      this.maxObservedInputTokens = Math.max(this.maxObservedInputTokens, inputTokens);
    }
    if (outputTokens > 0) this.sawExactOutput = true;
    this.invocationInputTokens += inputTokens;
    this.invocationOutputTokens += outputTokens;
    this.invocationCacheReadTokens += Number(usage.cacheReadTokens ?? 0);
    this.invocationCacheCreationTokens += Number(usage.cacheCreationTokens ?? 0);
  }

  // Add already-aggregated invocation totals (e.g. a subagent's usage) on top
  // of the tracked invocations.
  addTotals(inputTokens: number, outputTokens: number): void {
    this.invocationInputTokens += inputTokens || 0;
    this.invocationOutputTokens += outputTokens || 0;
  }

  get inputTokens(): number {
    return this.invocationInputTokens;
  }

  get outputTokens(): number {
    return this.invocationOutputTokens;
  }

  // Cache-token totals follow the same sum-across-invocations semantics so
  // the hover-card hit rate stays consistent with the input totals it is
  // divided by.
  get cacheReadTokens(): number {
    return this.invocationCacheReadTokens;
  }

  get cacheCreationTokens(): number {
    return this.invocationCacheCreationTokens;
  }
}

/**
 * Compacts conversation history when it approaches token limits.
 * Collapses old tool traces and retains recent turns verbatim.
 */
export function compactHistory(
  turns: Array<{ role: "user" | "assistant" | "event"; text: string; kind?: string }>,
  maxTokens = 8000
): CompactTurn[] {  if (!turns || turns.length === 0) return [];

  const budget = Math.max(64, Math.floor(maxTokens));
  const enforceBudget = (items: CompactTurn[]): CompactTurn[] => {
    const result = [...items];
    // Drop the oldest context first. The newest turn is the most useful piece
    // of context when a caller gives us an unusually small budget.
    while (result.length > 1 && result.reduce((sum, item) => sum + estimateTokens(item.text), 0) > budget) result.shift();
    const total = result.reduce((sum, item) => sum + estimateTokens(item.text), 0);
    if (total > budget && result.length) {
      const capChars = Math.max(64, Math.floor(budget * 3.8));
      const last = result[result.length - 1];
      result[result.length - 1] = { ...last, text: last.text.slice(-capChars) };
    }
    return result;
  };

  // Filter to just user and assistant turns
  const validTurns = turns.filter((t) => t.role === "user" || t.role === "assistant");
  const durableEvents = turns.filter((t) => t.role === "event" && ["tool", "error", "plan", "status"].includes(t.kind || ""));
  if (validTurns.length <= 4) {
    return enforceBudget(validTurns.map((t) => ({ role: t.role as "user" | "assistant", text: t.text })));
  }

  // Keep last 4 turns completely verbatim
  const recentTurns = validTurns.slice(-4);
  const olderTurns = validTurns.slice(0, -4);

  let currentTokens = recentTurns.reduce((sum, t) => sum + estimateTokens(t.text), 0);

  const compactedOlder: CompactTurn[] = [];
  const summaryBullets: string[] = [];

  const excerpt = (text: string, cap: number) => {
    if (text.length <= cap) return text.replace(/\r?\n/g, " ");
    const head = Math.floor(cap * 0.65);
    return `${text.slice(0, head)} … ${text.slice(-Math.floor(cap * 0.35))}`.replace(/\r?\n/g, " ");
  };

  for (const turn of olderTurns) {
    const turnTokens = estimateTokens(turn.text);

    // If turn is very large (e.g. large file dump or tool output), compress it
    if (turnTokens > 500) {
      const snippet = excerpt(turn.text, 520);
      summaryBullets.push(`${turn.role === "user" ? "User requested" : "Assistant performed"}: ${snippet}… [collapsed ${turnTokens} tokens]`);
    } else if (currentTokens + turnTokens < maxTokens) {
      compactedOlder.push({ role: turn.role as "user" | "assistant", text: turn.text });
      currentTokens += turnTokens;
    } else {
      const snippet = excerpt(turn.text, 280);
      summaryBullets.push(`${turn.role === "user" ? "User" : "Assistant"}: ${snippet}…`);
    }
  }

  // Tool results and diagnostics are not conversation turns, but they often
  // contain the exact failure or verification state needed to continue a
  // large task. Preserve compact excerpts instead of dropping them entirely.
  for (const event of durableEvents.slice(-12)) {
    summaryBullets.push(`${event.kind}: ${excerpt(event.text, 360)}`);
  }

  const result: CompactTurn[] = [];

  if (summaryBullets.length > 0) {
    result.push({
      role: "user",
      text: `[Prior Conversation Summary]\n` + summaryBullets.map((b) => `- ${b}`).join("\n"),
    });
    result.push({
      role: "assistant",
      text: "Understood. I have context on our previous discussion and will proceed accordingly.",
    });
  }

  result.push(...compactedOlder);
  result.push(...recentTurns.map((t) => ({ role: t.role as "user" | "assistant", text: t.text })));

  return enforceBudget(result);
}

/**
 * P1: model-backed compaction. When older history is large, a single cheap
 * summarization call preserves decisions/facts far better than first-N-chars
 * truncation. Best-effort with timeout — any failure falls back to
 * compactHistory() so runs never stall on summarization.
 */
export async function compactHistoryWithModel(
  turns: Array<{ role: "user" | "assistant" | "event"; text: string; kind?: string }>,
  summarize: (prompt: string) => Promise<string>,
  maxTokens = 8000
): Promise<CompactTurn[]> {
  try {
    const validTurns = (turns || []).filter((t) => t.role === "user" || t.role === "assistant");
    if (validTurns.length <= 6) return compactHistory(turns, maxTokens);
    const olderTurns = validTurns.slice(0, -4);
    const olderTokens = olderTurns.reduce((sum, t) => sum + estimateTokens(t.text), 0);
    // Small histories don't need a model call.
    if (olderTokens < 6000) return compactHistory(turns, maxTokens);
    const input = olderTurns
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.length > 2600 ? `${t.text.slice(0, 1700)} … ${t.text.slice(-900)}` : t.text}`)
      .join("\n\n")
      .slice(0, 24000);
    const prompt =
      `Summarize this coding-session history into short recovery notes for a coding agent. Preserve the original request and constraints, ` +
      `current goal, decisions and their reasons, important findings with file paths or source references, files changed, unfinished plan steps, ` +
      `latest diagnostics and verification results, and the next action. Distinguish verified facts from assumptions; do not invent details. ` +
      `Omit verbatim code dumps and repetitive tool noise. Max 20 bullets, each one line.\n\n${input}`;
    const timed = await Promise.race([
      Promise.resolve(summarize(prompt)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000)),
    ]);
    if (typeof timed !== "string" || !timed.trim()) return compactHistory(turns, maxTokens);
    const recentTurns = validTurns.slice(-4).map((t) => ({ role: t.role as "user" | "assistant", text: t.text }));
    const summaryTurn: CompactTurn = {
      role: "user",
      text: `[Prior Conversation Summary — model-generated]\n${timed.trim().slice(0, 4000)}`,
    };
    const ackTurn: CompactTurn = {
      role: "assistant",
      text: "Understood. I have context on our previous discussion and will proceed accordingly.",
    };
    const compacted = [summaryTurn, ackTurn, ...recentTurns];
    // Model summaries are useful but still untrusted output; enforce the same
    // hard budget as the deterministic path before handing history to a model.
    return compactHistory(compacted, maxTokens);
  } catch {
    return compactHistory(turns, maxTokens);
  }
}
