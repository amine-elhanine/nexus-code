import type { ProviderConfig, ProviderDefinition } from "../types.js";

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

/**
 * Resolves the supported reasoning efforts for a given model.
 * Prioritizes explicitly configured efforts (e.g. from OpenRouter/endpoints or user config),
 * followed by provider definition defaults and known model capabilities.
 * Returns an empty array if the model does not support effort adjustment.
 */
export function resolveModelEfforts(
  providerId: string,
  modelName: string,
  providerConfig?: ProviderConfig,
  providerDef?: ProviderDefinition
): string[] {
  if (!modelName) return [];
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;

  // 1. Explicit per-provider model efforts (from remote fetch or user config)
  if (providerConfig?.modelEfforts) {
    if (providerConfig.modelEfforts[modelName] !== undefined) {
      return [...providerConfig.modelEfforts[modelName]!];
    }
    if (providerConfig.modelEfforts[basename] !== undefined) {
      return [...providerConfig.modelEfforts[basename]!];
    }
  }

  // 2. Definition seed efforts
  if (providerDef?.modelEfforts) {
    if (providerDef.modelEfforts[modelName] !== undefined) {
      return [...providerDef.modelEfforts[modelName]!];
    }
    if (providerDef.modelEfforts[basename] !== undefined) {
      return [...providerDef.modelEfforts[basename]!];
    }
  }

  // 3. Known model catalogue
  if (KNOWN_MODEL_EFFORTS[normalized]) return [...KNOWN_MODEL_EFFORTS[normalized]];
  if (KNOWN_MODEL_EFFORTS[basename]) return [...KNOWN_MODEL_EFFORTS[basename]];

  // 4. Pattern heuristics for models with reasoning in their names
  if (/^o[134](-|$)/.test(basename)) return ["low", "medium", "high"];
  if (basename.startsWith("gpt-5")) return ["none", "low", "medium", "high"];
  if (basename.includes("reasoner") || basename.includes("-r1")) return ["low", "medium", "high"];
  if (basename.includes("thinking")) return ["none", "low", "medium", "high"];
  if (/claude-(3[-.]7|opus-4|sonnet-4)/.test(basename)) return ["low", "medium", "high", "max"];

  // Default: model does not support reasoning effort
  return [];
}

export function formatEffortLabel(effort: string): string {
  if (!effort) return "Auto";
  switch (effort.toLowerCase()) {
    case "none": return "None";
    case "minimal": return "Minimal";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra High";
    case "max": return "Max";
    default: return effort.charAt(0).toUpperCase() + effort.slice(1);
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
  providerDef?: ProviderDefinition
): number {
  if (!modelName) return 128_000;
  const normalized = modelName.trim().toLowerCase();
  const basename = normalized.includes("/") ? normalized.split("/").pop()! : normalized;

  // 1. Explicit per-provider modelContextWindows
  if (providerConfig?.modelContextWindows) {
    if (providerConfig.modelContextWindows[modelName]) return providerConfig.modelContextWindows[modelName]!;
    if (providerConfig.modelContextWindows[basename]) return providerConfig.modelContextWindows[basename]!;
  }

  // 2. Provider definition seed
  if (providerDef && (providerDef as any).modelContextWindows) {
    const map = (providerDef as any).modelContextWindows;
    if (map[modelName]) return map[modelName];
    if (map[basename]) return map[basename];
  }

  // 3. Known catalogue
  if (KNOWN_MODEL_CONTEXT_WINDOWS[normalized]) return KNOWN_MODEL_CONTEXT_WINDOWS[normalized];
  if (KNOWN_MODEL_CONTEXT_WINDOWS[basename]) return KNOWN_MODEL_CONTEXT_WINDOWS[basename];

  // 4. Pattern heuristics
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

  // Defaults by family
  if (basename.startsWith("gemini-")) return 1_048_576;
  if (basename.startsWith("claude-")) return 200_000;
  if (/^o[134](-|$)/.test(basename)) return 200_000;

  // Standard fallback
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
