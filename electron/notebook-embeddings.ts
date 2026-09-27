import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { listEmbeddingProviders, listProviders, type EmbeddingEndpointKind, type EmbeddingProviderConfig, type ProviderConfig } from "./store.js";

// Lazy Electron access (see notebook-store.ts): plain-node safe.
const electronRequire = createRequire(import.meta.url);
function userDataBase(): string {
  try {
    const mod = electronRequire("electron") as unknown;
    if (mod && typeof mod === "object") {
      const app = (mod as { app?: { getPath: (n: string) => string } }).app;
      if (app?.getPath) return app.getPath("userData");
    }
  } catch { /* fall through */ }
  return path.join(process.cwd(), ".nexus-data");
}

export type NotebookEmbeddingConfig = {
  /** EmbeddingProviderConfig.id from Settings → Notebook. Empty = local built-in embeddings (offline). */
  providerId: string;
  /** Embedding model name, e.g. text-embedding-3-small, nomic-embed-text. */
  model: string;
};

export type EmbeddingEndpoint = { kind: EmbeddingEndpointKind; baseUrl?: string; apiKey?: string };

const DEFAULTS: NotebookEmbeddingConfig = { providerId: "", model: "text-embedding-3-small" };

function configPath() {
  return path.join(userDataBase(), "notebooks", "embedding-config.json");
}

export async function getNotebookEmbeddingConfig(): Promise<NotebookEmbeddingConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), "utf8")) as Partial<NotebookEmbeddingConfig>;
    return { providerId: raw.providerId || "", model: raw.model || DEFAULTS.model };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveNotebookEmbeddingConfig(input: NotebookEmbeddingConfig): Promise<NotebookEmbeddingConfig> {
  const next = { providerId: input.providerId || "", model: input.model?.trim() || DEFAULTS.model };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function embeddingModelLabel(config: NotebookEmbeddingConfig, providers: ProviderConfig[], embeddingProviders?: EmbeddingProviderConfig[]): string {
  if (!config.providerId) return `local-hash (${config.model})`;
  const emb = (embeddingProviders || []).find((x) => x.id === config.providerId);
  if (emb) return `${emb.name} / ${config.model}`;
  const p = providers.find((x) => x.id === config.providerId);
  return `${p?.label || "provider"} / ${config.model}`;
}

// ---- Local fallback embedding: hashed unigram+bigram bag, L2-normalized.
// Deterministic and offline; combined with BM25 it gives reasonable recall
// until the user configures a remote embedding model in Settings. ----

// 2048 dimensions: with 512, random hash collisions between unrelated texts
// (~1.4 expected shared buckets per query-chunk pair) produced cosine scores
// up to ~0.15, defeating the groundedness gate. At 2048 the collision floor
// drops to ~0.01 while paraphrase-level matches still score well above it.
export const LOCAL_DIMS = 2048;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const LOCAL_STOPWORDS = new Set(
  "the,a,an,and,or,of,to,in,on,for,with,as,at,by,from,is,are,was,were,be,been,being,it,its,this,that,these,those,you,your,he,she,they,them,his,her,their,our,we,us,i,me,my,not,no,yes,if,then,else,when,where,which,who,whom,what,how,why,can,could,should,would,will,do,does,did,have,has,had,all,any,each,more,most,other,some,such,than,too,very,into,over,after,before,between,through,during,about,against,per,via,also,within,without".split(",")
);

export function localEmbed(text: string, dims = LOCAL_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  // Stopwords removed: without this, filler words ("the", "what", "and")
  // shared by any two texts inflate cosine and drown out real similarity.
  const tokens = (text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_\-]{2,}/gu) || []).filter((t) => !LOCAL_STOPWORDS.has(t)).slice(0, 2000);
  const grams = [...tokens];
  for (let i = 0; i + 1 < tokens.length && grams.length < 4000; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
  for (const g of grams) {
    vec[hashToken(g) % dims] += 1;
  }
  // Log-scale dampens long-document dominance.
  for (let i = 0; i < dims; i++) vec[i] = Math.log1p(vec[i]);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

function openAiCompatibleBase(baseUrl: string | undefined, legacyProvider?: string): string {
  const raw = (baseUrl || "").trim().replace(/\/+$/, "");
  if (raw) return raw;
  if (legacyProvider === "openrouter") return "https://openrouter.ai/api/v1";
  if (legacyProvider === "together") return "https://api.together.xyz/v1";
  if (legacyProvider === "fireworks") return "https://api.fireworks.ai/inference/v1";
  if (legacyProvider === "deepseek") return "https://api.deepseek.com/v1";
  if (legacyProvider === "groq") return "https://api.groq.com/openai/v1";
  if (legacyProvider === "xai") return "https://api.x.ai/v1";
  if (legacyProvider === "mistral") return "https://api.mistral.ai/v1";
  if (legacyProvider === "opencode-zen") return "https://opencode.ai/zen/v1";
  return "https://api.openai.com/v1";
}

async function remoteEmbedOpenAiCompatible(endpoint: { baseUrl?: string; apiKey?: string }, legacyProvider: string | undefined, model: string, texts: string[]): Promise<number[][]> {
  const base = openAiCompatibleBase(endpoint.baseUrl, legacyProvider);
  const tries = [base, `${base}/v1`].filter((v, i, arr) => arr.indexOf(v) === i);
  // Providers differ in how many inputs they accept per request. In
  // particular, a one-text connection test can succeed while a full notebook
  // re-index fails when hundreds of chunks are sent in one payload.
  const batchSize = 16;
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    let batchRows: number[][] | null = null;
    let lastError: Error | null = null;
    for (const candidate of tries) {
      try {
        const res = await fetch(`${candidate}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
          },
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          lastError = new Error(`Embeddings request failed: ${res.status} ${res.statusText}`);
          continue;
        }
        const payload = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
        const rows = (payload.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
        if (rows.length === batch.length) {
          batchRows = rows;
          break;
        }
        lastError = new Error("Embeddings endpoint returned an unexpected shape.");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!batchRows) throw lastError || new Error("Embeddings request failed.");
    output.push(...batchRows);
  }
  return output;
}

async function remoteEmbedOllama(endpoint: { baseUrl?: string }, model: string, texts: string[]): Promise<number[][]> {
  const base = (endpoint.baseUrl || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
  const out: number[][] = [];
  for (const text of texts) {
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status} ${res.statusText}`);
    const payload = (await res.json()) as { embedding?: number[] };
    if (!payload.embedding?.length) throw new Error("Ollama returned no embedding.");
    out.push(payload.embedding);
  }
  return out;
}

async function remoteEmbedGemini(apiKey: string, model: string, texts: string[]): Promise<number[][]> {
  if (!apiKey) throw new Error("Gemini embeddings need an API key (Google AI Studio).");
  const out: number[][] = [];
  // batchEmbedContents caps at ~100 requests per call — page through.
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: batch.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Gemini embeddings failed: ${res.status} ${res.statusText}`);
    const payload = (await res.json()) as { responses?: Array<{ values?: number[] }> };
    const rows = (payload.responses || []).map((r) => r.values || []);
    if (rows.length !== batch.length || rows.some((r) => !r.length)) {
      throw new Error("Gemini returned an unexpected shape.");
    }
    out.push(...rows);
  }
  return out;
}

async function remoteEmbedCohere(apiKey: string, model: string, texts: string[]): Promise<number[][]> {
  if (!apiKey) throw new Error("Cohere embeddings need an API key.");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const res = await fetch("https://api.cohere.com/v2/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input_type: "search_document", embedding_types: ["float"], texts: batch }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Cohere embeddings failed: ${res.status} ${res.statusText}`);
    const payload = (await res.json()) as { embeddings?: { float?: number[][] } };
    const rows = payload.embeddings?.float || [];
    if (rows.length !== batch.length) throw new Error("Cohere returned an unexpected shape.");
    out.push(...rows);
  }
  return out;
}

