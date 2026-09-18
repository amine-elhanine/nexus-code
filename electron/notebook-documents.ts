import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { composeContextBlock } from "./notebook-text.js";
import { listNotebookSources, notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";
import { hybridRetrieve } from "./notebook-rag.js";
import { loadLibrary, sessionOutline } from "./notebook-library.js";

// Grounded document generation for Notebook Mode: reports (docx/pdf) and
// slide decks (pptx). Retrieval + outline reuse the isolated notebook store,
// a Home-style tool agent with the shared skill library designs the file, and
// deterministic converters remain as fallback. No cross-notebook leakage.

export type NotebookDocumentKind = "report" | "slides";
export type NotebookDocumentFormat = "docx" | "pdf" | "pptx" | "md" | "xlsx";

export type NotebookDocument = {
  id: string;
  notebookId: string;
  kind: NotebookDocumentKind;
  format: NotebookDocumentFormat;
  title: string;
  filename: string;
  size: number;
  prompt: string;
  preview: string;
  citations: NotebookSourceCitation[];
  sectionCount: number;
  slideCount: number;
  /** Which pipeline produced the file: skill-driven agent or built-in renderer. */
  engine?: "skill-agent" | "builtin";
  createdAt: string;
  updatedAt: string;
};

export type GenerateDocumentInput = {
  kind: NotebookDocumentKind;
  format: NotebookDocumentFormat;
  prompt?: string;
  fileIds?: string[];
  providerId?: string;
  model?: string;
  instructions?: string;
  generate?: (system: string, user: string) => Promise<string>;
  onStatus?: (text: string) => void;
};

type ReportPlan = {
  title: string;
  executiveSummary: string;
  sections: Array<{ heading: string; body: string; keyPoints?: string[] }>;
  takeaways: string[];
};

type SlideCallout = { title: string; text: string };

type SlidePlan = {
  title: string;
  subtitle?: string;
  bullets: string[];
  code?: string;
  callouts?: SlideCallout[];
  notes?: string;
};

type SlidesPlan = {
  title: string;
  subtitle?: string;
  slides: SlidePlan[];
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function docsPath(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "documents.json");
}
export function docsDir(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "documents");
}
export function safeStem(title: string, fallback: string) {
  const stem = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return stem || fallback;
}

async function readDocs(notebookId: string): Promise<NotebookDocument[]> {
  try {
    return JSON.parse(await fs.readFile(docsPath(notebookId), "utf8")) as NotebookDocument[];
  } catch {
    return [];
  }
}
async function writeDocs(notebookId: string, docs: NotebookDocument[]) {
  await fs.mkdir(path.dirname(docsPath(notebookId)), { recursive: true });
  await fs.writeFile(docsPath(notebookId), JSON.stringify(docs, null, 2), "utf8");
}

export async function listNotebookDocuments(notebookId: string): Promise<NotebookDocument[]> {
  const docs = await readDocs(notebookId);
  return [...docs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteNotebookDocument(notebookId: string, docId: string): Promise<NotebookDocument[]> {
  const docs = await readDocs(notebookId);
  const target = docs.find((d) => d.id === docId);
  const next = docs.filter((d) => d.id !== docId);
  await writeDocs(notebookId, next);
  if (target) {
    try {
      await fs.unlink(path.join(docsDir(notebookId), target.filename));
    } catch { /* gone */ }
  }
  return next;
}

export async function readNotebookDocument(
  notebookId: string,
  docId: string
): Promise<{ name: string; path: string; size: number; base64: string }> {
  const docs = await readDocs(notebookId);
  const target = docs.find((d) => d.id === docId);
  if (!target) throw new Error("Document not found.");
  const abs = path.join(docsDir(notebookId), target.filename);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(abs);
  } catch {
    throw new Error("File is missing on disk — regenerate it.");
  }
  if (buffer.length > 30 * 1024 * 1024) {
    throw new Error("File is too large to preview — download it instead.");
  }
  return { name: target.filename, path: target.filename, size: buffer.length, base64: buffer.toString("base64") };
}

export async function downloadNotebookDocument(notebookId: string, docId: string): Promise<string | null> {
  const docs = await readDocs(notebookId);
  const target = docs.find((d) => d.id === docId);
  if (!target) throw new Error("Document not found.");
  const source = path.join(docsDir(notebookId), target.filename);
  try {
    await fs.access(source);
  } catch {
    throw new Error("File is missing on disk — regenerate it.");
  }
  const electronRequire = createRequire(import.meta.url);
  let dialog: { showSaveDialog: (opts: unknown) => Promise<{ canceled: boolean; filePath?: string }> } | null = null;
  try {
    const mod = electronRequire("electron") as unknown as { dialog?: { showSaveDialog: (opts: unknown) => Promise<{ canceled: boolean; filePath?: string }> } };
    if (mod && typeof mod === "object") dialog = mod.dialog || null;
  } catch { /* plain node (tests) */ }
  if (!dialog) return source;
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: target.filename, title: "Save document" });
  if (canceled || !filePath) return null;
  await fs.copyFile(source, filePath);
  return filePath;
}

export function toCitations(results: Array<{ sourceId: string; sourceName: string; chunkId: string; headingPath: string[]; text: string; final: number }>): NotebookSourceCitation[] {
  return results.map((r, i) => ({
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

async function planWithLlm(system: string, user: string, input: GenerateDocumentInput): Promise<string> {
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

function stripCodeFences(raw: string): string {
  return raw.replace(/```(?:json)?\s*/gi, "```").replace(/```/g, "");
}

/** Best-effort JSON extraction: models often add prose around the object. */
export function extractDocumentJson(raw: string): unknown {
  const text = stripCodeFences(raw);
  const candidates: string[] = [];
  const greedy = text.match(/\{[\s\S]*\}/);
  if (greedy) candidates.push(greedy[0]);
  // Balance from the first opening brace (handles trailing prose).
  const first = text.indexOf("{");
  if (first >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = first; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(first, i + 1));
          break;
        }
      }
    }
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `The model did not return valid structured content (${errors[0] || "no JSON object found"}) — try again or switch model.`
  );
}

function str(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max);
}

function strArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : typeof item === "object" && item !== null ? str((item as { text?: unknown }).text ?? JSON.stringify(item), maxLen) : str(item, maxLen)))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

