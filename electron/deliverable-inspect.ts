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
import { z } from "zod";
import { tool } from "./agentcore/tools.js";
import { validateHomeArtifact } from "./home-artifact-service.js";

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

const PLACEHOLDER_PATTERN =
  /(?:\b(?:lorem\s+ipsum|click\s+to\s+add\s+(?:a\s+)?(?:title|text|subtitle)|TODO:\s*\S)|\[(?:insert\s+[^\]]+|placeholder[^\]]*|your\s+(?:name|title|company|date)[^\]]*)\])/i;
const SERIALIZATION_LEAK_PATTERN = /\[object Object\]/;
const RAW_MARKDOWN_LEAK_PATTERN = /(?:!\[[^\]]*\]\([^)]+\)|```[a-z]*\s|\|\s*---+\s*\|)/i;

type FormatInspection = {
  metrics: DeliverableMetrics;
  formatProblems: string[];
};

// ---- pptx ----------------------------------------------------------------

async function inspectPptx(bytes: Buffer): Promise<FormatInspection> {
  const zip = await loadZip(bytes);
  const slideNames = Object.keys(zip.files || {})
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) && !zip.files![name].dir)
    .sort((a, b) => (Number(a.match(/(\d+)/)?.[1]) || 0) - (Number(b.match(/(\d+)/)?.[1]) || 0));
  const titles: string[] = [];
  const formatProblems: string[] = [];
  const seenSlides = new Map<string, number>();
  let allText = "";
  for (let i = 0; i < Math.min(slideNames.length, 60); i++) {
    const name = slideNames[i];
    const xml = await zip.files![name].async("string");
    // <a:t> runs in document order; the first non-empty run of a slide is a
    // good-enough title heuristic (title placeholders are hard to detect
    // reliably across generator tools).
    const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlText(m[1])).filter(Boolean);
    // Designed decks put a bare kicker number ("01") before the title — skip
    // pure-number runs so the real title surfaces.
    const titleRun = runs.find((r) => !/^\d+$/.test(r.trim()));
    if (titleRun && titles.length < 30) titles.push(titleRun.slice(0, 120));
    const slideText = runs.join(" ").trim();
    const slideWords = countWords(slideText);
    const hasImage = /<p:pic[\s>]/i.test(xml);
    if (slideWords === 0 && !hasImage) {
      formatProblems.push(`slide ${i + 1} is empty (no text or image content)`);
    } else if (slideWords <= 1 && !hasImage && i > 0 && slideNames.length >= 2) {
      formatProblems.push(`slide ${i + 1} has almost no content (${slideWords} word) — expand it or merge with an adjacent slide`);
    }
    if (slideWords > 350) {
      formatProblems.push(`slide ${i + 1} has ~${slideWords} words and likely overflows slide bounds — split across multiple slides or condense into bullets`);
    }
    if (SERIALIZATION_LEAK_PATTERN.test(slideText)) {
      formatProblems.push(`slide ${i + 1} contains "[object Object]" serialization leak`);
    }
    if (/!\[[^\]]*\]\([^)]+\)|```/i.test(slideText)) {
      formatProblems.push(`slide ${i + 1} contains unrendered Markdown syntax (image link or code fence rendered as raw text)`);
    }
    if (PLACEHOLDER_PATTERN.test(slideText)) {
      formatProblems.push(`slide ${i + 1} still contains placeholder text`);
    }
    const norm = slideText.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm.length >= 20) {
      const prior = seenSlides.get(norm);
      if (prior !== undefined) {
        formatProblems.push(`slide ${i + 1} duplicates slide ${prior}`);
      } else {
        seenSlides.set(norm, i + 1);
      }
    }
    allText += ` ${slideText}`;
  }
  return {
    metrics: { kind: "pptx", primaryCount: slideNames.length, wordCount: countWords(allText), titles, textSample: allText.slice(0, 2000) },
    formatProblems,
  };
}

// ---- docx ----------------------------------------------------------------

