// Chat client surface. One interface, three protocol adapters. The loop and
// every agent consumer depend only on these types — provider specifics live
// inside the adapters.
import type { ChatMessage, ContentBlock, ToolCall, Usage } from "../messages.js";
import type { AgentTool } from "../tools.js";

export interface ChatRequest {
  messages: ChatMessage[];
  /** System prompt (adapters extract chat["system"] messages if set there). */
  system?: string;
  tools?: AgentTool[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; argsDelta: string }
  | { type: "done"; text: string; toolCalls: ToolCall[]; usage?: Usage; stopReason: "stop" | "tool" | "length" };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: "stop" | "tool" | "length";
}

export interface ChatClient {
  /** Provider id ("openai", "anthropic", …) — telemetry and failover labels. */
  providerId: string;
  label: string;
  model: string;
  /** Streaming invocation: the final "done" event carries the full result. */
  stream(request: ChatRequest): AsyncGenerator<ChatEvent, void, unknown>;
  /** Non-streaming helper for one-shot calls (summaries, extractions). */
  complete(request: ChatRequest): Promise<ChatResult>;
}

export type { ChatMessage, ContentBlock, ToolCall, Usage };
