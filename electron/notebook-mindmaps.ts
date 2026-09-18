import { promises as fs } from "node:fs";
import path from "node:path";
import { composeContextBlock } from "./notebook-text.js";
import { collectDocumentEvidence, extractDocumentJson, fallbackTitle } from "./notebook-documents.js";
import { notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";

// Grounded mindmap generation for Notebook Mode: a topic tree (roots with
// nested children) covering the main topics and subtopics of the in-scope
// sources. Retrieval reuses the isolated notebook store via
// collectDocumentEvidence, so maps never leak across notebooks and every node
// stays traceable to cited passages.

export type NotebookMindmapNode = {
  id: string;
  label: string;
  detail: string;
  citations: NotebookSourceCitation[];
  children: NotebookMindmapNode[];
};

export type NotebookMindmap = {
  id: string;
  notebookId: string;
  title: string;
  topic: string;
  nodeCount: number;
  roots: NotebookMindmapNode[];
  citations: NotebookSourceCitation[];
  createdAt: string;
  updatedAt: string;
};

export type GenerateMindmapInput = {
  topic?: string;
  maxNodes?: number;
  fileIds?: string[];
  providerId?: string;
  model?: string;
  instructions?: string;
  generate?: (system: string, user: string) => Promise<string>;
  onStatus?: (text: string) => void;
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function mindmapsPath(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "mindmaps.json");
}

async function readMaps(notebookId: string): Promise<NotebookMindmap[]> {
  try {
    return JSON.parse(await fs.readFile(mindmapsPath(notebookId), "utf8")) as NotebookMindmap[];
  } catch {
    return [];
  }
}

async function writeMaps(notebookId: string, maps: NotebookMindmap[]) {
  await fs.mkdir(path.dirname(mindmapsPath(notebookId)), { recursive: true });
  await fs.writeFile(mindmapsPath(notebookId), JSON.stringify(maps, null, 2), "utf8");
}

export async function listNotebookMindmaps(notebookId: string): Promise<NotebookMindmap[]> {
  const maps = await readMaps(notebookId);
  return [...maps].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteNotebookMindmap(notebookId: string, mapId: string): Promise<NotebookMindmap[]> {
  const maps = await readMaps(notebookId);
  const next = maps.filter((m) => m.id !== mapId);
  await writeMaps(notebookId, next);
  return next;
}

export function clampMindmapNodes(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 24;
  return Math.min(60, Math.max(8, Math.round(n)));
}

async function planWithLlm(system: string, user: string, input: GenerateMindmapInput): Promise<string> {
  if (input.generate) return input.generate(system, user);
  const { listProviders } = await import("./store.js");
  const { createChatModel } = await import("./providers.js");
  const providers = await listProviders();
  const provider = input.providerId ? providers.find((p) => p.id === input.providerId) : providers[0];
  if (!provider) throw new Error("Configure a chat provider first (Providers button, top right).");
  const modelName = input.model || provider.models[0];
  if (!modelName) throw new Error("No chat model selected.");
  const llm = await createChatModel(provider, modelName);
  const res = await llm.invoke([
    { role: "system", content: system } as never,
    { role: "user", content: user } as never,
  ]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

function citationByIndex(citations: NotebookSourceCitation[], index: number): NotebookSourceCitation | undefined {
  return citations.find((c) => c.index === index);
}

function parseCitationRefs(text: string): number[] {
  const out: number[] = [];
  const re = /\[S(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 4);
}

type RawMindmapNode = {
  label?: unknown;
  detail?: unknown;
  citations?: unknown;
  children?: unknown;
};

const MAX_DEPTH = 4;
const MAX_CHILDREN = 8;
/** Safety rail only: the agent decides the real node count from the content. */
const DEFAULT_MAX_NODES = 100;

function sanitizeNode(
  rawEntry: unknown,
  citations: NotebookSourceCitation[],
  budget: { remaining: number },
  depth: number,
  citeCursor: { i: number }
): NotebookMindmapNode | null {
  if (budget.remaining <= 0) return null;
  const raw = (rawEntry || {}) as RawMindmapNode;
  const label = String(raw.label || "").trim().slice(0, 120);
  if (!label) return null;
  const detail = String(raw.detail || "").trim().slice(0, 300);
  const refs = parseCitationRefs(`${label} ${detail} ${Array.isArray(raw.citations) ? (raw.citations as unknown[]).join(" ") : ""}`);
  const linked = refs.map((n) => citationByIndex(citations, n)).filter((c): c is NotebookSourceCitation => Boolean(c));
  const fallbackCite = citations.length ? citations[citeCursor.i % citations.length] : undefined;
  citeCursor.i++;
  budget.remaining--;
  const children: NotebookMindmapNode[] = [];
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const childRaw of (raw.children as unknown[]).slice(0, MAX_CHILDREN)) {
      const child = sanitizeNode(childRaw, citations, budget, depth + 1, citeCursor);
      if (child) children.push(child);
      if (budget.remaining <= 0) break;
    }
  }
  return { id: uid("node"), label, detail, citations: (linked.length ? linked : fallbackCite ? [fallbackCite] : []).slice(0, 2), children };
}

function countNodes(nodes: NotebookMindmapNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

function sanitizeRoots(parsed: unknown, maxNodes: number, citations: NotebookSourceCitation[]): NotebookMindmapNode[] {
  const root = (parsed || {}) as { roots?: unknown; nodes?: unknown };
  const rawRoots = Array.isArray(root.roots) ? root.roots : Array.isArray(root.nodes) ? root.nodes : null;
  if (!rawRoots) throw new Error("Model did not return a roots array.");
  const budget = { remaining: maxNodes };
  const citeCursor = { i: 0 };
  const roots: NotebookMindmapNode[] = [];
  for (const raw of (rawRoots as unknown[]).slice(0, 8)) {
    const node = sanitizeNode(raw, citations, budget, 1, citeCursor);
    if (node) roots.push(node);
    if (budget.remaining <= 0) break;
  }
  if (!roots.length) throw new Error("Model returned no usable topics.");
  return roots;
}

export async function generateNotebookMindmap(
  notebookId: string,
  input: GenerateMindmapInput
): Promise<NotebookMindmap> {
  const status = input.onStatus || (() => {});
  const topic = (input.topic || "").trim() || "overview of the uploaded sources";
  // No user-facing count: the agent sizes the map from the content; the cap
  // is only a safety rail against runaway output.
  const maxNodes = input.maxNodes == null ? DEFAULT_MAX_NODES : clampMindmapNodes(input.maxNodes);
  const scope = input.fileIds?.length ? input.fileIds : undefined;

  status("Searching notebook sources…");
  const evidence = await collectDocumentEvidence(notebookId, topic, scope);
  if (!evidence.ranked.length) {
    throw new Error("Not covered in your files — upload the relevant sources or widen the file scope first.");
  }
  status(`Using ${evidence.ranked.length} passages from ${evidence.coverage.filesUsed}/${evidence.coverage.filesTotal} files…`);

  const context = composeContextBlock(
    evidence.ranked.map((r) => ({ headingPath: [r.sourceName, ...r.headingPath], text: r.text })),
    40000
  );
  const baseInstructions = input.instructions ? `\nNotebook goal:\n${input.instructions}` : "";
  const system = `You are a precise knowledge cartographer. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "roots": [{"label": string, "detail": string, "children": [...] }]}. Rules: decide yourself how many nodes the content needs (hard cap ${maxNodes}) — cover EVERY main topic and subtopic the sources support, never cut the map short to hit a number; 3-8 top-level roots; each node has children (possibly empty) with the same shape up to 4 levels deep; label is 2-8 words; detail is one short sentence; every node grounded in SOURCES with its [S1]/[S2] marker kept in the label or detail; no duplicates.${baseInstructions}`;
  const user = `Topic: ${topic}\nCitation markers available: ${evidence.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;

  status("Drafting grounded mind map…");
  let parsed: unknown;
  try {
    parsed = extractDocumentJson(await planWithLlm(system, user, input));
    sanitizeRoots(parsed, maxNodes, evidence.citations);
  } catch {
    status("First draft came back malformed — retrying with stricter format…");
    const repairSystem = `${system}\nCRITICAL: your previous reply was not usable. Reply with a single valid JSON object only — no markdown fences, no prose before or after.`;
    parsed = extractDocumentJson(await planWithLlm(repairSystem, user, input));
  }
  const roots = sanitizeRoots(parsed, maxNodes, evidence.citations);
  const rawTitle = ((parsed || {}) as { title?: unknown }).title;
  const title = (typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : fallbackTitle(topic, "report")).slice(0, 120);
  const now = new Date().toISOString();
  const map: NotebookMindmap = {
    id: uid("mindmap"),
    notebookId,
    title: title || `Mind map — ${topic}`.slice(0, 120),
    topic,
    nodeCount: countNodes(roots),
    roots,
    citations: evidence.citations,
    createdAt: now,
    updatedAt: now,
  };
  const maps = await readMaps(notebookId);
  await writeMaps(notebookId, [map, ...maps]);
  return map;
}
