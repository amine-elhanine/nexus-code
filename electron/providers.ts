import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import type { ProviderConfig } from "./store.js";

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
  if (provider === "custom") {
    if (!config.baseUrl) throw new Error("Custom providers need a base URL (for example http://127.0.0.1:1234/v1). Edit the provider to add one.");
    return new ChatOpenAI({ apiKey: key || "not-needed", model: modelName, temperature: 0.1, configuration: { baseURL: config.baseUrl } });
  }
  if (provider === "openai") return new ChatOpenAI({ apiKey: key, model: modelName, temperature: 0.1, configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined });
  if (provider === "anthropic") { const { ChatAnthropic } = await import("@langchain/anthropic"); return new ChatAnthropic({ apiKey: key, model: modelName, temperature: 0.1 }); }
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
  return new ChatOpenAI({ apiKey: key, model: modelName, temperature: 0.1, configuration: { baseURL: baseUrl } });
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
