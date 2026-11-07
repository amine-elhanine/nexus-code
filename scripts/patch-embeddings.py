# One-off: Phase 2.2 — Ollama auto-detect for offline semantic embeddings +
# trigram/morphological hashing in the zero-dependency localEmbed fallback.
p = 'electron/notebook-embeddings.ts'
s = open(p, encoding='utf8').read()

# 1. Morphology-aware local fallback: singular/stem folding + char trigrams.
old = '''export function localEmbed(text: string, dims = LOCAL_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  // Stopwords removed: without this, filler words ("the", "what", "and")
  // shared by any two texts inflate cosine and drown out real similarity.
  // Same stopword list as the lexical pipeline (notebook-text.js).
  const tokens = (text.toLocaleLowerCase().match(/[\\p{L}\\p{N}][\\p{L}\\p{N}_\\-]{2,}/gu) || []).filter((t) => !NOTEBOOK_STOPWORDS.has(t)).slice(0, 2000);
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
}'''
assert old in s
new = '''/**
 * Light morphological folding (English plural/verb suffixes) so "models" and
 * "model", "indexed" and "indexing" share buckets — the pure hash bag treated
 * every inflection as an unrelated token.
 */
export function singularToken(token: string): string {
  let t = token.toLowerCase();
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && (t.endsWith("sses") || t.endsWith("shes") || t.endsWith("ches") || t.endsWith("xes"))) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  return t;
}

export function localEmbed(text: string, dims = LOCAL_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  // Stopwords removed: without this, filler words ("the", "what", "and")
  // shared by any two texts inflate cosine and drown out real similarity.
  // Same stopword list as the lexical pipeline (notebook-text.js).
  const raw = (text.toLocaleLowerCase().match(/[\\p{L}\\p{N}][\\p{L}\\p{N}_\\-]{2,}/gu) || []).filter((t) => !NOTEBOOK_STOPWORDS.has(t)).slice(0, 2000);
  const tokens = raw.map(singularToken);
  const grams = [...tokens];
  for (let i = 0; i + 1 < tokens.length && grams.length < 4000; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
  // Unigram+bigram (weight 1) plus character trigrams of every token
  // (weight 0.35): sub-word similarity catches typos, rare inflections and
  // cognate loanwords the token fold misses.
  for (const g of grams) {
    vec[hashToken(g) % dims] += 1;
  }
  for (const token of tokens) {
    const padded = `#${token}#`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      vec[hashToken(padded.slice(i, i + 3)) % dims] += 0.35;
    }
  }
  // Log-scale dampens long-document dominance.
  for (let i = 0; i < dims; i++) vec[i] = Math.log1p(vec[i]);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

// ---- Ollama auto-detect: a local Ollama with an embedding model installed
// upgrades the offline path from hash vectors to true semantic vectors with
// zero configuration. Detection is cached per base URL for 60s so batch
// embedding never re-probes per chunk. ----

let ollamaProbe: { base: string; model: string | null; at: number } | null = null;

export async function detectLocalOllamaEmbeddingModel(baseUrl?: string): Promise<string | null> {
  const base = (baseUrl || "http://127.0.0.1:11434").trim().replace(/\\/+$/, "");
  if (ollamaProbe && ollamaProbe.base === base && Date.now() - ollamaProbe.at < 60_000) {
    return ollamaProbe.model;
  }
  let model: string | null = null;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (res.ok) {
      const payload = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (payload.models || []).map((m) => String(m.name || "")).filter(Boolean);
      const preferred = ["nomic-embed-text", "all-minilm", "mxbai-embed-large", "snowflake-arctic-embed"];
      for (const prefix of preferred) {
        const hit = names.find((n) => n.startsWith(prefix));
        if (hit) { model = hit; break; }
      }
      if (!model) {
        model = names.find((n) => /embed|minilm|arctic/i.test(n)) || null;
      }
    }
  } catch { /* no local Ollama — hash fallback stays */ }
  ollamaProbe = { base, model, at: Date.now() };
  return model;
}'''
s = s.replace(old, new)

# 2. Hook auto-detect into embedTexts' fallback path.
old2 = '''  return { vectors: texts.map((t) => localEmbed(t)), model: `local-hash/${config.model}`, dims: LOCAL_DIMS, remote: false };
}'''
assert old2 in s
new2 = '''  // Offline upgrade: a locally installed Ollama embedding model beats the
  // hash fallback. Any failure degrades silently to localEmbed.
  try {
    const ollamaModel = await detectLocalOllamaEmbeddingModel();
    if (ollamaModel) {
      const vectors = await remoteEmbedOllama({ baseUrl: "http://127.0.0.1:11434" }, ollamaModel, texts);
      if (vectors.length === texts.length && vectors.every((v) => v?.length)) {
        return { vectors: normalizeAll(vectors), model: `ollama-local/${ollamaModel}`, dims: vectors[0].length, remote: false };
      }
    }
  } catch (error) {
    console.warn("[notebook] local Ollama embeddings unavailable, using hash fallback:", error instanceof Error ? error.message : error);
  }
  return { vectors: texts.map((t) => localEmbed(t)), model: `local-hash/${config.model}`, dims: LOCAL_DIMS, remote: false };
}'''
s = s.replace(old2, new2)
open(p, 'w', encoding='utf8', newline='\n').write(s)
print("2.2 installed")
