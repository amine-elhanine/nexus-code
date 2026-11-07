
/**
 * Calculates the auto-compaction threshold for a model's context window:
 * a flat 85% of the window. The 15% completion headroom is what the trigger
 * leaves for the in-flight call; a rare overflow past that is recovered by
 * the context-window-error path (compact + relaunch), so max output tokens
 * are not additionally reserved here. `maxOutput` is kept in the signature
 * for call-site compatibility but no longer moves the threshold.
 */
export function computeCompactionThreshold(contextWindow: number, _maxOutput?: number): number {
  const ctx = Math.max(4096, contextWindow || 128_000);
  return Math.floor(ctx * 0.85);
}

import { createChatClient, defaultEndpointForProvider, resolveModelEndpoint } from "./agentcore/llm/factory.js";
import type { ChatClient } from "./agentcore/llm/types.js";
import type { ChatEndpointKind, ProviderConfig } from "./store.js";

export type { ChatEndpointKind };
export { defaultEndpointForProvider, resolveModelEndpoint };

/**
 * The Zen gateway identifies official clients by HTTP headers; the header set
 * and base-URL routing live in agentcore/llm/factory.ts now.
 */

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
    packageName: "builtin",
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
    packageName: "builtin",
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
    packageName: "builtin",
    envKey: "GOOGLE_API_KEY",
    models: ["gemini-3.7-pro", "gemini-3.7-flash", "gemini-2.5-flash"],
    modelEfforts: {
      "gemini-3.7-pro": ["none", "low", "medium", "high"],
      "gemini-3.7-flash": ["none", "low", "medium", "high"],
      "gemini-2.5-flash": ["none", "low", "medium", "high"],
    },
  },
  { id: "mistral", label: "Mistral", packageName: "builtin", envKey: "MISTRAL_API_KEY", models: ["mistral-large-latest", "codestral-latest", "mistral-small-latest"] },
  { id: "groq", label: "Groq", packageName: "builtin", envKey: "GROQ_API_KEY", models: ["openai/gpt-oss-120b", "llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b"] },
  { id: "xai", label: "xAI", packageName: "builtin", envKey: "XAI_API_KEY", models: ["grok-4", "grok-4-fast", "grok-3-mini"] },
  {
    id: "openrouter",
    label: "OpenRouter",
    packageName: "builtin",
    envKey: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "google/gemini-3.7-pro"],
    modelEfforts: {
      "openai/gpt-5.5": ["none", "low", "medium", "high"],
      "google/gemini-3.7-pro": ["none", "low", "medium", "high"],
      "anthropic/claude-sonnet-4.6": ["low", "medium", "high", "max"],
    },
  },
  { id: "ollama", label: "Ollama", packageName: "builtin", envKey: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434", models: ["qwen3-coder", "devstral", "llama3.3"] },
  {
    id: "deepseek",
    label: "DeepSeek",
    packageName: "builtin",
    envKey: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelEfforts: {
      "deepseek-reasoner": ["low", "medium", "high"],
    },
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    packageName: "builtin",
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
  { id: "together", label: "Together AI", packageName: "builtin", envKey: "TOGETHER_AI_API_KEY", models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"] },
  { id: "fireworks", label: "Fireworks", packageName: "builtin", envKey: "FIREWORKS_API_KEY", models: ["accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/qwen3-coder"] },
  {
    id: "azure",
    label: "Azure OpenAI",
    packageName: "builtin",
    envKey: "AZURE_OPENAI_API_KEY",
    models: ["gpt-5.5", "gpt-4.1", "o3"],
    modelEfforts: {
      "gpt-5.5": ["none", "low", "medium", "high"],
      "o3": ["low", "medium", "high"],
    },
  },
  { id: "bedrock", label: "AWS Bedrock", packageName: "builtin", envKey: "AWS_ACCESS_KEY_ID", models: ["anthropic.claude-sonnet-4-6", "amazon.nova-pro-v1:0"] },
  { id: "custom", label: "Custom (OpenAI-compatible)", packageName: "builtin", envKey: "CUSTOM_API_KEY", models: [] },
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

export async function createChatModel(config: ProviderConfig, modelName: string, options?: ModelChatOptions): Promise<ChatClient> {
  const key = config.apiKey || process.env[getProviderDefinition(config.provider).envKey] || "";
  const withKey: ProviderConfig = { ...config, apiKey: key };
  return createChatClient(withKey, modelName, { reasoningEffort: options?.reasoningEffort });
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
