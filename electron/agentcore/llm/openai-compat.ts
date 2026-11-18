// OpenAI-compatible adapter — /chat/completions and /responses, streaming.
// Covers OpenAI, Azure OpenAI, Ollama, Together, Fireworks, DeepSeek, Groq,
// xAI, Mistral, OpenRouter, OpenCode Zen, custom OpenAI-compatible base URLs
// and plugin-registered providers — i.e. everything the old ChatOpenAI family
// instantiated, plus the per-provider reasoning flags the old factory set.
import { postJSON, sseFrom } from "./sse.js";
import type { ChatEvent, ChatRequest, ChatResult, ChatClient, Usage } from "./types.js";
import type { ChatMessage, ToolCall, ContentBlock } from "../messages.js";
import type { AgentTool } from "../tools.js";

export type OpenAiCompatOptions = {
  baseUrl: string;
  apiKey?: string;
  providerId: string;
  label: string;
  model: string;
  /** reasoning_effort top-level (OpenAI/o-series/deepseek) vs OpenRouter's reasoning:{effort}. */
  reasoningStyle?: "effort" | "openrouter";
  extraHeaders?: Record<string, string>;
  /** Azure uses path-based deployment URLs + api-key header. */
  azure?: { endpointOrInstance: string; isFullUrl: boolean; apiVersion: string };
  /** Use the /responses wire protocol instead of /chat/completions. */
  protocol?: "chat" | "responses";
  temperature?: number;
};

interface WireMessage {
  role: string;
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function imageBlocks(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) => (block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image_url", image_url: { url: block.url } }));
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      if (typeof message.content === "string") wire.push({ role: "user", content: message.content });
      else wire.push({ role: "user", content: imageBlocks(message.content) });
    } else if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      wire.push({
        role: "assistant",
        // OpenAI-compat providers reject `content: null` on tool-call turns
        // ("invalid message content type: <nil>") — the old LangChain runtime
        // sent an empty string, so keep that shape.
        content: text,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        } : {}),
      });
    } else {
      wire.push({ role: "tool", content: message.content, tool_call_id: message.toolCallId });
    }
  }
  return wire;
}

function toolsToWire(tools?: AgentTool[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function extractUsage(payload: any): Usage | undefined {
  const u = payload?.usage ?? payload?.response_metadata?.usage;
  if (!u) return undefined;
  const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!inputTokens && !outputTokens) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: Number(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0) || undefined,
    cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0) || undefined,
  };
}

/** Repairs common small-model JSON quirks only when strict JSON.parse fails. */
export function parseToolArgsSafely(rawJson: string): unknown {
  const trimmed = (rawJson || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to repair */ }

  let candidate = trimmed;
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();

  // Escape literal newlines/tabs inside JSON string literals before removing trailing commas.
  let inString = false;
  let escaped = false;
  let fixed = "";
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      fixed += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      fixed += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      fixed += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") { fixed += "\\n"; continue; }
      if (ch === "\r") { fixed += "\\r"; continue; }
      if (ch === "\t") { fixed += "\\t"; continue; }
    }
    fixed += ch;
  }
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(fixed);
  } catch {
    return { _raw: rawJson };
  }
}

/**
 * Fallback parser for local models that emit `<tool_call>...</tool_call>` or
 * `<function=name>{...}</function>` in text instead of structured `delta.tool_calls`.
 * Fenced code blocks are shielded so code examples in prose are never misparsed.
 */
export function extractTextToolCalls(rawText: string): { text: string; calls: ToolCall[] } {
  if (!rawText || (!rawText.includes("<tool_call>") && !rawText.includes("<function="))) {
    return { text: rawText, calls: [] };
  }
  const codeBlocks: string[] = [];
  const shielded = rawText.replace(/```[\s\S]*?```/g, (block) => {
    const idx = codeBlocks.length;
    codeBlocks.push(block);
    return `\u0000NEXUS_CODE_BLOCK_${idx}\u0000`;
  });

  const extracted: ToolCall[] = [];
  let stripped = shielded.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (full, inner: string) => {
    const parsed = parseToolArgsSafely(inner);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as any).name === "string" && !("_raw" in (parsed as any))) {
      const name = String((parsed as any).name).trim();
      const rawArgs = (parsed as any).arguments ?? (parsed as any).args ?? {};
      const args = typeof rawArgs === "string" ? parseToolArgsSafely(rawArgs) : (rawArgs && typeof rawArgs === "object" ? rawArgs : {});
      if (name) {
        extracted.push({ id: `call_${name}_${extracted.length}`, name, args });
        return "";
      }
    }
    return full;
  });

  stripped = stripped.replace(/<function=([a-zA-Z0-9_.:-]+)>\s*([\s\S]*?)\s*<\/function>/gi, (full, name: string, inner: string) => {
    const parsed = parseToolArgsSafely(inner);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("_raw" in (parsed as any))) {
      extracted.push({ id: `call_${name}_${extracted.length}`, name, args: parsed });
      return "";
    }
    return full;
  });

  const restored = stripped.replace(/\u0000NEXUS_CODE_BLOCK_(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)] ?? "");
  return { text: restored.trim(), calls: extracted };
}

