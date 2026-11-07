// Anthropic Messages-API adapter (native Anthropic AND Anthropic-protocol
// gateways serving Claude on /messages). Ports the behavior of the old
// CachingChatAnthropic subclass: top-level cache_control injection (cached
// prefix billing), thinking budgets from the reasoning-effort setting, and the
// temperature-1.0-with-thinking API requirement. Thinking deltas stream from
// native thinking blocks — no more mining additional_kwargs shapes.
import { postJSON, sseFrom } from "./sse.js";
import type { ChatEvent, ChatRequest, ChatResult, ChatClient, Usage } from "./types.js";
import type { ChatMessage, ContentBlock, ToolCall } from "../messages.js";
import type { AgentTool } from "../tools.js";

export interface AnthropicOptions {
  baseUrl?: string;
  apiKey?: string;
  providerId: string;
  label: string;
  model: string;
  extraHeaders?: Record<string, string>;
  defaultMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 8192;

function effortToBudget(effort: string): number {
  switch (effort.toLowerCase()) {
    case "minimal": return 1024;
    case "low": return 2048;
    case "medium": return 8192;
    case "high": return 16384;
    case "xhigh":
    case "max": return 32000;
    default: return 8192;
  }
}

function toWireBlocks(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    const url = block.url || "";
    const dataUrlMatch = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (dataUrlMatch) {
      return { type: "image", source: { type: "base64", media_type: dataUrlMatch[1], data: dataUrlMatch[2] } };
    }
    return { type: "image", source: { type: "url", url } };
  });
}

function toWireMessages(messages: ChatMessage[]): { system: string; wire: Array<Record<string, unknown>> } {
  let systemText = "";
  const wire: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemText = systemText ? `${systemText}\n\n${message.content}` : message.content;
      continue;
    }
    if (message.role === "user") {
      wire.push({
        role: "user",
        content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : toWireBlocks(message.content),
      });
    } else if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      const text = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (text) content.push({ type: "text", text });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
      }
      if (content.length) wire.push({ role: "assistant", content });
    } else {
      // tool result → user message with tool_result block.
      wire.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        }],
      });
    }
  }
  return { system: systemText, wire };
}

function toolsToWire(tools?: AgentTool[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

const STOP_BY_REASON: Record<string, "stop" | "tool" | "length"> = {
  end_turn: "stop",
  tool_use: "tool",
  max_tokens: "length",
  stop_sequence: "stop",
};

/** Builds the /v1/messages request body (exported for tests + telemetry). */
export function buildAnthropicRequestBody(request: ChatRequest, options: AnthropicOptions): Record<string, unknown> {
  const { system, wire } = toWireMessages(request.messages);
  let systemText = system;
  if (request.system !== undefined) systemText = system ? `${request.system}\n\n${system}` : request.system;
  const thinking = request.reasoningEffort && request.reasoningEffort !== "none"
    ? { type: "enabled" as const, budget_tokens: effortToBudget(request.reasoningEffort) }
    : undefined;
  const maxTokens = request.maxOutputTokens ?? options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    model: options.model,
    max_tokens: thinking ? Math.max(maxTokens, thinking.budget_tokens + 32_768) : maxTokens,
    temperature: thinking ? 1.0 : (request.temperature ?? 0.1),
    messages: wire,
    stream: true,
    // Agent-loop prompt caching: applies a cache breakpoint to the last
    // cacheable block and advances it as the conversation grows (same
    // request field the old invocationParams() override injected).
    cache_control: { type: "ephemeral" },
    ...(systemText ? { system: systemText } : {}),
    ...(thinking ? { thinking } : {}),
    ...(request.tools?.length ? { tools: toolsToWire(request.tools) } : {}),
  };
}

export function createAnthropicClient(options: AnthropicOptions): ChatClient {
  const base = (options.baseUrl || "https://api.anthropic.com").trim().replace(/\/+$/, "");
  const endpoint = `${base}/v1/messages`;
  const headers: Record<string, string> = {
    "x-api-key": options.apiKey || "",
    "anthropic-version": "2023-06-01",
    ...options.extraHeaders,
  };

  async function* stream(request: ChatRequest): AsyncGenerator<ChatEvent, void, unknown> {
    const body = buildAnthropicRequestBody(request, options);

    const response = await postJSON(endpoint, body, headers, options.providerId, request.signal);
    const sse = sseFrom(response);
    let text = "";
    const calls = new Map<number, { id: string; name: string; json: string }>();
    let usage: Usage | undefined = { inputTokens: 0, outputTokens: 0 };
    let stopReason: "stop" | "tool" | "length" = "stop";

    for await (const payload of sse.events()) {
      let data: any;
      try { data = JSON.parse(payload); } catch { continue; }
      switch (data?.type) {
        case "message_start": {
          const u = data.message?.usage ?? {};
          usage = {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: 0,
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0) || undefined,
            cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0) || undefined,
          };
          break;
        }
        case "content_block_start": {
          const block = data.content_block ?? {};
          if (block.type === "tool_use") {
            calls.set(Number(data.index ?? 0), { id: String(block.id ?? ""), name: String(block.name ?? ""), json: "" });
          }
          break;
        }
        case "content_block_delta": {
          const delta = data.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            text += delta.text;
            yield { type: "text", delta: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
            yield { type: "thinking", delta: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const entry = calls.get(Number(data.index ?? 0));
            if (entry) entry.json += delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          const mapped = STOP_BY_REASON[String(data.delta?.stop_reason ?? "")];
          if (mapped) stopReason = mapped;
          if (data.usage?.output_tokens != null && usage) usage.outputTokens = Number(data.usage.output_tokens);
          break;
        }
        case "error": {
          const detail = data.error?.message || "stream error";
          throw new Error(detail);
        }
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()].filter((c) => c.name).map((c) => {
      let args: unknown = {};
      try { args = c.json ? JSON.parse(c.json) : {}; } catch { args = { _raw: c.json }; }
      return { id: c.id || `call_${c.name}`, name: c.name, args };
    });
    yield { type: "done", text, toolCalls, usage, stopReason };
  }

  return {
    providerId: options.providerId,
    label: options.label,
    model: options.model,
    stream,
    async complete(request: ChatRequest): Promise<ChatResult> {
      let text = "";
      let toolCalls: ToolCall[] = [];
      let usage: Usage | undefined;
      let stopReason: ChatResult["stopReason"] = "stop";
      for await (const event of stream(request)) {
        if (event.type === "text") text += event.delta;
        else if (event.type === "done") {
          toolCalls = event.toolCalls;
          usage = event.usage;
          stopReason = event.stopReason;
          if (event.text && !text) text = event.text;
        }
      }
      return { text, toolCalls, usage, stopReason };
    },
  };
}
