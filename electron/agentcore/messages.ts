// Nexus agent-core message model. Replaces @langchain/core/messages with a
// plain, serializable union — no classes, no toJSON() indirection, no
// _getType() duck-typing. Every agent component (loop, compaction,
// checkpoints, adapters) speaks this shape.
//
// Design rules carried over from the LangChain runtime:
// - Tool results are STRING content only. The old runtime had to flatten
//   structured ToolMessage payloads at the stream boundary
//   (flattenToolMessageContent) because structured tool content permanently
//   400s OpenAI-compatible providers — the type now guarantees it.
// - An assistant message's toolCalls are never separated from their
//   role:"tool" responses (compaction, checkpoint pruning and adapters all
//   preserve the pairing).
// - Images ride in user messages as { type: "image", url } blocks; adapters
//   translate to the provider wire format.

import type { ZodTypeAny } from "zod";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type ChatMessage =
  | { role: "user"; content: string | ContentBlock[] }
  | {
      role: "assistant";
      content: string | ContentBlock[];
      toolCalls?: ToolCall[];
      stopReason?: "stop" | "tool" | "length";
      usage?: Usage;
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
      name?: string;
      /** Providers reject a tool result with no matching assistant call. */
      isError?: boolean;
    }
  | { role: "system"; content: string };

export type MessageKind = ChatMessage["role"];

export function userMsg(content: string | ContentBlock[]): ChatMessage {
  return { role: "user", content };
}

export function assistantMsg(content: string | ContentBlock[], toolCalls?: ToolCall[]): ChatMessage {
  return { role: "assistant", content, ...(toolCalls?.length ? { toolCalls } : {}) };
}

export function toolMsg(toolCallId: string, content: string, name?: string, isError?: boolean): ChatMessage {
  return { role: "tool", content, toolCallId, ...(name ? { name } : {}), ...(isError ? { isError: true } : {}) };
}

export function systemMsg(content: string): ChatMessage {
  return { role: "system", content };
}

export function msgKind(message: ChatMessage | undefined | null): MessageKind | "" {
  return message?.role ?? "";
}

export function isImageBlock(content: unknown): content is ContentBlock[] {
  return (
    Array.isArray(content) &&
    content.some((part: unknown) => {
      if (!part || typeof part !== "object") return false;
      const p = part as Record<string, unknown>;
      return p.type === "image" || (p.image_url as Record<string, unknown>)?.url != null || p.type === "image_url";
    })
  );
}

/** Plain-text of any message (content blocks collapse to their text). */
export function textOf(message: ChatMessage | undefined | null): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => (typeof part === "string" ? part : String((part as Record<string, unknown>)?.text ?? "")))
      .join("\n");
  }
  return "";
}

/** Text with blocks joined WITHOUT separators — final-answer extraction. */
export function textJoined(message: ChatMessage | undefined | null): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => (typeof part === "string" ? part : String((part as Record<string, unknown>)?.text ?? "")))
      .join("");
  }
  return "";
}

export function toolCallsOf(message: ChatMessage | undefined | null): ToolCall[] {
  return message?.role === "assistant" && Array.isArray(message.toolCalls) ? message.toolCalls : [];
}

// ---- Serialization (checkpoint / transcript persistence) ----
// v2: plain { role, content, ... } objects — the ChatMessage itself.
// v1: legacy LangChain dumps { type: "human"|"ai"|"tool"|"system", kwargs } —
// still revived so checkpoints saved before the migration keep resuming.

const V1_TYPE_BY_ROLE: Record<MessageKind, string> = {
  user: "human",
  assistant: "ai",
  tool: "tool",
  system: "system",
};
const ROLE_BY_V1_TYPE: Record<string, MessageKind> = {
  human: "user",
  ai: "assistant",
  tool: "tool",
  system: "system",
};