/**
 * Splits a leading `<think>...</think>` reasoning span emitted inline by local
 * models (DeepSeek-R1/Qwen3/QwQ) into `thinking` events while leaving normal
 * text and code untouched (passthrough activates immediately if stream doesn't start with `<think>`).
 */
export function createLeadingThinkSplitter() {
  let state: "detect" | "inside" | "passthrough" = "detect";
  let buf = "";
  const OPEN_TAG = "<think>";
  const CLOSE_TAG = "</think>";

  const push = (chunk: string): { textDeltas: string[]; thinkingDeltas: string[] } => {
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    if (!chunk) return { textDeltas, thinkingDeltas };

    if (state === "passthrough") {
      textDeltas.push(chunk);
      return { textDeltas, thinkingDeltas };
    }

    buf += chunk;
    if (state === "detect") {
      const trimmedStart = buf.replace(/^\s+/, "");
      if (!trimmedStart) return { textDeltas, thinkingDeltas };
      if (OPEN_TAG.startsWith(trimmedStart) && trimmedStart.length < OPEN_TAG.length) {
        return { textDeltas, thinkingDeltas };
      }
      if (!trimmedStart.startsWith(OPEN_TAG)) {
        state = "passthrough";
        textDeltas.push(buf);
        buf = "";
        return { textDeltas, thinkingDeltas };
      }
      buf = trimmedStart.slice(OPEN_TAG.length);
      state = "inside";
    }

    if (state === "inside") {
      const closeIdx = buf.indexOf(CLOSE_TAG);
      if (closeIdx >= 0) {
        const thought = buf.slice(0, closeIdx);
        if (thought) thinkingDeltas.push(thought);
        const rest = buf.slice(closeIdx + CLOSE_TAG.length).replace(/^\s+/, "");
        buf = "";
        state = "passthrough";
        if (rest) textDeltas.push(rest);
        return { textDeltas, thinkingDeltas };
      }
      // Retain possible partial suffix of `</think>` at buffer end.
      const keepSuffix = Math.min(buf.length, CLOSE_TAG.length - 1);
      const safeEnd = buf.length - keepSuffix;
      if (safeEnd > 0) {
        thinkingDeltas.push(buf.slice(0, safeEnd));
        buf = buf.slice(safeEnd);
      }
    }
    return { textDeltas, thinkingDeltas };
  };

  const flush = (): { textDeltas: string[]; thinkingDeltas: string[] } => {
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    if (!buf) return { textDeltas, thinkingDeltas };
    if (state === "inside") thinkingDeltas.push(buf);
    else textDeltas.push(buf);
    buf = "";
    state = "passthrough";
    return { textDeltas, thinkingDeltas };
  };

  return { push, flush };
}

function azureUrl(options: OpenAiCompatOptions, path: string): string {
  const az = options.azure!;
  if (az.isFullUrl) {
    const base = options.baseUrl.replace(/\/+$/, "");
    return `${base}${path.includes("?") ? path.replace("/chat/completions", `/openai/deployments/${encodeURIComponent(options.model)}/chat/completions`) : path}`;
  }
  return `https://${az.endpointOrInstance}.openai.azure.com/openai/deployments/${encodeURIComponent(options.model)}/chat/completions?api-version=${az.apiVersion}`;
}

