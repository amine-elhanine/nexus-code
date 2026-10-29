// Reasoning extraction for streamed LangChain chunks. Providers surface model
// thinking in different shapes:
//   - Anthropic extended thinking: content blocks `[{ type: "thinking", thinking: "…" }]`
//   - DeepSeek R1 / OpenRouter / xAI / Kimi: `additional_kwargs.reasoning_content`
//   - Generic/OpenAI-compatible variants: `additional_kwargs.reasoning` (string or { content })
// Returns the thinking delta for this chunk, or "" when the chunk carries none.
export function chunkThinking(chunk: any): string {
  const extra = chunk?.additional_kwargs ?? {};
  const kwarg =
    (typeof extra.reasoning_content === "string" && extra.reasoning_content) ||
    (typeof extra.reasoning === "string" && extra.reasoning) ||
    (extra.reasoning && typeof extra.reasoning === "object" && typeof extra.reasoning.content === "string" && extra.reasoning.content) ||
    "";
  if (kwarg) return kwarg;

  const content = chunk?.content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part && typeof part === "object" && (part.type === "thinking" || part.type === "reasoning")) {
          if (typeof part.thinking === "string") return part.thinking;
          if (typeof part.text === "string") return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}
