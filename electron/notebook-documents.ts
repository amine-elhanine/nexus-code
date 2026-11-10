import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { composeContextBlock, toCitations, uid } from "./notebook-text.js";
import { listNotebookSources, notebookSessionDir, type NotebookSourceCitation } from "./notebook-store.js";
import { hybridRetrieve } from "./notebook-rag.js";
import { loadLibrary, sessionOutline } from "./notebook-library.js";
import { notebookGenerationInvokeOptions } from "./notebook-generation.js";
import { writeFileAtomic } from "./atomic-write.js";
import { invokeChatText } from "./agentcore/llm/invoke.js";
import { systemMsg, userMsg } from "./agentcore/messages.js";

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
  runId?: string;
  isCancelled?: () => boolean;
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
  paragraphs?: string[];
  bullets: string[];
  table?: { headers: string[]; rows: string[][] };
  code?: string;
  callouts?: SlideCallout[];
  notes?: string;
  /** Image URL or data URI to embed on the slide (renderers fetch http(s)). */
  image?: string;
  imageAlt?: string;
};

type SlidesPlan = {
  title: string;
  subtitle?: string;
  coverImage?: string;
  slides: SlidePlan[];
};

function docsPath(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "documents.json");
}
export function docsDir(notebookId: string) {
  return path.join(notebookSessionDir(notebookId), "documents");
}
export function safeStem(title: string, fallback: string) {
  // Apostrophes, ampersands, and percent signs survive filesystem naming but
  // are shell/python metacharacters — titles are model-authored (grounded in
  // untrusted documents), so strip them too.
  const stem = title.replace(/[<>:"/\\|?*`'$&%!^\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
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
  // Atomic (temp + rename): a crash mid-write must not truncate the doc index.
  await writeFileAtomic(docsPath(notebookId), JSON.stringify(docs, null, 2));
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

// Shared ranked-passages → citations helper now lives in notebook-text.js;
// re-exported here for existing importers of the documents module.
export { toCitations };

function checkDocumentCancellation(input: GenerateDocumentInput) {
  if (input.isCancelled?.()) throw new Error("Document generation cancelled.");
}

async function planWithLlm(system: string, user: string, input: GenerateDocumentInput): Promise<string> {
  checkDocumentCancellation(input);
  if (input.generate) {
    const response = await input.generate(system, user);
    checkDocumentCancellation(input);
    return response;
  }
  const { listProviders } = await import("./store.js");
  const { createChatModel } = await import("./providers.js");
  const providers = await listProviders();
  checkDocumentCancellation(input);
  const provider = input.providerId ? providers.find((p) => p.id === input.providerId) : providers[0];
  if (!provider) throw new Error("Configure a chat provider first (Providers button, top right).");
  const modelName = input.model || provider.models[0];
  if (!modelName) throw new Error("No chat model selected.");
  const llm = await createChatModel(provider, modelName);
  const text = await invokeChatText(llm, [systemMsg(system), userMsg(user)], notebookGenerationInvokeOptions(input.runId));
  checkDocumentCancellation(input);
  return text;
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
      image: typeof o.image === "string" && /^https?:\/\/|^data:image\//i.test(o.image) ? o.image.slice(0, 500_000) : undefined,
      imageAlt: typeof o.imageAlt === "string" ? o.imageAlt.slice(0, 160) : undefined,
    } as SlidePlan;
  }).filter((s) => s.title !== "Slide" || s.bullets.length || s.code || s.callouts?.length || s.image);
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
    executiveSummary: summary.join("\n").slice(0, 10000),
    sections: sections.slice(0, 50).map((s) => ({
      heading: s.heading,
      body: s.body.join("\n").slice(0, 30000),
      keyPoints: s.keyPoints.length ? s.keyPoints.slice(0, 20) : undefined,
    })),
    takeaways: takeaways.slice(0, 20),
  };
}

export interface DocumentTheme {
  name: string;
  ink: string;         // Primary dark tone (cover background, titles, table headers)
  accent: string;      // Primary accent (kickers, highlights, key phrases)
  accentSoft: string;  // Subtle accent tint (card borders, callouts)
  card: string;        // Card / section fill
  muted: string;       // Secondary / metadata text
  body: string;        // Primary body text
  light: string;       // Border lines, dividers
  bgLight: string;     // Content slide background (clean white or subtle tint)
  fontTitle: string;   // Title font
  fontBody: string;    // Body font
}