function legacyKwargsToMessage(stored: { type: string; kwargs?: any }): ChatMessage | null {
  const role = ROLE_BY_V1_TYPE[stored.type];
  if (!role) return null;
  const kw = stored.kwargs ?? {};
  const content = typeof kw.content === "string" ? kw.content : Array.isArray(kw.content) ? normalizeLegacyContent(kw.content) : "";
  if (role === "tool") {
    const toolCallId = String(kw.tool_call_id ?? kw.toolCallId ?? "");
    return toolMsg(toolCallId, textFromLegacyContent(content), kw.name, kw.status === "error");
  }
  if (role === "assistant") {
    const calls = Array.isArray(kw.tool_calls)
      ? kw.tool_calls.map((c: any) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? c?.function?.name ?? "tool"), args: parseLegacyArgs(c) })).filter((c: ToolCall) => c.id || c.name)
      : undefined;
    return assistantMsg(content, calls);
  }
  return role === "system" ? systemMsg(textFromLegacyContent(content)) : userMsg(content);
}

function parseLegacyArgs(call: any): unknown {
  const raw = call?.args;
  if (raw !== undefined && raw !== null) return raw;
  const fnArgs = call?.function?.arguments;
  if (typeof fnArgs === "string") {
    try { return JSON.parse(fnArgs); } catch { return {}; }
  }
  return {};
}

function normalizeLegacyContent(content: any[]): ContentBlock[] {
  return content
    .map((part: any): ContentBlock | null => {
      if (typeof part === "string") return { type: "text", text: part };
      if (part?.type === "text" || typeof part?.text === "string") return { type: "text", text: String(part.text ?? "") };
      if (part?.type === "image_url" || part?.image_url?.url) return { type: "image", url: String(part.image_url?.url ?? part.url ?? "") };
      if (part?.type === "thinking" || part?.type === "reasoning") return { type: "text", text: String(part.thinking ?? part.text ?? "") };
      return null;
    })
    .filter((b): b is ContentBlock => b !== null);
}

function textFromLegacyContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => (typeof part === "string" ? part : String(part?.text ?? part?.thinking ?? part?.content ?? ""))).filter(Boolean).join("\n");
  return "";
}

export function serializeMessage(message: ChatMessage): unknown {
  return message;
}

export function reviveMessage(stored: unknown): ChatMessage | null {
  if (!stored || typeof stored !== "object") return null;
  const anyStored = stored as any;
  // v2: the role field is present.
  if (typeof anyStored.role === "string" && ["user", "assistant", "tool", "system"].includes(anyStored.role)) {
    if (anyStored.role === "tool") return toolMsg(String(anyStored.toolCallId ?? ""), String(anyStored.content ?? ""), anyStored.name, anyStored.isError);
    if (anyStored.role === "assistant") {
      const calls = Array.isArray(anyStored.toolCalls)
        ? anyStored.toolCalls.map((c: any) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? "tool"), args: c?.args ?? {} })).filter((c: ToolCall) => c.name)
        : undefined;
      return assistantMsg(anyStored.content ?? "", calls);
    }
    return anyStored.role === "system" ? systemMsg(String(anyStored.content ?? "")) : userMsg(anyStored.content ?? "");
  }
  // v1: legacy LangChain checkpoint dump.
  if (typeof anyStored.type === "string" && ROLE_BY_V1_TYPE[anyStored.type]) {
    return legacyKwargsToMessage({ type: anyStored.type, kwargs: anyStored.kwargs });
  }
  return null;
}

export function reviveMessages(stored: unknown[]): ChatMessage[] {
  return (stored || []).map(reviveMessage).filter((m): m is ChatMessage => m !== null);
}

/** Serialization for a ChatMessage list (v2 checkpoints store these as-is). */
export function serializeMessages(messages: ChatMessage[]): unknown[] {
  return messages.map(serializeMessage);
}

// Legacy shims for v1-dump consumers (sanitizeResumeCheckpoint used to read
// these off LangChain objects). Keeping the tiny helpers central avoids
// re-scattering role checks.
export function toolCallIdOf(message: ChatMessage | undefined | null): string {
  return message?.role === "tool" ? message.toolCallId : "";
}

export function toolResultNameOf(message: ChatMessage | undefined | null): string | undefined {
  return message?.role === "tool" ? message.name : undefined;
}

export type { ZodTypeAny };
