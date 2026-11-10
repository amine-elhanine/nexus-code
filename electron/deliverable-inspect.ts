// Content-level deliverable inspection for Home runs.
//
// home-artifact-service.ts already proves an artifact is STRUCTURALLY valid
// (valid headers, has slides/worksheets/pages). That is not enough for
// long-task reliability: a 2-slide deck with placeholder titles or a 40-word
// "report" passes structure and gets announced as done. This module inspects
// CONTENT — slide counts, extracted text volume, sheet names, and whether the
// request's key terms actually appear in the produced file — so the verify
// node can issue targeted repair instructions ("slide text never mentions
// 'troy'") instead of trusting the model's claim.
//
// Deliberately lenient: every threshold exists to catch gross failure
// (empty/placeholder output), not to judge quality. A false "not done"
// costs one repair round; a false "done" breaks user trust.

import { promises as fs } from "node:fs";
import path from "node:path";

export type DeliverableMetrics = {
  kind: string;
  /** Format-specific primary unit: slides / words / sheets / pages. */
  primaryCount: number;
  wordCount: number;
  /** Slide titles (pptx) or headings (docx/md) — empty for other kinds. */
  titles: string[];
  sheetNames?: string[];
  textSample: string;
};

export type DeliverableInspection = {
  path: string;
  kind: string;
  ok: boolean;
  metrics: DeliverableMetrics;
  /** Human-readable problems; each one is actionable repair feedback. */
  problems: string[];
  /** One-line description for status events ("12 slides, 840 words"). */
  summary: string;
};

type ZipLike = {
  file: (name: string) => { async: (kind: "string") => Promise<string> } | null;
  files?: Record<string, { dir?: boolean; async: (kind: "string") => Promise<string> }>;
};

async function loadZip(buffer: Buffer): Promise<ZipLike> {
  const mod = await import("jszip");
  const JSZip = (mod as unknown as { default: new () => { loadAsync: (b: Buffer) => Promise<ZipLike> } }).default;
  return new JSZip().loadAsync(buffer);
}

function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  return (text.match(/[^\s]+/g) || []).length;
}

// ---- pptx ----------------------------------------------------------------

async function inspectPptx(bytes: Buffer): Promise<DeliverableMetrics> {
  const zip = await loadZip(bytes);
  const slideNames = Object.keys(zip.files || {})
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) && !zip.files![name].dir)
    .sort((a, b) => (Number(a.match(/(\d+)/)?.[1]) || 0) - (Number(b.match(/(\d+)/)?.[1]) || 0));
  const titles: string[] = [];
  let allText = "";
  for (const name of slideNames.slice(0, 60)) {
    const xml = await zip.files![name].async("string");
    // <a:t> runs in document order; the first non-empty run of a slide is a
    // good-enough title heuristic (title placeholders are hard to detect
    // reliably across generator tools).
    const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlText(m[1])).filter(Boolean);
    // Designed decks put a bare kicker number ("01") before the title — skip
    // pure-number runs so the real title surfaces.
    const titleRun = runs.find((r) => !/^\d+$/.test(r.trim()));
    if (titleRun && titles.length < 30) titles.push(titleRun.slice(0, 120));
    allText += ` ${runs.join(" ")}`;
  }
  return { kind: "pptx", primaryCount: slideNames.length, wordCount: countWords(allText), titles, textSample: allText.slice(0, 2000) };
}

// ---- docx ----------------------------------------------------------------

async function inspectDocx(bytes: Buffer): Promise<DeliverableMetrics> {
  const zip = await loadZip(bytes);
  const doc = zip.file("word/document.xml");
  const xml = doc ? await doc.async("string") : "";
  const paras: string[] = [];
  const titles: string[] = [];
  const pRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(xml))) {
    const texts = [...pm[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => xmlText(m[1])).join("");
    if (!texts.trim()) continue;
    paras.push(texts);
    const style = pm[0].match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] || "";
    if (/^(Title|Heading[1-3])$/i.test(style) && titles.length < 30) titles.push(texts.slice(0, 120));
  }
  const text = paras.join(" ");
  return { kind: "docx", primaryCount: paras.length, wordCount: countWords(text), titles, textSample: text.slice(0, 2000) };
}

