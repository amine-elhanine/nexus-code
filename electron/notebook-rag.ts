import { createChatModel } from "./providers.js";
import { tool } from "@langchain/core/tools";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { CompositeBackend, createDeepAgent, FilesystemBackend } from "deepagents";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { executeCommand } from "./command-service.js";
import { getSkillsConfig, listProviders } from "./store.js";
import { cosine, embedQuery } from "./notebook-embeddings.js";
import { notebookFlags } from "./notebook-flags.js";
import {
  chunkNeighbors,
  listChunks,
  loadLibrary,
  loadVectors,
  sessionOutline,
  sessionSummary,
  type SessionLibrary,
  type VectorPartition,
} from "./notebook-library.js";
import { notebookSessionDir, saveNotebookNote, type NotebookSourceCitation, type NotebookAgentStep } from "./notebook-store.js";
import {
  composeContextBlock,
  composeContextBlockIndexed,
  evaluateCitationCoverage,
  gateDecision,
  isSessionWideAsk,
  notebookTokens,
  rewriteQuery,
  routeMessageHeuristic,
  toCitations,
  type RouteAction,
} from "./notebook-text.js";

// Chat pipeline: persist-first happens in main.ts; here route → retrieve →
// gate → generate (streaming) → sources. Retrieval never leaves the session.

export type NotebookRagOptions = {
  topK?: number;
  fileIds?: string[]; // user-selected scope; default = all files
  chatProviderId?: string;
  chatModel?: string;
  instructions?: string;
  rerank?: { enabled: boolean; providerId?: string; model?: string };
  onToken?: (delta: string) => void;
  onStreamReset?: () => void;
  onStatus?: (text: string) => void;
  onTool?: (name: string, summary: string, detail?: string) => void;
  onStep?: (step: NotebookAgentStep) => void;
  generate?: (system: string, user: string) => Promise<string>;
  /** Scoped run id for shell cancellation (defaults to `nbchat-<notebookId>`). */
  runId?: string;
  isCancelled?: () => boolean;
};

export type RetrievedChunk = {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  headingPath: string[];
  text: string;
  summary?: string;
  semantic: number;
  lexical: number;
  graphBoost: number;
  fused: number;
  final: number;
  methods: string[];
};

export type ChatMetadata = {
  routing: RouteAction | "session_outline";
  topScore: number;
  refused: boolean;
  fallbackModel: boolean;
};

export type ChatResult = {
  answer: string;
  sources: NotebookSourceCitation[];
  retrieval: Array<{ chunkId: string; sourceName: string; score: number; methods: string[] }>;
  metadata: ChatMetadata;
  embeddingModel: string;
  dims: number;
  steps?: NotebookAgentStep[];
  evaluation?: { citationCoverage: number; verdict: "grounded" | "partial" | "ungrounded"; issues: string[] };
};

function queryVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants = new Set<string>();
  if (trimmed) variants.add(trimmed);

  // Keep the natural-language question for embeddings, then add a compact
  // lexical view. This helps when the source uses terminology that the user
  // did not use in the exact same sentence shape.
  const compact = rewriteQuery(trimmed)
    .replace(/\b(what|why|when|where|who|which|how|does|do|did|is|are|was|were|can|could|would)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (compact && compact !== trimmed) variants.add(compact);

  // Questions with a contrast or conjunction often contain two independent
  // retrieval intents. Searching each clause separately improves recall for
  // cross-document answers without requiring an extra model call.
  for (const clause of trimmed.split(/\s+(?:and|versus|vs\.?|compared with|compare)\s+/i)) {
    const value = rewriteQuery(clause).trim();
    if (value.length >= 12 && value !== trimmed) variants.add(value);
  }
  return [...variants].slice(0, 4);
}

function mergeRetrievedResults(batches: RetrievedChunk[][], limit: number): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk & { appearances: number; bestRank: number }>();
  batches.forEach((batch) => batch.forEach((item, rank) => {
    const existing = merged.get(item.chunkId);
    if (!existing) {
      merged.set(item.chunkId, { ...item, appearances: 1, bestRank: rank });
      return;
    }
    existing.appearances += 1;
    existing.bestRank = Math.min(existing.bestRank, rank);
    existing.final = Math.max(existing.final, item.final) + Math.min(0.08, (existing.appearances - 1) * 0.025);
    existing.semantic = Math.max(existing.semantic, item.semantic);
    existing.lexical = Math.max(existing.lexical, item.lexical);
    existing.fused = Math.max(existing.fused, item.fused);
    existing.methods = [...new Set([...existing.methods, ...item.methods, "multi-query"])]
  }));

  const ranked = [...merged.values()].sort((a, b) => {
    const scoreA = a.final + Math.min(0.1, a.appearances * 0.02) - Math.min(0.04, a.bestRank * 0.001);
    const scoreB = b.final + Math.min(0.1, b.appearances * 0.02) - Math.min(0.04, b.bestRank * 0.001);
    return scoreB - scoreA;
  });

  // Prefer evidence diversity. Keep the strongest passages, but avoid using
  // every slot for one source/section when another source is also relevant.
  const selected: typeof ranked = [];
  const deferred: typeof ranked = [];
  const seenSections = new Set<string>();
  for (const item of ranked) {
    const section = `${item.sourceId}:${item.headingPath.join("/")}`;
    if (seenSections.has(section) && selected.length < Math.min(limit, ranked.length)) deferred.push(item);
    else {
      selected.push(item);
      seenSections.add(section);
    }
    if (selected.length >= limit) break;
  }
  for (const item of deferred) {
    if (selected.length >= limit) break;
    selected.push(item);
  }
  return selected.slice(0, limit).map(({ appearances: _appearances, bestRank: _bestRank, ...item }) => item);
}

function chunkTextContent(chunk: unknown): string {
  const content = (chunk as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text ?? "")).join("");
  }
  return "";
}

function bm25Scores(queryTokens: string[], docs: string[][]): number[] {
  const k1 = 1.2;
  const b = 0.75;
  const N = Math.max(1, docs.length);
  const avgLen = docs.reduce((s, t) => s + t.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const toks of docs) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  return docs.map((toks) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const n = df.get(q) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgLen)));
    }
    return score;
  });
}

function orderByScore(scores: number[]): number[] {
  return scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
}

function reciprocalRankFusion(ranks: number[][], k = 60): number[] {
  const fused = new Array<number>(ranks[0]?.length || 0).fill(0);
  for (const rank of ranks) {
    rank.forEach((chunkIdx, position) => {
      fused[chunkIdx] += 1 / (k + position + 1);
    });
  }
  return fused;
}

// Query-time embedding drift: the partition was built with a different
// embedding model than the current settings. Semantic scores silently become
// 0 or garbage — rebuild the partition from the relational library (no
// re-parse) once per notebook; lexical retrieval still serves this query.
const driftReindexed = new Set<string>();
async function handleEmbeddingDrift(notebookId: string, indexModel: string): Promise<void> {
  if (driftReindexed.has(notebookId)) return;
  driftReindexed.add(notebookId);
  console.warn(`[notebook] embedding model changed since indexing (index: ${indexModel}) — rebuilding vectors from library.`);
  try {
    const { reindexSessionFromLibrary } = await import("./notebook-jobs.js");
    await reindexSessionFromLibrary(notebookId);
  } catch (error) {
    console.warn("[notebook] drift reindex failed:", error instanceof Error ? error.message : error);
    driftReindexed.delete(notebookId);
  }
}

