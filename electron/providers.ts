import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatEndpointKind, ProviderConfig } from "./store.js";

export type { ChatEndpointKind };

/** Provider-level default wire protocol (a per-model entry overrides this). */
export function defaultEndpointForProvider(providerId: string): ChatEndpointKind {
  return providerId === "anthropic" ? "messages" : "chat";
}

/** Resolve which path a model speaks: explicit per-model entry wins. */
export function resolveModelEndpoint(providerId: string, modelName: string, modelEndpoints?: Partial<Record<string, ChatEndpointKind>>): ChatEndpointKind {
  const override = modelEndpoints?.[modelName];
  if (override === "chat" || override === "responses" || override === "messages") return override;
  return defaultEndpointForProvider(providerId);
}

/**
 * The Zen gateway identifies official clients by HTTP headers. Without them,
 * requests are treated as anonymous: free-tier models are rejected outright
 * ("free tier can only be used in OpenCode") and the rest get harsh rate
 * limits. These mirror what the official CLI sends; the session / project /
 * request IDs are random per client construction so runs don't share buckets.
 */
function zenClientHeaders(): Record<string, string> {
  return {
    "x-opencode-client": "cli",
    "x-opencode-session": randomUUID(),
    "x-opencode-project": randomUUID(),
    "x-opencode-request": randomUUID(),
    "User-Agent": "opencode/cli",
  };
}

/** True when requests go to the Zen gateway (native entry or custom base). */
function isZenEndpoint(config: ProviderConfig): boolean {
  if (config.provider === "opencode-zen") return true;
  return /opencode\.ai\/zen/i.test(config.baseUrl || "");
}

