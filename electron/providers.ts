
/**
 * Calculates the auto-compaction threshold for a model's context window.
 * Matches Claude Code & Codex behavior: triggers auto-compaction when context
 * reaches ~80% capacity, leaving room for max completion output tokens and
 * system prompt reserves.
 */
export function computeCompactionThreshold(contextWindow: number, maxOutput?: number): number {
  const ctx = Math.max(4096, contextWindow || 128_000);
  const outReserve = Math.max(2048, maxOutput || 8192);
  const headroomReserve = outReserve + 4000;
  const thresholdByRatio = Math.floor(ctx * 0.80); // 80% threshold like Claude Code / Codex
  const thresholdByHeadroom = ctx - headroomReserve;
  return Math.max(Math.floor(ctx * 0.40), Math.min(thresholdByRatio, thresholdByHeadroom));
}

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
  modelEfforts?: Record<string, string[]>;
};

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    packageName: "@langchain/openai",
    envKey: "OPENAI_API_KEY",
    models: ["gpt-5.5", "gpt-5.5-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"],
    modelEfforts: {
      "gpt-5.5": ["none", "low", "medium", "high"],
      "gpt-5.5-mini": ["none", "low", "medium", "high"],
      "o3": ["low", "medium", "high"],
      "o4-mini": ["low", "medium", "high"],
    },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    packageName: "@langchain/anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    modelEfforts: {
      "claude-opus-4-6": ["low", "medium", "high", "max"],
      "claude-sonnet-4-6": ["low", "medium", "high", "max"],
    },
  },
  {
    id: "google",
    label: "Google Gemini",
    packageName: "@langchain/google-genai",
    envKey: "GOOGLE_API_KEY",
    models: ["gemini-3.7-pro", "gemini-3.7-flash", "gemini-2.5-flash"],
    modelEfforts: {
      "gemini-3.7-pro": ["none", "low", "medium", "high"],
      "gemini-3.7-flash": ["none", "low", "medium", "high"],
      "gemini-2.5-flash": ["none", "low", "medium", "high"],
    },
  },
  { id: "mistral", label: "Mistral", packageName: "@langchain/mistralai", envKey: "MISTRAL_API_KEY", models: ["mistral-large-latest", "codestral-latest", "mistral-small-latest"] },
  { id: "groq", label: "Groq", packageName: "@langchain/groq", envKey: "GROQ_API_KEY", models: ["openai/gpt-oss-120b", "llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b"] },
  { id: "xai", label: "xAI", packageName: "@langchain/xai", envKey: "XAI_API_KEY", models: ["grok-4", "grok-4-fast", "grok-3-mini"] },
  {
    id: "openrouter",
    label: "OpenRouter",
    packageName: "@langchain/openrouter",
    envKey: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "google/gemini-3.7-pro"],
    modelEfforts: {
      "openai/gpt-5.5": ["none", "low", "medium", "high"],
      "google/gemini-3.7-pro": ["none", "low", "medium", "high"],
      "anthropic/claude-sonnet-4.6": ["low", "medium", "high", "max"],
    },
  },
  { id: "ollama", label: "Ollama", packageName: "@langchain/ollama", envKey: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434", models: ["qwen3-coder", "devstral", "llama3.3"] },
  {
    id: "deepseek",
    label: "DeepSeek",
    packageName: "@langchain/deepseek",
    envKey: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelEfforts: {
      "deepseek-reasoner": ["low", "medium", "high"],
    },
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    packageName: "@langchain/openai",
    envKey: "OPENCODE_API_KEY",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    models: ["kimi-k2.6", "kimi-k2.5", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "qwen3.7-max", "claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.5"],
    modelEfforts: {
      "gpt-5.5": ["none", "low", "medium", "high"],
      "deepseek-v4-pro": ["low", "medium", "high"],
      "claude-opus-4-6": ["low", "medium", "high", "max"],
      "claude-sonnet-4-6": ["low", "medium", "high", "max"],
    },
  },
  { id: "together", label: "Together AI", packageName: "@langchain/community", envKey: "TOGETHER_AI_API_KEY", models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"] },
  { id: "fireworks", label: "Fireworks", packageName: "@langchain/community", envKey: "FIREWORKS_API_KEY", models: ["accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/qwen3-coder"] },
  {
    id: "azure",
    label: "Azure OpenAI",
    packageName: "@langchain/openai",
    envKey: "AZURE_OPENAI_API_KEY",
    models: ["gpt-5.5", "gpt-4.1", "o3"],
    modelEfforts: {
      "gpt-5.5": ["none", "low", "medium", "high"],
      "o3": ["low", "medium", "high"],
    },
  },
  { id: "bedrock", label: "AWS Bedrock", packageName: "@langchain/aws", envKey: "AWS_ACCESS_KEY_ID", models: ["anthropic.claude-sonnet-4-6", "amazon.nova-pro-v1:0"] },
  { id: "custom", label: "Custom (OpenAI-compatible)", packageName: "@langchain/openai", envKey: "CUSTOM_API_KEY", models: [] },
];

export function getProviderDefinition(providerId: string) { return PROVIDERS.find((provider) => provider.id === providerId) ?? PROVIDERS[0]; }

export type ModelChatOptions = {
  reasoningEffort?: string;
};

export const KNOWN_MODEL_EFFORTS: Record<string, string[]> = {
  // OpenAI reasoning models
  "o1": ["low", "medium", "high"],
  "o1-mini": ["low", "medium", "high"],
  "o1-preview": ["low", "medium", "high"],
  "o3": ["low", "medium", "high"],
  "o3-mini": ["low", "medium", "high"],
  "o4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["none", "low", "medium", "high"],
  "gpt-5.5-mini": ["none", "low", "medium", "high"],
  "gpt-5": ["none", "low", "medium", "high"],
  "gpt-5-mini": ["none", "low", "medium", "high"],

  // Anthropic extended thinking models
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-3-7-sonnet": ["low", "medium", "high", "max"],
  "claude-3.7-sonnet": ["low", "medium", "high", "max"],
  "claude-3-7-sonnet-latest": ["low", "medium", "high", "max"],

  // Google Gemini thinking models
  "gemini-3.7-pro": ["none", "low", "medium", "high"],
  "gemini-3.7-flash": ["none", "low", "medium", "high"],
  "gemini-2.5-flash": ["none", "low", "medium", "high"],
  "gemini-2.0-flash-thinking-exp": ["none", "low", "medium", "high"],
  "gemini-2.0-flash-thinking": ["none", "low", "medium", "high"],

  // DeepSeek reasoning models
  "deepseek-reasoner": ["low", "medium", "high"],
  "deepseek-r1": ["low", "medium", "high"],
  "deepseek-v4-pro": ["low", "medium", "high"],
};

export function resolveModelEfforts(
  providerId: string,
  modelName: string,
  providerConfig?: ProviderConfig,
  providerDef?: ProviderDefinition
): string[] {
  if (!modelName) return [];
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;

  if (providerConfig?.modelEfforts) {
    if (providerConfig.modelEfforts[modelName] !== undefined) {
      return [...providerConfig.modelEfforts[modelName]!];
    }
    if (providerConfig.modelEfforts[basename] !== undefined) {
      return [...providerConfig.modelEfforts[basename]!];
    }
  }

  if (providerDef?.modelEfforts) {
    if (providerDef.modelEfforts[modelName] !== undefined) {
      return [...providerDef.modelEfforts[modelName]!];
    }
    if (providerDef.modelEfforts[basename] !== undefined) {
      return [...providerDef.modelEfforts[basename]!];
    }
  }

  if (KNOWN_MODEL_EFFORTS[normalized]) return [...KNOWN_MODEL_EFFORTS[normalized]];
  if (KNOWN_MODEL_EFFORTS[basename]) return [...KNOWN_MODEL_EFFORTS[basename]];

  if (/^o[134](-|$)/.test(basename)) return ["low", "medium", "high"];
  if (basename.startsWith("gpt-5")) return ["none", "low", "medium", "high"];
  if (basename.includes("reasoner") || basename.includes("-r1")) return ["low", "medium", "high"];
  if (basename.includes("thinking")) return ["none", "low", "medium", "high"];
  if (/claude-(3[-.]7|opus-4|sonnet-4)/.test(basename)) return ["low", "medium", "high", "max"];

  return [];
}

export function formatEffortLabel(effort: string): string {
  switch (effort.toLowerCase()) {
    case "none": return "None (Disabled)";
    case "minimal": return "Minimal";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra High";
    case "max": return "Max";
    default: return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

function effortToAnthropicBudget(effort: string): number {
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

function openAiReasoningOptions(effort?: string) {
  if (!effort) return {};
  return {
    reasoning: { effort: effort as any },
    modelKwargs: { reasoning_effort: effort },
  };
}

export async function createChatModel(config: ProviderConfig, modelName: string, options?: ModelChatOptions): Promise<BaseChatModel> {
  const key = config.apiKey || process.env[getProviderDefinition(config.provider).envKey];
  const provider = config.provider;
  // Per-model wire protocol first: gateways (e.g. OpenCode Zen) serve
  // different models on /chat/completions, /responses and /messages.
  const endpoint = resolveModelEndpoint(provider, modelName, config.modelEndpoints);
  const zenHeaders = isZenEndpoint(config) ? zenClientHeaders() : undefined;
  const reasoning = options?.reasoningEffort;

  if (endpoint === "responses") {
    const { ChatOpenAIResponses } = await import("@langchain/openai");
    return new ChatOpenAIResponses(modelName, {
      apiKey: key,
      temperature: 0.1,
      ...(reasoning ? { reasoning: { effort: reasoning as any } } : {}),
      configuration: { baseURL: openAiBaseFor(config), ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) },
    });
  }
  if (endpoint === "messages" && provider !== "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    const thinking = reasoning && reasoning !== "none" ? {
      type: "enabled" as const,
      budget_tokens: effortToAnthropicBudget(reasoning),
    } : undefined;
    return new ChatAnthropic({
      apiKey: key,
      model: modelName,
      temperature: thinking ? 1.0 : 0.1,
      // The Anthropic SDK appends /v1/messages to this base URL.
      anthropicApiUrl: (config.baseUrl || "").trim().replace(/\/+$/, "") || "https://api.anthropic.com",
      ...(zenHeaders ? { clientOptions: { defaultHeaders: zenHeaders } } : {}),
      ...(thinking ? { thinking } : {}),
    });
  }
  try {
    const { getRegisteredProvider } = await import("./provider-registry.js");
    const registered = getRegisteredProvider(provider);
    if (registered && registered.owner !== "builtin") {
      const baseUrl = (config.baseUrl || (registered.definition as { defaultBaseUrl?: string }).defaultBaseUrl || "").trim();
      if (!baseUrl) throw new Error(`Provider "${registered.id}" needs a base URL.`);
      return new ChatOpenAI({
        apiKey: key || "not-needed",
        model: modelName,
        temperature: 0.1,
        ...openAiReasoningOptions(reasoning),
        configuration: { baseURL: baseUrl },
      });
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("needs a base URL")) throw err;
  }

  if (provider === "custom") {
    if (!config.baseUrl) throw new Error("Custom providers need a base URL (for example http://127.0.0.1:1234/v1). Edit the provider to add one.");
    return new ChatOpenAI({
      apiKey: key || "not-needed",
      model: modelName,
      temperature: 0.1,
      ...openAiReasoningOptions(reasoning),
      configuration: { baseURL: config.baseUrl, ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) }
    });
  }
  if (provider === "openai") {
    return new ChatOpenAI({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      ...openAiReasoningOptions(reasoning),
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined
    });
  }
  if (provider === "anthropic" && endpoint === "chat" && config.baseUrl?.trim()) {
    // Explicit per-model override: speak OpenAI chat completions to a
    // custom Anthropic-compatible base instead of the native API.
    return new ChatOpenAI({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      ...openAiReasoningOptions(reasoning),
      configuration: { baseURL: config.baseUrl.trim().replace(/\/+$/, "") }
    });
  }
  if (provider === "anthropic") {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    class CachingChatAnthropic extends ChatAnthropic {
      override invocationParams(options?: any): any {
        const params = super.invocationParams(options);
        if (params && (params as Record<string, unknown>).cache_control == null) {
          (params as Record<string, unknown>).cache_control = { type: "ephemeral" };
        }
        return params;
      }
    }
    const thinking = reasoning && reasoning !== "none" ? {
      type: "enabled" as const,
      budget_tokens: effortToAnthropicBudget(reasoning),
    } : undefined;
    return new CachingChatAnthropic({
      apiKey: key,
      model: modelName,
      temperature: thinking ? 1.0 : 0.1,
      ...(thinking ? { thinking } : {}),
    });
  }
  if (provider === "google") {
    const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
    let thinkingConfig: any = undefined;
    if (reasoning) {
      if (reasoning === "none") {
        thinkingConfig = { thinkingBudget: 0 };
      } else {
        const budgetMap: Record<string, number> = {
          minimal: 1024,
          low: 2048,
          medium: 8192,
          high: 24576,
          xhigh: 32768,
          max: 65536,
        };
        thinkingConfig = { thinkingBudget: budgetMap[reasoning.toLowerCase()] || 8192 };
      }
    }
    return new ChatGoogleGenerativeAI({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    });
  }
  if (provider === "mistral") { const { ChatMistralAI } = await import("@langchain/mistralai"); return new ChatMistralAI({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "groq") { const { ChatGroq } = await import("@langchain/groq"); return new ChatGroq({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "xai") { const { ChatXAI } = await import("@langchain/xai"); return new ChatXAI({ apiKey: key, model: modelName, temperature: 0.1 }); }
  if (provider === "openrouter") {
    const { ChatOpenRouter } = await import("@langchain/openrouter");
    return new ChatOpenRouter({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      ...(reasoning ? { modelKwargs: { reasoning: { effort: reasoning } } } : {}),
    });
  }
  if (provider === "ollama") {
    let base = (config.baseUrl || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
    if (!base.endsWith("/v1")) base = `${base}/v1`;
    return new ChatOpenAI({
      apiKey: key || "ollama",
      model: modelName,
      temperature: 0.1,
      ...openAiReasoningOptions(reasoning),
      configuration: { baseURL: base },
    });
  }
  if (provider === "deepseek") {
    const { ChatDeepSeek } = await import("@langchain/deepseek");
    return new ChatDeepSeek({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      ...(reasoning ? { modelKwargs: { reasoning_effort: reasoning } } : {}),
    });
  }
  if (provider === "opencode-zen") {
    return new ChatOpenAI({
      apiKey: key,
      model: modelName,
      temperature: 0.1,
      ...openAiReasoningOptions(reasoning),
      configuration: { baseURL: openAiBaseFor(config), ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) }
    });
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
      ...openAiReasoningOptions(reasoning),
    });
  }
  if (provider === "bedrock") { const { ChatBedrockConverse } = await import("@langchain/aws"); return new ChatBedrockConverse({ model: modelName, region: process.env.AWS_REGION || "us-east-1", temperature: 0.1 }); }
  const baseUrl = config.baseUrl || (provider === "together" ? "https://api.together.xyz/v1" : "https://api.fireworks.ai/inference/v1");
  return new ChatOpenAI({
    apiKey: key,
    model: modelName,
    temperature: 0.1,
    ...openAiReasoningOptions(reasoning),
    configuration: { baseURL: baseUrl, ...(zenHeaders ? { defaultHeaders: zenHeaders } : {}) }
  });
}

export type RemoteModelsResult = {
  models: string[];
  modelEfforts: Record<string, string[]>;
  modelContextWindows?: Record<string, number>;
  modelMaxOutputs?: Record<string, number>;
  defaultEfforts?: Record<string, string>;
};

// Query an OpenAI-compatible endpoint's model list (GET /models). Tries the base
// URL as given, then falls back to appending /v1 for hosts configured without it.
export async function fetchRemoteModels(baseUrl: string, apiKey?: string): Promise<RemoteModelsResult> {
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
      const models: string[] = [];
      const modelEfforts: Record<string, string[]> = {};
      const modelContextWindows: Record<string, number> = {};
      const modelMaxOutputs: Record<string, number> = {};
      const defaultEfforts: Record<string, string> = {};

      for (const entry of raw) {
        const id = typeof entry === "string" ? entry : entry?.id ?? entry?.name;
        if (typeof id === "string" && Boolean(id)) {
          models.push(id);
          const rawEfforts = Array.isArray(entry?.reasoning?.supported_efforts)
            ? entry.reasoning.supported_efforts
            : Array.isArray(entry?.supported_efforts)
            ? entry.supported_efforts
            : Array.isArray(entry?.reasoning_efforts)
            ? entry.reasoning_efforts
            : undefined;

          if (rawEfforts && rawEfforts.length) {
            modelEfforts[id] = rawEfforts.filter((e: unknown): e is string => typeof e === "string");
          }
          if (entry?.reasoning?.default_effort && typeof entry.reasoning.default_effort === "string") {
            defaultEfforts[id] = entry.reasoning.default_effort;
          }
          const rawCtx = entry?.context_length ?? entry?.context_window ?? entry?.max_context_length ?? entry?.top_provider?.context_length;
          if (typeof rawCtx === "number" && rawCtx > 0) {
            modelContextWindows[id] = rawCtx;
          }
          const rawMaxOut = entry?.top_provider?.max_completion_tokens ?? entry?.max_completion_tokens ?? entry?.max_tokens;
          if (typeof rawMaxOut === "number" && rawMaxOut > 0) {
            modelMaxOutputs[id] = rawMaxOut;
          }
        }
      }
      if (models.length) return { models, modelEfforts, modelContextWindows, modelMaxOutputs, defaultEfforts };
      lastError = new Error("The endpoint returned no models. Add model names manually.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Unable to reach the endpoint.");
}


export type PublicCatalogModel = {
  id: string;
  name?: string;
  context_length?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
  architecture?: { modality?: string; tokenizer?: string; instruct_type?: string };
  reasoning?: { supported_efforts?: string[]; default_effort?: string };
};

let publicCatalogCache: { timestamp: number; data: PublicCatalogModel[] } | null = null;

export async function fetchPublicCatalogModels(): Promise<PublicCatalogModel[]> {
  if (publicCatalogCache && (Date.now() - publicCatalogCache.timestamp < 10 * 60 * 1000)) {
    return publicCatalogCache.data;
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "User-Agent": "nexus/0.4.5" },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return publicCatalogCache ? publicCatalogCache.data : [];
    const payload: any = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    publicCatalogCache = { timestamp: Date.now(), data };
    return data;
  } catch {
    return publicCatalogCache ? publicCatalogCache.data : [];
  }
}

/**
 * Automatically discovers supported reasoning efforts for a model by:
 * 1. Querying the provider's remote endpoint (if baseUrl or OpenRouter configured).
 * 2. Querying the public models catalog for remote model reasoning metadata.
 * 3. Falling back to known provider definitions and model patterns.
 */
export async function autoDiscoverModelEfforts(
  config: ProviderConfig,
  modelName: string
): Promise<string[]> {
  if (!modelName) return [];
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;

  // 1. If provider has a custom endpoint / baseUrl or is OpenRouter, query that endpoint first
  if (config.baseUrl || config.provider === "openrouter") {
    try {
      const endpoint = config.baseUrl || "https://openrouter.ai/api/v1";
      const remote = await fetchRemoteModels(endpoint, config.apiKey);
      if (remote.modelEfforts[modelName]?.length) {
        return remote.modelEfforts[modelName];
      }
      if (remote.modelEfforts[basename]?.length) {
        return remote.modelEfforts[basename];
      }
      for (const [key, val] of Object.entries(remote.modelEfforts)) {
        if (key.toLowerCase() === normalized || key.toLowerCase().endsWith("/" + normalized) || key.toLowerCase().endsWith("/" + basename)) {
          if (val?.length) return val;
        }
      }
    } catch {
      // Fall through to public catalog / known models
    }
  }

  // 2. Query public catalog
  try {
    const catalog = await fetchPublicCatalogModels();
    // A. Direct or suffix match
    let match = catalog.find((m) => {
      const mId = m.id.toLowerCase();
      return mId === normalized || mId.endsWith("/" + normalized);
    });

    // B. Basename match or normalized dash/dot match (e.g. claude-sonnet-4-6 vs claude-sonnet-4.6)
    if (!match) {
      const cleanBase = basename.replace(/[-_.]/g, "");
      match = catalog.find((m) => {
        const mBase = m.id.toLowerCase().split("/").pop()!;
        if (mBase === basename) return true;
        const cleanMBase = mBase.replace(/[-_.]/g, "");
        return cleanMBase === cleanBase || cleanMBase.startsWith(cleanBase);
      });
    }

    if (match?.reasoning?.supported_efforts?.length) {
      return match.reasoning.supported_efforts.filter((e): e is string => typeof e === "string");
    }
  } catch {
    // Fall through
  }

  // 3. Fallback to known provider definitions and patterns
  try {
    const def = getProviderDefinition(config.provider);
    return resolveModelEfforts(config.provider, modelName, config, def);
  } catch {
    return resolveModelEfforts(config.provider, modelName, config);
  }
}


export const KNOWN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Google Gemini
  "gemini-2.5-pro": 2_097_152,
  "gemini-2.0-pro": 2_097_152,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-pro-latest": 2_097_152,
  "gemini-3.7-pro": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  "gemini-2.0-flash-thinking": 1_048_576,
  "gemini-2.0-flash-thinking-exp": 1_048_576,
  "gemini-1.5-flash": 1_048_576,

  // Anthropic Claude
  "claude-3-7-sonnet": 200_000,
  "claude-3.7-sonnet": 200_000,
  "claude-3-7-sonnet-latest": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-3-5-sonnet-latest": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3.5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,

  // OpenAI
  "o3": 200_000,
  "o3-mini": 200_000,
  "o3-pro": 200_000,
  "o4-mini": 200_000,
  "o1": 200_000,
  "o1-mini": 200_000,
  "o1-preview": 200_000,
  "gpt-5": 256_000,
  "gpt-5-mini": 256_000,
  "gpt-5.5": 256_000,
  "gpt-5.5-mini": 256_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4-turbo-preview": 128_000,
  "gpt-4": 8_192,
  "gpt-4-32k": 32_768,
  "gpt-3.5-turbo": 16_385,

  // DeepSeek
  "deepseek-reasoner": 131_072,
  "deepseek-chat": 131_072,
  "deepseek-r1": 131_072,
  "deepseek-v3": 131_072,
  "deepseek-v4.1-flash": 131_072,
  "deepseek-v4.1-flash-free": 131_072,

  // Meta LLaMA
  "llama-3.3-70b-instruct": 131_072,
  "llama-3.1-405b-instruct": 131_072,
  "llama-3.1-70b-instruct": 131_072,
  "llama-3.1-8b-instruct": 131_072,
  "llama-3-70b-instruct": 8_192,
  "llama-3-8b-instruct": 8_192,

  // Mistral
  "mistral-large-latest": 128_000,
  "mistral-small-latest": 128_000,
  "codestral-latest": 256_000,
  "mistral-medium-3-5": 128_000,

  // Qwen
  "qwen-2.5-72b-instruct": 131_072,
  "qwen-2.5-coder-32b-instruct": 131_072,
  "qwen3.5:4b": 32_768,
  "qwen3.8-max-prime": 1_000_000,

  // NVIDIA
  "nemotron-3-ultra-550b-a55b": 1_048_576,
  "nemotron-3.5-super-vl": 1_048_576,
  "nemotron-3.5-super-vl-120b-a12b": 1_048_576,

  // Zai / GLM
  "glm-4.7-flash": 200_000,
  "glm-4.5": 128_000,
  "glm-4.7": 128_000,
  "glm-5": 128_000,
  "glm-5.3": 128_000,
  "glm-5.3-flash": 128_000,

  // Moonshot / Kimi
  "kimi-k3": 262_144,
};

export const KNOWN_MODEL_MAX_OUTPUTS: Record<string, number> = {
  "claude-3-7-sonnet": 64_000,
  "claude-3.7-sonnet": 64_000,
  "claude-3-5-sonnet": 8_192,
  "claude-3.5-sonnet": 8_192,
  "claude-3-5-haiku": 8_192,
  "o3": 100_000,
  "o3-mini": 100_000,
  "o4-mini": 100_000,
  "o1": 100_000,
  "o1-mini": 65_536,
  "gpt-4o": 16_384,
  "gpt-4o-mini": 16_384,
  "deepseek-reasoner": 8_192,
  "deepseek-r1": 8_192,
  "gemini-2.5-pro": 65_536,
  "gemini-2.5-flash": 65_536,
  "gemini-2.0-flash": 8_192,
};

export function resolveModelContextWindow(
  providerId: string,
  modelName: string,
  providerConfig?: ProviderConfig,
  providerDef?: any
): number {
  if (!modelName) return 128_000;
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;

  if (providerConfig?.modelContextWindows) {
    if (providerConfig.modelContextWindows[modelName]) return providerConfig.modelContextWindows[modelName]!;
    if (providerConfig.modelContextWindows[basename]) return providerConfig.modelContextWindows[basename]!;
  }

  if (providerDef && providerDef.modelContextWindows) {
    const map = providerDef.modelContextWindows;
    if (map[modelName]) return map[modelName];
    if (map[basename]) return map[basename];
  }

  if (KNOWN_MODEL_CONTEXT_WINDOWS[normalized]) return KNOWN_MODEL_CONTEXT_WINDOWS[normalized];
  if (KNOWN_MODEL_CONTEXT_WINDOWS[basename]) return KNOWN_MODEL_CONTEXT_WINDOWS[basename];

  if (basename.includes("2m") || basename.includes("2000k")) return 2_097_152;
  if (basename.includes("1m") || basename.includes("1000k") || basename.includes("1048k")) return 1_048_576;
  if (basename.includes("512k")) return 524_288;
  if (basename.includes("256k") || basename.includes("262k")) return 262_144;
  if (basename.includes("200k")) return 200_000;
  if (basename.includes("128k") || basename.includes("131k")) return 131_072;
  if (basename.includes("64k") || basename.includes("65k")) return 65_536;
  if (basename.includes("32k")) return 32_768;
  if (basename.includes("16k")) return 16_384;
  if (basename.includes("8k")) return 8_192;

  if (basename.startsWith("gemini-")) return 1_048_576;
  if (basename.startsWith("claude-")) return 200_000;
  if (/^o[134](-|$)/.test(basename)) return 200_000;

  return 128_000;
}

export function resolveModelMaxOutput(
  providerId: string,
  modelName: string,
  providerConfig?: ProviderConfig,
  definition?: ProviderDefinition
): number | undefined {
  if (!modelName) return undefined;
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;
  if (providerConfig?.modelMaxOutputs) {
    if (providerConfig.modelMaxOutputs[modelName]) return providerConfig.modelMaxOutputs[modelName];
    if (providerConfig.modelMaxOutputs[basename]) return providerConfig.modelMaxOutputs[basename];
  }
  return KNOWN_MODEL_MAX_OUTPUTS[normalized] || KNOWN_MODEL_MAX_OUTPUTS[basename];
}

export function formatContextWindow(tokens: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_048_576 && Math.abs(tokens - Math.round(tokens / 1_048_576) * 1_048_576) < 1000) {
    return `${Math.round(tokens / 1_048_576)}M`;
  }
  if (tokens >= 1_000_000) {
    const m = (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1);
    return `${m.replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1000) {
    if (tokens % 1000 === 0) {
      return `${Math.round(tokens / 1000)}k`;
    }
    if (tokens % 1024 === 0) {
      return `${Math.round(tokens / 1024)}k`;
    }
    const k = Math.round(tokens / 1000);
    return `${k}k`;
  }
  return `${tokens}`;
}

export function formatTokenCount(tokens: number): string {
  if (!tokens || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (tokens >= 10_000) {
    return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return tokens.toLocaleString();
}

export async function autoDiscoverModelContextWindow(
  config: ProviderConfig,
  modelName: string
): Promise<{ contextWindow: number; maxOutput?: number; tokenizer?: string; modality?: string }> {
  if (!modelName) return { contextWindow: 128_000 };
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;

  // 1. Endpoint / baseUrl query
  if (config.baseUrl || config.provider === "openrouter") {
    try {
      const endpoint = config.baseUrl || "https://openrouter.ai/api/v1";
      const remote = await fetchRemoteModels(endpoint, config.apiKey);
      const ctx = remote.modelContextWindows?.[modelName] ?? remote.modelContextWindows?.[basename];
      const maxOut = remote.modelMaxOutputs?.[modelName] ?? remote.modelMaxOutputs?.[basename];
      if (ctx) {
        return { contextWindow: ctx, maxOutput: maxOut };
      }
    } catch {
      // Fall through
    }
  }

  // 2. Public catalog
  try {
    const catalog = await fetchPublicCatalogModels();
    let match = catalog.find((m) => {
      const mId = m.id.toLowerCase();
      return mId === normalized || mId.endsWith("/" + normalized);
    });
    if (!match) {
      const cleanBase = basename.replace(/[-_.]/g, "");
      match = catalog.find((m) => {
        const mBase = m.id.toLowerCase().split("/").pop()!;
        if (mBase === basename) return true;
        const cleanMBase = mBase.replace(/[-_.]/g, "");
        return cleanMBase === cleanBase || cleanMBase.startsWith(cleanBase);
      });
    }

    if (match) {
      const ctx = match.context_length || match.top_provider?.context_length;
      const maxOut = match.top_provider?.max_completion_tokens;
      if (ctx) {
        return {
          contextWindow: ctx,
          maxOutput: maxOut,
          tokenizer: match.architecture?.tokenizer,
          modality: match.architecture?.modality,
        };
      }
    }
  } catch {
    // Fall through
  }

  // 3. Fallback
  const fallback = resolveModelContextWindow(config.provider, modelName, config);
  const maxOutput = resolveModelMaxOutput(config.provider, modelName, config);
  return { contextWindow: fallback, maxOutput };
}
