// Compact / local model profile detection, Ollama context probing, and
// lightweight tool-schema compaction so small local models (7B-32B, 4k-32k)
// perform reliably without changing any defaults for large frontier models.
import type { AgentTaskKind } from "./agent-types.js";
import type { AgentTool } from "./agentcore/tools.js";

const SMALL_PARAM_PATTERN = /(?:^|[:\-_/])(?:0\.5|1|1\.5|2|3|4|7|8|9|12|14)b(?:$|[:\-_q])/i;
const SMALL_FAMILY_PATTERN = /(?:^|[:\-_/])(?:phi-?[234]|tinyllama|smollm|gemma-?2b|gemma-?7b)(?:$|[:\-_/])/i;
const LARGE_PARAM_OR_WINDOW_PATTERN = /(?:^|[:\-_/])(?:70|72|110|120|235|405|671)b(?:$|[:\-_q])|\b(?:64k|128k|200k|256k|1m)\b/i;
const FRONTIER_CLOUD_MODEL_PATTERN = /^(?:claude-|gpt-[45]|o[134](?:-|$)|gemini-|deepseek-(?:chat|reasoner|v3))/i;

export function isLoopbackUrl(rawUrl?: string): boolean {
  const urlText = (rawUrl || "").trim();
  if (!urlText) return false;
  try {
    const host = new URL(urlText).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0";
  } catch {
    return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i.test(urlText);
  }
}

export function isCompactModelProfile(input: {
  provider?: string;
  baseUrl?: string;
  modelName?: string;
  contextWindow?: number;
}): boolean {
  const ctx = Number(input.contextWindow || 0);
  if (ctx > 0 && ctx <= 32_768) return true;

  const model = (input.modelName || "").trim();
  const baseName = model.includes("/") ? model.split("/").pop() || model : model;
  if (SMALL_PARAM_PATTERN.test(baseName) || SMALL_FAMILY_PATTERN.test(baseName)) {
    return true;
  }

  // Never downgrade recognized large frontier cloud models when context > 32k.
  if (FRONTIER_CLOUD_MODEL_PATTERN.test(baseName)) return false;
  if (LARGE_PARAM_OR_WINDOW_PATTERN.test(baseName)) return false;

  const provider = (input.provider || "").trim().toLowerCase();
  if (provider === "ollama") return true;
  if (provider === "custom" && isLoopbackUrl(input.baseUrl)) return true;
  return false;
}

const ollamaCtxCache = new Map<string, { ctx: number | null; expiresAt: number }>();
const OLLAMA_CTX_TTL_MS = 5 * 60 * 1000;

export function parseOllamaShowContextWindow(data: any): number | null {
  if (!data || typeof data !== "object") return null;
  // Explicit Modelfile / parameter override takes precedence.
  const params = typeof data.parameters === "string" ? data.parameters : "";
  const numCtxMatch = params.match(/(?:^|\s)num_ctx\s+(\d+)/i);
  if (numCtxMatch) {
    const n = Number(numCtxMatch[1]);
    if (Number.isFinite(n) && n >= 1024) return Math.min(n, 2_097_152);
  }
  const info = data.model_info && typeof data.model_info === "object" ? data.model_info : null;
  if (info) {
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(".context_length")) {
        const n = Number(v);
        // Without explicit num_ctx in Modelfile, Ollama defaults small runtime windows
        // even when GGUF architecture lists 131k/262k; cap conservatively at 32k.
        if (Number.isFinite(n) && n >= 1024) return Math.min(n, 32_768);
      }
    }
  }
  return null;
}

export async function resolveOllamaContextWindow(baseUrl: string | undefined, modelName: string): Promise<number | null> {
  const model = (modelName || "").trim();
  if (!model) return null;
  const root = (baseUrl || "http://127.0.0.1:11434").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const cacheKey = `${root}::${model}`;
  const cached = ollamaCtxCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  let resolved: number | null = null;
  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const json = await res.json();
      resolved = parseOllamaShowContextWindow(json);
    }
  } catch {
    resolved = null;
  }
  if (ollamaCtxCache.size >= 100) ollamaCtxCache.clear();
  ollamaCtxCache.set(cacheKey, { ctx: resolved, expiresAt: Date.now() + OLLAMA_CTX_TTL_MS });
  return resolved;
}

function shortenToolDescription(desc: string, maxLen = 150): string {
  const clean = (desc || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const firstSentence = clean.match(/^.{20,}?[.!?](?=\s|$)/)?.[0];
  if (firstSentence && firstSentence.length <= maxLen) return firstSentence;
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

function compactJsonSchema(schema: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || depth > 4) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" && depth === 0) continue;
    if (k === "description" && typeof v === "string") {
      out[k] = shortenToolDescription(v, 96);
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = pv && typeof pv === "object" ? compactJsonSchema(pv as Record<string, unknown>, depth + 1) : pv;
      }
      out[k] = props;
      continue;
    }
    if (k === "items" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = compactJsonSchema(v as Record<string, unknown>, depth + 1);
      continue;
    }
    out[k] = v;
  }
  return out;
}

const COMPACT_DROP_OPTIONAL_TOOLS = new Set(["delegate_task", "project_memory", "learn_skill", "inspect_artifact"]);

/**
 * Compacts bound tool schemas and trims low-ROI optional tools for small / local
 * models. Validation (`schema`) and `execute` remain completely unchanged.
 */
export function compactToolsForSmallModel(
  tools: AgentTool[],
  options: { taskKind: AgentTaskKind; isSimple: boolean; requiresPlanGate?: boolean }
): AgentTool[] {
  const dropTodo = options.isSimple || !options.requiresPlanGate;
  return tools
    .filter((tool) => {
      if (!tool?.name) return false;
      if (COMPACT_DROP_OPTIONAL_TOOLS.has(tool.name)) return false;
      if (tool.name === "write_todos" && dropTodo) return false;
      // On compact models without research intent, drop apply_patch so the model
      // uses one consistent editing tool (edit_file / write_file) instead of mixing formats.
      if (tool.name === "apply_patch" && options.taskKind === "general") return false;
      return true;
    })
    .map((tool) => ({
      ...tool,
      description: shortenToolDescription(tool.description, 150),
      parameters: compactJsonSchema(tool.parameters),
    }));
}
