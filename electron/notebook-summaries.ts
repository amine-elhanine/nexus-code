import { promises as fs } from "node:fs";
import path from "node:path";
import { composeContextBlock } from "./notebook-text.js";
import { collectDocumentEvidence, extractDocumentJson, fallbackTitle } from "./notebook-documents.js";
import { notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";

// Rich summary generation for Notebook Mode: an overview plus themed
// sections with flowing prose, key points, and takeaways — a full study-grade
// synthesis, not a paragraph. Retrieval reuses the isolated notebook store
// via collectDocumentEvidence, so summaries never leak across notebooks and
// every claim stays traceable to cited passages.

export type NotebookSummaryLength = "brief" | "standard" | "detailed";

export type NotebookSummarySection = {
  heading: string;
  body: string;
  keyPoints: string[];
};

export type NotebookSummary = {
  id: string;
  notebookId: string;
  title: string;
  topic: string;
  length: NotebookSummaryLength;
  overview: string;
  sections: NotebookSummarySection[];
  takeaways: string[];
  citations: NotebookSourceCitation[];
  createdAt: string;
  updatedAt: string;
};

export type GenerateSummaryInput = {
  topic?: string;
  length?: NotebookSummaryLength;
  fileIds?: string[];
  providerId?: string;
  model?: string;
  instructions?: string;
  generate?: (system: string, user: string) => Promise<string>;
  onStatus?: (text: string) => void;
};

const SECTIONS_BY_LENGTH: Record<NotebookSummaryLength, { sections: number; body: string }> = {
  brief: { sections: 3, body: "one solid paragraph of 4-6 sentences" },
  standard: { sections: 5, body: "two flowing paragraphs" },
  detailed: { sections: 7, body: "three flowing paragraphs with depth and examples" },
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function summariesPath(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "summaries.json");
}

async function readSummaries(notebookId: string): Promise<NotebookSummary[]> {
  try {
    return JSON.parse(await fs.readFile(summariesPath(notebookId), "utf8")) as NotebookSummary[];
  } catch {
    return [];
  }
}

async function writeSummaries(notebookId: string, summaries: NotebookSummary[]) {
  await fs.mkdir(path.dirname(summariesPath(notebookId)), { recursive: true });
  await fs.writeFile(summariesPath(notebookId), JSON.stringify(summaries, null, 2), "utf8");
}

export async function listNotebookSummaries(notebookId: string): Promise<NotebookSummary[]> {
  const summaries = await readSummaries(notebookId);
  return [...summaries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteNotebookSummary(notebookId: string, summaryId: string): Promise<NotebookSummary[]> {
  const summaries = await readSummaries(notebookId);
  const next = summaries.filter((s) => s.id !== summaryId);
  await writeSummaries(notebookId, next);
  return next;
}

export function normalizeSummaryLength(raw: unknown): NotebookSummaryLength {
  if (raw === "brief" || raw === "standard" || raw === "detailed") return raw;
  return "standard";
}

async function planWithLlm(system: string, user: string, input: GenerateSummaryInput): Promise<string> {
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

type RawSummarySection = {
  heading?: unknown;
  body?: unknown;
  keyPoints?: unknown;
};

export function sanitizeSummary(
  parsed: unknown,
  length: NotebookSummaryLength,
  citations: NotebookSourceCitation[]
): { overview: string; sections: NotebookSummarySection[]; takeaways: string[] } {
  const root = (parsed || {}) as { overview?: unknown; sections?: unknown; takeaways?: unknown };
  const overview = String(root.overview || "").trim();
  if (overview.length < 120) throw new Error("Model returned a thin overview — retrying.");
  if (!Array.isArray(root.sections) || !root.sections.length) throw new Error("Model did not return sections.");
  const wantSections = SECTIONS_BY_LENGTH[length].sections;
  const sections: NotebookSummarySection[] = (root.sections as unknown[]).slice(0, wantSections).map((rawEntry, i) => {
    const raw = (rawEntry || {}) as RawSummarySection;
    const heading = String(raw.heading || "").trim().slice(0, 120);
    if (!heading) throw new Error(`Section ${i + 1} is missing its heading.`);
    const body = String(raw.body || "").trim();
    if (body.length < 120) throw new Error(`Section "${heading}" came back too thin.`);
    const keyPoints = Array.isArray(raw.keyPoints)
      ? (raw.keyPoints as unknown[]).map((k) => String(k || "").trim().slice(0, 300)).filter(Boolean).slice(0, 5)
      : [];
    if (!keyPoints.length) throw new Error(`Section "${heading}" is missing key points.`);
    return { heading, body: body.slice(0, 4000), keyPoints };
  });
  if (sections.length < 3) throw new Error("Model returned too few sections.");
  const takeaways = Array.isArray(root.takeaways)
    ? (root.takeaways as unknown[]).map((t) => String(t || "").trim().slice(0, 300)).filter(Boolean).slice(0, 8)
    : [];
  if (takeaways.length < 3) throw new Error("Model returned too few takeaways.");
  void citations;
  return { overview: overview.slice(0, 3000), sections, takeaways };
}

export async function generateNotebookSummary(
  notebookId: string,
  input: GenerateSummaryInput
): Promise<NotebookSummary> {
  const status = input.onStatus || (() => {});
  const topic = (input.topic || "").trim() || "overview of the uploaded sources";
  const length = normalizeSummaryLength(input.length);
  const spec = SECTIONS_BY_LENGTH[length];
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
  const system = `You are a precise research synthesizer writing a RICH, study-grade summary. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "overview": string, "sections": [{"heading": string, "body": string, "keyPoints": string[]}], "takeaways": string[]}. Rules: exactly ${spec.sections} themed sections (no filler, no repetition); overview is a substantial scene-setting of 6-10 sentences; every section body is ${spec.body} with concrete concepts, definitions, mechanisms, and examples from SOURCES; each section has 3-5 keyPoints (single sharp sentences); takeaways are 4-6 memorable conclusions; every factual claim carries its [S1]/[S2] marker from the citation list; never invent facts, numbers, or names.${baseInstructions}`;
  const user = `Topic: ${topic}\nCitation markers available: ${evidence.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;

  status("Drafting rich summary…");
  let parsed: unknown;
  try {
    parsed = extractDocumentJson(await planWithLlm(system, user, input));
    sanitizeSummary(parsed, length, evidence.citations);
  } catch {
    status("First draft came back thin — retrying with stricter format…");
    const repairSystem = `${system}\nCRITICAL: your previous reply was too thin or unusable. Write FULL bodies and reply with a single valid JSON object only — no markdown fences, no prose before or after.`;
    parsed = extractDocumentJson(await planWithLlm(repairSystem, user, input));
  }
  const { overview, sections, takeaways } = sanitizeSummary(parsed, length, evidence.citations);
  const rawTitle = ((parsed || {}) as { title?: unknown }).title;
  const title = (typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : fallbackTitle(topic, "report")).slice(0, 120);
  const now = new Date().toISOString();
  const summary: NotebookSummary = {
    id: uid("summary"),
    notebookId,
    title: title || `Summary — ${topic}`.slice(0, 120),
    topic,
    length,
    overview,
    sections,
    takeaways,
    citations: evidence.citations,
    createdAt: now,
    updatedAt: now,
  };
  const summaries = await readSummaries(notebookId);
  await writeSummaries(notebookId, [summary, ...summaries]);
  return summary;
}