async function inspectDocx(bytes: Buffer): Promise<FormatInspection> {
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
  const formatProblems: string[] = [];
  if (SERIALIZATION_LEAK_PATTERN.test(text)) formatProblems.push('document contains "[object Object]" serialization leak');
  if (PLACEHOLDER_PATTERN.test(text)) formatProblems.push("document contains leftover template placeholders");
  if (RAW_MARKDOWN_LEAK_PATTERN.test(text)) formatProblems.push("document contains unrendered Markdown syntax (table pipes, image tags, or code fences)");
  return {
    metrics: { kind: "docx", primaryCount: paras.length, wordCount: countWords(text), titles, textSample: text.slice(0, 2000) },
    formatProblems,
  };
}

// ---- xlsx ----------------------------------------------------------------

async function inspectXlsx(bytes: Buffer): Promise<FormatInspection> {
  const zip = await loadZip(bytes);
  const workbook = zip.file("xl/workbook.xml");
  const xml = workbook ? await workbook.async("string") : "";
  const sheetNames = [...xml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]).slice(0, 30);
  const sharedStrings: string[] = [];
  const sharedPart = zip.file("xl/sharedStrings.xml");
  if (sharedPart) {
    const ssXml = await sharedPart.async("string");
    for (const si of ssXml.matchAll(/<si[\s>][\s\S]*?<\/si>/g)) {
      const joined = [...si[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join("");
      sharedStrings.push(joined);
    }
  }
  const sheetFiles = Object.keys(zip.files || {})
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name) && !zip.files![name].dir)
    .sort((a, b) => (Number(a.match(/(\d+)/)?.[1]) || 0) - (Number(b.match(/(\d+)/)?.[1]) || 0));
  let totalRows = 0;
  const formatProblems: string[] = [];
  const formulaErrRe = /^(#(?:(?:REF|DIV\/0|VALUE|NUM|NULL)!|NAME\?|N\/A)|Err:\d+)$/i;
  for (let i = 0; i < sheetFiles.length; i++) {
    const sheetXml = await zip.files![sheetFiles[i]].async("string");
    const rowCount = (sheetXml.match(/<row[\s>]/g) || []).length;
    totalRows += rowCount;
    const sheetLabel = sheetNames[i] || `Sheet${i + 1}`;
    if (rowCount === 0 && sheetNames.length > 0) {
      formatProblems.push(`worksheet "${sheetLabel}" has 0 rows`);
    }
    const errorsFound = new Set<string>();
    for (const cm of sheetXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const body = cm[2];
      const typeMatch = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      let cellText = "";
      if (typeMatch === "inlineStr") {
        cellText = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join("");
      } else {
        const vVal = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
        if (typeMatch === "s") {
          const idx = Number(vVal);
          cellText = Number.isInteger(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : "";
        } else {
          cellText = xmlText(vVal);
        }
      }
      if (!cellText) continue;
      if (typeMatch === "e" || formulaErrRe.test(cellText.trim())) {
        errorsFound.add(cellText.trim());
      } else if (SERIALIZATION_LEAK_PATTERN.test(cellText) || /^(?:undefined|NaN)$/i.test(cellText.trim())) {
        errorsFound.add(cellText.trim());
      }
    }
    if (errorsFound.size > 0) {
      formatProblems.push(`worksheet "${sheetLabel}" contains formula/value errors (${[...errorsFound].slice(0, 5).join(", ")})`);
    }
  }
  return {
    metrics: { kind: "xlsx", primaryCount: sheetNames.length, wordCount: totalRows, titles: sheetNames, sheetNames, textSample: "" },
    formatProblems,
  };
}

// ---- pdf -----------------------------------------------------------------

async function inspectPdf(bytes: Buffer): Promise<FormatInspection> {
  type PdfParser = { getText: () => Promise<{ pages?: Array<{ items?: Array<{ text?: string }> }>; text?: string }>; destroy: () => Promise<void> };
  let parser: PdfParser | undefined;
  try {
    const mod = await import("pdf-parse");
    const PDFParse = (mod as unknown as { PDFParse: new (opts: { data: Buffer }) => PdfParser }).PDFParse;
    parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    const text = result.text || (result.pages || []).map((p) => (p.items || []).map((i) => i.text || "").join(" ")).join(" ");
    const pages = Math.max(1, (result.pages || []).length || ((bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length || 1));
    const formatProblems: string[] = [];
    if (SERIALIZATION_LEAK_PATTERN.test(text)) formatProblems.push('PDF contains "[object Object]" serialization leak');
    if (PLACEHOLDER_PATTERN.test(text)) formatProblems.push("PDF contains leftover template placeholders");
    if (RAW_MARKDOWN_LEAK_PATTERN.test(text)) formatProblems.push("PDF contains unrendered Markdown syntax");
    return {
      metrics: { kind: "pdf", primaryCount: pages, wordCount: countWords(text), titles: [], textSample: text.slice(0, 2000) },
      formatProblems,
    };
  } finally {
    await parser?.destroy().catch(() => {});
  }
}

// ---- plain text, csv, tex, svg, html, json, images -----------------------

function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function inspectText(bytes: Buffer, ext: string): FormatInspection {
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const formatProblems: string[] = [];

  if (ext === "csv") {
    const parsedRows = lines.map(splitCsvRow);
    const headerCols = parsedRows[0]?.length ?? 0;
    const inconsistentRows: number[] = [];
    let hasCellLeak = false;
    for (let r = 1; r < parsedRows.length; r++) {
      if (headerCols > 0 && parsedRows[r].length !== headerCols) inconsistentRows.push(r + 1);
      if (parsedRows[r].some((c) => SERIALIZATION_LEAK_PATTERN.test(c) || /^(?:undefined|NaN)$/i.test(c))) {
        hasCellLeak = true;
      }
    }
    if (inconsistentRows.length > 0) {
      formatProblems.push(`CSV has inconsistent column counts on row(s) ${inconsistentRows.slice(0, 5).join(", ")} (expected ${headerCols} columns)`);
    }
    if (hasCellLeak) {
      formatProblems.push('CSV contains invalid cell values ("undefined", "NaN", or "[object Object]")');
    }
    return {
      metrics: { kind: "csv", primaryCount: Math.max(0, lines.length - 1), wordCount: countWords(text), titles: parsedRows[0]?.slice(0, 20) || [], textSample: text.slice(0, 1000) },
      formatProblems,
    };
  }

  if (ext === "tex") {
    if (!/\\begin\{document\}/.test(text) || !/\\end\{document\}/.test(text)) {
      formatProblems.push("LaTeX file is missing \\begin{document} or \\end{document}");
    }
    const opens = new Map<string, number>();
    const closes = new Map<string, number>();
    for (const m of text.matchAll(/\\begin\{([A-Za-z0-9_*]+)\}/g)) opens.set(m[1], (opens.get(m[1]) || 0) + 1);
    for (const m of text.matchAll(/\\end\{([A-Za-z0-9_*]+)\}/g)) closes.set(m[1], (closes.get(m[1]) || 0) + 1);
    for (const [env, n] of opens) {
      if ((closes.get(env) || 0) !== n) {
        formatProblems.push(`LaTeX environment \\begin{${env}} / \\end{${env}} is unbalanced (${n} open vs ${closes.get(env) || 0} close)`);
      }
    }
    const prose = text.replace(/\\[A-Za-z@]+(\[[^\]]*\])?(\{[^}]*\})?/g, " ").replace(/[{}%]/g, " ");
    const proseWords = countWords(prose);
    if (proseWords < 3) formatProblems.push("LaTeX document contains almost no prose content");
    if (PLACEHOLDER_PATTERN.test(text)) formatProblems.push("LaTeX document contains leftover placeholder text");
    return {
      metrics: { kind: "tex", primaryCount: lines.length, wordCount: countWords(text), titles: [], textSample: prose.slice(0, 2000) },
      formatProblems,
    };
  }

  if (ext === "svg") {
    if (!/<svg[\s>]/i.test(text) || !/<\/svg>/i.test(text)) {
      formatProblems.push("SVG is missing valid <svg>...</svg> root tags");
    }
    if (!/\bviewBox\s*=/i.test(text) && !(/\bwidth\s*=/i.test(text) && /\bheight\s*=/i.test(text))) {
      formatProblems.push("SVG is missing viewBox or width/height dimensions");
    }
    if (!/<(?:path|rect|circle|ellipse|line|polyline|polygon|text|g|image|use)\b/i.test(text)) {
      formatProblems.push("SVG contains no drawable elements");
    }
    if (/=["'](?:NaN|undefined)["']/i.test(text)) {
      formatProblems.push('SVG contains "NaN" or "undefined" coordinate attributes');
    }
    return {
      metrics: { kind: "svg", primaryCount: lines.length, wordCount: countWords(text), titles: [], textSample: "" },
      formatProblems,
    };
  }

  if (ext === "html" || ext === "htm") {
    const scriptsOpen = (text.match(/<script(?:\s|>)/gi) || []).length;
    const scriptsClose = (text.match(/<\/script>/gi) || []).length;
    if (scriptsOpen !== scriptsClose) formatProblems.push("HTML has unclosed <script> tag");
    if (SERIALIZATION_LEAK_PATTERN.test(text)) formatProblems.push('HTML contains "[object Object]" serialization leak');
    const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    const visibleWords = countWords(stripped);
    if (visibleWords < 10 && !/<(?:canvas|svg|img)\b/i.test(text)) {
      formatProblems.push("HTML artifact has almost no visible text or graphics");
    }
    return {
      metrics: { kind: "html", primaryCount: lines.length, wordCount: visibleWords, titles: [], textSample: "" },
      formatProblems,
    };
  }

  if (ext === "json") {
    try {
      const parsed = JSON.parse(text);
      const isEmptyObj = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
      const isEmptyArr = Array.isArray(parsed) && parsed.length === 0;
      if (isEmptyObj || isEmptyArr) formatProblems.push("JSON artifact is empty ({} or [])");
    } catch (e) {
      formatProblems.push(`JSON syntax error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      metrics: { kind: "json", primaryCount: lines.length, wordCount: countWords(text), titles: [], textSample: "" },
      formatProblems,
    };
  }

  const titles = ext === "md" || ext === "markdown"
    ? (text.match(/^#{1,4}\s+(.+)$/gm) || []).map((h) => h.replace(/^#{1,4}\s+/, "").slice(0, 120)).slice(0, 30)
    : [];
  if (SERIALIZATION_LEAK_PATTERN.test(text)) formatProblems.push('document contains "[object Object]" serialization leak');
  if (PLACEHOLDER_PATTERN.test(text)) formatProblems.push("document contains leftover placeholder text");
  return {
    metrics: { kind: ext, primaryCount: lines.length, wordCount: countWords(text), titles, textSample: text.slice(0, 2000) },
    formatProblems,
  };
}

// ---- images --------------------------------------------------------------

function inspectImage(bytes: Buffer, ext: string): FormatInspection {
  let width = 0;
  let height = 0;
  const formatProblems: string[] = [];
  if (ext === "png") {
    if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      formatProblems.push("invalid PNG signature");
    } else {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    }
  } else if (ext === "jpg" || ext === "jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      formatProblems.push("invalid JPEG signature");
    } else {
      let i = 2;
      while (i + 8 < bytes.length) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          height = bytes.readUInt16BE(i + 5);
          width = bytes.readUInt16BE(i + 7);
          break;
        }
        const len = bytes.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } else if (ext === "webp") {
    if (bytes.length < 30 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
      formatProblems.push("invalid WebP signature");
    } else {
      const chunk = bytes.subarray(12, 16).toString("ascii");
      if (chunk === "VP8 " && bytes.length >= 30) {
        width = bytes.readUInt16LE(26) & 0x3fff;
        height = bytes.readUInt16LE(28) & 0x3fff;
      } else if (chunk === "VP8L" && bytes.length >= 25) {
        const b = bytes.readUInt32LE(21);
        width = (b & 0x3fff) + 1;
        height = ((b >> 14) & 0x3fff) + 1;
      } else if (chunk === "VP8X" && bytes.length >= 30) {
        width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      }
    }
  }
  if (!formatProblems.length && (width <= 0 || height <= 0)) {
    formatProblems.push(`${ext.toUpperCase()} image dimensions could not be decoded or are zero`);
  } else if (!formatProblems.length && width < 16 && height < 16) {
    formatProblems.push(`${ext.toUpperCase()} image is degenerate (${width}x${height}px) — expected a full visual asset`);
  }
  return {
    metrics: { kind: ext, primaryCount: width, wordCount: height, titles: [], textSample: "" },
    formatProblems,
  };
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
  let inspected: FormatInspection;
  try {
    const bytes = await fs.readFile(full);
    if (ext === "pptx") inspected = await inspectPptx(bytes);
    else if (ext === "docx") inspected = await inspectDocx(bytes);
    else if (ext === "xlsx") inspected = await inspectXlsx(bytes);
    else if (ext === "pdf") inspected = await inspectPdf(bytes);
    else if (["md", "markdown", "txt", "csv", "tex", "svg", "html", "htm", "json"].includes(ext)) inspected = inspectText(bytes, ext);
    else if (["png", "jpg", "jpeg", "webp"].includes(ext)) inspected = inspectImage(bytes, ext);
    else {
      // Source scripts / unknown kinds: nothing content-level to judge.
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

  const { metrics, formatProblems } = inspected;
  const problems: string[] = [...formatProblems];
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

  // Topic coverage for prose/document deliverables (skip structured/code/image kinds).
  const PROSE_TOPIC_KINDS = new Set(["pptx", "docx", "pdf", "md", "markdown", "txt", "csv"]);
  const keywords = PROSE_TOPIC_KINDS.has(ext) ? extractRequestKeywords(request) : [];
  if (keywords.length && metrics.textSample) {
    const haystack = metrics.textSample.toLowerCase();
    const missing = keywords.filter((word) => !haystack.includes(word));
    const required = Math.min(2, keywords.length);
    if (keywords.length - missing.length < required) {
      problems.push(`the request's key terms (${keywords.slice(0, 4).join(", ")}) barely appear in the content — missing ${missing.slice(0, 4).join(", ")}; make sure the output actually covers the requested topic`);
    }
  }

  const isImage = ["png", "jpg", "jpeg", "webp"].includes(ext);
  const units = ext === "pptx" ? "slides" : ext === "xlsx" ? "sheets" : ext === "pdf" ? "pages" : ext === "csv" ? "rows" : "lines";
  const summary = isImage
    ? `${metrics.primaryCount}x${metrics.wordCount}px ${ext.toUpperCase()} image`
    : `${metrics.primaryCount} ${units}, ~${metrics.wordCount} words${metrics.titles.length ? `, titles: ${metrics.titles.slice(0, 3).join(" | ")}` : ""}`;
  return { path: normalized, kind: ext || "unknown", ok: problems.length === 0, metrics, problems, summary };
}

/** Inspect several deliverables in parallel; skips non-inspectable kinds. */
export async function inspectDeliverables(root: string, relativePaths: string[], request: string): Promise<DeliverableInspection[]> {
  return Promise.all(relativePaths.map((p) => inspectDeliverable(root, p, request)));
}

/**
 * Creates the `inspect_artifact` tool for Home and Code modes so the agent can
 * inspect any generated artifact (pptx, docx, xlsx, pdf, tex, svg, html, json,
 * csv, md, png/jpg/webp) for structural and content problems and self-correct
 * before finishing.
 */
export function createInspectArtifactTool(options: { projectRoot: string; request?: string }) {
  return tool(
    async ({ file_path }: { file_path: string }) => {
      const rel = String(file_path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
      if (!rel) return "file_path is required.";
      const structural = await validateHomeArtifact(options.projectRoot, rel);
      const inspection = await inspectDeliverable(options.projectRoot, rel, options.request || "");
      const problems = [
        ...(structural.valid ? [] : [`STRUCTURE: ${structural.error || "failed structural validation"}`]),
        ...inspection.problems.map((p) => `CONTENT: ${p}`),
      ];
      return [
        `Artifact: ${rel}`,
        `Structure: ${structural.valid ? `VALID (${structural.size} bytes)` : `INVALID — ${structural.error || "invalid"}`}`,
        `Content: ${inspection.summary}`,
        problems.length > 0
          ? `Status: PROBLEMS DETECTED (fix these before finishing):\n${problems.map((p) => `- ${p}`).join("\n")}`
          : "Status: OK — passed structural and content checks.",
      ].join("\n");
    },
    {
      name: "inspect_artifact",
      description:
        "Inspect a generated deliverable or artifact (pptx, docx, xlsx, pdf, tex, svg, html, json, csv, md, png/jpg/webp) for structural integrity, slide/page/sheet completeness, formula errors, placeholders, overflow, or missing content. Use this after building or editing any artifact with scripts or tools, and fix any reported problems before presenting the final result.",
      schema: z.object({
        file_path: z.string().min(1).describe("Workspace-relative path to the generated artifact (e.g. 'deck.pptx', 'report.pdf', 'chart.svg')."),
      }),
    }
  );
}