/** Accepts the documented shape plus common model variants (aliases, string items). */
export function sanitizeReportPlan(plan: unknown): ReportPlan {
  const p = (plan || {}) as Record<string, unknown>;
  const rawSections = [p.sections, p.report_sections, p.content, p.body].find((v) => Array.isArray(v)) as unknown[] | undefined;
  const sections = (Array.isArray(rawSections) ? rawSections : []).slice(0, 12).map((s) => {
    if (typeof s === "string") {
      const text = s.trim();
      const lines = text.split(/\n+/).filter(Boolean);
      return { heading: (lines[0] || "Section").slice(0, 120), body: lines.slice(1).join("\n") || text, keyPoints: undefined };
    }
    const o = (s || {}) as Record<string, unknown>;
    const heading = str(o.heading ?? o.title ?? o.name ?? "Section", 120) || "Section";
    const body = str(o.body ?? o.text ?? o.content ?? o.summary ?? "", 6000);
    const keyPoints = strArray(o.keyPoints ?? o.points ?? o.bullets ?? o.highlights, 6, 300);
    return { heading, body, keyPoints: keyPoints.length ? keyPoints : undefined };
  }).filter((s) => s.body.trim() || s.heading !== "Section");
  if (!sections.length) throw new Error("empty-report");
  return {
    title: str(p.title ?? p.name ?? p.heading ?? "Notebook report", 160) || "Notebook report",
    executiveSummary: str(p.executiveSummary ?? p.summary ?? p.overview ?? p.introduction ?? "", 4000),
    sections,
    takeaways: strArray(p.takeaways ?? p.conclusion ?? p.key_takeaways ?? p.recommendations, 8, 300),
  };
}