export function createOpenAICompatClient(options: OpenAiCompatOptions): ChatClient {
  const headers: Record<string, string> = { ...options.extraHeaders };
  if (options.azure) {
    headers["api-key"] = options.apiKey || "";
  } else {
    headers.authorization = `Bearer ${options.apiKey || "not-needed"}`;
  }
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const chatEndpoint = options.azure
    ? azureUrl(options, "/chat/completions")
    : `${baseUrl}/chat/completions`;
  const responsesEndpoint = options.azure
    ? azureUrl(options, "/responses").replace("/chat/completions", "/responses")
    : `${baseUrl}/responses`;

  async function* stream(request: ChatRequest): AsyncGenerator<ChatEvent, void, unknown> {
    if ((options.protocol ?? "chat") === "responses") {
      yield* streamResponses(request);
      return;
    }
    const body: Record<string, unknown> = {
      model: options.model,
      messages: toWireMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? options.temperature ?? 0.1,
      ...(request.tools?.length ? { tools: toolsToWire(request.tools), tool_choice: "auto" } : {}),
    };
    if (request.system !== undefined) {
      // Adapters receive system as its own param; the loop may also leave it
      // in messages as role:"system" — handle both.
      (body.messages as WireMessage[]) = [{ role: "system", content: request.system }, ...toWireMessages(request.messages.filter((m) => m.role !== "system"))];
    }
    if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;
    if (request.reasoningEffort && request.reasoningEffort !== "none") {
      if (options.reasoningStyle === "openrouter") body.reasoning = { effort: request.reasoningEffort };
      else body.reasoning_effort = request.reasoningEffort;
    }

    const response = await postJSON(chatEndpoint, body, headers, options.providerId, request.signal);
    const sse = sseFrom(response);
    let text = "";
    const calls = new Map<string, { id: string; name: string; json: string }>();
    let usage: Usage | undefined;
    let stopReason: "stop" | "tool" | "length" = "stop";
    let sawAnyChunk = false;
    const thinkSplitter = createLeadingThinkSplitter();

    for await (const payload of sse.events()) {
      if (payload === "[DONE]") break;
      let data: any;
      try { data = JSON.parse(payload); } catch { continue; }
      sawAnyChunk = true;
      const choice = data?.choices?.[0];
      if (choice) {
        // Text extraction tolerant of gateway dialects: delta.content
        // (string, part array, or {content}), delta.text (legacy
        // completions-style deltas), and choice.message.content for
        // gateways that send a whole-message final chunk instead of deltas.
        const delta = choice.delta ?? choice.message ?? {};
        let deltaText = "";
        const content: any = delta.content ?? delta.text;
        if (typeof content === "string" && content) deltaText = content;
        else if (Array.isArray(content)) {
          deltaText = content.map((part: any) => {
            if (typeof part === "string") return part;
            return part?.text ?? part?.content ?? "";
          }).join("");
        }
        if (deltaText) {
          const split = thinkSplitter.push(deltaText);
          for (const t of split.thinkingDeltas) yield { type: "thinking", delta: t };
          for (const out of split.textDeltas) {
            text += out;
            yield { type: "text", delta: out };
          }
        }
        const reasoning = delta.reasoning_content ?? (typeof delta.reasoning === "string" ? delta.reasoning : delta.reasoning?.content);
        if (typeof reasoning === "string" && reasoning) yield { type: "thinking", delta: reasoning };
        for (const tc of delta.tool_calls ?? []) {
          // OpenAI streaming sends `id` only on the FIRST delta of a call;
          // continuation deltas carry just the `index`. Key by index when
          // present (unique per parallel call) so a call's argument fragments
          // accumulate on one entry regardless of whether later deltas repeat
          // the id.
          const key = String(tc.index ?? tc.id ?? "");
          const entry = calls.get(key) ?? { id: String(tc.id ?? ""), name: "", json: "" };
          if (tc.id && !entry.id) entry.id = String(tc.id);
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.json += tc.function.arguments;
          calls.set(key, entry);
        }
        if (choice.finish_reason === "tool_calls") stopReason = "tool";
        else if (choice.finish_reason === "length") stopReason = "length";
        else if (choice.finish_reason) stopReason = "stop";
      }
      if (data?.usage) usage = extractUsage(data);
    }

    const tail = thinkSplitter.flush();
    for (const t of tail.thinkingDeltas) yield { type: "thinking", delta: t };
    for (const out of tail.textDeltas) {
      text += out;
      yield { type: "text", delta: out };
    }

    if (!sawAnyChunk) {
      // Silent SSE failure (OpenRouter quirk): HTTP 200 wrapping an error
      // payload that ends the stream before any output — raise as transient.
      throw new Error("empty response");
    }

    let toolCalls: ToolCall[] = [...calls.values()]
      .filter((c) => c.name)
      .map((c) => ({
        id: c.id || `call_${c.name}_${c.json.slice(0, 8)}`,
        name: c.name,
        args: parseToolArgsSafely(c.json),
      }));
    if (toolCalls.length === 0 && request.tools?.length && text) {
      const fallback = extractTextToolCalls(text);
      if (fallback.calls.length > 0) {
        text = fallback.text;
        toolCalls = fallback.calls;
        stopReason = "tool";
      }
    }
    yield { type: "done", text, toolCalls, usage, stopReason };
  }

  async function* streamResponses(request: ChatRequest): AsyncGenerator<ChatEvent, void, unknown> {
    const items: Array<Record<string, unknown>> = [];
    if (request.system !== undefined) items.push({ role: "system", content: [{ type: "input_text", text: request.system }] });
    for (const message of request.messages) {
      if (message.role === "system") {
        items.push({ role: "system", content: [{ type: "input_text", text: typeof message.content === "string" ? message.content : "" }] });
      } else if (message.role === "user") {
        const content = typeof message.content === "string" ? [{ type: "input_text", text: message.content }] : imageBlocks(message.content).map((b) => (b.type === "text" ? { type: "input_text", text: (b as any).text } : { type: "input_image", image_url: (b as any).image_url }));
        items.push({ role: "user", content });
      } else if (message.role === "assistant") {
        const text = typeof message.content === "string" ? message.content : "";
        if (text) items.push({ role: "assistant", content: [{ type: "output_text", text }] });
        for (const call of message.toolCalls ?? []) {
          items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) });
        }
      } else {
        items.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      }
    }
    const body: Record<string, unknown> = {
      model: options.model,
      input: items,
      stream: true,
      temperature: request.temperature ?? options.temperature ?? 0.1,
      ...(request.tools?.length ? {
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        tool_choice: "auto",
      } : {}),
    };
    if (request.maxOutputTokens) body.max_output_tokens = request.maxOutputTokens;
    if (request.reasoningEffort && request.reasoningEffort !== "none") body.reasoning = { effort: request.reasoningEffort };

    const response = await postJSON(responsesEndpoint, body, headers, options.providerId, request.signal);
    const sse = sseFrom(response);
    let text = "";
    const calls = new Map<string, { id: string; name: string; json: string }>();
    let usage: Usage | undefined;
    let stopReason: "stop" | "tool" | "length" = "stop";
    let sawAnyChunk = false;

    for await (const payload of sse.events()) {
      let data: any;
      try { data = JSON.parse(payload); } catch { continue; }
      sawAnyChunk = true;
      const type = data?.type ?? "";
      if (type === "response.output_text.delta" && typeof data.delta === "string") {
        text += data.delta;
        yield { type: "text", delta: data.delta };
      } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        if (typeof data.delta === "string") yield { type: "thinking", delta: data.delta };
      } else if (type === "response.output_item.added" && data.item?.type === "function_call") {
        const id = String(data.item.call_id ?? data.item.id ?? "");
        calls.set(id, { id, name: String(data.item.name ?? ""), json: String(data.item.arguments ?? "") });
      } else if (type === "response.function_call_arguments.delta") {
        const entry = calls.get(String(data.call_id ?? data.item_id ?? ""));
        if (entry && typeof data.delta === "string") entry.json += data.delta;
      } else if (type === "response.completed" || type === "response.done") {
        const resp = data.response ?? {};
        const status = resp.status === "failed" ? "stop" : "stop";
        void status;
        const u = resp.usage;
        if (u) usage = { inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0) };
        const last = resp.output?.filter((o: any) => o.type === "function_call").length;
        if (last) stopReason = "tool";
      }
    }

    if (!sawAnyChunk) {
      // Same silent-failure guard the chat-completions path has: HTTP 200
      // wrapping an error payload that ends the stream before ANY event
      // (no response.completed either) must surface as a retryable error,
      // not as a fabricated empty answer after tool work was already done.
      throw new Error("empty response");
    }

    let toolCalls: ToolCall[] = [...calls.values()].filter((c) => c.name).map((c) => ({
      id: c.id,
      name: c.name,
      args: parseToolArgsSafely(c.json),
    }));
    if (toolCalls.length === 0 && request.tools?.length && text) {
      const fallback = extractTextToolCalls(text);
      if (fallback.calls.length > 0) {
        text = fallback.text;
        toolCalls = fallback.calls;
        stopReason = "tool";
      }
    }
    yield { type: "done", text, toolCalls, usage, stopReason };
  }

  return {
    providerId: options.providerId,
    label: options.label,
    model: options.model,
    stream,
    async complete(request: ChatRequest): Promise<ChatResult> {
      let result: ChatResult | null = null;
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
          if (event.toolCalls?.length && typeof event.text === "string") text = event.text;
          else if (event.text && !text) text = event.text;
        }
      }
      result = { text, toolCalls, usage, stopReason };
      return result;
    },
  };
}
