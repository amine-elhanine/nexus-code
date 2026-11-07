// Google Gemini adapter — streamGenerateContent (SSE) over the v1beta REST
// surface. Ports the old ChatGoogleGenerativeAI configuration: thinking
// budgets from the reasoning-effort map, function-calling tools, image parts.
import { postJSON, sseFrom } from "./sse.js";
import type { ChatEvent, ChatRequest, ChatResult, ChatClient, Usage } from "./types.js";
import type { ChatMessage, ContentBlock, ToolCall } from "../messages.js";
import type { AgentTool } from "../tools.js";

export interface GoogleOptions {
  apiKey?: string;
  providerId: string;
  label: string;
  model: string;
  baseUrl?: string;
}

const THINKING_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 65536,
};

/** Google wants UPPERCASE type names and rejects JSON-Schema-only keywords. */
function sanitizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const src = schema as Record<string, unknown>;
  if (Object.keys(src).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  const type = src.type;
  if (typeof type === "string") out.type = type.toUpperCase();
  else if (Array.isArray(type)) out.type = type.map((t) => String(t).toUpperCase());
  if (src.description) out.description = src.description;
  if (src.enum) out.enum = src.enum;
  if (src.format && (out.type === "STRING" || out.type === "NUMBER" || out.type === "INTEGER")) out.format = src.format;
  if (src.items) {
    const items = sanitizeSchema(src.items);
    if (items) out.items = items;
  }
  if (src.properties && typeof src.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src.properties as Record<string, unknown>)) {
      const sanitized = sanitizeSchema(value);
      if (sanitized) props[key] = sanitized;
      else props[key] = { type: "STRING" };
    }
    out.properties = props;
    const required = Array.isArray(src.required)
      ? src.required.filter((r) => props[String(r)])
      : Object.keys(props);
    if (required.length) out.required = required;
  }
  return Object.keys(out).length ? out : undefined;
}

function toWireContents(messages: ChatMessage[]): { systemText: string; contents: Array<Record<string, unknown>> } {
  let systemText = "";
  const contents: Array<Record<string, unknown>> = [];
  const pushParts = (role: "user" | "model", parts: Array<Record<string, unknown>>) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) (last.parts as unknown[]).push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "system") {
      systemText = systemText ? `${systemText}\n\n${message.content}` : message.content;
      continue;
    }
    if (message.role === "user") {
      const blocks: ContentBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      const parts = blocks.map((block) => (block.type === "text"
        ? { text: block.text }
        : (() => {
            const dataUrl = block.url.match(/^data:([^;]+);base64,(.*)$/s);
            if (dataUrl) return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
            // http(s) image URLs are unsupported by inlineData — Gemini accepts fileData for some sources; degrade to text pointer.
            return { text: `[image unavailable for this provider: ${block.url.slice(0, 120)}]` };
          })()));
      pushParts("user", parts);
    } else if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const parts: Array<Record<string, unknown>> = [];
      if (text) parts.push({ text });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: (call.args ?? {}) as Record<string, unknown> } });
      }
      if (parts.length) pushParts("model", parts);
    } else {
      // Tool result → functionResponse part.
      const parts = [{
        functionResponse: {
          name: message.name || "tool",
          response: { result: message.content },
        },
      }];
      pushParts("user", parts);
    }
  }
  return { systemText, contents };
}

export function createGoogleClient(options: GoogleOptions): ChatClient {
  const base = (options.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const headers: Record<string, string> = { "x-goog-api-key": options.apiKey || "" };

  async function* stream(request: ChatRequest): AsyncGenerator<ChatEvent, void, unknown> {
    const bundle = toWireContents(request.messages);
    const contents = bundle.contents;
    let systemText = bundle.systemText;
    if (request.system !== undefined) systemText = systemText ? `${request.system}\n\n${systemText}` : request.system;
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature ?? 0.1,
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.reasoningEffort ? {
          thinkingConfig: { thinkingBudget: request.reasoningEffort === "none" ? 0 : (THINKING_BUDGET[request.reasoningEffort.toLowerCase()] ?? 8192) },
        } : {}),
      },
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(request.tools?.length ? {
        tools: [{
          functionDeclarations: request.tools
            .map((tool) => ({ name: tool.name, description: tool.description, parameters: sanitizeSchema(tool.parameters) }))
            .filter((t) => t.name),
        }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      } : {}),
    };

    const url = `${base}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;
    const response = await postJSON(url, body, headers, options.providerId, request.signal);
    const sse = sseFrom(response);
    let text = "";
    const pendingCalls: ToolCall[] = [];
    let usage: Usage | undefined;
    let stopReason: "stop" | "tool" | "length" = "stop";

    for await (const payload of sse.events()) {
      let data: any;
      try { data = JSON.parse(payload); } catch { continue; }
      const candidate = data?.candidates?.[0];
      const parts: any[] = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text) {
          if (part.thought === true) yield { type: "thinking", delta: part.text };
          else {
            text += part.text;
            yield { type: "text", delta: part.text };
          }
        }
        if (part.functionCall?.name) {
          pendingCalls.push({
            id: `call_${part.functionCall.name}_${pendingCalls.length}`,
            name: String(part.functionCall.name),
            args: part.functionCall.args ?? {},
          });
        }
      }
      if (candidate?.finishReason === "MAX_TOKENS") stopReason = "length";
      else if (candidate?.finishReason === "STOP") stopReason = pendingCalls.length ? "tool" : "stop";
      if (data?.usageMetadata) {
        const u = data.usageMetadata;
        usage = {
          inputTokens: Number(u.promptTokenCount ?? 0),
          outputTokens: Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0),
        };
      }
    }
    if (pendingCalls.length) stopReason = "tool";
    yield { type: "done", text, toolCalls: pendingCalls, usage, stopReason };
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