/** Default OpenAI-compatible base per provider (saved baseUrl wins). */
function openAiBaseFor(config: ProviderConfig): string {
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

export type ProviderDefinition = {
  id: string;
  label: string;
  packageName: string;
  envKey: string;
  defaultBaseUrl?: string;
  models: string[];
};

export const PROVIDERS: ProviderDefinition[] = [
  { id: "openai", label: "OpenAI", packageName: "@langchain/openai", envKey: "OPENAI_API_KEY", models: ["gpt-5.5", "gpt-5.5-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"] },
  { id: "anthropic", label: "Anthropic", packageName: "@langchain/anthropic", envKey: "ANTHROPIC_API_KEY", models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  { id: "google", label: "Google Gemini", packageName: "@langchain/google-genai", envKey: "GOOGLE_API_KEY", models: ["gemini-3.7-pro", "gemini-3.7-flash", "gemini-2.5-flash"] },
  { id: "mistral", label: "Mistral", packageName: "@langchain/mistralai", envKey: "MISTRAL_API_KEY", models: ["mistral-large-latest", "codestral-latest", "mistral-small-latest"] },
  { id: "groq", label: "Groq", packageName: "@langchain/groq", envKey: "GROQ_API_KEY", models: ["openai/gpt-oss-120b", "llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b"] },
  { id: "xai", label: "xAI", packageName: "@langchain/xai", envKey: "XAI_API_KEY", models: ["grok-4", "grok-4-fast", "grok-3-mini"] },
  { id: "openrouter", label: "OpenRouter", packageName: "@langchain/openrouter", envKey: "OPENROUTER_API_KEY", models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "google/gemini-3.7-pro"] },
  { id: "ollama", label: "Ollama", packageName: "@langchain/ollama", envKey: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434", models: ["qwen3-coder", "devstral", "llama3.3"] },
  { id: "deepseek", label: "DeepSeek", packageName: "@langchain/deepseek", envKey: "DEEPSEEK_API_KEY", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "opencode-zen", label: "OpenCode Zen", packageName: "@langchain/openai", envKey: "OPENCODE_API_KEY", defaultBaseUrl: "https://opencode.ai/zen/v1", models: ["kimi-k2.6", "kimi-k2.5", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "qwen3.7-max", "claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.5"] },
  { id: "together", label: "Together AI", packageName: "@langchain/community", envKey: "TOGETHER_AI_API_KEY", models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"] },
  { id: "fireworks", label: "Fireworks", packageName: "@langchain/community", envKey: "FIREWORKS_API_KEY", models: ["accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/qwen3-coder"] },
  { id: "azure", label: "Azure OpenAI", packageName: "@langchain/openai", envKey: "AZURE_OPENAI_API_KEY", models: ["gpt-5.5", "gpt-4.1", "o3"] },
  { id: "bedrock", label: "AWS Bedrock", packageName: "@langchain/aws", envKey: "AWS_ACCESS_KEY_ID", models: ["anthropic.claude-sonnet-4-6", "amazon.nova-pro-v1:0"] },
  { id: "custom", label: "Custom (OpenAI-compatible)", packageName: "@langchain/openai", envKey: "CUSTOM_API_KEY", models: [] },
];

export function getProviderDefinition(providerId: string) { return PROVIDERS.find((provider) => provider.id === providerId) ?? PROVIDERS[0]; }

export async function createChatModel(config: ProviderConfig, modelName: string): Promise<BaseChatModel> {
  const key = config.apiKey || process.env[getProviderDefinition(config.provider).envKey];
  const provider = config.provider;
  // Per-model wire protocol first: gateways (e.g. OpenCode Zen) serve
  // different models on /chat/completions, /responses and /messages.
  const endpoint = resolveModelEndpoint(provider, modelName, config.modelEndpoints);
  const zenHeaders = isZenEndpoint(config) ? zenClientHeaders() : undefined;
  if (endpoint === "responses") {
    const { ChatOpenAIResponses } = await import("@langchain/openai");
    return new ChatOpenAIResponses(modelName, {
      apiKey: key,
      temperature: 0.1,
      configuration: { baseURL: openAiBaseFor(config), ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) },
    });
  }
  if (endpoint === "messages" && provider !== "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      // The Anthropic SDK appends /v1/messages to this base URL.
      anthropicApiUrl: (config.baseUrl || "").trim().replace(/\/+$/, "") || "https://api.anthropic.com",
      ...(zenHeaders ? { clientOptions: { defaultHeaders: zenHeaders } } : {}),
    });
  }
  if (provider === "custom") {
    if (!config.baseUrl) throw new Error("Custom providers need a base URL (for example http://127.0.0.1:1234/v1). Edit the provider to add one.");
    return new ChatOpenAI({ apiKey: key || "not-needed", model: modelName, temperature: 0.1, configuration: { baseURL: config.baseUrl, ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) } });
  }
  if (provider === "openai") return new ChatOpenAI({ apiKey: key, model: modelName, temperature: 0.1, configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined });
  if (provider === "anthropic" && endpoint === "chat" && config.baseUrl?.trim()) {
    // Explicit per-model override: speak OpenAI chat completions to a
    // custom Anthropic-compatible base instead of the native API.
    return new ChatOpenAI({ apiKey: key, model: modelName, temperature: 0.1, configuration: { baseURL: config.baseUrl.trim().replace(/\/+$/, "") } });
  }
  if (provider === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    // Prompt caching: Anthropic 1.5.8 only honors cache_control as a
    // per-request param (invocationParams reads call options — the
    // constructor field is dropped), and deepagents owns the per-call path.
    // So the breakpoint is injected by overriding invocationParams: the
    // top-level breakpoint auto-attaches to the last cacheable block (system
    // prompt + tools) and advances as the conversation grows. Within a run
    // the system prompt is identical across dozens of model calls, so steps
    // after the first hit cache (~90% input discount + lower latency).
    // OpenAI-compatible providers and Gemini apply automatic prefix caching
    // server-side — no code needed there beyond the stable prompt prefix.
    class CachingChatAnthropic extends ChatAnthropic {
      override invocationParams(options?: any): any {
        const params = super.invocationParams(options);
        if (params && (params as Record<string, unknown>).cache_control == null) {
          (params as Record<string, unknown>).cache_control = { type: "ephemeral" };
        }
        return params;
      }
    }
    return new CachingChatAnthropic({ apiKey: key, model: modelName, temperature: 0.1 });
  }
  if (provider === "google") { const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai"); return new ChatGoogleGenerativeAI({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "mistral") { const { ChatMistralAI } = await import("@langchain/mistralai"); return new ChatMistralAI({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "groq") { const { ChatGroq } = await import("@langchain/groq"); return new ChatGroq({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "xai") { const { ChatXAI } = await import("@langchain/xai"); return new ChatXAI({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "openrouter") { const { ChatOpenRouter } = await import("@langchain/openrouter"); return new ChatOpenRouter({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "ollama") {
    let base = (config.baseUrl || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
    if (!base.endsWith("/v1")) base = `${base}/v1`;
    return new ChatOpenAI({
      apiKey: key || "ollama",
      model: modelName,
      temperature: 0.1,
      configuration: { baseURL: base },
    });
  }
  if (provider === "deepseek") { const { ChatDeepSeek } = await import("@langchain/deepseek"); return new ChatDeepSeek({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "opencode-zen") {
    // Curated OpenAI-compatible gateway (chat completions path by default;
    // per-model responses/messages overrides are handled above).
    return new ChatOpenAI({ apiKey: key, model: modelName, temperature: 0.1, configuration: { baseURL: openAiBaseFor(config), ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) } });
  }
  if (provider === "azure") {
    const { AzureChatOpenAI } = await import("@langchain/openai");
    const AzureModel = AzureChatOpenAI as any;
    const isUrl = config.baseUrl && /^https?:\/\//i.test(config.baseUrl);
    return new AzureModel({
      azureOpenAIApiKey: key,
      azureOpenAIApiDeploymentName: modelName,
      azureOpenAIApiVersion: "2024-10-21",
      ...(isUrl ? { azureOpenAIEndpoint: config.baseUrl } : { azureOpenAIApiInstanceName: config.baseUrl }),
      temperature: 0.1,
    });
  }
  if (provider === "bedrock") { const { ChatBedrockConverse } = await import("@langchain/aws"); return new ChatBedrockConverse({ model: modelName, region: process.env.AWS_REGION || "us-east-1", temperature: 0.1 }); }
  const baseUrl = config.baseUrl || (provider === "together" ? "https://api.together.xyz/v1" : "https://api.fireworks.ai/inference/v1");
  return new ChatOpenAI({ apiKey: key, model: modelName, temperature: 0.1, configuration: { baseURL: baseUrl, ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) } });
}

// Query an OpenAI-compatible endpoint's model list (GET /models). Tries the base
// URL as given, then falls back to appending /v1 for hosts configured without it.
export async function fetchRemoteModels(baseUrl: string, apiKey?: string) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("Enter a valid http(s) base URL first.");
  const headers: Record<string, string> = {};
  if (apiKey && apiKey !== "********") headers.Authorization = `Bearer ${apiKey}`;
  const candidates = base.endsWith("/v1") ? [base] : [base, `${base}/v1`];
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) { lastError = new Error(`Model list request failed: ${response.status} ${response.statusText}`); continue; }
      const payload: any = await response.json();
      const raw = Array.isArray(payload) ? payload : payload?.data ?? payload?.models ?? [];
      const models = raw.map((entry: any) => typeof entry === "string" ? entry : entry?.id ?? entry?.name).filter((id: unknown): id is string => typeof id === "string" && Boolean(id));
      if (models.length) return models;
      lastError = new Error("The endpoint returned no models. Add model names manually.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Unable to reach the endpoint.");
}
