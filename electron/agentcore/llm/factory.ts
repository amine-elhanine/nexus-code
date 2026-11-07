// Chat client factory — the replacement for providers.ts createChatModel's
// LangChain class matrix. One adapter per WIRE PROTOCOL (not per vendor):
// OpenAI-compatible /chat/completions + /responses, Anthropic /v1/messages,
// Google generateContent. Provider selection logic, per-provider base URLs,
// reasoning flag styles and Zen gateway headers are ported 1:1 from the old
// factory. Bedrock (the only protocol without an HTTP shortcut) is deferred —
// constructing it throws with an explicit message.
import { createOpenAICompatClient, type OpenAiCompatOptions } from "./openai-compat.js";
import { createAnthropicClient } from "./anthropic.js";
import { createGoogleClient } from "./google.js";
import type { ChatClient } from "./types.js";

export type ChatEndpointKind = "chat" | "responses" | "messages";

export interface ClientProviderConfig {
  id?: string;
  label?: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  modelEndpoints?: Partial<Record<string, ChatEndpointKind>>;
  [key: string]: unknown;
}

export function defaultEndpointForProvider(providerId: string): ChatEndpointKind {
  return providerId === "anthropic" ? "messages" : "chat";
}

export function resolveModelEndpoint(providerId: string, modelName: string, modelEndpoints?: Partial<Record<string, ChatEndpointKind>>): ChatEndpointKind {
  const override = modelEndpoints?.[modelName];
  if (override === "chat" || override === "responses" || override === "messages") return override;
  return defaultEndpointForProvider(providerId);
}

/** Zen gateway client identification headers (see providers.ts for rationale). */
function zenClientHeaders(): Record<string, string> {
  return {
    "x-opencode-client": "cli",
    "x-opencode-session": crypto.randomUUID(),
    "x-opencode-project": crypto.randomUUID(),
    "x-opencode-request": crypto.randomUUID(),
    "User-Agent": "opencode/cli",
  };
}

function isZenEndpoint(config: ClientProviderConfig): boolean {
  if (config.provider === "opencode-zen") return true;
  return /opencode\.ai\/zen/i.test(config.baseUrl || "");
}

function openAiBaseFor(config: ClientProviderConfig): string {
  const raw = (config.baseUrl || "").trim().replace(/\/+$/, "");
  if (raw) return raw;
  switch (config.provider) {
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "opencode-zen": return "https://opencode.ai/zen/v1";
    case "together": return "https://api.together.xyz/v1";
    case "fireworks": return "https://api.fireworks.ai/inference/v1";
    case "deepseek": return "https://api.deepseek.com/v1";
    case "groq": return "https://api.groq.com/openai/v1";
    case "xai": return "https://api.x.ai/v1";
    case "mistral": return "https://api.mistral.ai/v1";
    default: return "https://api.openai.com/v1";
  }
}

export interface ClientFactoryOptions {
  reasoningEffort?: string;
}

export async function createChatClient(config: ClientProviderConfig, modelName: string, options?: ClientFactoryOptions): Promise<ChatClient> {
  const provider = config.provider;
  const key = config.apiKey;
  const label = config.label || provider;
  const providerId = config.id || provider;
  const endpoint = resolveModelEndpoint(providerId, modelName, config.modelEndpoints);
  const zenHeaders = isZenEndpoint(config) ? zenClientHeaders() : undefined;
  const reasoning = options?.reasoningEffort;
  const common = { providerId, label, model: modelName, extraHeaders: zenHeaders };

  if (endpoint === "responses") {
    return createOpenAICompatClient({
      ...common,
      baseUrl: openAiBaseFor(config),
      apiKey: key,
      protocol: "responses",
      reasoningStyle: "effort",
    } satisfies OpenAiCompatOptions);
  }

  if (endpoint === "messages" && provider !== "anthropic") {
    // Anthropic-protocol gateway serving Claude.
    return createAnthropicClient({
      ...common,
      baseUrl: (config.baseUrl || "").trim().replace(/\/+$/, "") || "https://api.anthropic.com",
      apiKey: key,
    });
  }

  // Plugin-registered providers: OpenAI-compatible with a mandatory base URL.
  if (!["openai", "anthropic", "google", "azure", "bedrock", "custom", "ollama", "together", "fireworks", "openrouter", "deepseek", "groq", "xai", "mistral", "opencode-zen"].includes(provider)) {
    const baseUrl = (config.baseUrl || "").trim();
    if (!baseUrl) throw new Error(`Provider "${providerId}" needs a base URL.`);
    return createOpenAICompatClient({
      ...common,
      baseUrl,
      apiKey: key || "not-needed",
      reasoningStyle: "effort",
    });
  }

  switch (provider) {
    case "custom": {
      if (!config.baseUrl) throw new Error("Custom providers need a base URL (for example http://127.0.0.1:1234/v1). Edit the provider to add one.");
      return createOpenAICompatClient({ ...common, baseUrl: config.baseUrl, apiKey: key || "not-needed", reasoningStyle: "effort" });
    }
    case "openai": {
      return createOpenAICompatClient({
        ...common,
        baseUrl: config.baseUrl ? config.baseUrl.trim().replace(/\/+$/, "") : "https://api.openai.com/v1",
        apiKey: key,
        reasoningStyle: "effort",
      });
    }
    case "anthropic": {
      if (endpoint === "chat" && config.baseUrl?.trim()) {
        // Explicit per-model override: speak OpenAI chat completions to a
        // custom Anthropic-compatible base instead of the native API.
        return createOpenAICompatClient({ ...common, baseUrl: config.baseUrl.trim().replace(/\/+$/, ""), apiKey: key, reasoningStyle: "effort" });
      }
      return createAnthropicClient({ ...common, apiKey: key });
    }
    case "google":
      return createGoogleClient({ ...common, apiKey: key });
    case "azure": {
      const isUrl = Boolean(config.baseUrl && /^https?:\/\//i.test(config.baseUrl));
      return createOpenAICompatClient({
        ...common,
        baseUrl: config.baseUrl || "",
        apiKey: key,
        azure: { endpointOrInstance: config.baseUrl || "", isFullUrl: isUrl, apiVersion: "2024-10-21" },
        reasoningStyle: "effort",
      });
    }
    case "bedrock":
      throw new Error("AWS Bedrock support is deferred in the self-built provider layer. Configure an OpenAI-compatible or Anthropic-compatible endpoint instead.");
    case "ollama": {
      let base = (config.baseUrl || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
      if (!base.endsWith("/v1")) base = `${base}/v1`;
      return createOpenAICompatClient({ ...common, baseUrl: base, apiKey: key || "ollama", reasoningStyle: "effort" });
    }
    case "openrouter":
      return createOpenAICompatClient({ ...common, baseUrl: openAiBaseFor(config), apiKey: key, reasoningStyle: "openrouter" });
    case "deepseek":
      return createOpenAICompatClient({ ...common, baseUrl: openAiBaseFor(config), apiKey: key, reasoningStyle: "effort" });
    case "opencode-zen":
      return createOpenAICompatClient({ ...common, baseUrl: openAiBaseFor(config), apiKey: key, reasoningStyle: "effort" });
    case "together":
    case "fireworks":
    default:
      return createOpenAICompatClient({ ...common, baseUrl: openAiBaseFor(config), apiKey: key, reasoningStyle: "effort" });
  }
}
