import { promises as fs } from "node:fs";
import path from "node:path";
import { composeContextBlock } from "./notebook-text.js";
import { collectDocumentEvidence, extractDocumentJson, fallbackTitle } from "./notebook-documents.js";
import { notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";

// Grounded flashcard generation for Notebook Mode: concise Q/A cards covering
// the key concepts in the in-scope sources. Retrieval reuses the isolated
// notebook store via collectDocumentEvidence, so card sets never leak across
// notebooks and every card stays traceable to cited passages.

export type NotebookFlashcard = {
  id: string;
  front: string;
  back: string;
  citations: NotebookSourceCitation[];
};

export type NotebookFlashcardSet = {
  id: string;
  notebookId: string;
  title: string;
  topic: string;
  cardCount: number;
  cards: NotebookFlashcard[];
  citations: NotebookSourceCitation[];
  createdAt: string;
  updatedAt: string;
};

export type GenerateFlashcardsInput = {
  topic?: string;
  count?: number;
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

function flashcardsPath(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "flashcards.json");
}

async function readSets(notebookId: string): Promise<NotebookFlashcardSet[]> {
  try {
    return JSON.parse(await fs.readFile(flashcardsPath(notebookId), "utf8")) as NotebookFlashcardSet[];
  } catch {
    return [];
  }
}

async function writeSets(notebookId: string, sets: NotebookFlashcardSet[]) {
  await fs.mkdir(path.dirname(flashcardsPath(notebookId)), { recursive: true });
  await fs.writeFile(flashcardsPath(notebookId), JSON.stringify(sets, null, 2), "utf8");
}

export async function listNotebookFlashcardSets(notebookId: string): Promise<NotebookFlashcardSet[]> {
  const sets = await readSets(notebookId);
  return [...sets].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteNotebookFlashcardSet(notebookId: string, setId: string): Promise<NotebookFlashcardSet[]> {
  const sets = await readSets(notebookId);
  const next = sets.filter((s) => s.id !== setId);
  await writeSets(notebookId, next);
  return next;
}

export function clampFlashcardCount(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 10;
  return Math.min(30, Math.max(3, Math.round(n)));
}

async function planWithLlm(system: string, user: string, input: GenerateFlashcardsInput): Promise<string> {
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

type RawFlashcard = {
  front?: unknown;
  back?: unknown;
  citations?: unknown;
};

function sanitizeCards(
  parsed: unknown,
  count: number,
  citations: NotebookSourceCitation[]
): NotebookFlashcard[] {
  const root = (parsed || {}) as { cards?: unknown };
  if (!Array.isArray(root.cards)) throw new Error("Model did not return a cards array.");
  const cards: NotebookFlashcard[] = [];
  root.cards.slice(0, count).forEach((rawEntry, i) => {
    const raw = (rawEntry || {}) as RawFlashcard;
    const front = String(raw.front || "").trim().slice(0, 300);
    if (!front) throw new Error(`Card ${i + 1} is missing its front.`);
    const back = String(raw.back || "").trim().slice(0, 600);
    if (!back) throw new Error(`Card ${i + 1} is missing its back.`);
    const refs = parseCitationRefs(`${front} ${back} ${Array.isArray(raw.citations) ? (raw.citations as unknown[]).join(" ") : ""}`);
    const linked = refs.map((n) => citationByIndex(citations, n)).filter((c): c is NotebookSourceCitation => Boolean(c));
    const fallbackCite = citations[i % Math.max(1, citations.length)];
    const cardCitations = (linked.length ? linked : fallbackCite ? [fallbackCite] : []).slice(0, 2);
    cards.push({ id: uid("card"), front, back, citations: cardCitations });
  });
  if (!cards.length) throw new Error("Model returned no usable cards.");
  return cards;
}

export async function generateNotebookFlashcards(
  notebookId: string,
  input: GenerateFlashcardsInput
): Promise<NotebookFlashcardSet> {
  const status = input.onStatus || (() => {});
  const topic = (input.topic || "").trim() || "overview of the uploaded sources";
  const count = clampFlashcardCount(input.count);
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
  const system = `You are a precise study-card author. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "cards": [{"front": string, "back": string}]}. Rules: exactly ${count} cards; front is a short prompt (term, question, or cue, max 20 words); back is the concise answer (1-3 sentences); every card grounded in SOURCES with its [S1]/[S2] marker kept in the front or back; one idea per card; cover the key concepts, definitions, and theories — no duplicates.${baseInstructions}`;
  const user = `Topic: ${topic}\nCount: ${count}\nCitation markers available: ${evidence.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;

  status("Drafting grounded flashcards…");
  let parsed: unknown;
  try {
    parsed = extractDocumentJson(await planWithLlm(system, user, input));
    sanitizeCards(parsed, count, evidence.citations);
  } catch {
    status("First draft came back malformed — retrying with stricter format…");
    const repairSystem = `${system}\nCRITICAL: your previous reply was not usable. Reply with a single valid JSON object only — no markdown fences, no prose before or after.`;
    parsed = extractDocumentJson(await planWithLlm(repairSystem, user, input));
  }
  const cards = sanitizeCards(parsed, count, evidence.citations);
  const rawTitle = ((parsed || {}) as { title?: unknown }).title;
  const title = (typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : fallbackTitle(topic, "report")).slice(0, 120);
  const now = new Date().toISOString();
  const set: NotebookFlashcardSet = {
    id: uid("fiches"),
    notebookId,
    title: title || `Flashcards — ${topic}`.slice(0, 120),
    topic,
    cardCount: cards.length,
    cards,
    citations: evidence.citations,
    createdAt: now,
    updatedAt: now,
  };
  const sets = await readSets(notebookId);
  await writeSets(notebookId, [set, ...sets]);
  return set;
}
