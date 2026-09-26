export type CompactTurn = {
  role: "user" | "assistant";
  text: string;
};

export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  // Standard approximation: ~4 characters per token for English/Code
  return Math.max(1, Math.round(text.length / 3.8));
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
  sawExactInput = false;
  sawExactOutput = false;

  noteChunk(chunk: any): void {
    const usage = extractStreamUsage(chunk);
    if (!usage) return;
    if (usage.inputTokens > 0) this.sawExactInput = true;
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
      `Summarize this coding-session history into short durable bullets (decisions, files changed, errors seen, current goal). ` +
      `Omit verbatim code dumps and tool noise. Max 20 bullets, each one line.\n\n${input}`;
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