// ---- xlsx ----------------------------------------------------------------

async function inspectXlsx(bytes: Buffer): Promise<DeliverableMetrics> {
  const zip = await loadZip(bytes);
  const workbook = zip.file("xl/workbook.xml");
  const xml = workbook ? await workbook.async("string") : "";
  const sheetNames = [...xml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]).slice(0, 30);
  let totalRows = 0;
  for (const name of Object.keys(zip.files || {})) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name) && !zip.files![name].dir) {
      const sheetXml = await zip.files![name].async("string");
      totalRows += (sheetXml.match(/<row[\s>]/g) || []).length;
    }
  }
  return { kind: "xlsx", primaryCount: sheetNames.length, wordCount: totalRows, titles: sheetNames, sheetNames, textSample: "" };
}

// ---- pdf -----------------------------------------------------------------

async function inspectPdf(bytes: Buffer): Promise<DeliverableMetrics> {
  type PdfParser = { getText: () => Promise<{ pages?: Array<{ items?: Array<{ text?: string }> }>; text?: string }>; destroy: () => Promise<void> };
  let parser: PdfParser | undefined;
  try {
    const mod = await import("pdf-parse");
    const PDFParse = (mod as unknown as { PDFParse: new (opts: { data: Buffer }) => PdfParser }).PDFParse;
    parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    const text = result.text || (result.pages || []).map((p) => (p.items || []).map((i) => i.text || "").join(" ")).join(" ");
    const pages = Math.max(1, (result.pages || []).length || ((bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length || 1));
    return { kind: "pdf", primaryCount: pages, wordCount: countWords(text), titles: [], textSample: text.slice(0, 2000) };
  } finally {
    await parser?.destroy().catch(() => {});
  }
}

// ---- plain text ----------------------------------------------------------

function inspectText(bytes: Buffer, ext: string): DeliverableMetrics {
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (ext === "csv") {
    return { kind: "csv", primaryCount: Math.max(0, lines.length - 1), wordCount: countWords(text), titles: lines[0]?.split(",").slice(0, 20).map((h) => h.replace(/^"|"$/g, "")) || [], textSample: text.slice(0, 1000) };
  }
  const titles = ext === "md" || ext === "markdown"
    ? (text.match(/^#{1,4}\s+(.+)$/gm) || []).map((h) => h.replace(/^#{1,4}\s+/, "").slice(0, 120)).slice(0, 30)
    : [];
  return { kind: ext, primaryCount: lines.length, wordCount: countWords(text), titles, textSample: text.slice(0, 2000) };
}

// ---- request keyword extraction ------------------------------------------

// Words that describe the TASK FORMAT or are pure filler must never be
// required to appear inside the artifact ("write a presentation about…" —
// the deck does not have to contain the word "presentation").
const REQUEST_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "about", "into", "onto", "over", "from", "that", "this", "these", "those",
  "please", "make", "write", "create", "generate", "produce", "build", "give", "show", "want", "need", "would", "could",
  "presentation", "presentations", "report", "reports", "document", "documents", "doc", "file", "files", "slide", "slides",
  "spreadsheet", "sheet", "sheets", "deck", "essay", "article", "summary", "summaries", "note", "notes", "csv", "pdf",
  "powerpoint", "word", "excel", "markdown", "pptx", "docx", "xlsx", "using", "use", "include", "including", "contains",
  "should", "must", "have", "has", "will", "can", "may", "new", "also", "some", "more", "very", "each", "every", "all",
]);

/** Significant lowercase words from the request, most useful for matching first. */
export function extractRequestKeywords(request: string, max = 6): string[] {
  const counts = new Map<string, number>();
  for (const raw of String(request || "").toLowerCase().split(/[^a-z0-9À-ÿ]+/)) {
    const word = raw.trim();
    if (word.length < 4 || REQUEST_STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map(([word]) => word);
}

/**
 * Evidence check for the plan-as-hard-contract gate: does a plan item marked
 * "completed" map to anything observable? Evidence is (a) a produced file
 * whose name/path matches a topic keyword or the item's named extension, or
 * (b) a recorded journal action sharing enough topic keywords. Deliberately
 * lenient — items without judgeable keywords count as evidenced, so a false
 * alarm can never trap a legitimate run in a repair loop.
 */
export function planItemEvidence(item: string, filePaths: string[], actionTexts: string[]): boolean {
  const keywords = extractRequestKeywords(item, 8);
  if (keywords.length === 0) return true;
  const itemLower = String(item || "").toLowerCase();
  for (const filePath of filePaths) {
    const lower = String(filePath).toLowerCase();
    if (keywords.some((keyword) => lower.includes(keyword))) return true;
    const ext = path.extname(lower).replace(".", "");
    if (ext && itemLower.includes(ext)) return true;
  }
  for (const action of actionTexts) {
    const lower = String(action).toLowerCase();
    if (keywords.filter((keyword) => lower.includes(keyword)).length >= Math.min(2, keywords.length)) return true;
  }
  return false;
}

// ---- content thresholds ---------------------------------------------------

const MIN_WORDS_BY_KIND: Record<string, number> = {
  pptx: 40, // across the whole deck — catches "one slide that says Title"
  docx: 80,
  pdf: 80,
  md: 80,
  markdown: 80,
  txt: 40,
};

/**
 * Inspect one deliverable's CONTENT. Returns ok=false with targeted problems
 * when the artifact is grossly incomplete relative to what a real finished
 * deliverable looks like. Never throws — unreadable files surface as a
 * problem, not an exception (structure validation owns corrupt files).
 */
export async function inspectDeliverable(root: string, relativePath: string, request: string): Promise<DeliverableInspection> {
  const normalized = relativePath.replace(/\\/g, "/");
  const full = path.resolve(root, normalized);
  const ext = path.extname(normalized).replace(".", "").toLowerCase();
  let metrics: DeliverableMetrics;
  try {
    const bytes = await fs.readFile(full);
    if (ext === "pptx") metrics = await inspectPptx(bytes);
    else if (ext === "docx") metrics = await inspectDocx(bytes);
    else if (ext === "xlsx") metrics = await inspectXlsx(bytes);
    else if (ext === "pdf") metrics = await inspectPdf(bytes);
    else if (["md", "markdown", "txt", "csv"].includes(ext)) metrics = inspectText(bytes, ext);
    else {
      // Source scripts / images / unknown kinds: nothing content-level to judge.
      return { path: normalized, kind: ext || "unknown", ok: true, metrics: { kind: ext || "unknown", primaryCount: 0, wordCount: 0, titles: [], textSample: "" }, problems: [], summary: "no content inspection for this kind" };
    }
  } catch (error) {
    return {
      path: normalized, kind: ext || "unknown", ok: false,
      metrics: { kind: ext || "unknown", primaryCount: 0, wordCount: 0, titles: [], textSample: "" },
      problems: [`could not be read for content inspection (${error instanceof Error ? error.message : String(error)})`],
      summary: "unreadable",
    };
  }

  const problems: string[] = [];
  if (ext === "pptx") {
    if (metrics.primaryCount < 2) problems.push(`deck has only ${metrics.primaryCount} slide${metrics.primaryCount === 1 ? "" : "s"} — a finished presentation needs at least 2`);
    if (metrics.wordCount < MIN_WORDS_BY_KIND.pptx) problems.push(`slides contain only ~${metrics.wordCount} words of content — too thin for a finished deck`);
    if (metrics.titles.every((title) => /^(title|slide \d+|new slide|click to add (a )?(title|text))$/i.test(title.trim()))) {
      problems.push("slide titles are all placeholders (\"Title\", \"Slide 1\"…) — write real titles");
    }
  } else if (ext === "docx") {
    if (metrics.primaryCount < 3) problems.push(`document has only ${metrics.primaryCount} non-empty paragraphs`);
    if (metrics.wordCount < (MIN_WORDS_BY_KIND.docx)) problems.push(`document contains only ~${metrics.wordCount} words — too thin for a finished document`);
  } else if (ext === "pdf") {
    if (metrics.wordCount < MIN_WORDS_BY_KIND.pdf) problems.push(`PDF contains only ~${metrics.wordCount} words of extractable text`);
  } else if (ext === "xlsx") {
    if (metrics.primaryCount < 1) problems.push("workbook has no named sheets");
    if (metrics.wordCount < 4) problems.push(`worksheets contain only ~${metrics.wordCount} rows — too thin for a finished spreadsheet`);
  } else if (ext === "csv") {
    if (metrics.primaryCount < 2) problems.push(`CSV has only ${metrics.primaryCount} data row${metrics.primaryCount === 1 ? "" : "s"}`);
  } else if (MIN_WORDS_BY_KIND[ext]) {
    if (metrics.wordCount < MIN_WORDS_BY_KIND[ext]) problems.push(`file contains only ~${metrics.wordCount} words`);
  }

  // Depth-aware checks: requests asking for courses, tutorials, guides, or manuals
  // require substantial content, not a 1-page outline or empty stub.
  const comprehensiveMatch = request.match(/\b(course|tutorial|guide|manual|book|mastery|curriculum|handbook|in-depth|deep dive|comprehensive)\b/i);
  if (comprehensiveMatch && (ext === "docx" || ext === "pdf" || ext === "md" || ext === "markdown")) {
    if (metrics.wordCount < 250) {
      problems.push(`the request asks for a ${comprehensiveMatch[1].toLowerCase()}, but the document contains only ~${metrics.wordCount} words — provide comprehensive educational content with complete modules and working examples instead of an outline`);
    }
  }

  // Detect empty or truncated code stubs
  if (metrics.textSample && /(def\s+\w+\([^)]*\):(?:\s*(?:pass|#\s*TODO|\.\.\.))+)/i.test(metrics.textSample)) {
    problems.push("code examples contain empty or truncated stubs ('pass' / '# TODO') — provide complete, working code implementations");
  }

  // Topic coverage: the request's significant terms should appear in the
  // artifact text. Require 2 of the top keywords (1 when only 1 exists) so a
  // single odd word can never fail an otherwise-good deliverable.
  const keywords = extractRequestKeywords(request);
  if (keywords.length && metrics.textSample) {
    const haystack = metrics.textSample.toLowerCase();
    const missing = keywords.filter((word) => !haystack.includes(word));
    const required = Math.min(2, keywords.length);
    if (keywords.length - missing.length < required) {
      problems.push(`the request's key terms (${keywords.slice(0, 4).join(", ")}) barely appear in the content — missing ${missing.slice(0, 4).join(", ")}; make sure the output actually covers the requested topic`);
    }
  }

  const units = ext === "pptx" ? "slides" : ext === "xlsx" ? "sheets" : ext === "pdf" ? "pages" : ext === "csv" ? "rows" : "lines";
  const summary = `${metrics.primaryCount} ${units}, ~${metrics.wordCount} words${metrics.titles.length ? `, titles: ${metrics.titles.slice(0, 3).join(" | ")}` : ""}`;
  return { path: normalized, kind: ext || "unknown", ok: problems.length === 0, metrics, problems, summary };
}

/** Inspect several deliverables in parallel; skips non-inspectable kinds. */
export async function inspectDeliverables(root: string, relativePaths: string[], request: string): Promise<DeliverableInspection[]> {
  return Promise.all(relativePaths.map((p) => inspectDeliverable(root, p, request)));
}