/** One consistent library+vector read per ask. Hybrid retrieval, the agent's
 *  search tools and the fallback pipeline all share it instead of each
 *  re-parsing the store. Stale only if an ingestion job finishes mid-ask. */
export type NotebookRetrievalSnapshot = { lib: SessionLibrary; partition: VectorPartition };

export async function loadRetrievalSnapshot(notebookId: string): Promise<NotebookRetrievalSnapshot> {
  const root = notebookSessionDir(notebookId);
  const [lib, partition] = await Promise.all([loadLibrary(root, notebookId), loadVectors(root, notebookId)]);
  return { lib, partition };
}

export async function hybridRetrieve(
  notebookId: string,
  query: string,
  topK = 8,
  fileIds?: string[],
  snapshot?: NotebookRetrievalSnapshot
): Promise<{ results: RetrievedChunk[]; embeddingModel: string; dims: number; embeddingModelMismatch?: boolean }> {
  const root = notebookSessionDir(notebookId);
  const lib = snapshot?.lib ?? await loadLibrary(root, notebookId);
  const scope = fileIds?.length ? new Set(fileIds) : null;
  const corpus = lib.order
    .map((id) => lib.chunks[id])
    .filter((c) => c && (!scope || scope.has(c.fileId)));
  const partition = snapshot?.partition ?? await loadVectors(root, notebookId);
  if (!corpus.length) return { results: [], embeddingModel: partition.embeddingModel || "none", dims: partition.dims || 0 };

  const { vector: queryVec, modelMismatch } = await embedQuery(query, partition.embeddingModel || undefined);
  if (modelMismatch) void handleEmbeddingDrift(notebookId, partition.embeddingModel || "none");
  const semantic = corpus.map((c) => {
    const vec = partition.vectors[c.id];
    return vec && vec.length === queryVec.length ? cosine(queryVec, vec) : 0;
  });
  const queryTokens = notebookTokens(query);
  const docTokens = corpus.map((c) => notebookTokens(`${c.text} ${c.headingPath.join(" ")}`));
  const lexical = bm25Scores(queryTokens, docTokens);
  const maxLex = Math.max(1, ...lexical);

  // Graph expansion over heading-path + key-term postings.
  const queryEntities = new Set(notebookTokens(query));
  const postings = new Map<string, number[]>();
  corpus.forEach((c, i) => {
    const section = lib.sections[c.sectionId];
    const keys = new Set<string>();
    for (const h of c.headingPath) for (const t of notebookTokens(h)) keys.add(t);
    for (const t of section?.keyTerms || []) keys.add(t.toLowerCase());
    for (const k of keys) {
      if (!postings.has(k)) postings.set(k, []);
      postings.get(k)!.push(i);
    }
  });
  const seed = new Set<number>();
  for (const q of queryEntities) {
    for (const i of postings.get(q) || []) seed.add(i);
  }
  const expanded = new Set(seed);
  const seedKeys = new Set<string>();
  for (const i of seed) {
    const c = corpus[i];
    for (const h of c.headingPath) for (const t of notebookTokens(h)) seedKeys.add(t);
  }
  corpus.forEach((c, i) => {
    if (expanded.has(i)) return;
    const keys = new Set<string>();
    for (const h of c.headingPath) for (const t of notebookTokens(h)) keys.add(t);
    for (const k of keys) {
      if (seedKeys.has(k)) {
        expanded.add(i);
        break;
      }
    }
  });
  const graphBoost = corpus.map((_, i) => (seed.has(i) ? 0.25 : expanded.has(i) ? 0.12 : 0));
  const fused = reciprocalRankFusion([orderByScore(semantic), orderByScore(lexical), orderByScore(graphBoost)]);

  const querySet = new Set(queryTokens);
  const ranked: RetrievedChunk[] = corpus.map((c, i) => {
    const section = lib.sections[c.sectionId];
    const chunkSet = new Set(docTokens[i]);
    let overlap = 0;
    for (const t of querySet) if (chunkSet.has(t)) overlap++;
    const coverage = querySet.size ? overlap / querySet.size : 0;
    let entityOverlap = 0;
    for (const h of c.headingPath) {
      for (const t of notebookTokens(h)) {
        if (queryEntities.has(t)) {
          entityOverlap++;
          break;
        }
      }
    }
    const final = 0.55 * semantic[i] + 0.25 * (lexical[i] / maxLex) + 0.12 * coverage + 0.08 * Math.min(1, entityOverlap / 2) + graphBoost[i];
    const methods: string[] = [];
    if (semantic[i] > 0.05) methods.push("semantic");
    if (lexical[i] > 0.5) methods.push("lexical");
    if (graphBoost[i] > 0) methods.push("graph");
    if (!methods.length) methods.push("fused");
    const doc = lib.documents[c.fileId];
    return {
      chunkId: c.id,
      sourceId: c.fileId,
      sourceName: doc?.filename || c.fileId,
      headingPath: c.headingPath,
      text: c.text,
      summary: section?.summary,
      semantic: semantic[i],
      lexical: lexical[i],
      graphBoost: graphBoost[i],
      fused: fused[i],
      final,
      methods,
    };
  });
  ranked.sort((a, b) => b.final - a.final);
  return { results: ranked.slice(0, Math.max(1, topK)), embeddingModel: partition.embeddingModel || "none", dims: partition.dims || 0, embeddingModelMismatch: modelMismatch };
}

// Generative outputs (quiz, flashcards, mindmap, summary, study plan, full
// overview) need broad coverage, not a top-k slice. These requests must pull
// representative passages from every section instead of the 8 best hits.
const GENERATIVE_PATTERN = /\b(quiz|quizzes|flashcards?|fiches|mind ?map|carte mentale|study plan|revision plan|r[eé]sum[eé]|summary of (all|everything|the)|overview of (all|everything|the)|all (topics|sections|concepts)|cheat sheet|key takeaways)\b/i;

export function isGenerativeOutputRequest(text: string): boolean {
  return GENERATIVE_PATTERN.test(text || "") || isSessionWideAsk(text || "");
}

// ---- Flag-gated: LLM router (one small structured call) ----