/** Dispatch one batch to a concrete endpoint kind. */
export async function remoteEmbed(endpoint: EmbeddingEndpoint, model: string, texts: string[]): Promise<number[][]> {
  if (endpoint.kind === "ollama") return remoteEmbedOllama(endpoint, model, texts);
  if (endpoint.kind === "gemini") return remoteEmbedGemini(endpoint.apiKey || "", model, texts);
  if (endpoint.kind === "cohere") return remoteEmbedCohere(endpoint.apiKey || "", model, texts);
  return remoteEmbedOpenAiCompatible(endpoint, undefined, model, texts);
}

/** Smoke-test an endpoint (saved or still in the form) with one short text. */
export async function testEmbeddingEndpoint(input: EmbeddingEndpoint & { model: string }): Promise<{ dims: number }> {
  if (!input.model.trim()) throw new Error("Enter an embedding model to test.");
  const vectors = await remoteEmbed(input, input.model.trim(), ["Hello world"]);
  if (!vectors[0]?.length) throw new Error("Endpoint returned no embedding.");
  return { dims: vectors[0].length };
}

/** Embed a batch. Falls back to local embeddings when unconfigured or when
 *  the remote call fails (indexing must never hard-fail a whole upload). */
export async function embedTexts(texts: string[]): Promise<{ vectors: number[][]; model: string; dims: number; remote: boolean }> {
  const config = await getNotebookEmbeddingConfig();
  if (config.providerId) {
    try {
      // Dedicated embedding providers first…
      const embProviders = await listEmbeddingProviders();
      const emb = embProviders.find((p) => p.id === config.providerId);
      if (emb) {
        const vectors = await remoteEmbed(emb, config.model, texts);
        return { vectors: normalizeAll(vectors), model: `${emb.name}/${config.model}`, dims: vectors[0]?.length || 0, remote: true };
      }
      // …then legacy chat-provider ids (configs saved before custom
      // embedding providers existed keep working).
      const providers = await listProviders();
      const provider = providers.find((p) => p.id === config.providerId);
      if (provider) {
        const vectors =
          provider.provider === "ollama"
            ? await remoteEmbedOllama(provider, config.model, texts)
            : await remoteEmbedOpenAiCompatible(provider, provider.provider, config.model, texts);
        return { vectors: normalizeAll(vectors), model: `${provider.label}/${config.model}`, dims: vectors[0]?.length || 0, remote: true };
      }
      console.warn(`[notebook] embedding provider ${config.providerId} not found, using local fallback.`);
    } catch (error) {
      console.warn("[notebook] remote embeddings failed, using local fallback:", error instanceof Error ? error.message : error);
    }
  }
  return { vectors: texts.map((t) => localEmbed(t)), model: `local-hash/${config.model}`, dims: LOCAL_DIMS, remote: false };
}

function normalizeAll(vectors: number[][]): number[][] {
  // Normalize remote vectors so cosine stays comparable across providers.
  return vectors.map((v) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}

export async function embedQuery(text: string, indexEmbeddingModel?: string): Promise<{ vector: number[]; model: string; remote: boolean; modelMismatch?: boolean }> {
  const { vectors, model, remote } = await embedTexts([text]);
  // A provider changed after indexing silently zeroes semantic scores (dim
  // mismatch) or yields garbage (same dims, different space). Detect it so
  // the caller can rebuild the partition instead of degrading quietly.
  const modelMismatch = Boolean(indexEmbeddingModel) && indexEmbeddingModel !== "none" && indexEmbeddingModel !== model;
  return { vector: vectors[0], model, remote, modelMismatch };
}