export const DOCUMENT_THEMES: Record<string, DocumentTheme> = {
  heritage: {
    name: "heritage",
    ink: "3E2723",       // Rich Walnut / Bronze
    accent: "D97706",    // Warm Terracotta Gold
    accentSoft: "FEF3C7",
    card: "FDFBF7",
    muted: "78716C",
    body: "292524",
    light: "E7E5E4",
    bgLight: "FFFFFF",
    fontTitle: "Georgia",
    fontBody: "Calibri",
  },
  navy: {
    name: "navy",
    ink: "0F172A",       // Slate Navy
    accent: "2563EB",    // Royal Blue
    accentSoft: "DBEAFE",
    card: "F8FAFC",
    muted: "64748B",
    body: "1E293B",
    light: "CBD5E1",
    bgLight: "FFFFFF",
    fontTitle: "Calibri",
    fontBody: "Calibri",
  },
  emerald: {
    name: "emerald",
    ink: "064E3B",       // Deep Forest
    accent: "059669",    // Emerald Green
    accentSoft: "D1FAE5",
    card: "F0FDF4",
    muted: "4B7268",
    body: "132E27",
    light: "A7F3D0",
    bgLight: "FFFFFF",
    fontTitle: "Calibri",
    fontBody: "Calibri",
  },
  ocean: {
    name: "ocean",
    ink: "0C2340",       // Deep Oceanic
    accent: "0284C7",    // Bright Sky / Teal
    accentSoft: "E0F2FE",
    card: "F0F9FF",
    muted: "475569",
    body: "0F172A",
    light: "BAE6FD",
    bgLight: "FFFFFF",
    fontTitle: "Calibri",
    fontBody: "Calibri",
  },
  crimson: {
    name: "crimson",
    ink: "450A0A",       // Deep Burgundy
    accent: "DC2626",    // Crimson Red
    accentSoft: "FEE2E2",
    card: "FFF5F5",
    muted: "713F3F",
    body: "1F1212",
    light: "FECACA",
    bgLight: "FFFFFF",
    fontTitle: "Arial",
    fontBody: "Arial",
  },
  indigo: {
    name: "indigo",
    ink: "1E1B4B",       // Deep Midnight Indigo
    accent: "6366F1",    // Vibrant Indigo
    accentSoft: "E0E7FF",
    card: "F5F7FF",
    muted: "6B7280",
    body: "1F2937",
    light: "C7D2FE",
    bgLight: "FFFFFF",
    fontTitle: "Calibri",
    fontBody: "Calibri",
  },
  regal: {
    name: "regal",
    ink: "2E1065",       // Deep Violet
    accent: "9333EA",    // Purple Accent
    accentSoft: "F3E8FF",
    card: "FAF5FF",
    muted: "6B7280",
    body: "1F2937",
    light: "E9D5FF",
    bgLight: "FFFFFF",
    fontTitle: "Georgia",
    fontBody: "Calibri",
  },
  charcoal: {
    name: "charcoal",
    ink: "18181B",       // Zinc Charcoal
    accent: "0D9488",    // Teal Accent
    accentSoft: "CCFBF1",
    card: "F4F4F5",
    muted: "71717A",
    body: "27272A",
    light: "E4E4E7",
    bgLight: "FFFFFF",
    fontTitle: "Arial",
    fontBody: "Calibri",
  },
};

export function pickDocumentTheme(topic: string): DocumentTheme {
  const t = String(topic || "").toLowerCase();

  if (/\b(history|ancient|pharaoh|pyramid|nile|rome|roman|greek|greece|egypt|morocco|ottoman|dynasty|kingdom|archaeol|civilization|medieval|antiquity|persian|byzantine|sultan|caliphate|century|bc\b|bce\b|heritage|monument)\b/i.test(t)) {
    return DOCUMENT_THEMES.heritage;
  }
  if (/\b(nature|biology|green|forest|plant|animal|wildlife|ecosystem|climate|earth|sustainab|agricul|ecolog|organic|botany|conservation)\b/i.test(t)) {
    return DOCUMENT_THEMES.emerald;
  }
  if (/\b(ocean|sea|marine|water|aqua|beach|river|lake|deep sea)\b/i.test(t)) {
    return DOCUMENT_THEMES.ocean;
  }
  if (/\b(war|battle|conflict|revolution|sports|fitness|boxing|military|attack|titan|anime|action|speed|energy|combat|martial)\b/i.test(t)) {
    return DOCUMENT_THEMES.crimson;
  }
  if (/\b(tech|software|code|ai|machine learning|developer|engineering|cyber|data|algorithm|neural|api|crypto|programming|python|javascript|cloud)\b/i.test(t)) {
    return DOCUMENT_THEMES.indigo;
  }
  if (/\b(art|music|literature|poetry|drama|theatre|film|cinema|philosophy|culture|fashion|design|creative)\b/i.test(t)) {
    return DOCUMENT_THEMES.regal;
  }
  if (/\b(finance|business|market|stock|bank|banking|economy|revenue|invest|manage|strategy|law|legal|corporate|enterprise|consulting|guide|solar|space|planet|astronomy|physics|science)\b/i.test(t)) {
    return DOCUMENT_THEMES.navy;
  }

  // Deterministic fallback based on string hash so distinct topics get consistent varied themes
  const themeKeys = Object.keys(DOCUMENT_THEMES);
  let hash = 0;
  for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) >>> 0;
  return DOCUMENT_THEMES[themeKeys[hash % themeKeys.length]];
}

/** Parses a plain-Markdown slide outline into a plan. Conventions:
 *  `# ` deck title, `## ` slide title, `- ` bullets (<=5 kept),
 *  fenced code blocks attach as a code card, `> Title: text` as a callout. */
