import { HumanMessage } from "@langchain/core/messages";
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

/** Rough token estimate of a single LangChain message (content + tool-call args). */
export function estimateMessageTokens(message: any): number {
  if (!message) return 0;
  const content = message.content ?? message.text ?? "";
  let chars = 0;
  if (typeof content === "string") chars = content.length;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") chars += part.length;
      else if (part?.text) chars += String(part.text).length;
      else if (part?.image_url?.url) chars += String(part.image_url.url).length;
      else chars += JSON.stringify(part).length;
    }
  }
  let tokens = Math.ceil(chars / 3.8);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      try { tokens += Math.ceil(JSON.stringify(call?.args ?? {}).length / 3.8) + 8; } catch { tokens += 24; }
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: any[]): number {
  return (messages || []).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// Zod v4 first (the project's pinned zod), then a v3-style _def walk, then raw
// stringify for plain JSON-Schema inputs (MCP tools arrive pre-serialized).
function schemaToText(schema: any, depth = 0): string {
  if (!schema || depth > 8) return "";
  if (typeof schema === "string") return schema;
  try {
    const json = zodV4.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    if (json && typeof json === "object") return JSON.stringify(json);
  } catch { /* not a zod v4 schema */ }
  try {
    if (typeof schema.shape === "object" && schema.shape) {
      return `{${Object.entries(schema.shape).map(([key, value]) => `${key}:${schemaToText(value, depth + 1)}`).join(",")}}`;
    }
    const def = schema._def ?? {};
    const inner = def.innerType ?? def.schema ?? def.element ?? def.wrappedValue;
    const description = schema.description ?? def.description ?? "";
    return `${def.typeName ?? schema.type ?? ""}${inner ? `<${schemaToText(inner, depth + 1)}>` : ""}${description ? `(${description})` : ""}`;
  } catch { /* fall through */ }
  try { return JSON.stringify(schema) || ""; } catch { return ""; }
}

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
  typeof message?._getType === "function" ? message._getType()
    : typeof message?.type === "string" ? message.type
      : message?.role || (Array.isArray(message?.tool_calls) && message.tool_calls.length ? "ai" : "")
);

/**
 * Group boundaries of a run message list. Cutting the transcript at any of
 * these indices keeps the Anthropic/OpenAI tool-calling contract intact:
 * an AIMessage with tool_calls is never separated from its ToolMessages,
 * and the remaining transcript never opens with an orphan tool result.
 */
function runMessageGroupStarts(messages: any[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const kind = messageKind(messages[i]);
    const extendsPrior = kind === "tool" || (kind === "ai" && Array.isArray(messages[i]?.tool_calls) && messages[i].tool_calls.length > 0);
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
  const summary: any = new HumanMessage(digest);
  summary.content = digest;
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
  const brief = new HumanMessage(recoveryBrief.trim());
  brief.content = recoveryBrief.trim();
  return trimRunMessages([...compacted, brief], budgetTokens);
}

export type StreamUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

function usageFromMeta(u: any): StreamUsage | null {
  if (!u || typeof u !== "object") return null;
  const usage = {
    inputTokens: u.promptTokens || u.prompt_tokens || u.input_tokens || u.inputTokens || 0,
    outputTokens: u.completionTokens || u.completion_tokens || u.output_tokens || u.outputTokens || 0,
    totalTokens: u.totalTokens || u.total_tokens || u.totalTokens || 0,
  };
  // An all-zero payload carries no information (some providers emit empty
  // usage objects mid-stream); treat it as absent so callers can fall through
  // to the other metadata locations.
  if (!usage.inputTokens && !usage.outputTokens && !usage.totalTokens) return null;
  return usage;
}

export function extractStreamUsage(chunk: any): StreamUsage | null {
  if (!chunk) return null;

  // LangChain standard usage_metadata wins when it carries real values; some
  // providers emit an empty one alongside populated legacy metadata.
  return (
    usageFromMeta(chunk.usage_metadata) ??
    // Provider-specific spots: OpenAI-style response_metadata, Mistral/Groq
    // tokenUsage (which can live in additional_kwargs even when
    // response_metadata is present, so both must be checked).
    usageFromMeta(chunk.response_metadata?.tokenUsage) ??
    usageFromMeta(chunk.response_metadata?.usage) ??
    usageFromMeta(chunk.additional_kwargs?.tokenUsage) ??
    usageFromMeta(chunk.additional_kwargs?.usage)
  );
}

// Streaming usage accounting. A single model invocation surfaces its usage in
// different shapes depending on the provider:
//  - one trailing chunk with the invocation totals (OpenAI and friends),
//  - repeated chunks carrying cumulative totals under the same message id
//    (Groq's x_groq usage, Anthropic's native event stream),
//  - complementary chunks: input on an id-bearing message_start chunk, output
//    on an id-less message_delta chunk (Anthropic legacy),
//  - per-chunk deltas on id-less chunks (Google Gemini).
// Accordingly: repeated usage under the same message id is cumulative and
// collapses to the max seen per field, usage on id-less chunks is incremental
// and is summed as reported, and the grand total sums across invocations.
export class StreamUsageTracker {
  private perMessage = new Map<string, { inputTokens: number; outputTokens: number }>();
  private incrementalInputTokens = 0;
  private incrementalOutputTokens = 0;
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

  noteChunk(chunk: any): void {
    const usage = extractStreamUsage(chunk);
    if (!usage) return;
    if (usage.inputTokens > 0) {
      this.sawExactInput = true;
      this.maxObservedInputTokens = Math.max(this.maxObservedInputTokens, usage.inputTokens);
    }
    if (usage.outputTokens > 0) this.sawExactOutput = true;
    const id = typeof chunk?.id === "string" && chunk.id ? chunk.id : null;
    if (!id) {
      this.incrementalInputTokens += usage.inputTokens || 0;
      this.incrementalOutputTokens += usage.outputTokens || 0;
      return;
    }
    const bucket = this.perMessage.get(id) ?? { inputTokens: 0, outputTokens: 0 };
    bucket.inputTokens = Math.max(bucket.inputTokens, usage.inputTokens || 0);
    bucket.outputTokens = Math.max(bucket.outputTokens, usage.outputTokens || 0);
    this.perMessage.set(id, bucket);
  }

  // Add already-aggregated invocation totals (e.g. a subagent's usage) on top
  // of the tracked chunks.
  addTotals(inputTokens: number, outputTokens: number): void {
    this.incrementalInputTokens += inputTokens || 0;
    this.incrementalOutputTokens += outputTokens || 0;
  }

  get inputTokens(): number {
    let total = this.incrementalInputTokens;
    for (const bucket of this.perMessage.values()) total += bucket.inputTokens;
    return total;
  }

  get outputTokens(): number {
    let total = this.incrementalOutputTokens;
    for (const bucket of this.perMessage.values()) total += bucket.outputTokens;
    return total;
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