export function sanitizeSlidesPlan(plan: unknown): SlidesPlan {
  const p = (plan || {}) as Record<string, unknown>;
  const rawSlides = [p.slides, p.deck, p.content].find((v) => Array.isArray(v)) as unknown[] | undefined;
  const slides = (Array.isArray(rawSlides) ? rawSlides : []).slice(0, 14).map((s) => {
    if (typeof s === "string") return { title: s.slice(0, 120), bullets: [] as string[], notes: undefined } as SlidePlan;
    const o = (s || {}) as Record<string, unknown>;
    const bullets = strArray(o.bullets ?? o.points ?? o.content ?? o.body, 5, 220)
      .filter((b) => !/```/.test(b) && !/^\s*mermaid\b/i.test(b));
    const rawCallouts = o.callouts;
    const callouts = Array.isArray(rawCallouts)
      ? (rawCallouts as unknown[])
          .map((c) => {
            const co = (c || {}) as Record<string, unknown>;
            return { title: str(co.title ?? co.heading ?? "", 60), text: str(co.text ?? co.body ?? "", 300) };
          })
          .filter((c) => c.title || c.text)
          .slice(0, 3)
      : undefined;
    const rawCode = typeof o.code === "string" ? o.code : "";
    const code = rawCode && !/mermaid|graph\s+(LR|TD|TB|BT)/i.test(rawCode) ? rawCode.slice(0, 600) : undefined;
    return {
      title: str(o.title ?? o.heading ?? o.name ?? "Slide", 120) || "Slide",
      subtitle: typeof o.subtitle === "string" ? o.subtitle.slice(0, 220) : undefined,
      bullets,
      code,
      callouts: callouts?.length ? callouts : undefined,
      notes: typeof o.notes === "string" ? o.notes.slice(0, 300) : undefined,
    } as SlidePlan;
  }).filter((s) => s.title !== "Slide" || s.bullets.length || s.code || s.callouts?.length);
  if (!slides.length) throw new Error("empty-slides");
  return {
    title: str(p.title ?? p.name ?? "Notebook presentation", 160) || "Notebook presentation",
    subtitle: typeof p.subtitle === "string" ? p.subtitle.slice(0, 220) : undefined,
    slides,
  };
}

function firstSentence(text: string, max = 220): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^.*?[.!?…](?=\s|$)/);
  return (match ? match[0] : cleaned.slice(0, max)).slice(0, max).trim() || cleaned.slice(0, max).trim();
}

function splitSentences(text: string, maxItems: number, maxLen: number): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim().slice(0, maxLen))
    .filter((s) => s.length > 8)
    .slice(0, maxItems);
}

/**
 * Deterministic fallback when the model can't produce structured JSON
 * (small/free-tier models often reply in prose or truncate). Assembles the
 * document directly from ranked passages — grounded by construction, since
 * every section carries its [Sn] citation marker.
 */
function shortName(filename: string, max = 48): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").trim().slice(0, max) || filename.slice(0, max);
}

export function fallbackTitle(topic: string, kind: "report" | "slides"): string {
  if (topic && topic !== "overview of the uploaded sources") return topic.slice(0, 160);
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return kind === "slides" ? `Source overview — ${date}` : `Overview of your sources — ${date}`;
}

function extractiveReport(topic: string, ranked: RankedPassage[], citations: NotebookSourceCitation[]): ReportPlan {
  const indexOf = new Map(citations.map((c) => [c.chunkId, c.index]));
  const groups = new Map<string, RankedPassage[]>();
  for (const r of ranked) {
    const list = groups.get(r.sourceId) || [];
    if (list.length < 2) list.push(r);
    groups.set(r.sourceId, list);
    if (groups.size >= 6) break;
  }
  const picked = [...groups.values()].slice(0, 6);
  const sections = picked.map((chunks) => {
    const head = chunks[0];
    const section = (head.headingPath.at(-1) || "Key passages").slice(0, 60);
    const body = chunks
      .map((c) => `${c.text.slice(0, 800).trim()} [S${indexOf.get(c.chunkId) || "?"}]`)
      .join("\n\n");
    return {
      heading: `${shortName(head.sourceName)} — ${section}`.slice(0, 120),
      body,
      keyPoints: undefined as string[] | undefined,
    };
  });
  const sourceNames = [...new Set(ranked.map((r) => r.sourceName))];
  return {
    title: fallbackTitle(topic, "report"),
    executiveSummary: `Overview assembled directly from ${citations.length} cited passages across ${sourceNames.length} source${sourceNames.length === 1 ? "" : "s"}. Each section below quotes the source passages with their citation markers. (The assistant could not draft a written synthesis, so this is a faithful selection of the most relevant passages.)`,
    sections,
    takeaways: picked.map((chunks) => firstSentence(chunks[0].text)).filter(Boolean).slice(0, 6),
  };
}

function extractiveSlides(topic: string, ranked: RankedPassage[], citations: NotebookSourceCitation[]): SlidesPlan {
  const indexOf = new Map(citations.map((c) => [c.chunkId, c.index]));
  // Group by section so each slide pools the best sentences of one idea
  // instead of dumping a single raw chunk.
  const groups = new Map<string, RankedPassage[]>();
  for (const r of ranked) {
    const key = `${r.sourceId}::${r.headingPath.join(" › ")}`;
    const list = groups.get(key) || [];
    if (list.length < 3) list.push(r);
    groups.set(key, list);
    if (groups.size >= 10) break;
  }
  const seen = new Set<string>();
  const slides: SlidePlan[] = [...groups.values()].slice(0, 10).map((chunks) => {
    const head = chunks[0];
    const bullets: string[] = [];
    for (const c of chunks) {
      for (const s of splitSentences(c.text, 6, 180)) {
        const key = s.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        bullets.push(`${s} [S${indexOf.get(c.chunkId) || "?"}]`);
        if (bullets.length >= 5) break;
      }
      if (bullets.length >= 5) break;
    }
    return {
      title: (head.headingPath.at(-1) || shortName(head.sourceName)).slice(0, 120),
      subtitle: shortName(head.sourceName, 60),
      bullets: bullets.length ? bullets : [`${head.text.slice(0, 180)} [S${indexOf.get(head.chunkId) || "?"}]`],
      notes: shortName(head.sourceName, 60),
    };
  });
  return {
    title: fallbackTitle(topic, "slides"),
    slides,
  };
}

export type RankedPassage = {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  headingPath: string[];
  text: string;
  final: number;
};

export type DocumentEvidenceFile = {
  sourceId: string;
  sourceName: string;
  /** Chunks the file has in the library (0 = not indexed yet or failed). */
  total: number;
  /** Chunks from this file included in the pack. */
  used: number;
};

export type DocumentEvidence = {
  ranked: RankedPassage[];
  citations: NotebookSourceCitation[];
  topic: string;
  coverage: {
    totalChunks: number;
    usedChunks: number;
    truncated: boolean;
    mode: "full" | "targeted";
    filesTotal: number;
    filesUsed: number;
    perFile: DocumentEvidenceFile[];
  };
};

const EVIDENCE_MAX_CHUNKS = 60;
const EVIDENCE_MIN_TARGETED = 20;

function isGenericOverviewTopic(topic: string): boolean {
  const t = (topic || "").trim().toLowerCase();
  return (
    !t ||
    t === "overview of the uploaded sources" ||
    /^(overview|full overview|summary of everything|everything|all content|all)$/.test(t)
  );
}

/**
 * Full-coverage evidence collection for generated outputs (reports, slides,
 * and — via the same pack — the agent's EVIDENCE.md).
 *
 * - Empty/generic topic → per-file quotas in document order (up to 2 chunks
 *   per section), so one big file can never starve the rest. Every in-scope
 *   file is represented instead of 12 embedding lottery winners.
 * - Concrete topic → large retrieval (top 60) filtered by a relative score
 *   floor, keeping ALL relevant chunks instead of a fixed top-k slice.
 */
export async function collectDocumentEvidence(
  notebookId: string,
  topic: string,
  scope?: string[]
): Promise<DocumentEvidence> {
  const cleanTopic = (topic || "").trim() || "overview of the uploaded sources";
  const root = notebookSessionDir(notebookId);
  const lib = await loadLibrary(root, notebookId);
  const scopeSet = scope?.length ? new Set(scope) : null;
  const scopedOrder = lib.order.filter((id) => {
    const c = lib.chunks[id];
    return c && (!scopeSet || scopeSet.has(c.fileId));
  });
  const totalChunks = scopedOrder.length;
  const emptyCoverage = (mode: "full" | "targeted"): DocumentEvidence => ({
    ranked: [],
    citations: [],
    topic: cleanTopic,
    coverage: { totalChunks, usedChunks: 0, truncated: false, mode, filesTotal: 0, filesUsed: 0, perFile: [] },
  });
  if (!totalChunks) return emptyCoverage("full");

  // Chunks grouped by file, document order preserved inside each file.
  const byFile = new Map<string, typeof scopedOrder>();
  for (const id of scopedOrder) {
    const c = lib.chunks[id];
    if (!c) continue;
    const list = byFile.get(c.fileId) || [];
    list.push(id);
    byFile.set(c.fileId, list);
  }
  const fileNameOf = (fileId: string) => lib.documents[fileId]?.filename || fileId;

  if (isGenericOverviewTopic(topic)) {
    // Round-robin over files (≤2 chunks per section, per-file budget first)
    // so a 40-section file cannot eat the whole 60-chunk budget.
    const fileIds = [...byFile.keys()];
    const perFileBudget = Math.max(4, Math.ceil(EVIDENCE_MAX_CHUNKS / Math.max(1, fileIds.length)));
    const usedInSection = new Map<string, number>();
    const usedInFile = new Map<string, number>();
    const taken = new Set<string>();
    const ranked: RankedPassage[] = [];
    const takeNext = (fileId: string, respectBudget: boolean): boolean => {
      const ids = byFile.get(fileId) || [];
      for (const id of ids) {
        if (ranked.length >= EVIDENCE_MAX_CHUNKS) return false;
        if (taken.has(id)) continue;
        const c = lib.chunks[id];
        if (!c) continue;
        if ((usedInSection.get(c.sectionId) || 0) >= 2) continue;
        if (respectBudget && (usedInFile.get(fileId) || 0) >= perFileBudget) return true;
        taken.add(id);
        usedInSection.set(c.sectionId, (usedInSection.get(c.sectionId) || 0) + 1);
        usedInFile.set(fileId, (usedInFile.get(fileId) || 0) + 1);
        ranked.push({
          chunkId: c.id,
          sourceId: c.fileId,
          sourceName: fileNameOf(c.fileId),
          headingPath: c.headingPath,
          text: c.text,
          final: 1,
        });
      }
      return true;
    };
    for (let pass = 0; pass < 2 && ranked.length < EVIDENCE_MAX_CHUNKS; pass++) {
      for (const fileId of fileIds) {
        if (ranked.length >= EVIDENCE_MAX_CHUNKS) break;
        takeNext(fileId, pass === 0);
      }
    }
    const perFile: DocumentEvidenceFile[] = fileIds.map((fileId) => ({
      sourceId: fileId,
      sourceName: fileNameOf(fileId),
      total: (byFile.get(fileId) || []).length,
      used: usedInFile.get(fileId) || 0,
    }));
    return {
      ranked,
      citations: toCitations(ranked),
      topic: cleanTopic,
      coverage: {
        totalChunks,
        usedChunks: ranked.length,
        truncated: totalChunks > ranked.length,
        mode: "full",
        filesTotal: fileIds.length,
        filesUsed: perFile.filter((f) => f.used > 0).length,
        perFile,
      },
    };
  }

  const found = await hybridRetrieve(notebookId, cleanTopic, EVIDENCE_MAX_CHUNKS, scope);
  if (!found.results.length) return emptyCoverage("targeted");
  const sorted = [...found.results].sort((a, b) => b.final - a.final);
  const best = sorted[0].final;
  const floor = Math.max(0.12, best * 0.3);
  let kept = sorted.filter((r) => r.final >= floor);
  if (kept.length < Math.min(EVIDENCE_MIN_TARGETED, sorted.length)) {
    kept = sorted.slice(0, Math.min(EVIDENCE_MIN_TARGETED, sorted.length));
  }
  const ranked: RankedPassage[] = kept.slice(0, EVIDENCE_MAX_CHUNKS).map((r) => ({
    chunkId: r.chunkId,
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    headingPath: r.headingPath,
    text: r.text,
    final: r.final,
  }));
  const usedByFile = new Map<string, number>();
  for (const r of ranked) usedByFile.set(r.sourceId, (usedByFile.get(r.sourceId) || 0) + 1);
  const perFile: DocumentEvidenceFile[] = [...byFile.keys()].map((fileId) => ({
    sourceId: fileId,
    sourceName: fileNameOf(fileId),
    total: (byFile.get(fileId) || []).length,
    used: usedByFile.get(fileId) || 0,
  }));
  return {
    ranked,
    citations: toCitations(ranked),
    topic: cleanTopic,
    coverage: {
      totalChunks,
      usedChunks: ranked.length,
      truncated: sorted.length > ranked.length,
      mode: "targeted",
      filesTotal: perFile.length,
      filesUsed: perFile.filter((f) => f.used > 0).length,
      perFile,
    },
  };
}

/** One repair attempt with a stricter prompt before surfacing an error. */
async function planWithRepair(
  kind: NotebookDocumentKind,
  system: string,
  user: string,
  input: GenerateDocumentInput
): Promise<unknown> {
  const first = await planWithLlm(system, user, input);
  try {
    const parsed = extractDocumentJson(first);
    if (kind === "report") sanitizeReportPlan(parsed);
    else sanitizeSlidesPlan(parsed);
    return parsed;
  } catch {
    input.onStatus?.("First draft came back malformed — retrying with stricter format…");
    const repairSystem = `${system}\nCRITICAL: your previous reply was not usable. Reply with a single valid JSON object only — no markdown fences, no prose before or after.`;
    const second = await planWithLlm(repairSystem, user, input);
    return extractDocumentJson(second); // throws a descriptive error when still invalid
  }
}

function reportMarkdown(plan: ReportPlan, citations: NotebookSourceCitation[]): string {
  const lines = [`# ${plan.title}`, "", "## Executive summary", "", plan.executiveSummary || "_No summary._", ""];
  plan.sections.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.heading}`, "", s.body || "_No content._", "");
    if (s.keyPoints?.length) {
      lines.push(...s.keyPoints.map((k) => `- ${k}`), "");
    }
  });
  if (plan.takeaways.length) lines.push("## Key takeaways", "", ...plan.takeaways.map((t) => `- ${t}`), "");
  lines.push("## Sources", "", ...citations.map((c) => `- [S${c.index}] ${c.sourceName} — ${c.heading.slice(0, 120)}`));
  return lines.join("\n") + "\n";
}

function slidesMarkdown(plan: SlidesPlan, citations: NotebookSourceCitation[]): string {
  const lines = [`# ${plan.title} (slides)`, ""];
  plan.slides.forEach((s, i) => {
    lines.push(`## Slide ${i + 1}: ${s.title}`, "");
    for (const b of s.bullets) lines.push(`- ${b}`);
    lines.push("");
    if (s.notes) lines.push(`> Notes: ${s.notes}`, "");
  });
  lines.push("## Sources", "", ...citations.map((c) => `- [S${c.index}] ${c.sourceName} — ${c.heading.slice(0, 120)}`));
  return lines.join("\n") + "\n";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function paras(text: string): string {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (/^[-*]\s+/.test(p)) return `<li>${escapeHtml(p.replace(/^[-*]\s+/, ""))}</li>`;
      return `<p>${escapeHtml(p)}</p>`;
    })
    .join("\n")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
}

/** Structured HTML for PDF: real headings/paragraphs/lists, never raw markdown. */
function reportHtmlFromPlan(plan: ReportPlan, citations: NotebookSourceCitation[]): string {
  const parts = [`<h1>${escapeHtml(plan.title)}</h1>`, `<h2>Executive summary</h2>`, paras(plan.executiveSummary || "No summary.")];
  plan.sections.forEach((s, i) => {
    parts.push(`<h2>${i + 1}. ${escapeHtml(s.heading)}</h2>`, paras(s.body || "No content."));
    if (s.keyPoints?.length) {
      parts.push(`<ul>\n${s.keyPoints.map((k) => `<li>${escapeHtml(k)}</li>`).join("\n")}\n</ul>`);
    }
  });
  if (plan.takeaways.length) {
    parts.push(`<h2>Key takeaways</h2>`, `<ul>\n${plan.takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join("\n")}\n</ul>`);
  }
  parts.push(`<h2>Sources</h2>`, `<ul class="sources">\n${citations.map((c) => `<li>[S${c.index}] ${escapeHtml(c.sourceName)} — ${escapeHtml(c.heading.slice(0, 120))}</li>`).join("\n")}\n</ul>`);
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  parts.push(`<div class="footer">${escapeHtml(plan.title.slice(0, 80))} · ${today}</div>`);
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${escapeHtml(plan.title)}</title><style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px;color:#333;line-height:1.55}h1{font-size:26px;color:#1F3864}h2{font-size:18px;margin-top:28px;color:#1F3864;border-bottom:2px solid #2E75B6;padding-bottom:4px}ul{padding-left:22px}li{margin:4px 0}ul.sources li{color:#808080;font-size:13px}.footer{margin-top:40px;padding-top:8px;border-top:1px solid #ccc;color:#808080;font-size:12px}</style></head><body>${parts.join("\n")}</body></html>`;
}

/**
 * Parses a plain-Markdown report (the prose fallback weak models CAN write)
 * into the structured plan. Throws "empty-report" when nothing usable.
 */
export function markdownToReportPlan(md: string, fallbackTitle: string): ReportPlan {
  const lines = md.replace(/```/g, "").split("\n");
  let title = "";
  const summary: string[] = [];
  const sections: Array<{ heading: string; body: string[]; keyPoints: string[] }> = [];
  const takeaways: string[] = [];
  let current: { heading: string; body: string[]; keyPoints: string[] } | null = null;
  let mode: "summary" | "section" | "takeaways" | "none" = "summary";
  const flush = () => {
    if (current && (current.body.length || current.keyPoints.length)) sections.push(current);
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h1 = line.match(/^#\s+(.*)/);
    if (h1 && !title) {
      title = h1[1].trim().slice(0, 160);
      continue;
    }
    const h2 = line.match(/^#{2,3}\s+(.*)/);
    if (h2) {
      const heading = h2[1].trim();
      flush();
      if (/executive|summary|overview|introduction/i.test(heading)) mode = "summary";
      else if (/takeaway|conclusion|key points?/i.test(heading)) mode = "takeaways";
      else if (/source|citation|reference/i.test(heading)) mode = "none";
      else {
        mode = "section";
        current = { heading: heading.replace(/^\d+[.)]\s*/, "").slice(0, 120), body: [], keyPoints: [] };
      }
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) {
      const text = bullet[1].trim();
      if (!text) continue;
      if (mode === "takeaways") takeaways.push(text.slice(0, 300));
      else if (mode === "section" && current) current.keyPoints.push(text.slice(0, 300));
      else if (mode === "summary") summary.push(text);
      continue;
    }
    if (/^>\s?/.test(line)) continue; // speaker notes / quotes add no report value
    if (mode === "takeaways") takeaways.push(line.slice(0, 300));
    else if (mode === "section" && current) current.body.push(line);
    else if (mode === "summary") summary.push(line);
  }
  flush();
  if (!sections.length) throw new Error("empty-report");
  return {
    title: (title || fallbackTitle).slice(0, 160),
    executiveSummary: summary.join("\n").slice(0, 4000),
    sections: sections.slice(0, 12).map((s) => ({
      heading: s.heading,
      body: s.body.join("\n").slice(0, 6000),
      keyPoints: s.keyPoints.length ? s.keyPoints.slice(0, 6) : undefined,
    })),
    takeaways: takeaways.slice(0, 8),
  };
}

/** Parses a plain-Markdown slide outline into a plan. Conventions:
 *  `# ` deck title, `## ` slide title, `- ` bullets (<=5 kept),
 *  fenced code blocks attach as a code card, `> Title: text` as a callout. */
export function markdownToSlidesPlan(md: string, fallbackTitle: string): SlidesPlan {
  const lines = md.split("\n");
  let title = "";
  const slides: SlidePlan[] = [];
  let current: SlidePlan | null = null;
  let inCode = false;
  let skipping = false;
  let codeBuf: string[] = [];
  const flush = () => {
    if (current && (current.title !== "Slide" || current.bullets.length || current.code || current.callouts?.length)) {
      slides.push({ ...current, callouts: current.callouts?.length ? current.callouts : undefined });
    }
    current = null;
    codeBuf = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      if (inCode && current && codeBuf.length && !skipping) {
        current.code = (current.code ? `${current.code}\n` : "") + codeBuf.join("\n").slice(0, 600);
      }
      codeBuf = [];
      // Mermaid diagrams can't render in pptx — skip the block, never paste it.
      skipping = !inCode && /^```\s*mermaid/i.test(line);
      inCode = !inCode;
      continue;
    }
    // A mermaid dump pasted mid-line (bullets, prose) opens skip mode until
    // its closing fence — but only when the fence is unclosed on this line.
    // Complete inline pairs fall through to the bullet branch, which drops them.
    if (/```mermaid/i.test(line) && (line.match(/```/g) || []).length < 2) {
      skipping = true;
      inCode = true;
      codeBuf = [];
      continue;
    }
    if (skipping) {
      if (/```/.test(line)) {
        skipping = false;
        inCode = false;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      if (current && codeBuf.join("\n").length < 600) codeBuf.push(raw.replace(/\t/g, "  ").slice(0, 120));
      continue;
    }
    if (!line) continue;
    const h1 = line.match(/^#\s+(.*)/);
    if (h1 && !title) {
      title = h1[1].trim().slice(0, 160);
      continue;
    }
    const h2 = line.match(/^#{2,3}\s+(.*)/);
    if (h2) {
      const heading = h2[1].trim();
      if (/source|citation|reference/i.test(heading)) {
        flush();
        current = null;
        break;
      }
      flush();
      current = { title: heading.replace(/^slide\s*\d+\s*[:.-]?\s*/i, "").slice(0, 120) || "Slide", bullets: [] };
      continue;
    }
    const quote = line.match(/^>\s?(.*)/);
    if (quote && current) {
      const text = quote[1].trim();
      if (!text) continue;
      const split = text.match(/^([^:]{2,60}):\s+(.*)/);
      const callouts = current.callouts || (current.callouts = []);
      if (callouts.length < 3) {
        callouts.push(split ? { title: split[1].trim(), text: split[2].trim().slice(0, 300) } : { title: "", text: text.slice(0, 300) });
      }
      continue;
    }
    const bullet = line.match(/^[-*•+]\s+(.*)/);
    if (bullet && current && current.bullets.length < 5) {
      const text = bullet[1].trim();
      if (!text || /```/.test(text)) continue;
      // Lone citation markers and emptied formulas carry no content.
      const residue = text.replace(/\$/g, "").replace(/\s+/g, " ").trim();
      if (!residue || /^\[S\d+\]$/.test(residue)) continue;
      current.bullets.push(text.slice(0, 220));
    }
  }
  flush();
  if (!slides.length) throw new Error("empty-slides");
  return { title: (title || fallbackTitle).slice(0, 160), slides: slides.slice(0, 14) };
}

async function renderDocx(plan: ReportPlan, citations: NotebookSourceCitation[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const NAVY = "1F3864";
  const MUTED = "808080";
  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: plan.title, color: NAVY })] }),
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Executive summary", color: NAVY })] }),
    new Paragraph({ children: [new TextRun(plan.executiveSummary || "No summary.")] }),
  ];
  plan.sections.forEach((s, i) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: `${i + 1}. ${s.heading}`, color: NAVY })] }));
    for (const para of s.body.split(/\n+/).slice(0, 12)) {
      const text = para.trim().replace(/^#{1,3}\s+/, "");
      if (!text) continue;
      const bullet = text.match(/^[-*]\s+(.*)/);
      if (bullet) children.push(new Paragraph({ text: bullet[1], bullet: { level: 0 } }));
      else children.push(new Paragraph({ children: [new TextRun(text)] }));
    }
    for (const k of s.keyPoints || []) {
      children.push(new Paragraph({ text: k.replace(/^[-*]\s+/, ""), bullet: { level: 0 } }));
    }
  });
  if (plan.takeaways.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Key takeaways", color: NAVY })] }));
    for (const t of plan.takeaways) children.push(new Paragraph({ text: t, bullet: { level: 0 } }));
  }
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Sources", color: NAVY })] }));
  for (const c of citations) {
    children.push(new Paragraph({ children: [new TextRun({ text: `[S${c.index}] ${c.sourceName} — ${c.heading}`, color: MUTED, size: 20 })] }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function renderPdf(plan: ReportPlan, citations: NotebookSourceCitation[]): Promise<Buffer> {
  const electronRequire = createRequire(import.meta.url);
  type Win = { loadURL: (url: string) => Promise<void>; webContents: { printToPDF: (opts: unknown) => Promise<Uint8Array> }; destroy: () => void };
  let BrowserWindow: (new (opts: unknown) => Win) | null = null;
  try {
    const mod = electronRequire("electron") as unknown as { BrowserWindow?: new (opts: unknown) => Win };
    if (mod && typeof mod === "object") BrowserWindow = mod.BrowserWindow || null;
  } catch { /* plain node */ }
  if (!BrowserWindow) throw new Error("PDF export needs the desktop app — pick DOCX instead.");
  const html = reportHtmlFromPlan(plan, citations);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const data = await win.webContents.printToPDF({ printBackground: true });
    return Buffer.from(data);
  } finally {
    try { win.destroy(); } catch { /* ignore */ }
  }
}

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
  pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
};

/** Transliterates LaTeX into readable plain text for slides (no math renderer in pptx). */
function simplifyLatex(text: string): string {
  let out = text;
  out = out.replace(/\\(mathbb|mathbf|mathrm|mathit|mathsf|mathtt|boldsymbol)\{([^}]*)\}/g, "$2");
  out = out.replace(/\\(text|textrm|textit|textbf)\{([^}]*)\}/g, "$2");
  out = out.replace(/\\(vec|hat|tilde|bar|dot|ddot)\{([^}]*)\}/g, "$2");
  out = out.replace(/\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)(?![a-zA-Z])/g, (_m, name) => GREEK[name] || name);
  out = out.replace(/\\(rightarrow|to)\b/g, "→").replace(/\\leftarrow\b/g, "←");
  out = out.replace(/\\(times|cdot)\b/g, "×").replace(/\\in\b/g, "∈");
  out = out.replace(/\\([{}_$%#&])/g, "$1").replace(/\\\\/g, "\\");
  out = out.replace(/\$\$/g, "").replace(/\$/g, "");
  return out;
}

/** Strips markdown debris (fences, bullets, bold markers) → plain slide text. */
function cleanSlideText(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, " ");
  out = simplifyLatex(out);
  out = out.replace(/^\s*(?:#{1,4}\s+|[-*•+]\s+|\d+[.)]\s+)/, "");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  out = out.replace(/`([^`]*)`/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}

export function cleanSlideTitle(title: string): string {
  const cleaned = cleanSlideText(title).replace(/[:;,.]+$/, "").trim();
  return cleaned.slice(0, 120) || "Slide";
}

/** Plain-text bullet cleaning shared by the fallback renderer (content hygiene only — no theme). */
function cleanBullets(bullets: string[]): string[] {
  return bullets
    .map((b) => cleanSlideText(b))
    .filter((b) => b && !/^\[S\d+\]$/.test(b) && !/```/.test(b) && !/^\s*mermaid\b/i.test(b));
}

async function renderPptx(plan: SlidesPlan, citations: NotebookSourceCitation[]): Promise<Buffer> {
  // Fallback renderer with a modest built-in theme (navy titles, accent
  // callouts, footers). It can never match a skill-designed deck, but its
  // output must be usable on its own. Designed decks come from the
  // skill-driven script path (notebook-documents-agent.ts), where the model
  // writes the python-pptx code and decides theme, layout and content.
  const NAVY = "1F3864";
  const ACCENT = "2E75B6";
  const BODY = "333333";
  const MUTED = "808080";
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const mod = (await import("pptxgenjs")) as unknown as { default?: unknown } & Record<string, unknown>;
  const PptxGenJS = (mod.default || mod) as unknown as new () => {
    title: string;
    addSlide: () => { addText: (t: unknown, o?: unknown) => void };
    write: (opts: { outputType: "nodebuffer" }) => Promise<Buffer>;
  };
  const pres = new PptxGenJS();
  pres.title = plan.title;
  let slideNo = 0;
  const footer = (slide: { addText: (t: unknown, o?: unknown) => void }, n: number) => {
    slide.addText(`${plan.title.slice(0, 60)}  •  ${today}`, { x: 0.5, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: MUTED });
    slide.addText(String(n), { x: 9.3, y: 7.05, w: 0.7, h: 0.3, fontSize: 9, color: MUTED, align: "right" });
  };
  slideNo++;
  const cover = pres.addSlide();
  cover.addText("NOTEBOOK", { x: 0.5, y: 0.9, w: 9, h: 0.4, fontSize: 13, bold: true, color: ACCENT });
  cover.addText(plan.title, { x: 0.5, y: 1.3, w: 9, h: 1.4, fontSize: 32, bold: true, color: NAVY });
  if (plan.subtitle) cover.addText(plan.subtitle, { x: 0.5, y: 2.8, w: 9, h: 0.6, fontSize: 16, color: MUTED });
  cover.addText(`Grounded in ${citations.length} cited passage${citations.length === 1 ? "" : "s"} — every claim traceable to your sources.`, { x: 0.5, y: 3.6, w: 9, h: 0.6, fontSize: 14, italic: true, color: MUTED });
  footer(cover, slideNo);
  for (const s of plan.slides) {
    const title = cleanSlideTitle(s.title);
    const bullets = cleanBullets(s.bullets).slice(0, 6);
    const code = s.code && !/mermaid|graph\s+(LR|TD|TB|BT)/i.test(s.code) ? s.code.slice(0, 600) : undefined;
    const callouts = (s.callouts || []).filter((c) => c.title || c.text).slice(0, 3);
    if ((!title || title === "Slide") && !bullets.length && !code && !callouts.length) continue;
    slideNo++;
    const slide = pres.addSlide();
    slide.addText(title || "Slide", { x: 0.5, y: 0.25, w: 9, h: 0.8, fontSize: 28, bold: true, color: NAVY });
    let y = 1.2;
    if (s.subtitle) {
      slide.addText(cleanSlideText(s.subtitle), { x: 0.5, y, w: 9, h: 0.5, fontSize: 15, color: MUTED });
      y += 0.6;
    }
    if (bullets.length) {
      slide.addText(bullets.map((b) => ({ text: b, options: { breakLine: true, color: BODY } })), { x: 0.5, y, w: 9, h: 3.2, fontSize: 14, color: BODY, bullet: true });
      y += 3.3;
    }
    if (code) {
      slide.addText(code, { x: 0.5, y, w: 9, h: 1.5, fontSize: 10, fontFace: "Consolas", color: BODY });
      y += 1.6;
    }
    for (const c of callouts) {
      const label = (c.title || "Note").slice(0, 60);
      const body = cleanSlideText(c.text).slice(0, 340);
      slide.addText(
        [{ text: `${label}: `, options: { bold: true, color: ACCENT } }, { text: body, options: { color: BODY } }],
        { x: 0.5, y, w: 9, h: 0.6, fontSize: 13 }
      );
      y += 0.65;
    }
    // Speaker notes are intentionally omitted here: rendered as body text
    // they overflow and truncate mid-sentence. They remain in the preview.
    footer(slide, slideNo);
  }
  slideNo++;
  const sources = pres.addSlide();
  sources.addText("Sources", { x: 0.5, y: 0.25, w: 9, h: 0.8, fontSize: 28, bold: true, color: NAVY });
  const byFile = new Map<string, NotebookSourceCitation[]>();
  for (const c of citations) {
    const list = byFile.get(c.sourceName) || [];
    list.push(c);
    byFile.set(c.sourceName, list);
  }
  const sourceLines: string[] = [];
  for (const [file, list] of byFile) {
    sourceLines.push(`${shortName(file, 60)} (${list.length})`);
    for (const c of list.slice(0, 12)) sourceLines.push(`  [S${c.index}] ${c.heading.slice(0, 90)}`);
  }
  sources.addText(sourceLines.join("\n").slice(0, 3000), { x: 0.5, y: 1.2, w: 9, h: 5.4, fontSize: 11, color: BODY });
  footer(sources, slideNo);
  const out = await pres.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as unknown as Uint8Array);
}

export async function generateNotebookDocument(
  notebookId: string,
  input: GenerateDocumentInput
): Promise<{ doc: NotebookDocument; fallbackReason: string | null }> {
  if (input.kind === "report" && input.format !== "docx" && input.format !== "pdf") {
    throw new Error("Reports support DOCX or PDF — pick one.");
  }
  if (input.kind === "slides" && input.format !== "pptx") {
    throw new Error("Presentations export as PPTX.");
  }
  const status = input.onStatus || (() => {});
  status("Searching notebook sources…");
  const topic = input.prompt?.trim() || "overview of the uploaded sources";
  const scope = input.fileIds?.length ? input.fileIds : undefined;
  const [evidence, outline] = await Promise.all([
    collectDocumentEvidence(notebookId, topic, scope),
    sessionOutline(notebookSessionDir(notebookId), notebookId).catch(() => []),
  ]);
  if (!evidence.ranked.length) {
    throw new Error("Not covered in your files — upload the relevant sources or widen the file scope first.");
  }
  const ranked = evidence.ranked;
  const citations = evidence.citations;
  const cov = evidence.coverage;
  status(
    cov.mode === "full"
      ? `Using ${ranked.length} passages from ${cov.filesUsed}/${cov.filesTotal} files…`
      : `Using ${ranked.length} passages relevant to the topic (${cov.filesUsed}/${cov.filesTotal} files)…`
  );
  const emptyFiles: string[] = [];
  try {
    const sources = await listNotebookSources(notebookId).catch(() => []);
    const inScope = scope?.length ? sources.filter((s) => scope.includes(s.id)) : sources;
    for (const s of inScope) {
      if (s.status !== "ready") emptyFiles.push(`${s.filename} (${s.status})`);
    }
  } catch { /* warnings are best-effort */ }
  if (emptyFiles.length) {
    status(`⚠ Not indexed yet: ${emptyFiles.slice(0, 3).join(", ")}${emptyFiles.length > 3 ? ` +${emptyFiles.length - 3} more` : ""} — wait for indexing or re-index, then regenerate for full coverage.`);
  }
  const unusedFiles = cov.perFile.filter((f) => f.total > 0 && f.used === 0).map((f) => f.sourceName);
  if (unusedFiles.length) {
    status(`⚠ No passages used from ${unusedFiles.slice(0, 3).join(", ")}${unusedFiles.length > 3 ? ` +${unusedFiles.length - 3} more` : ""} — the topic matched other files.`);
  }
  const context = composeContextBlock(
    ranked.map((r) => ({ headingPath: [r.sourceName, ...r.headingPath], text: r.text })),
    40000
  );
  const files = outline.map((d) => d.filename).join(", ");
  const baseInstructions = input.instructions ? `\nNotebook goal:\n${input.instructions}` : "";

  // Skill-based path first: a Home-style agent run follows the pptx/docx/pdf
  // skill to design the file, grounded strictly in the retrieved evidence.
  // The failure reason is returned (not just flashed in status) so the UI can
  // show why the built-in renderer was used instead.
  let fallbackReason: string | null = null;
  try {
    const { generateNotebookDocumentViaAgent } = await import("./notebook-documents-agent.js");
    const doc = await generateNotebookDocumentViaAgent(notebookId, input, { ranked, citations, topic, coverage: evidence.coverage });
    return { doc, fallbackReason };
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    status(`Skill build failed (${fallbackReason}) — using built-in renderer…`);
  }

  if (input.kind === "report") {
    status("Drafting the grounded report…");
    const system = `You are a precise research analyst. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "executiveSummary": string, "sections": [{"heading": string, "body": string, "keyPoints": string[]}], "takeaways": string[]}. Rules: 4-7 sections with non-empty body text; every factual claim must be traceable to the SOURCES and end relevant sentences with [S1]/[S2] markers from the citation list; never invent facts; if the topic is broad, cover the main themes.${baseInstructions}`;
    const user = `Topic: ${topic}\nFiles: ${files || "(unknown)"}\nCitation markers available: ${citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;
    let plan: ReportPlan;
    try {
      plan = sanitizeReportPlan(await planWithRepair("report", system, user, input));
    } catch {
      // Tier 2: weak models can write prose but not JSON — parse Markdown.
      status("Structured draft failed — asking for a plain written report…");
      try {
        const prose = await planWithLlm(
          `You write clear reports in Markdown only. Use "# " for the title, "## " for 4-7 section headings, flowing paragraphs, "- " for bullet points, and a final "## Key takeaways" list. Every factual claim must be traceable to the SOURCES and carry its [S1]/[S2] marker. Never invent facts.${baseInstructions}`,
          user,
          input
        );
        plan = markdownToReportPlan(prose, fallbackTitle(topic, "report"));
      } catch {
        // Tier 3: assemble faithfully from passages — grounded by construction.
        status("Model draft failed — assembling the report directly from your sources…");
        plan = extractiveReport(topic, ranked, citations);
      }
    }
    const preview = reportMarkdown(plan, citations);
    status(input.format === "pdf" ? "Rendering PDF…" : "Rendering Word document…");
    const buffer = input.format === "pdf" ? await renderPdf(plan, citations) : await renderDocx(plan, citations);
    return { doc: await persistDocument(notebookId, input, plan.title, buffer, preview, citations, plan.sections.length, 0), fallbackReason };
  }

  status("Planning the grounded slide deck…");
  const slidesSystem = `You are a precise presentation designer. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "subtitle": string, "slides": [{"title": string, "subtitle": string, "bullets": string[3-5], "code": string, "callouts": [{"title": string, "text": string}], "notes": string}]}. Rules: 8-12 slides; short bullets (<=18 words, "Lead — explanation" shape where natural); optional fenced-command "code" for procedures/commands; optional 1-3 "callouts" highlight cards; every slide traceable to SOURCES with [S1]/[S2] markers where factual; title slide content is separate; never invent facts.${baseInstructions}`;
  const slidesUser = `Topic: ${topic}\nFiles: ${files || "(unknown)"}\nCitation markers available: ${citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;
  let plan: SlidesPlan;
  try {
    plan = sanitizeSlidesPlan(await planWithRepair("slides", slidesSystem, slidesUser, input));
  } catch {
    // Tier 2: plain-Markdown outline ("## " slide title, "- " bullets).
    status("Structured draft failed — asking for a plain slide outline…");
    try {
      const prose = await planWithLlm(
        `You design presentations in Markdown only. Use "# " for the deck title, "## " for 8-12 slide titles, and "- " for 3-5 short bullets (<=18 words, "Lead — explanation" shape) under each slide. Optional: a fenced code block for commands, and "> Title: text" lines for highlight cards. Every factual bullet must carry its [S1]/[S2] source marker. No other text.${baseInstructions}`,
        slidesUser,
        input
      );
      plan = markdownToSlidesPlan(prose, fallbackTitle(topic, "slides"));
    } catch {
      // Tier 3: assemble faithfully from passages — grounded by construction.
      status("Model draft failed — assembling the slides directly from your sources…");
      plan = extractiveSlides(topic, ranked, citations);
    }
  }
  const preview = slidesMarkdown(plan, citations);
  status("Rendering PowerPoint file…");
  const buffer = await renderPptx(plan, citations);
  return { doc: await persistDocument(notebookId, input, plan.title, buffer, preview, citations, 0, plan.slides.length + 2), fallbackReason };
}

export type RegisterDocumentInput = {
  kind: NotebookDocumentKind;
  format: NotebookDocumentFormat;
  title: string;
  filename: string;
  size: number;
  prompt?: string;
  preview: string;
  citations: NotebookSourceCitation[];
  sectionCount: number;
  slideCount: number;
  engine?: NotebookDocument["engine"];
};

/** Metadata-only registration for files already on disk (skill-agent path). */
export async function registerNotebookDocument(notebookId: string, input: RegisterDocumentInput): Promise<NotebookDocument> {
  const now = new Date().toISOString();
  const doc: NotebookDocument = {
    id: uid("nbdoc"),
    notebookId,
    kind: input.kind,
    format: input.format,
    title: input.title,
    filename: input.filename,
    size: input.size,
    prompt: (input.prompt || "").slice(0, 2000),
    preview: input.preview.slice(0, 20000),
    citations: input.citations.slice(0, 24),
    sectionCount: input.sectionCount,
    slideCount: input.slideCount,
    engine: input.engine || "builtin",
    createdAt: now,
    updatedAt: now,
  };
  const docs = await readDocs(notebookId);
  docs.unshift(doc);
  await writeDocs(notebookId, docs.slice(0, 100));
  return doc;
}

export async function persistDocument(
  notebookId: string,
  input: GenerateDocumentInput,
  title: string,
  buffer: Buffer,
  preview: string,
  citations: NotebookSourceCitation[],
  sectionCount: number,
  slideCount: number
): Promise<NotebookDocument> {
  const ext = input.format;
  const now = new Date().toISOString();
  const id = uid("nbdoc");
  const filename = `${safeStem(title, input.kind === "slides" ? "presentation" : "report")}_${id.slice(-6)}.${ext}`;
  await fs.mkdir(docsDir(notebookId), { recursive: true });
  await fs.writeFile(path.join(docsDir(notebookId), filename), buffer);
  return registerNotebookDocument(notebookId, {
    kind: input.kind,
    format: input.format,
    title,
    filename,
    size: buffer.length,
    prompt: input.prompt,
    preview,
    citations,
    sectionCount,
    slideCount,
  });
}