export function markdownToSlidesPlan(md: string, fallbackTitle: string): SlidesPlan {
  const lines = md.split("\n");
  let title = "";
  let subtitle = "";
  let coverImage: string | undefined;
  let coverImageAlt: string | undefined;
  const slides: SlidePlan[] = [];
  let current: SlidePlan | null = null;
  let inCode = false;
  let skipping = false;
  let codeBuf: string[] = [];
  let tableLines: string[] = [];

  const flushTable = () => {
    if (current && tableLines.length >= 2) {
      const headers = tableLines[0].replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const dataRows = tableLines.slice(1).filter((r) => {
        const cells = r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        return !cells.every((c) => /^:?-+:?$/.test(c));
      }).map((r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
      if (headers.length && dataRows.length) {
        current.table = { headers: headers.slice(0, 6), rows: dataRows.slice(0, 8).map((r) => r.slice(0, 6)) };
      }
    }
    tableLines = [];
  };

  const flush = () => {
    flushTable();
    if (current && (current.title !== "Slide" || current.bullets.length || current.paragraphs?.length || current.table || current.code || current.callouts?.length || current.image)) {
      slides.push({
        ...current,
        callouts: current.callouts?.length ? current.callouts : undefined,
        paragraphs: current.paragraphs?.length ? current.paragraphs : undefined,
      });
    }
    current = null;
    codeBuf = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      if (inCode && current && codeBuf.length && !skipping) {
        current.code = (current.code ? `${current.code}\n` : "") + codeBuf.join("\n").slice(0, 1500);
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
      if (current && codeBuf.join("\n").length < 1500) codeBuf.push(raw.replace(/\t/g, "  ").slice(0, 160));
      continue;
    }
    if (!line) {
      flushTable();
      continue;
    }

    if (line.startsWith("|") && line.endsWith("|")) {
      if (current) tableLines.push(line);
      continue;
    } else if (tableLines.length) {
      flushTable();
    }

    const h1 = line.match(/^#\s+(.*)/);
    if (h1 && !title) {
      title = h1[1].trim().slice(0, 160);
      continue;
    }

    // Capture subtitle or image before the first slide
    if (!current && title && !line.startsWith("#")) {
      const coverImg = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*;?$/);
      if (coverImg) {
        coverImage = coverImg[2].trim().slice(0, 500_000);
        coverImageAlt = coverImg[1].trim().slice(0, 160) || undefined;
        continue;
      }
      if (!subtitle) {
        subtitle = line.slice(0, 200);
        continue;
      }
    }

    const h2 = line.match(/^#{2,3}\s+(.*)/);
    if (h2) {
      const rawHeading = h2[1].trim();
      if (/source|citation|reference/i.test(rawHeading)) {
        flush();
        current = null;
        break;
      }
      flush();
      const cleanHeading = rawHeading
        .replace(/^slide\s*\d+\s*[:.—–-]?\s*/i, "")
        .replace(/^[:.—–-]\s*/, "")
        .trim();
      current = { title: cleanHeading.slice(0, 120) || "Slide", bullets: [] };
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
    if (bullet && current && current.bullets.length < 8) {
      const text = bullet[1].trim();
      if (!text || /```/.test(text)) continue;
      // Lone citation markers and emptied formulas carry no content.
      const residue = text.replace(/\$/g, "").replace(/\s+/g, " ").trim();
      if (!residue || /^\[S\d+\]$/.test(residue)) continue;
      current.bullets.push(text.slice(0, 260));
      continue;
    }
    // Standalone image lines attach to the current slide (the renderer
    // fetches http(s) URLs and embeds the picture beside the bullets).
    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*;?$/);
    if (image) {
      if (!current) current = { title: "Slide", bullets: [] };
      if (!current.image) {
        current.image = image[2].trim().slice(0, 500_000);
        current.imageAlt = image[1].trim().slice(0, 160) || undefined;
      }
      continue;
    }

    // Descriptive prose on slide
    if (current && !line.startsWith("#")) {
      const paras = current.paragraphs || (current.paragraphs = []);
      if (paras.length < 3) paras.push(line.slice(0, 300));
    }
  }
  flush();
  if (!slides.length) throw new Error("empty-slides");

  // Check if first slide is a redundant Cover / Title slide:
  const first = slides[0];
  const isCover = /^(cover|title|title slide|cover slide)$/i.test(first.title.trim()) ||
    first.title.trim().toLowerCase() === title.trim().toLowerCase();
  if (isCover && slides.length > 1) {
    if (!subtitle) {
      if (first.paragraphs?.length) subtitle = first.paragraphs[0];
      else if (first.bullets?.length) subtitle = first.bullets[0];
    }
    if (!coverImage && first.image) {
      coverImage = first.image;
      coverImageAlt = first.imageAlt;
    }
    slides.shift();
  }

  return {
    title: (title || fallbackTitle).slice(0, 160),
    subtitle: subtitle.slice(0, 200) || undefined,
    coverImage,
    slides: slides.slice(0, 30),
  };
}

export function parseInlineDocxRuns(text: string, TextRunClass: any, ShadingTypeClass: any): any[] {
  const runs: any[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRunClass({ text: text.slice(lastIndex, match.index), color: "1E293B" }));
    }
    const raw = match[0];
    if (raw.startsWith("`")) {
      runs.push(new TextRunClass({
        text: raw.slice(1, -1),
        font: "Consolas",
        color: "9D174D",
        shading: { fill: "F1F5F9", type: ShadingTypeClass.CLEAR },
      }));
    } else if (raw.startsWith("**")) {
      runs.push(new TextRunClass({ text: raw.slice(2, -2), bold: true, color: "0F172A" }));
    } else if (raw.startsWith("*")) {
      runs.push(new TextRunClass({ text: raw.slice(1, -1), italics: true, color: "334155" }));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push(new TextRunClass({ text: text.slice(lastIndex), color: "1E293B" }));
  }
  return runs.length ? runs : [new TextRunClass({ text: "", color: "1E293B" })];
}

export async function renderMarkdownToDocx(md: string, fallbackTitle = "Document"): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, WidthType, BorderStyle, ShadingType
  } = await import("docx");

  const theme = pickDocumentTheme(fallbackTitle + " " + md.slice(0, 500));
  const PRIMARY = theme.ink;
  const ACCENT = theme.accent;

  const lines = md.split(/\r?\n/);
  const children: any[] = [];
  let titleFound = false;

  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  let inTable = false;
  let tableRows: string[][] = [];

  let inQuote = false;
  let quoteBuffer: string[] = [];

  const flushCode = () => {
    if (!codeBuffer.length && !inCode) return;
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
        left: { style: BorderStyle.SINGLE, size: 4, color: ACCENT },
        right: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: theme.card, type: ShadingType.CLEAR },
              margins: { top: 120, bottom: 120, left: 160, right: 160 },
              children: [
                ...(codeLang ? [new Paragraph({
                  children: [new TextRun({ text: codeLang.toUpperCase(), font: "Consolas", size: 16, bold: true, color: ACCENT })],
                  spacing: { after: 60 },
                })] : []),
                ...codeBuffer.map((cLine) => new Paragraph({
                  children: [new TextRun({ text: cLine || " ", font: "Consolas", size: 19, color: PRIMARY })],
                  spacing: { line: 240, after: 20 },
                })),
              ],
            }),
          ],
        }),
      ],
    });
    children.push(table);
    children.push(new Paragraph({ spacing: { after: 100 } }));
    inCode = false;
    codeLang = "";
    codeBuffer = [];
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.map((r, rIdx) => {
      const isHeader = rIdx === 0;
      return new TableRow({
        tableHeader: isHeader,
        children: r.map((cellText) => new TableCell({
          shading: isHeader ? { fill: PRIMARY, type: ShadingType.CLEAR } : (rIdx % 2 === 0 ? { fill: theme.card, type: ShadingType.CLEAR } : undefined),
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
            left: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
            right: { style: BorderStyle.SINGLE, size: 1, color: theme.light },
          },
          children: [
            new Paragraph({
              children: isHeader
                ? [new TextRun({ text: cellText, bold: true, color: "FFFFFF" })]
                : parseInlineDocxRuns(cellText, TextRun, ShadingType),
              spacing: { line: 240 },
            }),
          ],
        })),
      });
    });
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    }));
    children.push(new Paragraph({ spacing: { after: 120 } }));
    inTable = false;
    tableRows = [];
  };

  const flushQuote = () => {
    if (!quoteBuffer.length) return;
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.NONE },
        bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.SINGLE, size: 4, color: ACCENT },
        right: { style: BorderStyle.NONE },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { fill: theme.accentSoft, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 160, right: 160 },
              children: quoteBuffer.map((q) => new Paragraph({
                children: parseInlineDocxRuns(q, TextRun, ShadingType),
                spacing: { after: 60 },
              })),
            }),
          ],
        }),
      ],
    });
    children.push(table);
    children.push(new Paragraph({ spacing: { after: 100 } }));
    inQuote = false;
    quoteBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        flushCode();
      } else {
        if (inTable) flushTable();
        if (inQuote) flushQuote();
        inCode = true;
        codeLang = trimmed.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(rawLine.replace(/\t/g, "    "));
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (inQuote) flushQuote();
      const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }
      inTable = true;
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (trimmed.startsWith(">")) {
      inQuote = true;
      quoteBuffer.push(trimmed.replace(/^>\s?/, ""));
      continue;
    } else if (inQuote) {
      flushQuote();
    }

    if (!trimmed) continue;

    if (/^---+$|^\*\*\*+$/.test(trimmed)) {
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: theme.light } },
        spacing: { before: 160, after: 160 },
      }));
      continue;
    }

    const h1 = trimmed.match(/^#\s+(.*)/);
    if (h1) {
      titleFound = true;
      children.push(new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: h1[1], color: PRIMARY, bold: true, size: 48 })],
        spacing: { before: 240, after: 160 },
      }));
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.*)/);
    if (h2) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: h2[1], color: PRIMARY, bold: true, size: 32 })],
        spacing: { before: 320, after: 120 },
      }));
      continue;
    }

    const h3 = trimmed.match(/^###\s+(.*)/);
    if (h3) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: h3[1], color: ACCENT, bold: true, size: 26 })],
        spacing: { before: 240, after: 80 },
      }));
      continue;
    }

    const h4 = trimmed.match(/^####\s+(.*)/);
    if (h4) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: h4[1], color: theme.muted, bold: true, size: 22 })],
        spacing: { before: 180, after: 60 },
      }));
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)/);
    if (bulletMatch) {
      children.push(new Paragraph({
        children: parseInlineDocxRuns(bulletMatch[1], TextRun, ShadingType),
        bullet: { level: 0 },
        spacing: { after: 60 },
      }));
      continue;
    }

    const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)/);
    if (numMatch) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${numMatch[1]}. `, bold: true, color: PRIMARY }),
          ...parseInlineDocxRuns(numMatch[2], TextRun, ShadingType),
        ],
        spacing: { after: 60 },
      }));
      continue;
    }

    children.push(new Paragraph({
      children: parseInlineDocxRuns(trimmed, TextRun, ShadingType),
      spacing: { after: 120, line: 276 },
    }));
  }

  if (inCode) flushCode();
  if (inTable) flushTable();
  if (inQuote) flushQuote();

  if (!titleFound && fallbackTitle) {
    children.unshift(new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: fallbackTitle, color: PRIMARY, bold: true, size: 48 })],
      spacing: { before: 240, after: 160 },
    }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function renderDocx(plan: ReportPlan, citations: NotebookSourceCitation[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const NAVY = "1F3864";
  const MUTED = "808080";
  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: plan.title, color: NAVY })] }),
  ];
  if (plan.executiveSummary && plan.executiveSummary.trim() && !/^no summary/i.test(plan.executiveSummary.trim())) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Executive summary", color: NAVY })] }),
      new Paragraph({ children: [new TextRun(plan.executiveSummary)] })
    );
  }
  plan.sections.forEach((s, i) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: `${i + 1}. ${s.heading}`, color: NAVY })] }));
    for (const para of s.body.split(/\n+/)) {
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
  if (citations.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Sources", color: NAVY })] }));
    for (const c of citations) {
      children.push(new Paragraph({ children: [new TextRun({ text: `[S${c.index}] ${c.sourceName} — ${c.heading}`, color: MUTED, size: 20 })] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

function parseInlineHtml(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

export function markdownToDocumentHtml(markdown: string, fallbackTitle = "Document"): string {
  const theme = pickDocumentTheme(fallbackTitle + " " + markdown.slice(0, 500));
  const lines = markdown.split(/\r?\n/);
  const bodyParts: string[] = [];
  let title = fallbackTitle;

  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  let inTable = false;
  let tableRows: string[][] = [];

  let inList = false;

  const flushCode = () => {
    if (!codeBuffer.length && !inCode) return;
    const escaped = escapeHtml(codeBuffer.join("\n"));
    bodyParts.push(`<div class="code-card">${codeLang ? `<div class="code-lang">${escapeHtml(codeLang.toUpperCase())}</div>` : ""}<pre><code>${escaped}</code></pre></div>`);
    inCode = false;
    codeLang = "";
    codeBuffer = [];
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    const header = tableRows[0];
    const data = tableRows.slice(1);
    const ths = header.map((c) => `<th>${parseInlineHtml(c)}</th>`).join("");
    const trs = data.map((row) => `<tr>${row.map((c) => `<td>${parseInlineHtml(c)}</td>`).join("")}</tr>`).join("\n");
    bodyParts.push(`<table class="doc-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
    inTable = false;
    tableRows = [];
  };

  const flushList = () => {
    if (inList) {
      bodyParts.push("</ul>");
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        flushCode();
      } else {
        flushList();
        if (inTable) flushTable();
        inCode = true;
        codeLang = trimmed.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(rawLine.replace(/\t/g, "    "));
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushList();
      const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      inTable = true;
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (!trimmed) {
      flushList();
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushList();
      const quoteText = trimmed.replace(/^>\s?/, "");
      bodyParts.push(`<blockquote class="callout"><p>${parseInlineHtml(quoteText)}</p></blockquote>`);
      continue;
    }

    if (/^---+$|^\*\*\*+$/.test(trimmed)) {
      flushList();
      bodyParts.push('<hr class="divider"/>');
      continue;
    }

    const h1 = trimmed.match(/^#\s+(.*)/);
    if (h1) {
      flushList();
      title = h1[1].trim();
      bodyParts.push(`<h1>${parseInlineHtml(h1[1])}</h1>`);
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.*)/);
    if (h2) {
      flushList();
      bodyParts.push(`<h2>${parseInlineHtml(h2[1])}</h2>`);
      continue;
    }

    const h3 = trimmed.match(/^###\s+(.*)/);
    if (h3) {
      flushList();
      bodyParts.push(`<h3>${parseInlineHtml(h3[1])}</h3>`);
      continue;
    }

    const h4 = trimmed.match(/^####\s+(.*)/);
    if (h4) {
      flushList();
      bodyParts.push(`<h4>${parseInlineHtml(h4[1])}</h4>`);
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)/);
    if (bulletMatch) {
      if (!inList) {
        bodyParts.push('<ul class="bullet-list">');
        inList = true;
      }
      bodyParts.push(`<li>${parseInlineHtml(bulletMatch[1])}</li>`);
      continue;
    } else {
      flushList();
    }

    bodyParts.push(`<p>${parseInlineHtml(trimmed)}</p>`);
  }

  if (inCode) flushCode();
  if (inTable) flushTable();
  flushList();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif; max-width: 820px; margin: 36px auto; padding: 0 28px; color: #${theme.body}; line-height: 1.65; }
    h1 { font-size: 28px; color: #${theme.ink}; margin-bottom: 20px; border-bottom: 2px solid #${theme.accent}; padding-bottom: 8px; }
    h2 { font-size: 20px; color: #${theme.ink}; margin-top: 32px; margin-bottom: 12px; }
    h3 { font-size: 16px; color: #${theme.accent}; margin-top: 24px; margin-bottom: 8px; }
    h4 { font-size: 14px; color: #${theme.muted}; margin-top: 18px; margin-bottom: 6px; }
    p { margin: 8px 0 12px; }
    .code-card { background: #${theme.card}; border: 1px solid #${theme.light}; border-left: 4px solid #${theme.accent}; border-radius: 6px; padding: 12px 16px; margin: 16px 0; overflow-x: auto; }
    .code-lang { font-family: Consolas, monospace; font-size: 11px; font-weight: bold; color: #${theme.accent}; margin-bottom: 6px; letter-spacing: 0.5px; }
    pre { margin: 0; }
    code { font-family: Consolas, "Courier New", monospace; font-size: 13.5px; color: #${theme.ink}; line-height: 1.5; }
    .inline-code { background: #${theme.card}; color: #${theme.accent}; padding: 2px 5px; border-radius: 4px; font-size: 13px; }
    .doc-table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13.5px; }
    .doc-table th { background: #${theme.ink}; color: #ffffff; text-align: left; padding: 10px 12px; font-weight: 600; }
    .doc-table td { padding: 9px 12px; border-bottom: 1px solid #${theme.light}; }
    .doc-table tr:nth-child(even) td { background: #${theme.card}; }
    .callout { border-left: 4px solid #${theme.accent}; background: #${theme.accentSoft}; margin: 16px 0; padding: 10px 16px; border-radius: 0 6px 6px 0; color: #${theme.body}; }
    .callout p { margin: 4px 0; }
    .bullet-list { padding-left: 24px; margin: 8px 0 14px; }
    .bullet-list li { margin: 4px 0; }
    .divider { border: 0; border-top: 1px solid #${theme.light}; margin: 28px 0; }
  </style>
</head>
<body>
  ${bodyParts.join("\n  ")}
</body>
</html>`;
}

export async function renderMarkdownToPdf(md: string, fallbackTitle = "Document"): Promise<Buffer> {
  const electronRequire = createRequire(import.meta.url);
  type Win = { loadURL: (url: string) => Promise<void>; webContents: { printToPDF: (opts: unknown) => Promise<Uint8Array> }; destroy: () => void };
  let BrowserWindow: (new (opts: unknown) => Win) | null = null;
  try {
    const mod = electronRequire("electron") as unknown as { BrowserWindow?: new (opts: unknown) => Win };
    if (mod && typeof mod === "object") BrowserWindow = mod.BrowserWindow || null;
  } catch { /* plain node */ }
  if (!BrowserWindow) throw new Error("PDF export needs the desktop app — pick DOCX instead.");
  const html = markdownToDocumentHtml(md, fallbackTitle);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const data = await win.webContents.printToPDF({ printBackground: true });
    return Buffer.from(data);
  } finally {
    try { win.destroy(); } catch { /* ignore */ }
  }
}

export async function renderPdf(plan: ReportPlan, citations: NotebookSourceCitation[]): Promise<Buffer> {
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
  const cleaned = cleanSlideText(title)
    .replace(/^slide\s*\d+\s*[:.—–-]?\s*/i, "")
    .replace(/^[:.—–-]\s*/, "")
    .replace(/[:;,.]+$/, "")
    .trim();
  return cleaned.slice(0, 120) || "Slide";
}

/** Plain-text bullet cleaning shared by the fallback renderer (content hygiene only — no theme). */
function cleanBullets(bullets: string[]): string[] {
  return bullets
    .map((b) => cleanSlideText(b))
    .filter((b) => b && !/^\[S\d+\]$/.test(b) && !/```/.test(b) && !/^\s*mermaid\b/i.test(b));
}

export async function renderPptx(
  plan: SlidesPlan,
  citations: NotebookSourceCitation[],
  opts: { coverBadge?: string; theme?: DocumentTheme } = {}
): Promise<Buffer> {
  const theme = opts.theme || pickDocumentTheme(plan.title);
  const INK = theme.ink;
  const ACCENT = theme.accent;
  const ACCENT_SOFT = theme.accentSoft;
  const CARD = theme.card;
  const MUTED = theme.muted;
  const BODY = theme.body;
  const LIGHT = theme.light;
  const BG_LIGHT = theme.bgLight;
  const FONT_TITLE = theme.fontTitle;
  const FONT_BODY = theme.fontBody;

  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const mod = (await import("pptxgenjs")) as unknown as { default?: unknown } & Record<string, unknown>;
  type Slide = {
    addText: (t: unknown, o?: unknown) => void;
    addImage: (o: unknown) => void;
    addShape: (shape: unknown, o?: unknown) => void;
    addTable: (rows: unknown, o?: unknown) => void;
  };
  const PptxGenJS = (mod.default || mod) as unknown as new () => {
    title: string;
    defineLayout: (layout: { name: string; width: number; height: number }) => void;
    layout: string;
    addSlide: () => Slide;
    write: (opts: { outputType: "nodebuffer" }) => Promise<Buffer>;
  };
  const pres = new PptxGenJS();
  pres.defineLayout({ name: "NEXUS_WIDE", width: 13.33, height: 7.5 });
  pres.layout = "NEXUS_WIDE";
  pres.title = plan.title;

  const totalContentSlides = plan.slides.length;
  const footer = (slide: Slide, n: number) => {
    slide.addText(`${plan.title.slice(0, 70)} • ${today}`, { x: 0.6, y: 7.08, w: 9.0, h: 0.3, fontSize: 9, color: MUTED, fontFace: FONT_BODY });
    slide.addText(`${n} / ${totalContentSlides}`, { x: 11.7, y: 7.08, w: 1.0, h: 0.3, fontSize: 9, color: MUTED, align: "right", fontFace: FONT_BODY });
  };

  // ---- image embedding: fetch http(s) slide images once, embed as data ----
  const imageCache = new Map<string, { ext: string; b64: string } | null>();
  const fetchSlideImage = async (url: string): Promise<{ ext: string; b64: string } | null> => {
    const hit = imageCache.get(url);
    if (hit !== undefined) return hit;
    let result: { ext: string; b64: string } | null = null;
    try {
      if (/^data:image\/(png|jpe?g|gif);base64,/i.test(url)) {
        const ext = /png/i.test(url) ? "png" : /gif/i.test(url) ? "gif" : "jpg";
        result = { ext, b64: url.replace(/^data:image\/[a-z]+;base64,/i, "") };
      } else if (/^https?:\/\//i.test(url)) {
        const { safePublicFetch } = await import("./net-guard.js");
        const res = await safePublicFetch(url, { timeoutMs: 9_000, headers: { "user-agent": "nexus/0.5.0" } });
        const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" } as Record<string, string>)[type];
        if (res.ok && ext) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 50 && buf.length < 8_000_000) result = { ext, b64: buf.toString("base64") };
        }
      }
    } catch { /* decorative */ }
    imageCache.set(url, result);
    return result;
  };

  const bulletRuns = (text: string, isLast: boolean): Array<{ text: string; options: Record<string, unknown> }> => {
    const split = text.match(/^(.{4,80}?)\s+(?:—|–|-|:)\s+(.{8,})$/);
    if (split) {
      return [
        { text: `${split[1]} — `, options: { bold: true, color: INK, bullet: { code: "2022" }, fontFace: FONT_BODY } },
        { text: split[2], options: { color: BODY, breakLine: isLast, fontFace: FONT_BODY } },
      ];
    }
    return [{ text, options: { color: BODY, bullet: { code: "2022" }, breakLine: isLast, fontFace: FONT_BODY } }];
  };

  const bulletTextRuns = (bullets: string[]): Array<{ text: string; options: Record<string, unknown> }> => {
    const all: Array<{ text: string; options: Record<string, unknown> }> = [];
    bullets.forEach((b, i) => {
      all.push(...bulletRuns(b, true));
    });
    return all;
  };

  const addContentSlide = async (s: SlidePlan, index: number) => {
    const title = cleanSlideTitle(s.title);
    const bullets = cleanBullets(s.bullets).slice(0, 8);
    const code = s.code && !/mermaid|graph\s+(LR|TD|TB|BT)/i.test(s.code) ? s.code.slice(0, 1500) : undefined;
    const callouts = (s.callouts || []).filter((c) => c.title || c.text).slice(0, 2);
    const image = s.image ? await fetchSlideImage(s.image) : null;
    const hasTable = Boolean(s.table && s.table.headers.length);
    const hasParas = Boolean(s.paragraphs?.length);
    if ((!title || title === "Slide") && !bullets.length && !code && !callouts.length && !image && !hasTable && !hasParas) return;

    const slide = pres.addSlide();
    slide.addShape("rect", { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: BG_LIGHT } });

    // Kicker + Title
    slide.addText(String(index).padStart(2, "0"), { x: 0.6, y: 0.45, w: 1.5, h: 0.35, fontSize: 11, bold: true, color: ACCENT, charSpacing: 2, fontFace: FONT_BODY });
    slide.addText(title || "Slide", { x: 0.6, y: 0.72, w: 12.13, h: 0.75, fontSize: 24, bold: true, color: INK, fontFace: FONT_TITLE });

    let bodyY = 1.65;
    if (s.subtitle) {
      slide.addText(cleanSlideText(s.subtitle), { x: 0.6, y: bodyY, w: 12.13, h: 0.45, fontSize: 13.5, color: MUTED, fontFace: FONT_BODY });
      bodyY += 0.52;
    }

    const withImage = Boolean(image);
    const contentW = withImage ? 6.1 : 12.13;

    if (s.paragraphs?.length) {
      for (const p of s.paragraphs) {
        if (bodyY > 5.5) break;
        slide.addText(cleanSlideText(p), { x: 0.6, y: bodyY, w: contentW, h: 0.45, fontSize: 13, color: BODY, italic: true, fontFace: FONT_BODY });
        bodyY += 0.48;
      }
    }

    if (hasTable && s.table) {
      const rowCount = s.table.rows.length + 1;
      const fontSize = rowCount > 9 ? 9.5 : rowCount > 7 ? 10.5 : 11.5;
      const thRows = [
        s.table.headers.map((h) => ({
          text: h,
          options: { bold: true, color: "FFFFFF", fill: { color: INK }, fontFace: FONT_TITLE, fontSize: fontSize + 0.5 }
        })),
        ...s.table.rows.map((row, rIdx) => row.map((cell) => ({
          text: cell,
          options: { fill: rIdx % 2 === 0 ? { color: CARD } : { color: BG_LIGHT }, color: BODY, fontFace: FONT_BODY, fontSize }
        })))
      ];
      const availableH = Math.max(2.5, 6.85 - bodyY);
      const rowH = rowCount <= 5 ? 0.46 : Math.max(0.32, Math.min(0.42, (availableH - 0.1) / rowCount));
      const tableH = Math.min(rowH * rowCount, availableH);

      slide.addTable(thRows, {
        x: 0.6,
        y: bodyY,
        w: contentW,
        h: tableH,
        rowH,
        fontSize,
        border: { pt: 1, color: LIGHT },
        valign: "middle",
        margin: [3, 6, 3, 6],
        autoPage: false
      });
      bodyY += tableH + 0.25;
    }

    // Bullets rendering: If 2-4 bullets and no image/table, use Card Block layout
    if (bullets.length >= 2 && bullets.length <= 4 && !withImage && !hasTable) {
      const availableH = Math.max(2.6, 6.7 - bodyY);
      const gap = 0.16;
      const cardH = Math.min((availableH - gap * (bullets.length - 1)) / bullets.length, 1.25);
      let cardY = bodyY;
      for (const b of bullets) {
        slide.addShape("roundRect", {
          x: 0.6, y: cardY, w: contentW, h: cardH,
          fill: { color: CARD },
          line: { color: LIGHT, width: 1 },
          rectRadius: 0.05
        });
        const split = b.match(/^(.{3,80}?)\s+(?:—|–|-|:)\s+(.{6,})$/);
        if (split) {
          slide.addText([
            { text: split[1] + "  ", options: { bold: true, color: INK, fontSize: 13, fontFace: FONT_TITLE } },
            { text: "— " + split[2], options: { color: BODY, fontSize: 12.5, fontFace: FONT_BODY } }
          ], { x: 0.85, y: cardY + 0.06, w: contentW - 0.45, h: cardH - 0.12, valign: "middle" });
        } else {
          slide.addText(b, {
            x: 0.85, y: cardY + 0.06, w: contentW - 0.45, h: cardH - 0.12,
            fontSize: 12.5, color: BODY, valign: "middle", fontFace: FONT_BODY
          });
        }
        cardY += cardH + gap;
      }
      bodyY = cardY;
    } else if (bullets.length) {
      const twoColumn = bullets.length > 4 && !withImage && !hasTable;
      const paraOpts = { fontSize: 13.5, valign: "top" as const, fontFace: FONT_BODY };
      const bulletH = Math.min(bullets.length * 0.48 + 0.2, 4.2);
      if (twoColumn) {
        const half = Math.ceil(bullets.length / 2);
        slide.addText(bulletTextRuns(bullets.slice(0, half)), { ...paraOpts, x: 0.6, y: bodyY, w: 5.85, h: 4.6 });
        slide.addText(bulletTextRuns(bullets.slice(half)), { ...paraOpts, x: 6.85, y: bodyY, w: 5.85, h: 4.6 });
      } else {
        slide.addText(bulletTextRuns(bullets), { ...paraOpts, x: 0.6, y: bodyY, w: contentW, h: Math.min(4.8, 6.6 - bodyY) });
      }
      bodyY += bulletH;
    }

    if (image) {
      slide.addShape("roundRect", {
        x: 6.95, y: 1.55, w: 5.75, h: 5.1,
        fill: { color: CARD },
        line: { color: LIGHT, width: 1 },
        rectRadius: 0.05
      });
      slide.addImage({
        data: `image/${image.ext};base64,${image.b64}`,
        x: 7.1, y: 1.7, w: 5.45, h: 4.8,
        sizing: { type: "contain", w: 5.45, h: 4.8 }
      });
    }

    let calloutY = bodyY;
    for (const c of callouts) {
      if (calloutY > 6.0) break;
      const label = (c.title || "Note").slice(0, 60);
      const body = cleanSlideText(c.text).slice(0, 340);
      slide.addShape("roundRect", { x: 0.6, y: calloutY, w: contentW, h: 0.85, fill: { color: ACCENT_SOFT }, line: { color: ACCENT, width: 1 }, rectRadius: 0.05 });
      slide.addText(
        [{ text: `${label}: `, options: { bold: true, color: ACCENT, fontFace: FONT_TITLE } }, { text: body, options: { color: BODY, fontFace: FONT_BODY } }],
        { x: 0.85, y: calloutY + 0.05, w: contentW - 0.45, h: 0.75, fontSize: 11.5, valign: "middle" }
      );
      calloutY += 0.95;
    }

    if (code && calloutY <= 5.8) {
      const codeH = Math.min(6.8 - calloutY, 1.4);
      slide.addShape("roundRect", { x: 0.6, y: calloutY, w: contentW, h: codeH, fill: { color: INK }, rectRadius: 0.05 });
      slide.addText(code, { x: 0.85, y: calloutY + 0.08, w: contentW - 0.45, h: codeH - 0.16, fontSize: 10.5, fontFace: "Consolas", color: LIGHT, valign: "top" });
    }

    footer(slide, index);
  };

  // ---- Cover Slide ----
  const cover = pres.addSlide();
  cover.addShape("rect", { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: INK } });

  const coverImageUrl = plan.coverImage;
  const coverImage = coverImageUrl ? await fetchSlideImage(coverImageUrl) : null;
  if (coverImage) {
    cover.addShape("roundRect", { x: 7.4, y: 1.0, w: 5.2, h: 5.5, fill: { color: INK }, line: { color: ACCENT, width: 1 }, rectRadius: 0.08 });
    cover.addImage({ data: `image/${coverImage.ext};base64,${coverImage.b64}`, x: 7.5, y: 1.1, w: 5.0, h: 5.3, sizing: { type: "contain", w: 5.0, h: 5.3 } });
  }

  const coverBadge = opts.coverBadge;
  if (coverBadge) cover.addText(coverBadge, { x: 0.8, y: 1.0, w: 9, h: 0.4, fontSize: 13, bold: true, color: ACCENT, charSpacing: 3, fontFace: FONT_BODY });
  cover.addText(plan.title, { x: 0.8, y: 2.2, w: coverImage ? 6.4 : 11.7, h: 2.2, fontSize: 38, bold: true, color: "FFFFFF", fontFace: FONT_TITLE });
  if (plan.subtitle) cover.addText(plan.subtitle, { x: 0.8, y: 4.5, w: coverImage ? 6.4 : 11.7, h: 1.0, fontSize: 18, color: ACCENT_SOFT, fontFace: FONT_BODY });
  cover.addText(today, { x: 0.8, y: 6.6, w: 6, h: 0.4, fontSize: 11, color: "94A3B8", fontFace: FONT_BODY });
  if (citations.length) {
    cover.addText(`Grounded in ${citations.length} cited passage${citations.length === 1 ? "" : "s"}`, { x: 7, y: 6.6, w: 5.5, h: 0.4, fontSize: 11, italic: true, color: "94A3B8", align: "right", fontFace: FONT_BODY });
  }

  // ---- Content Slides ----
  let contentIndex = 0;
  for (const s of plan.slides) {
    contentIndex++;
    await addContentSlide(s, contentIndex);
  }

  // ---- Sources ----
  if (citations.length) {
    const sources = pres.addSlide();
    sources.addShape("rect", { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: BG_LIGHT } });
    sources.addText("Sources", { x: 0.8, y: 0.72, w: 11.7, h: 0.75, fontSize: 24, bold: true, color: INK, fontFace: FONT_TITLE });
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
    sources.addText(sourceLines.join("\n").slice(0, 3000), { x: 0.8, y: 1.8, w: 11.7, h: 4.8, fontSize: 11, color: BODY, valign: "top", fontFace: FONT_BODY });
    footer(sources, contentIndex + 1);
  }

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
  checkDocumentCancellation(input);
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
    if (input.isCancelled?.()) throw error;
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
      checkDocumentCancellation(input);
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
        checkDocumentCancellation(input);
        // Tier 3: assemble faithfully from passages — grounded by construction.
        status("Model draft failed — assembling the report directly from your sources…");
        plan = extractiveReport(topic, ranked, citations);
      }
    }
    const preview = reportMarkdown(plan, citations);
    checkDocumentCancellation(input);
    status(input.format === "pdf" ? "Rendering PDF…" : "Rendering Word document…");
    const buffer = input.format === "pdf" ? await renderPdf(plan, citations) : await renderDocx(plan, citations);
    checkDocumentCancellation(input);
    return { doc: await persistDocument(notebookId, input, plan.title, buffer, preview, citations, plan.sections.length, 0), fallbackReason };
  }

  status("Planning the grounded slide deck…");
  const slidesSystem = `You are a precise presentation designer. Reply with a single JSON object only, no markdown fences, no prose: {"title": string, "subtitle": string, "slides": [{"title": string, "subtitle": string, "bullets": string[3-5], "code": string, "callouts": [{"title": string, "text": string}], "notes": string}]}. Rules: 8-12 slides; short bullets (<=18 words, "Lead — explanation" shape where natural); optional fenced-command "code" for procedures/commands; optional 1-3 "callouts" highlight cards; every slide traceable to SOURCES with [S1]/[S2] markers where factual; title slide content is separate; never invent facts.${baseInstructions}`;
  const slidesUser = `Topic: ${topic}\nFiles: ${files || "(unknown)"}\nCitation markers available: ${citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}\n\nSOURCES:\n${context}`;
  let plan: SlidesPlan;
  try {
    plan = sanitizeSlidesPlan(await planWithRepair("slides", slidesSystem, slidesUser, input));
  } catch {
    checkDocumentCancellation(input);
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
      checkDocumentCancellation(input);
      // Tier 3: assemble faithfully from passages — grounded by construction.
      status("Model draft failed — assembling the slides directly from your sources…");
      plan = extractiveSlides(topic, ranked, citations);
    }
  }
  const preview = slidesMarkdown(plan, citations);
  checkDocumentCancellation(input);
  status("Rendering PowerPoint file…");
  const buffer = await renderPptx(plan, citations);
  checkDocumentCancellation(input);
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
