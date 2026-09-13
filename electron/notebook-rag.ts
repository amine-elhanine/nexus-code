import { createChatModel } from "./providers.js";
import { tool } from "@langchain/core/tools";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { z } from "zod";
import { listProviders } from "./store.js";
import { cosine, embedQuery } from "./notebook-embeddings.js";
import { notebookFlags } from "./notebook-flags.js";
import {
  chunkNeighbors,
  listChunks,
  loadLibrary,
  loadVectors,
  sessionOutline,
  sessionSummary,
} from "./notebook-library.js";
import { notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";
import {
  composeContextBlock,
  gateDecision,
  isSessionWideAsk,
  notebookTokens,
  rewriteQuery,
  routeMessageHeuristic,
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
  onStatus?: (text: string) => void;
  generate?: (system: string, user: string) => Promise<string>;
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

export async function hybridRetrieve(
  notebookId: string,
  query: string,
  topK = 8,
  fileIds?: string[]
): Promise<{ results: RetrievedChunk[]; embeddingModel: string; dims: number }> {
  const root = notebookSessionDir(notebookId);
  const lib = await loadLibrary(root, notebookId);
  const scope = fileIds?.length ? new Set(fileIds) : null;
  const corpus = lib.order
    .map((id) => lib.chunks[id])
    .filter((c) => c && (!scope || scope.has(c.fileId)));
  const partition = await loadVectors(root, notebookId);
  if (!corpus.length) return { results: [], embeddingModel: partition.embeddingModel || "none", dims: partition.dims || 0 };

  const { vector: queryVec } = await embedQuery(query, partition.embeddingModel || undefined);
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
  return { results: ranked.slice(0, Math.max(1, topK)), embeddingModel: partition.embeddingModel || "none", dims: partition.dims || 0 };
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

const ANALYST_SYSTEM = `You are a precise research analyst. Answer ONLY from the SOURCES below — never from your own knowledge. ${LANGUAGE_POLICY} Rules:
- Every factual claim must cite its source as [S1], [S2], etc.
- If the sources do not contain the answer, say so plainly and state what IS in them.
- Be direct and concise. No preamble, no tutoring tone.
- End with a "Sources" line listing [S1] heading, [S2] heading, ...`;

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
  const fallback = providers.find((p) => p.id !== primary.id && p.models.length);
  if (fallback) attempts.push({ provider: fallback, model: fallback.models[0], fallback: true });
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const llm = await createChatModel(attempt.provider, attempt.model);
      const messages = [
        { role: "system", content: system } as never,
        { role: "user", content: user } as never,
      ];
      if (onToken) {
        let text = "";
        const stream = await llm.stream(messages);
        for await (const chunk of stream) {
          const delta = chunkTextContent(chunk);
          if (delta) {
            text += delta;
            onToken(delta);
          }
        }
        return { text, fallbackModel: attempt.fallback };
      }
      const res = await llm.invoke(messages);
      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      return { text, fallbackModel: attempt.fallback };
    } catch (error) {
      lastError = error;
    }
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
};

/**
 * Tool-using notebook agent. LangGraph owns the run state, deepagents owns the
 * model/tool loop, and the tools keep the model grounded in this notebook's
 * source store. Casual conversation can finish without a tool call; source
 * questions must use search/outline before answering.
 */
async function runNotebookAgent(
  notebookId: string,
  question: string,
  history: Array<{ role: string; text: string }>,
  options: NotebookRagOptions,
  summary: { files: string[]; headings: string[]; terms: string[] }
): Promise<NotebookAgentRun | null> {
  if (options.generate) return null; // deterministic pipeline tests and callers can inject their own generator
  const providers = await listProviders().catch(() => []);
  const provider = options.chatProviderId ? providers.find((item) => item.id === options.chatProviderId) : providers[0];
  const modelName = options.chatModel || provider?.models[0];
  if (!provider || !modelName) return null;

  const selected = new Map<string, RetrievedChunk>();
  let embeddingModel = "";
  let dims = 0;
  options.onStatus?.("Understanding your question…");
  const searchTool = tool(async ({ query, topK, fileIds }) => {
    options.onStatus?.("Searching relevant passages…");
    const found = await hybridRetrieve(notebookId, query, Math.min(Math.max(topK || 8, 4), 16), fileIds?.length ? fileIds : options.fileIds);
    embeddingModel = found.embeddingModel;
    dims = found.dims;
    for (const item of found.results) selected.set(item.chunkId, item);
    return JSON.stringify(found.results.map((item, index) => ({
      citation: `[S${index + 1}]`,
      chunkId: item.chunkId,
      source: item.sourceName,
      heading: item.headingPath.join(" › "),
      score: Number(item.final.toFixed(4)),
      text: item.text.slice(0, 5000),
    })));
  }, {
    name: "search_notebook_sources",
    description: "Search the uploaded notebook sources using hybrid semantic, lexical, and structural retrieval. Use this for any factual question about the sources.",
    schema: z.object({ query: z.string().min(1), topK: z.number().int().min(4).max(16).optional(), fileIds: z.array(z.string()).optional() }),
  });
  const outlineTool = tool(async () => {
    options.onStatus?.("Inspecting the notebook structure…");
    const outline = await sessionOutline(notebookSessionDir(notebookId), notebookId);
    // Seed citations for overview answers as well as returning the structural map.
    const overview = await hybridRetrieve(notebookId, "main topics overview concepts themes", 12, options.fileIds);
    embeddingModel = overview.embeddingModel;
    dims = overview.dims;
    for (const item of overview.results) selected.set(item.chunkId, item);
    return JSON.stringify({
      files: outline.map((doc) => ({ filename: doc.filename, sections: doc.sectionCount, chunks: doc.chunkCount, headings: doc.headings.slice(0, 20) })),
      representativePassages: overview.results.slice(0, 12).map((item) => ({ source: item.sourceName, heading: item.headingPath.join(" › "), text: item.text.slice(0, 1800) })),
    });
  }, {
    name: "inspect_notebook_outline",
    description: "Inspect the notebook's files, headings, section structure, and representative passages. Use for broad questions like what the notebook is about, summaries, study plans, or topic overviews.",
    schema: z.object({}),
  });
  const passageTool = tool(async ({ chunkId }) => {
    options.onStatus?.("Reading the relevant source passage…");
    const passage = await getChunkPassage(notebookId, chunkId);
    if (!passage) return "Passage not found. Search again with the notebook source tool.";
    return JSON.stringify(passage);
  }, {
    name: "read_notebook_passage",
    description: "Read a retrieved passage with its neighboring context and section summary. Use when the user asks to explain, simplify, compare, or go deeper into evidence.",
    schema: z.object({ chunkId: z.string().min(1) }),
  });

  try {
    options.onStatus?.("Preparing a grounded answer…");
    const llm = await createChatModel(provider, modelName);
    const agent = await createDeepAgent({
      model: llm,
      backend: new FilesystemBackend({ rootDir: notebookSessionDir(notebookId), virtualMode: true }) as any,
      tools: [searchTool, outlineTool, passageTool],
      systemPrompt: `You are the interactive agent for an educational NotebookLM-style workspace. You have a conversation with the learner and a set of uploaded course sources.

Language: ${LANGUAGE_POLICY}

Behavior:
- Understand the user's intent, including short follow-ups such as "why?", "what about this?", "explain that", "quiz me", and "make a study plan" by using the recent conversation.
- For greetings and ordinary conversation, answer naturally without a canned phrase and without calling a source tool.
- For anything about the uploaded materials, call search_notebook_sources or inspect_notebook_outline before answering. For broad questions like "what is this about?", use inspect_notebook_outline.
- Use read_notebook_passage when a specific retrieved passage needs deeper explanation.
- Never invent facts about the uploaded materials. Every source-grounded factual claim must cite the returned citation marker such as [S1].
- If the sources do not contain the answer, say that clearly and suggest a useful next action. Do not silently answer from general knowledge.
- Be interactive: answer the immediate request, then offer one relevant next step only when it helps (for example, explain, compare, quiz, or summarize).
- Return clean Markdown. Do not mention internal tools or planning.

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
        const stream = await (agent as any).stream({ messages: state.messages }, { streamMode: ["values", "messages"], recursionLimit: 24 });
        let messages: any[] = state.messages;
        for await (const item of stream as AsyncIterable<any>) {
          const [mode, payload] = Array.isArray(item) ? item : ["values", item];
          if (mode === "values" && Array.isArray(payload?.messages)) messages = payload.messages;
        }
        const final = messages[messages.length - 1];
        return { messages, answer: chunkTextContent(final) };
      })
      .addEdge(START, "notebook_agent")
      .addEdge("notebook_agent", END)
      .compile();
    const result = await graph.invoke({ messages: initial });
    const answer = String((result as any).answer || "").trim();
    if (!answer) return null;
    const ranked = [...selected.values()].sort((a, b) => b.final - a.final).slice(0, 12);
    const sources = toCitations(ranked);
    return {
      answer,
      sources,
      retrieval: ranked.map((item) => ({ chunkId: item.chunkId, sourceName: item.sourceName, score: Number(item.final.toFixed(4)), methods: item.methods })),
      fallbackModel: false,
      embeddingModel,
      dims,
    };
  } catch (error) {
    console.warn("[notebook] agent loop unavailable; using grounded fallback:", error instanceof Error ? error.message : error);
    return null;
  }
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

  // The normal notebook path is now a tool-using agent. Keep the explicit
  // retrieval pipeline below as a grounded compatibility fallback for tests,
  // providers without tool-call support, and transient agent failures.
  const heuristicForAgent = routeMessageHeuristic(question, termSet);
  const agentResult = await runNotebookAgent(notebookId, question, history, options, summary);
  if (agentResult && (agentResult.sources.length > 0 || heuristicForAgent.action !== "retrieve" || isSessionWideAsk(question))) {
    return {
      answer: agentResult.answer,
      sources: agentResult.sources,
      retrieval: agentResult.retrieval,
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
    const lib = await loadLibrary(root, notebookId);
    const repChunks: RetrievedChunk[] = [];
    for (const doc of outline) {
      for (const heading of doc.headings.slice(0, 4)) {
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
    const context = composeContextBlock(
      repChunks.map((c) => ({ headingPath: [c.sourceName, ...c.headingPath], text: c.text })),
      12000
    );
    const historyBlock = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`).join("\n");
  const { text: answer, fallbackModel } = await generateAnswer(
      `${ANALYST_SYSTEM}\n${options.instructions ? `NOTEBOOK-SPECIFIC INSTRUCTIONS (follow only when compatible with source grounding):\n${options.instructions}` : ""}`,
      `Conversation so far:\n${historyBlock || "(none)"}\n\nQuestion: ${question}\n\nSOURCES (document outline + representative sections):\n${context}`,
      options,
      options.onToken
    );
    const sources = toCitations(repChunks);
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
  // deterministic base pipeline.
  const variants = queryVariants(searchQuery);
  const retrievalBatches = await Promise.all(
    variants.map((variant) => hybridRetrieve(notebookId, variant, Math.max(topK, 12), options.fileIds))
  );
  const firstBatch = retrievalBatches[0] || { results: [], embeddingModel: "none", dims: 0 };
  const results = mergeRetrievedResults(retrievalBatches.map((batch) => batch.results), Math.max(topK * 3, 16));
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
  const top = ranked.slice(0, topK);
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
    };
  }

  // 4. Context expansion: neighbors + heading path + section summary, bounded.
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
  const context = composeContextBlock(expanded, 12000);
  const historyBlock = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`).join("\n");
  const { text: answer, fallbackModel } = await generateAnswer(
    `${ANALYST_SYSTEM}\n${options.instructions ? `NOTEBOOK-SPECIFIC INSTRUCTIONS (follow only when compatible with source grounding):\n${options.instructions}` : ""}`,
    `Conversation so far:\n${historyBlock || "(none)"}\n\nQuestion: ${question}\n\nSOURCES:\n${context}`,
    options,
    options.onToken
  );
  const sources = toCitations(top);
  return {
    answer,
    sources,
    retrieval: top.map((r) => ({ chunkId: r.chunkId, sourceName: r.sourceName, score: Number(r.final.toFixed(4)), methods: r.methods })),
    metadata: { routing: action, topScore: Number(bestSemantic.toFixed(4)), refused: false, fallbackModel },
    embeddingModel,
    dims,
  };
}

function toCitations(chunks: RetrievedChunk[]): NotebookSourceCitation[] {
  return chunks.map((r, i) => ({
    index: i + 1,
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    chunkId: r.chunkId,
    heading: r.headingPath.join(" › ") || r.sourceName,
    excerpt: r.text.slice(0, 400),
    snippet: r.text.replace(/\s+/g, " ").trim().slice(0, 200),
    score: Number(r.final.toFixed(4)),
  }));
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