async function llmRoute(
  question: string,
  summary: { files: string[]; headings: string[]; terms: string[] },
  history: Array<{ role: string; text: string }>,
  options: NotebookRagOptions = {}
): Promise<{ action: RouteAction; query: string } | null> {
  const providers = await listProviders().catch(() => []);
  const provider = options.chatProviderId ? providers.find((item) => item.id === options.chatProviderId) : providers[0];
  const modelName = options.chatModel || provider?.models[0];
  if (!provider || !modelName) return null;
  try {
    const { createChatModel } = await import("./providers.js");
    const llm = await createChatModel(provider, modelName);
    const res = await llm.invoke([
      {
        role: "system",
        content: `You are the intent planner for an educational notebook agent. Reply with JSON only: {"action": "conversational_reply" | "retrieve" | "outside_files", "query": "compact search query"}. Use conversational_reply for greetings, thanks, or casual conversation. Use retrieve for any request that could be answered by the uploaded sources, including broad requests such as "what is this about", "summarize this", "teach me", "explain the main ideas", and follow-up questions that rely on chat history. Use outside_files only when the request is clearly unrelated to the notebook. When uncertain, always choose retrieve.`,
      } as never,
      {
        role: "user",
        content: `Files: ${summary.files.join(", ") || "(none)"}\nTop headings: ${summary.headings.slice(0, 15).join(" | ")}\nKey terms: ${summary.terms.slice(0, 25).join(", ")}\nRecent turns: ${history.slice(-6).map((m) => `${m.role}: ${m.text.slice(0, 200)}`).join("\n")}\n\nMessage: ${question}`,
      } as never,
    ]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { action?: string; query?: string };
    if (parsed.action === "conversational_reply" || parsed.action === "retrieve" || parsed.action === "outside_files") {
      return { action: parsed.action, query: typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : rewriteQuery(question) };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Flag-gated: LLM cross-encoder rerank (single scoring call) ----

async function llmRerankScores(question: string, candidates: RetrievedChunk[], config?: NotebookRagOptions["rerank"]): Promise<number[] | null> {
  const providers = await listProviders().catch(() => []);
  const provider = config?.providerId ? providers.find((item) => item.id === config.providerId) : providers[0];
  const modelName = config?.model || provider?.models[0];
  if (!provider || !modelName || !candidates.length) return null;
  try {
    const { createChatModel } = await import("./providers.js");
    const llm = await createChatModel(provider, modelName);
    const res = await llm.invoke([
      {
        role: "system",
        content: `Score how well each passage answers the question, 0-10. Reply with JSON only: {"0": 7, "1": 2, ...} with one key per passage index.`,
      } as never,
      {
        role: "user",
        content: `Question: ${question}\n\n${candidates.map((c, i) => `--- ${i} ---\n${c.text.slice(0, 800)}`).join("\n\n")}`,
      } as never,
    ]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, number>;
    return candidates.map((_, i) => {
      const v = Number(parsed[String(i)]);
      return Number.isFinite(v) ? Math.max(0, Math.min(10, v)) / 10 : 0.5;
    });
  } catch {
    return null;
  }
}

// ---- Generation ----

const LANGUAGE_POLICY = `Answer in the same language as the user's latest question. French questions receive French answers, English questions receive English answers, Arabic questions receive Arabic answers, and mixed-language questions use their dominant language. Do not translate unless asked. Keep citation markers such as [S1] unchanged.`;

function analystSystem(): string {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `You are a precise research analyst. Answer ONLY from the SOURCES below — never from your own knowledge. Today is ${today}. Anchor every relative time expression to it. ${LANGUAGE_POLICY} Rules:
- Every factual claim must cite its source as [S1], [S2], etc.
- If the sources do not contain the answer, say so plainly and state what IS in them.
- Be direct and concise. No preamble, no tutoring tone.
- When the sources contain numbers, trends, comparisons, shares, processes, structures, timelines, or plans, include one useful visual in a fenced mermaid block: use xychart-beta for numeric series, pie for shares, and flowchart TD or timeline for processes and histories. Keep every value source-grounded and cite the surrounding claims.
- End with a "Sources" line listing [S1] heading, [S2] heading, ...`;
}

async function generateAnswer(
  system: string,
  user: string,
  options: NotebookRagOptions,
  onToken?: (delta: string) => void
): Promise<{ text: string; fallbackModel: boolean }> {
  if (options.generate) return { text: await options.generate(system, user), fallbackModel: false };
  const providers = await listProviders();
  const primary = options.chatProviderId ? providers.find((p) => p.id === options.chatProviderId) : providers[0];
  if (!primary) throw new Error("Configure a chat provider first (Providers button, top right).");
  const modelName = options.chatModel || primary.models[0];
  if (!modelName) throw new Error("No chat model selected.");
  const attempts: Array<{ provider: (typeof providers)[number]; model: string; fallback: boolean }> = [
    { provider: primary, model: modelName, fallback: false },
  ];
  // Keyless remote providers would only fail with a guaranteed 401 and mask
  // the primary attempt's real error — local Ollama is the keyless exception.
  const fallback = providers.find((p) => p.id !== primary.id && p.models.length && (p.apiKey || p.provider === "ollama"));
  if (fallback) attempts.push({ provider: fallback, model: fallback.models[0], fallback: true });
  let lastError: unknown = null;
  let firstError: unknown = null;
  for (const attempt of attempts) {
    try {
      const llm = await createChatModel(attempt.provider, attempt.model);
      const messages = [
        { role: "system", content: system } as never,
        { role: "user", content: user } as never,
      ];
      if (onToken) {
        let text = "";
        let streamCompleted = true;
        try {
          const stream = await llm.stream(messages);
          for await (const chunk of stream) {
            const delta = chunkTextContent(chunk);
            if (delta) {
              text += delta;
              onToken(delta);
            }
          }
        } catch {
          // The streaming lane failed mid-run — providers surface overload and
          // rate limits either as an SSE error payload inside HTTP 200 or as a
          // thrown APIError. Never return a partial/truncated stream: fall
          // through to the non-streaming retry of the same model below.
          streamCompleted = false;
        }
        if (streamCompleted && text.trim()) return { text, fallbackModel: attempt.fallback };
      }
      // A stream that ends without content (silent SSE error payload or a
      // thrown error) must not become an empty or failed answer when the same
      // model still serves non-streaming requests. Retry it, then let the
      // loop try the next provider.
      const res = await llm.invoke(messages);
      const text = chunkTextContent(res);
      if (!text.trim()) throw new Error(`"${attempt.model}" returned an empty response (provider may be overloaded or rate-limited) — try again or switch models.`);
      return { text, fallbackModel: attempt.fallback };
    } catch (error) {
      if (!firstError) firstError = error;
      lastError = error;
      // The failed attempt may have already streamed partial deltas — reset
      // so the next attempt's stream replaces the buffer instead of appending.
      options.onStreamReset?.();
    }
  }
  // When the fallback provider also failed, report the primary attempt's
  // error first — it is the one the user's selected model produced.
  if (firstError && lastError !== firstError) {
    const first = firstError instanceof Error ? firstError.message : String(firstError);
    const last = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${first} — fallback provider also failed: ${last}`);
  }
  throw lastError instanceof Error ? lastError : new Error("Generation failed.");
}

function refusalText(scoped: boolean): string {
  return scoped
    ? "That doesn't appear to be covered in the selected files. Try widening the file scope or rephrasing — I'll only answer from what's actually in your documents."
    : "That doesn't appear to be covered in the uploaded files. I'll only answer from what's actually in your documents — upload the relevant file or rephrase and I'll try again.";
}

type NotebookAgentRun = {
  answer: string;
  sources: NotebookSourceCitation[];
  retrieval: Array<{ chunkId: string; sourceName: string; score: number; methods: string[] }>;
  fallbackModel: boolean;
  embeddingModel: string;
  dims: number;
  steps: NotebookAgentStep[];
  evaluation?: { citationCoverage: number; verdict: "grounded" | "partial" | "ungrounded"; issues: string[] };
  /** True when agent tokens already reached the renderer (fallback must reset). */
  streamedTokens?: boolean;
};

/**
 * Agentic notebook RAG. LangGraph orchestrates the run state, deepagents manages the
 * iterative model/tool loop. The model plans multi-hop retrieval, searches sources across
 * multiple queries, inspects document outlines, reads passages in depth, self-evaluates
 * evidence completeness, and can save takeaways to Studio notes.
 */
async function runNotebookAgent(
  notebookId: string,
  question: string,
  history: Array<{ role: string; text: string }>,
  options: NotebookRagOptions,
  summary: { files: string[]; headings: string[]; terms: string[] },
  snapshot: NotebookRetrievalSnapshot
): Promise<NotebookAgentRun | null> {
  if (options.generate) return null; // deterministic pipeline tests and callers can inject their own generator
  const providers = await listProviders().catch(() => []);
  const provider = options.chatProviderId ? providers.find((item) => item.id === options.chatProviderId) : providers[0];
  const modelName = options.chatModel || provider?.models[0];
  if (!provider || !modelName) return null;

  const runId = options.runId || `nbchat-${notebookId}`;
  const isCancelled = options.isCancelled || (() => false);
  // agent-service is imported lazily: it pulls Electron-only modules that
  // break plain-node unit tests when imported statically.
  let CancelledError: new () => Error = Error;
  try {
    CancelledError = (await import("./agent-service.js")).RunCancelledError;
  } catch { /* fallback throws plain Error; main still detects via runId flag */ }
  const throwIfCancelled = () => {
    if (isCancelled()) throw new CancelledError();
  };

  // Run-level citation registry: every retrieved chunk keeps ONE global [Sn]
  // number for the whole run, assigned in first-seen order. The previous
  // per-call numbering plus a score-resorted renumbering of the final list
  // made "[S3]" in the answer point at a different passage in the displayed
  // citation list.
  const citationRegistry: RetrievedChunk[] = [];
  const citationIndexByChunk = new Map<string, number>();
  const MAX_REGISTERED_CITATIONS = 30;
  const registerCitation = (item: RetrievedChunk): number | null => {
    const existing = citationIndexByChunk.get(item.chunkId);
    if (existing !== undefined) return existing;
    if (citationRegistry.length >= MAX_REGISTERED_CITATIONS) return null;
    citationIndexByChunk.set(item.chunkId, citationRegistry.length + 1);
    citationRegistry.push(item);
    return citationRegistry.length;
  };
  const executedSteps: NotebookAgentStep[] = [];
  let embeddingModel = "";
  let dims = 0;
  let streamedTokens = false;
  const trackedOnToken = (delta: string) => {
    streamedTokens = true;
    options.onToken?.(delta);
  };

  options.onStatus?.("Planning research & analyzing question…");

  const searchTool = tool(async ({ query, topK, fileIds }) => {
    throwIfCancelled();
    const cleanQuery = query.trim();
    options.onStatus?.(`Searching sources for "${cleanQuery}"…`);
    const found = await hybridRetrieve(notebookId, cleanQuery, Math.min(Math.max(topK || 8, 4), 24), fileIds?.length ? fileIds : options.fileIds, snapshot);
    embeddingModel = found.embeddingModel;
    dims = found.dims;
    const uniqueSources = [...new Set(found.results.map((r) => r.sourceName))];
    const detail = found.results.length > 0
      ? `Retrieved ${found.results.length} passage(s) from ${uniqueSources.join(", ")}`
      : "No matching passages found";
    const step: NotebookAgentStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: "search_notebook_sources",
      title: `Search: "${cleanQuery}"`,
      detail,
      status: "completed",
    };
    executedSteps.push(step);
    options.onStep?.(step);
    options.onTool?.("search_notebook_sources", `Search: "${cleanQuery}"`, detail);
    return JSON.stringify(found.results.map((item) => {
      const citationIndex = registerCitation(item);
      return {
        // Global, run-stable citation number — the same chunk keeps the same
        // [Sn] across every search call in this run.
        citation: citationIndex != null ? `[S${citationIndex}]` : "[unregistered]",
        chunkId: item.chunkId,
        source: item.sourceName,
        heading: item.headingPath.join(" › "),
        score: Number(item.final.toFixed(4)),
        text: item.text.slice(0, 5000),
      };
    }));
  }, {
    name: "search_notebook_sources",
    description: "Search uploaded notebook sources with hybrid semantic + lexical retrieval. Break complex questions into focused sub-queries and call this tool multiple times as needed.",
    schema: z.object({ query: z.string().min(1), topK: z.number().int().min(4).max(24).optional(), fileIds: z.array(z.string()).optional() }),
  });

  const outlineTool = tool(async () => {
    throwIfCancelled();
    options.onStatus?.("Inspecting notebook structure & table of contents…");
    const outline = await sessionOutline(notebookSessionDir(notebookId), notebookId);
    const overview = await hybridRetrieve(notebookId, "main topics overview concepts themes", 24, options.fileIds, snapshot);
    embeddingModel = overview.embeddingModel;
    dims = overview.dims;
    const detail = `${outline.length} file(s), ${outline.reduce((sum, d) => sum + d.sectionCount, 0)} sections`;
    const step: NotebookAgentStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: "inspect_notebook_outline",
      title: "Inspect notebook outline",
      detail,
      status: "completed",
    };
    executedSteps.push(step);
    options.onStep?.(step);
    options.onTool?.("inspect_notebook_outline", "Inspect notebook outline", detail);
    return JSON.stringify({
      files: outline.map((doc) => ({ filename: doc.filename, sections: doc.sectionCount, chunks: doc.chunkCount, headings: doc.headings.slice(0, 20) })),
      representativePassages: overview.results.slice(0, 24).map((item) => ({ source: item.sourceName, heading: item.headingPath.join(" › "), text: item.text.slice(0, 1800) })),
    });
  }, {
    name: "inspect_notebook_outline",
    description: "Inspect the notebook's files, headings, section structure, and representative passages. Use for broad questions like what the notebook is about, summaries, study plans, or finding where topics live.",
    schema: z.object({}),
  });

  const passageTool = tool(async ({ chunkId }) => {
    throwIfCancelled();
    options.onStatus?.("Reading source passage with surrounding context…");
    const passage = await getChunkPassage(notebookId, chunkId);
    if (!passage) return "Passage not found. Search again with search_notebook_sources.";
    const stepTitle = `Read passage: ${passage.headingPath.join(" › ") || passage.sourceName}`;
    const detail = `${passage.sourceName} (${passage.text.length} chars)`;
    const step: NotebookAgentStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: "read_notebook_passage",
      title: stepTitle,
      detail,
      status: "completed",
    };
    executedSteps.push(step);
    options.onStep?.(step);
    options.onTool?.("read_notebook_passage", stepTitle, detail);
    return JSON.stringify(passage);
  }, {
    name: "read_notebook_passage",
    description: "Read a specific retrieved passage with its neighboring context and section summary. Use when a retrieved chunk needs deeper examination.",
    schema: z.object({ chunkId: z.string().min(1) }),
  });

  const evaluateEvidenceTool = tool(async ({ question: q, needed_information, findings_so_far, sufficiency, next_search_query }) => {
    throwIfCancelled();
    options.onStatus?.(`Evaluating evidence: ${sufficiency}…`);
    const step: NotebookAgentStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: "evaluate_evidence",
      title: `Evidence check: ${sufficiency}`,
      detail: findings_so_far ? findings_so_far.slice(0, 200) : undefined,
      status: "completed",
    };
    executedSteps.push(step);
    options.onStep?.(step);
    options.onTool?.("evaluate_evidence", `Evidence check: ${sufficiency}`, findings_so_far);
    return JSON.stringify({
      status: "recorded",
      sufficiency,
      advice: sufficiency === "sufficient"
        ? "Evidence is sufficient. Synthesize your final grounded response, citing every factual claim with [Sn] markers."
        : `Evidence is ${sufficiency}. Run another search_notebook_sources with query: "${next_search_query || q}" to fill the gap before finalizing.`,
    });
  }, {
    name: "evaluate_evidence",
    description: "Self-RAG evaluation: call this tool after retrieving to evaluate if current evidence is sufficient to answer the question, or if another targeted search query is needed.",
    schema: z.object({
      question: z.string().describe("The core question or topic being investigated"),
      needed_information: z.string().describe("Specific facts or points needed to answer fully"),
      findings_so_far: z.string().describe("Summary of what has been found so far in the passages"),
      sufficiency: z.enum(["sufficient", "insufficient", "partially_sufficient"]).describe("Whether current evidence is sufficient"),
      next_search_query: z.string().optional().describe("If insufficient or partial, the refined search query to execute next"),
    }),
  });

  const saveNoteTool = tool(async ({ title, content }) => {
    throwIfCancelled();
    options.onStatus?.(`Saving studio note: "${title}"…`);
    const note = await saveNotebookNote({
      notebookId,
      title: title.trim(),
      content: content.trim(),
      citations: toCitations(citationRegistry.slice(0, 10)),
    });
    const step: NotebookAgentStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: "save_note_to_studio",
      title: `Saved studio note: "${title}"`,
      detail: `${content.length} chars`,
      status: "completed",
    };
    executedSteps.push(step);
    options.onStep?.(step);
    options.onTool?.("save_note_to_studio", `Saved note: "${title}"`, step.detail);
    return JSON.stringify({ status: "saved", noteId: note.id, title: note.title });
  }, {
    name: "save_note_to_studio",
    description: "Save a key takeaway, study note, flashcard set, or summary directly to the user's Studio notes.",
    schema: z.object({
      title: z.string().min(1).describe("Short title of the note"),
      content: z.string().min(1).describe("Markdown content of the note"),
    }),
  });

  // Workspace: the notebook's documents folder. Deliverables the agent builds
  // (slides, reports, spreadsheets) land here; the source store
  // (library/vectors/sources) lives next to it and is never exposed to file
  // tools — only the retrieval tools above can read it.
  const { docsDir } = await import("./notebook-documents.js");
  const workspace = docsDir(notebookId);
  await fs.mkdir(workspace, { recursive: true });
  const runStartMs = Date.now();

  const fileBackend: any = new FilesystemBackend({ rootDir: workspace, virtualMode: true });
  fileBackend.id = `notebook-${notebookId}`;
  fileBackend.execute = (command: string) => executeCommand(workspace, command, { runId });

  // Shared skills — the same global library Home and Code use (the user's own
  // uploaded skills) plus bundled system skills, scoped to skills enabled for
  // notebook mode.
  let backend: any = fileBackend;
  let skillNote = "";
  let skillFilesTool: any = null;
  let skillDirs: string[] = [];
  try {
    const skillsConfig = await getSkillsConfig().catch(() => ({ enabled: true }));
    if (skillsConfig.enabled !== false) {
      const { GLOBAL_SKILLS_ROUTE, SKILL_SOURCE_PRIORITY, SYSTEM_SKILLS_ROUTE, buildSkillMounts, createSkillFilesTool, globalSkillsDir, listSkills, listSystemSkills, recommendSkills, skillAppliesToMode, skillDirVirtualPath, skillVirtualPath, systemSkillsDir } = await import("./skills-service.js");
      const fullCatalog = [...(await listSkills(workspace).catch(() => [])), ...(await listSystemSkills().catch(() => []))];
      const catalog = fullCatalog.filter((s) => skillAppliesToMode(s, "notebook"));
      skillFilesTool = createSkillFilesTool(catalog, workspace);
      skillDirs = catalog
        .slice()
        .sort((a, b) => SKILL_SOURCE_PRIORITY[b.source] - SKILL_SOURCE_PRIORITY[a.source])
        .map(skillDirVirtualPath);
      const recs = recommendSkills(catalog, question, 3);
      const offLimits = fullCatalog.filter((s) => !skillAppliesToMode(s, "notebook"));
      const offUser = offLimits.filter((s) => s.source !== "system");
      const offSystemCount = offLimits.length - offUser.length;
      if (recs.length) {
        const counts = (["project", "global", "system"] as const)
          .map((source) => `${catalog.filter((s) => s.source === source).length} ${source}`)
          .join(", ");
        skillNote = `[System Note: ${catalog.length} skill(s) installed for notebook mode (${counts}). Most relevant to your task:\n${recs.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""} → read ${skillVirtualPath(s)} first`).join("\n")}\nIf a skill covers your task, read its SKILL.md BEFORE acting. This read is free.]`;
      }
      if (offUser.length) {
        skillNote += `${skillNote ? "\n" : ""}[Skills NOT available in notebook mode — do NOT read, follow, or mention them: ${offUser.map((s) => s.name).join(", ")}.]`;
      }
      if (offSystemCount > 0) {
        skillNote += `${skillNote ? "\n" : ""}[${offSystemCount} system skill(s) are disabled in notebook mode — only use skills listed above.]`;
      }
      const skillsBackend = new FilesystemBackend({ rootDir: globalSkillsDir(), virtualMode: true });
      let systemBackend: any = null;
      try {
        systemBackend = new FilesystemBackend({ rootDir: systemSkillsDir(), virtualMode: true });
        const refuseSystemWrite = (action: string) => async () => {
          throw new Error(`System skills are read-only: ${action} is disabled.`);
        };
        systemBackend.write = refuseSystemWrite("write_file");
        systemBackend.edit = refuseSystemWrite("edit_file");
        systemBackend.delete = refuseSystemWrite("delete");
        systemBackend.execute = refuseSystemWrite("execute");
      } catch { /* no system skills shipped */ }
      const mounts = buildSkillMounts(skillsBackend, systemBackend);
      backend = new CompositeBackend(fileBackend, mounts);
    }
  } catch { /* skills are advisory — never fail a run */ }

  try {
    options.onStatus?.("Preparing a grounded answer…");
    const llm = await createChatModel(provider, modelName);
    const agent = await createDeepAgent({
      model: llm,
      backend,
      tools: [searchTool, outlineTool, passageTool, evaluateEvidenceTool, saveNoteTool, ...(skillFilesTool ? [skillFilesTool] : [])],
      skills: skillDirs,
      systemPrompt: `You are an advanced Agentic RAG research assistant for an educational NotebookLM-style workspace.
Your primary directive is grounded, faithful synthesis over uploaded course materials.

Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (${new Date().toISOString().slice(0, 10)}). Anchor every relative time expression to it ("last decade", "this year", "recent").

Language: ${LANGUAGE_POLICY}

Agentic RAG Guidelines:
1. QUERY PLANNING: For complex, comparative ("Compare X and Y"), cross-document, or multi-topic questions, decompose the question and call search_notebook_sources with multiple distinct sub-queries. Do not settle for a single lookup if more context is needed.
2. ITERATIVE RETRIEVAL:
   - Call search_notebook_sources for factual search across sources.
   - Call inspect_notebook_outline when asked broad questions ("what is this notebook about?", summaries, study guides, topic overviews) or to discover which files cover what.
   - Call read_notebook_passage when a retrieved chunk needs deeper context.
3. SELF-REFLECTION (Self-RAG): Call evaluate_evidence to verify whether you have sufficient evidence to answer faithfully. If evidence is lacking, reformulate your query and search again.
4. GROUNDEDNESS & CITATIONS:
   - Every factual claim MUST include an inline citation marker matching the retrieved chunks, e.g. [S1], [S2].
   - If the sources do not contain the answer, say so clearly and state what is missing. Never invent facts outside the uploaded documents.
5. STUDIO NOTES: When the user asks for key takeaways, flashcards, study notes, or summaries to save, use save_note_to_studio in addition to your conversational response.
6. DELIVERABLES: If the user asks for a file (.docx, .pptx, .xlsx, .pdf), follow any relevant skill: write a generator script with write_file, run it with execute, verify with ls, and delete the throwaway script.
7. Return clean Markdown without exposing internal JSON tool arguments.
8. SKILLS: Skills listed in the System Note below include exact paths — read the relevant SKILL.md directly via its given path. Never browse skill folders (ls/glob of .nexus/skills, /global-skills, /system-skills) to discover skills.

${skillNote ? `\n${skillNote}` : ""}
Notebook files: ${summary.files.join(", ") || "(none)"}
Notebook headings: ${summary.headings.slice(0, 30).join(" | ") || "(none)"}
Notebook terms: ${summary.terms.slice(0, 40).join(", ") || "(none)"}${options.instructions ? `\nNotebook-specific instructions:\n${options.instructions}` : ""}`,
    });

    const prior = history.slice(-10).map((turn) => turn.role === "assistant" ? new AIMessage(turn.text.slice(-4000)) : new HumanMessage(turn.text.slice(-4000)));
    const initial = [...prior, new HumanMessage(question)];
    const AgentState = Annotation.Root({
      messages: Annotation<any[]>({ reducer: (_, value) => value, default: () => [] }),
      answer: Annotation<string>({ reducer: (_, value) => value, default: () => "" }),
    });

    const graph = new StateGraph(AgentState as any)
      .addNode("notebook_agent", async (state: any) => {
        throwIfCancelled();
        const stream = await (agent as any).stream(
          { messages: state.messages },
          { streamMode: ["values", "updates", "messages"], recursionLimit: 60 }
        );
        let messages: any[] = state.messages;
        let lastToolSig: string | null = null;
        let toolRepeatCount = 0;

        for await (const item of stream as AsyncIterable<any>) {
          throwIfCancelled();
          const [mode, payload] = Array.isArray(item) ? item : ["values", item];
          if (mode === "values" && Array.isArray(payload?.messages)) {
            messages = payload.messages;
            continue;
          }
          if (mode === "updates" && payload && typeof payload === "object") {
            for (const delta of Object.values<any>(payload)) {
              for (const message of delta?.messages ?? []) {
                if (Array.isArray(message?.tool_calls)) {
                  for (const call of message.tool_calls) {
                    const name = call?.name || "tool";
                    const sig = `${name}:${JSON.stringify(call?.args ?? {}).slice(0, 300)}`;
                    if (sig === lastToolSig) {
                      toolRepeatCount++;
                    } else {
                      lastToolSig = sig;
                      toolRepeatCount = 1;
                    }
                    if (toolRepeatCount >= 4) {
                      throw new Error(`DoomLoop: ${name} repeated without progress`);
                    }
                    const query = call.args?.query ? `"${call.args.query}"` : call.args?.title ? `"${call.args.title}"` : call.args?.path ? `"${call.args.path}"` : call.args?.file_path ? `"${call.args.file_path}"` : call.args?.command ? `"${call.args.command}"` : "";
                    const desc = query ? `${name} · ${query}` : name;
                    options.onTool?.(name, desc, JSON.stringify(call.args ?? {}));
                  }
                }
              }
            }
            continue;
          }
          if (mode === "messages") {
            const [chunk] = Array.isArray(payload) ? payload : [payload];
            const type = (chunk as any)?._getType?.() || (chunk as any)?.type || (chunk as any)?.constructor?.name;
            const isAi = type === "ai" || type === "AIMessageChunk" || type === "AIMessage";
            const hasToolCalls = Boolean((chunk as any)?.tool_call_chunks?.length || (chunk as any)?.tool_calls?.length);
            if (isAi && !hasToolCalls) {
              const delta = chunkTextContent(chunk);
              if (delta) trackedOnToken(delta);
            }
          }
        }
        const aiMessages = messages.filter((m: any) => {
          const type = m?._getType?.() || m?.type || m?.constructor?.name;
          return (type === "ai" || type === "AIMessage" || m?.role === "assistant") && !m?.tool_call_id;
        });
        const lastAi = aiMessages[aiMessages.length - 1];
        const hasPendingToolCalls = Boolean(Array.isArray(lastAi?.tool_calls) && lastAi.tool_calls.length > 0 && !chunkTextContent(lastAi).trim());
        const finalAnswer = lastAi && !hasPendingToolCalls ? chunkTextContent(lastAi).trim() : "";
        return { messages, answer: finalAnswer };
      })
      .addEdge(START, "notebook_agent")
      .addEdge("notebook_agent", END)
      .compile();

    const result = await graph.invoke({ messages: initial });
    const answer = String((result as any).answer || "").trim();
    if (!answer) {
      if (streamedTokens) options.onStreamReset?.();
      return null;
    }

    // Final citations come straight from the registry in registration order —
    // no re-scoring, no renumbering — so every [Sn] the model cited matches
    // the passage displayed at position n. Make sure the list is long enough
    // to include the highest marker the answer actually used.
    const citedMarkerNums = (answer.match(/\[S(\d+)\]/g) || []).map((m) => parseInt(m.slice(2, -1), 10)).filter((n) => Number.isFinite(n));
    const maxCited = citedMarkerNums.length ? Math.max(...citedMarkerNums) : 0;
    const baseKeep = isGenerativeOutputRequest(question) ? 24 : 12;
    const keep = Math.min(citationRegistry.length, Math.max(baseKeep, Math.min(maxCited, citationRegistry.length)));
    const ranked = citationRegistry.slice(0, keep);
    const sources = toCitations(ranked);
    await registerAgentDeliverables(notebookId, workspace, runStartMs, question, answer, sources);

    // Structural citation-coverage evaluation: every marker must resolve to a
    // registered chunk, and the score is the share of prose sentences carrying
    // one. Purely structural — no extra model call.
    const evaluation = sources.length > 0 ? evaluateCitationCoverage(answer, citationRegistry.length) : undefined;

    return {
      answer,
      sources,
      retrieval: ranked.map((item) => ({ chunkId: item.chunkId, sourceName: item.sourceName, score: Number(item.final.toFixed(4)), methods: item.methods })),
      fallbackModel: false,
      embeddingModel,
      dims,
      steps: executedSteps,
      evaluation,
      streamedTokens,
    };
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    console.warn("[notebook] agent loop unavailable; using grounded fallback:", error instanceof Error ? error.message : error);
    // The agent may already have streamed a partial answer — reset the
    // renderer's stream buffer so the fallback answer replaces it.
    if (streamedTokens) options.onStreamReset?.();
    return null;
  }
}

/**
 * Picks up deliverables the agent built in the workspace during the run
 * (verified .docx/.pptx/.pdf/.xlsx newer than the run start) and registers
 * them as notebook documents so they show up under OUTPUTS. Throwaway
 * generator scripts are removed once a deliverable exists.
 */
async function registerAgentDeliverables(
  notebookId: string,
  workspace: string,
  runStartMs: number,
  question: string,
  answer: string,
  sources: NotebookSourceCitation[]
): Promise<void> {
  try {
    const { registerNotebookDocument } = await import("./notebook-documents.js");
    const entries = await fs.readdir(workspace).catch(() => [] as string[]);
    const fresh: Array<{ name: string; size: number }> = [];
    for (const name of entries) {
      const ext = name.split(".").pop()?.toLowerCase() || "";
      if (!["docx", "pptx", "pdf", "xlsx"].includes(ext)) continue;
      const abs = path.join(workspace, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (stat && stat.isFile() && stat.size > 0 && stat.mtimeMs >= runStartMs - 60_000) {
        fresh.push({ name, size: stat.size });
      }
    }
    if (!fresh.length) return;
    // Throwaway generator scripts served their purpose — only deliverables remain.
    for (const name of entries) {
      if (!/^generate_.*\.(py|js|mjs|cjs|ts|sh|ps1)$/i.test(name) && !/^generate_doc\.py$/i.test(name)) continue;
      const abs = path.join(workspace, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (stat && stat.mtimeMs >= runStartMs - 60_000) {
        await fs.unlink(abs).catch(() => {});
      }
    }
    const title = question.trim().replace(/\s+/g, " ").slice(0, 80) || "Notebook deliverable";
    for (const file of fresh) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const format = (ext === "pptx" ? "pptx" : ext === "pdf" ? "pdf" : ext === "xlsx" ? "xlsx" : "docx") as "docx" | "pdf" | "pptx" | "xlsx";
      await registerNotebookDocument(notebookId, {
        kind: ext === "pptx" ? "slides" : "report",
        format,
        title,
        filename: file.name,
        size: file.size,
        prompt: question.slice(0, 2000),
        preview: answer.slice(0, 20000),
        citations: sources.slice(0, 24),
        sectionCount: 0,
        slideCount: 0,
        engine: "skill-agent",
      }).catch(() => {});
    }
  } catch { /* registration is best-effort */ }
}

// ---- Main pipeline ----

export async function answerNotebookQuestion(
  notebookId: string,
  question: string,
  history: Array<{ role: string; text: string }>,
  options: NotebookRagOptions = {}
): Promise<ChatResult> {
  const root = notebookSessionDir(notebookId);
  const topK = options.topK || 8;
  const summary = await sessionSummary(root, notebookId);
  const termSet = new Set(summary.termSet);
  // One store read per ask: every retrieval below (agent tools, multi-query
  // variants, session outline) reuses this snapshot.
  const snapshot = await loadRetrievalSnapshot(notebookId);

  // The normal notebook path is now a tool-using agent. Keep the explicit
  // retrieval pipeline below as a grounded compatibility fallback for tests,
  // providers without tool-call support, and transient agent failures.
  const heuristicForAgent = routeMessageHeuristic(question, termSet);
  const agentResult = await runNotebookAgent(notebookId, question, history, options, summary, snapshot);
  if (agentResult && (agentResult.sources.length > 0 || heuristicForAgent.action !== "retrieve" || isSessionWideAsk(question))) {
    return {
      answer: agentResult.answer,
      sources: agentResult.sources,
      retrieval: agentResult.retrieval,
      steps: agentResult.steps,
      evaluation: agentResult.evaluation,
      metadata: {
        routing: heuristicForAgent.action,
        topScore: agentResult.sources[0]?.score || 0,
        refused: heuristicForAgent.action === "outside_files",
        fallbackModel: agentResult.fallbackModel,
      },
      embeddingModel: agentResult.embeddingModel,
      dims: agentResult.dims,
    };
  }
  // Falling back after the agent already streamed tokens: reset the stream so
  // the deterministic answer replaces the partial one instead of appending.
  if (agentResult?.streamedTokens) options.onStreamReset?.();

  // 1. Route cheap-first.
  let action: RouteAction = "retrieve";
  let searchQuery = rewriteQuery(question) || question;
  const heuristic = routeMessageHeuristic(question, termSet);
  if (notebookFlags.llmRouter) {
    const routed = await llmRoute(question, summary, history, options);
    if (routed) {
      action = routed.action;
      searchQuery = routed.query;
    } else {
      action = heuristic.action;
      searchQuery = heuristic.query;
    }
  } else {
    action = heuristic.action;
    searchQuery = heuristic.query;
  }

  if (action === "conversational_reply") {
    const historyBlock = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`).join("\n");
    const { text: answer, fallbackModel } = await generateAnswer(
      `You are the conversational layer of an educational notebook agent. Respond naturally to the user using the conversation context. ${LANGUAGE_POLICY} Do not claim to have searched the sources for a casual message. Do not use a canned greeting; vary your response appropriately and invite the user to ask about the uploaded learning materials when useful.${options.instructions ? `\nNotebook instructions:\n${options.instructions}` : ""}`,
      `Conversation:\n${historyBlock || "(none)"}\n\nUser message: ${question}`,
      options,
      options.onToken
    );
    return {
      answer,
      sources: [],
      retrieval: [],
      metadata: { routing: action, topScore: 0, refused: false, fallbackModel },
      embeddingModel: "",
      dims: 0,
      steps: [{ id: `step-${Date.now()}`, name: "conversational_reply", title: "Direct conversational reply", status: "completed" }],
    };
  }
  if (action === "outside_files") {
    const { text: answer, fallbackModel } = await generateAnswer(
      `You are an educational notebook agent. The user's request is unrelated to the uploaded sources. ${LANGUAGE_POLICY} Explain that you can help with the notebook materials, but do not invent an answer from outside knowledge. Be natural and concise.${options.instructions ? `\nNotebook instructions:\n${options.instructions}` : ""}`,
      `User message: ${question}`,
      options,
      options.onToken
    );
    return {
      answer,
      sources: [],
      retrieval: [],
      metadata: { routing: action, topScore: 0, refused: true, fallbackModel },
      embeddingModel: "",
      dims: 0,
      steps: [{ id: `step-${Date.now()}`, name: "groundedness_gate", title: "Topic not covered in sources", status: "completed" }],
    };
  }

  // 2a. Session-wide asks: full outline + representative summaries, no top-k.
  if (isSessionWideAsk(question)) {
    const outline = await sessionOutline(root, notebookId);
    if (!outline.length || !outline.some((o) => o.chunkCount)) {
      return {
        answer: refusalText(false),
        sources: [],
        retrieval: [],
        metadata: { routing: "session_outline", topScore: 0, refused: true, fallbackModel: false },
        embeddingModel: "",
        dims: 0,
      };
    }
    const lib = snapshot.lib;
    const repChunks: RetrievedChunk[] = [];
    for (const doc of outline) {
      for (const heading of doc.headings.slice(0, 8)) {
        const sectionId = Object.values(lib.sections).find((s) => s.fileId === doc.fileId && s.headingPath.join(" › ") === heading.path.join(" › "))?.id;
        const firstChunkId = sectionId ? lib.sections[sectionId]?.chunkIds[0] : undefined;
        const chunk = firstChunkId ? lib.chunks[firstChunkId] : undefined;
        if (chunk) {
          repChunks.push({
            chunkId: chunk.id, sourceId: chunk.fileId, sourceName: doc.filename, headingPath: chunk.headingPath,
            text: chunk.text, summary: undefined, semantic: 1, lexical: 1, graphBoost: 0, fused: 1, final: 1, methods: ["outline"],
          });
        }
      }
    }
    const composedOutline = composeContextBlockIndexed(
      repChunks.map((c) => ({ headingPath: [c.sourceName, ...c.headingPath], text: c.text })),
      20000
    );
    const context = composedOutline.block;
    const historyBlock = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`).join("\n");
  const { text: answer, fallbackModel } = await generateAnswer(
      `${analystSystem()}\n${options.instructions ? `NOTEBOOK-SPECIFIC INSTRUCTIONS (follow only when compatible with source grounding):\n${options.instructions}` : ""}`,
      `Conversation so far:\n${historyBlock || "(none)"}\n\nQuestion: ${question}\n\nSOURCES (document outline + representative sections):\n${context}`,
      options,
      options.onToken
    );
    // Cite only the chunks the composed context actually showed the model —
    // markers in the context and entries in the citation list stay aligned.
    const sources = toCitations(composedOutline.keptIndices.map((i) => repChunks[i]));
    return {
      answer,
      sources,
      retrieval: repChunks.map((r) => ({ chunkId: r.chunkId, sourceName: r.sourceName, score: 1, methods: r.methods })),
      metadata: { routing: "session_outline", topScore: 1, refused: false, fallbackModel },
      embeddingModel: "",
      dims: 0,
    };
  }

  // 2b. Retrieve: run several inexpensive query views and fuse the results.
  // A single embedding is brittle for compound questions and paraphrases;
  // multi-query retrieval improves recall while preserving the local-only,
  // deterministic base pipeline. Generative outputs (quiz, mindmap, full
  // summary) retrieve and keep more so every section is represented.
  const generative = isGenerativeOutputRequest(question);
  const effectiveTopK = generative ? Math.max(topK, 24) : topK;
  const variants = queryVariants(searchQuery);
  const retrievalBatches = await Promise.all(
    variants.map((variant) => hybridRetrieve(notebookId, variant, Math.max(effectiveTopK, 24), options.fileIds, snapshot))
  );
  const firstBatch = retrievalBatches[0] || { results: [], embeddingModel: "none", dims: 0 };
  const results = mergeRetrievedResults(retrievalBatches.map((batch) => batch.results), Math.max(effectiveTopK * 3, 24));
  const embeddingModel = firstBatch.embeddingModel;
  const dims = firstBatch.dims;
  if (!results.length) {
    return {
      answer: refusalText(Boolean(options.fileIds?.length)),
      sources: [],
      retrieval: [],
      metadata: { routing: action, topScore: 0, refused: true, fallbackModel: false },
      embeddingModel,
      dims,
    };
  }

  // Optional LLM rerank (flag-gated), else the local fused order stands.
  let ranked = results;
  if (options.rerank?.enabled) {
    const scores = await llmRerankScores(searchQuery, results, options.rerank);
    if (scores) {
      ranked = results.map((r, i) => ({ ...r, final: r.final * 0.4 + scores[i] * 0.6 })).sort((a, b) => b.final - a.final);
    }
  }
  const top = ranked.slice(0, effectiveTopK);
  const bestSemantic = Math.max(...top.map((r) => r.semantic));

  // 3. Groundedness gate: refuse rather than hallucinate.
  const bestLexical = Math.max(...top.map((r) => r.lexical), 0);
  const gate = gateDecision(variants.join(" "), bestSemantic, top.map((r) => r.text), bestLexical);
  if (gate.refused) {
    return {
      answer: refusalText(Boolean(options.fileIds?.length)),
      sources: [],
      retrieval: top.map((r) => ({ chunkId: r.chunkId, sourceName: r.sourceName, score: Number(r.final.toFixed(4)), methods: r.methods })),
      metadata: { routing: action, topScore: Number(bestSemantic.toFixed(4)), refused: true, fallbackModel: false },
      embeddingModel,
      dims,
      steps: [{ id: `step-${Date.now()}`, name: "groundedness_gate", title: "Groundedness gate: refused to hallucinate", detail: `Top semantic score: ${bestSemantic.toFixed(2)}`, status: "completed" }],
    };
  }

  // 4. Context expansion: neighbors + heading path + section summary, bounded.
  // Generative outputs get a bigger budget so the plan covers everything.
  const expanded: Array<{ headingPath: string[]; text: string; summary?: string }> = [];
  for (const r of top) {
    const { prev, next } = await chunkNeighbors(root, notebookId, r.chunkId);
    const pieces = [prev?.text, r.text, next?.text].filter(Boolean) as string[];
    expanded.push({
      headingPath: [r.sourceName, ...r.headingPath],
      text: pieces.join("\n\n"),
      summary: r.summary,
    });
  }
  const composed = composeContextBlockIndexed(expanded, generative ? 20000 : 12000);
  const context = composed.block;
  const historyBlock = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`).join("\n");
  const { text: answer, fallbackModel } = await generateAnswer(
    `${analystSystem()}\n${options.instructions ? `NOTEBOOK-SPECIFIC INSTRUCTIONS (follow only when compatible with source grounding):\n${options.instructions}` : ""}`,
    `Conversation so far:\n${historyBlock || "(none)"}\n\nQuestion: ${question}\n\nSOURCES:\n${context}`,
    options,
    options.onToken
  );
  const sources = toCitations(composed.keptIndices.map((i) => top[i]));
  return {
    answer,
    sources,
    retrieval: top.map((r) => ({ chunkId: r.chunkId, sourceName: r.sourceName, score: Number(r.final.toFixed(4)), methods: r.methods })),
    metadata: { routing: action, topScore: Number(bestSemantic.toFixed(4)), refused: false, fallbackModel },
    embeddingModel,
    dims,
    steps: [{ id: `step-${Date.now()}`, name: "hybrid_retrieve", title: `Hybrid search: "${searchQuery}"`, detail: `Fused ${top.length} passage(s)`, status: "completed" }],
    evaluation: evaluateCitationCoverage(answer, sources.length),
  };
}

/** Single-chunk passage view: chunk + neighbors + section summary. */
export async function getChunkPassage(notebookId: string, chunkId: string): Promise<{
  chunkId: string;
  sourceId: string;
  sourceName: string;
  headingPath: string[];
  text: string;
  prevText: string | null;
  nextText: string | null;
  sectionSummary: string | null;
} | null> {
  const root = notebookSessionDir(notebookId);
  const { chunk, prev, next } = await chunkNeighbors(root, notebookId, chunkId);
  if (!chunk) return null;
  const lib = await loadLibrary(root, notebookId);
  const section = lib.sections[chunk.sectionId];
  return {
    chunkId: chunk.id,
    sourceId: chunk.fileId,
    sourceName: lib.documents[chunk.fileId]?.filename || chunk.fileId,
    headingPath: chunk.headingPath,
    text: chunk.text,
    prevText: prev?.text || null,
    nextText: next?.text || null,
    sectionSummary: section?.summary || null,
  };
}
