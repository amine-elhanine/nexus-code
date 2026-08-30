import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";

export type CompactTurn = {
  role: "user" | "assistant";
  text: string;
};

export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  // Standard approximation: ~4 characters per token for English/Code
  return Math.max(1, Math.round(text.length / 3.8));
}

export function extractStreamUsage(chunk: any): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
  if (!chunk) return null;

  // LangChain standard usage_metadata
  if (chunk.usage_metadata) {
    const meta = chunk.usage_metadata;
    return {
      inputTokens: meta.input_tokens || meta.inputTokens || 0,
      outputTokens: meta.output_tokens || meta.outputTokens || 0,
      totalTokens: meta.total_tokens || meta.totalTokens || 0,
    };
  }

  // Response metadata from various providers
  const respMeta = chunk.response_metadata || chunk.additional_kwargs;
  if (respMeta?.tokenUsage || respMeta?.usage) {
    const u = respMeta.tokenUsage || respMeta.usage;
    return {
      inputTokens: u.promptTokens || u.prompt_tokens || u.input_tokens || 0,
      outputTokens: u.completionTokens || u.completion_tokens || u.output_tokens || 0,
      totalTokens: u.totalTokens || u.total_tokens || 0,
    };
  }

  return null;
}

/**
 * Compacts conversation history when it approaches token limits.
 * Collapses old tool traces and retains recent turns verbatim.
 */
export function compactHistory(
  turns: Array<{ role: "user" | "assistant" | "event"; text: string; kind?: string }>,
  maxTokens = 8000
): CompactTurn[] {
  if (!turns || turns.length === 0) return [];

  // Filter to just user and assistant turns
  const validTurns = turns.filter((t) => t.role === "user" || t.role === "assistant");
  if (validTurns.length <= 4) {
    return validTurns.map((t) => ({ role: t.role as "user" | "assistant", text: t.text }));
  }

  // Keep last 4 turns completely verbatim
  const recentTurns = validTurns.slice(-4);
  const olderTurns = validTurns.slice(0, -4);

  let currentTokens = recentTurns.reduce((sum, t) => sum + estimateTokens(t.text), 0);

  const compactedOlder: CompactTurn[] = [];
  const summaryBullets: string[] = [];

  for (const turn of olderTurns) {
    const turnTokens = estimateTokens(turn.text);

    // If turn is very large (e.g. large file dump or tool output), compress it
    if (turnTokens > 500) {
      const snippet = turn.text.slice(0, 300).replace(/\r?\n/g, " ");
      summaryBullets.push(`${turn.role === "user" ? "User requested" : "Assistant performed"}: ${snippet}… [collapsed ${turnTokens} tokens]`);
    } else if (currentTokens + turnTokens < maxTokens) {
      compactedOlder.push({ role: turn.role as "user" | "assistant", text: turn.text });
      currentTokens += turnTokens;
    } else {
      const snippet = turn.text.slice(0, 150).replace(/\r?\n/g, " ");
      summaryBullets.push(`${turn.role === "user" ? "User" : "Assistant"}: ${snippet}…`);
    }
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

  return result;
}

/**
 * Injects prompt caching markers for providers that support it (Anthropic, Google Gemini).
 */
export function injectPromptCacheControl(messages: any[], providerType: string): any[] {
  if (providerType !== "anthropic") return messages;

  // In Anthropic, we can attach cache_control: { type: "ephemeral" } to message content blocks
  return messages.map((msg, index) => {
    // Cache the system prompt or early long context messages
    if (index === 0 && typeof msg.content === "string" && msg.content.length > 1000) {
      return new SystemMessage({
        content: [
          {
            type: "text",
            text: msg.content,
            cache_control: { type: "ephemeral" },
          },
        ],
      });
    }
    return msg;
  });
}
