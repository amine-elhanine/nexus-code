import { createHash } from "node:crypto";

// Pure deterministic core for Notebook Mode: stable IDs, markdown cleaning,
// structure extraction, chunking, upload validation, routing heuristics and
// the groundedness gate. No I/O, no Electron, no network — plain-node testable.

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// RFC 4122 uuid v5 (SHA-1 namespace + name). Implemented locally so the
// backend needs no extra dependency for stable deterministic chunk IDs.
const UUID_URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}
export function uuid5(name: string, namespace = UUID_URL_NAMESPACE): string {
  const hash = createHash("sha1").update(Buffer.concat([uuidToBytes(namespace), Buffer.from(name, "utf8")])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable deterministic chunk ID: uuid5(session+file+section+index+content-hash). */
export function stableChunkId(sessionId: string, fileId: string, sectionId: string, index: number, contentHash: string): string {
  return uuid5([sessionId, fileId, sectionId, String(index), contentHash].join("|"));
}

// ---- Upload validation (API edge) ----

export const NOTEBOOK_ALLOWED_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "html", "htm", "pdf", "docx", "pptx", "log", "tex", "json", "png", "jpg", "jpeg", "webp"]);
export const NOTEBOOK_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function validateUpload(filename: string, byteLength: number): { ok: boolean; error?: string } {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (!NOTEBOOK_ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: `Unsupported file type .${ext || "?"}. Supported: ${[...NOTEBOOK_ALLOWED_EXTENSIONS].sort().join(", ")}.` };
  }
  if (byteLength > NOTEBOOK_MAX_UPLOAD_BYTES) {
    return { ok: false, error: `File is too large (${Math.round(byteLength / 1024 / 1024)} MB). Limit is 15 MB.` };
  }
  if (byteLength === 0) return { ok: false, error: "File is empty." };
  return { ok: true };
}

// ---- Markdown cleaning (conservative boilerplate removal) ----

const STOPWORDS = new Set(
  "the,a,an,and,or,of,to,in,on,for,with,as,at,by,from,is,are,was,were,be,been,being,it,its,this,that,these,those,you,your,he,she,they,them,his,her,their,our,we,us,i,me,my,not,no,yes,if,then,else,when,where,which,who,whom,what,how,why,can,could,should,would,will,do,does,did,have,has,had,all,any,each,more,most,other,some,such,than,too,very,into,over,after,before,between,through,during,about,against,per,via,also,within,without".split(",")
);

export function notebookTokens(text: string): string[] {
  // Unicode-aware tokenization is important for education content: Arabic,
  // French accents, Greek, Cyrillic, and mixed-language course notes must be
  // searchable just like English documents.
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_\-]{2,}/gu) || []).filter((t) => !STOPWORDS.has(t));
}

export function meaningfulQueryTerms(query: string): string[] {
  const terms = new Set(notebookTokens(query));
  return [...terms].filter((t) => t.length >= 4);
}

// Split markdown into protected vs cleanable lines: fenced code blocks,
// indented code, tables and math blocks are never touched.
function maskProtectedBlocks(lines: string[]): boolean[] {
  const masked = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  let inMath = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      masked[i] = true;
      inFence = !inFence;
      continue;
    }
    if (/^\$\$/.test(trimmed)) {
      masked[i] = true;
      // Single-line $$...$$ stays masked; multi-line toggles.
      if (trimmed.length > 2 && trimmed.endsWith("$$")) continue;
      inMath = !inMath;
      continue;
    }
    if (inFence || inMath) {
      masked[i] = true;
      continue;
    }
    if (/^( {4}|\t)\S/.test(line)) {
      masked[i] = true; // indented code
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|.-]*$/.test(line)) {
      masked[i] = true; // tables incl. delimiter rows
      continue;
    }
  }
  return masked;
}

function isBoilerplateLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^(page\s+\d+(\s*(of|\/)\s*\d+)?|\d+\s*\/\s*\d+|p\.\s*\d+)$/i.test(t)) return true; // page counters
  if (/^slide\s+\d+(\s*(of|\/)\s*\d+)?$/i.test(t)) return true;
  if (/^[.\-–—_*\s]{8,}$/.test(t)) return true; // dot leaders / rule noise
  if (/^©|copyright|all rights reserved|confidential|internal use only/i.test(t) && t.length < 120) return true;
  if (/^(header|footer|logo|nav|menu|sidebar|advertisement)$/i.test(t)) return true;
  return false;
}

/**
 * Remove parser/slide boilerplate. Conservative: headings, tables, code
 * blocks and math are masked and never touched; repeated short lines
 * (running headers/footers appearing 3+ times) are dropped entirely.
 */
export function cleanMarkdown(markdown: string): { cleaned: string; removedLines: number } {
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
  const masked = maskProtectedBlocks(lines);
  const counts = new Map<string, number>();
  lines.forEach((line, i) => {
    if (masked[i] || /^\s*#{1,6}\s/.test(line)) return;
    const key = line.trim().toLowerCase();
    if (key.length >= 4 && key.length < 100) counts.set(key, (counts.get(key) || 0) + 1);
  });
  const repeated = new Set([...counts.entries()].filter(([, n]) => n >= 3).map(([k]) => k));
  const out: string[] = [];
  let removed = 0;
  lines.forEach((line, i) => {
    if (masked[i] || /^\s*#{1,6}\s/.test(line)) {
      out.push(line);
      return;
    }
    const key = line.trim().toLowerCase();
    if (isBoilerplateLine(line) || (key.length >= 4 && key.length < 100 && repeated.has(key))) {
      removed++;
      return;
    }
    out.push(line);
  });
  // Collapse 3+ blank lines to two.
  const collapsed = out.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return { cleaned: collapsed, removedLines: removed };
}

// ---- Structure extraction (deterministic, no LLM) ----

export type LibrarySectionInput = {
  heading: string;
  level: number;
  headingPath: string[];
  text: string;
};

function stripHeadingMarkers(line: string): { level: number; text: string } | null {
  const md = line.match(/^(#{1,6})\s+(.*)$/);
  if (md) return { level: md[1].length, text: md[2].trim() };
  const numbered = line.match(/^(\d+(?:\.\d+)*)[.)]\s+(.{3,120})$/);
  if (numbered) {
    const depth = numbered[1].split(".").length;
    return { level: Math.min(1 + depth, 6), text: numbered[2].trim() };
  }
  const chapter = line.match(/^(chapter|section|part|slide)\s+(\d+[.\d]*)\s*[:\-–.]?\s*(.{0,120})$/i);
  if (chapter) return { level: 1, text: line.trim() };
  // Plain inferred heading: short standalone line, Title Case or ALL CAPS.
  const t = line.trim();
  if (t.length >= 3 && t.length <= 100 && !/[.!?;:]$/.test(t) && !/^\W/.test(t)) {
    if (/^[A-Z0-9][A-Z0-9\s\-–:,&'()]{2,}$/.test(t) && /[A-Z]/.test(t)) return { level: 2, text: t };
    if (/^([A-Z][a-z0-9]+)(\s+[A-Z][a-z0-9]+){0,7}$/.test(t)) return { level: 2, text: t };
  }
  return null;
}

/** Walk markdown lines into a section hierarchy with full heading paths. */
export function extractStructure(markdown: string, fallbackTitle: string): LibrarySectionInput[] {
  const lines = (markdown || "").split("\n");
  const sections: LibrarySectionInput[] = [];
  let current: { heading: string; level: number; headingPath: string[]; text: string[] } | null = null;
  const stack: { heading: string; level: number }[] = [];
  let inFence = false;
  const flush = () => {
    if (current) {
      sections.push({ heading: current.heading, level: current.level, headingPath: [...current.headingPath], text: current.text.join("\n").trim() });
      current = null;
    }
  };
  for (const raw of lines) {
    const line = raw;
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence;
      if (!current) {
        current = { heading: fallbackTitle, level: 1, headingPath: [fallbackTitle], text: [] };
        stack.length = 0;
      }
      current.text.push(line);
      continue;
    }
    if (!inFence) {
      const h = stripHeadingMarkers(line);
      if (h) {
        flush();
        while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
        stack.push({ heading: h.text, level: h.level });
        current = { heading: h.text, level: h.level, headingPath: stack.map((s) => s.heading), text: [] };
        continue;
      }
    }
    if (!current) {
      current = { heading: fallbackTitle, level: 1, headingPath: [fallbackTitle], text: [] };
      stack.length = 0;
      stack.push({ heading: fallbackTitle, level: 1 });
    }
    current.text.push(line);
  }
  flush();
  // Merge leading empty sections into the next one so boilerplate-only heads vanish.
  const merged = sections.filter((s, i) => s.text.trim().length > 0 || i === sections.length - 1);
  if (!merged.length) {
    return [{ heading: fallbackTitle, level: 1, headingPath: [fallbackTitle], text: markdown.trim() }];
  }
  return merged.map((s) => ({ ...s, text: s.text.trim() }));
}

export function oneSentenceSummary(text: string, cap = 220): string {
  const plain = text.replace(/[#>*`|\-[\]()]/g, " ").replace(/\s+/g, " ").trim();
  const match = plain.match(/^(.{20,400}?[.!?])(\s|$)/);
  const sentence = (match ? match[1] : plain.slice(0, cap)).trim();
  return sentence.length > cap ? `${sentence.slice(0, cap)}…` : sentence;
}

export function keyTerms(text: string, cap = 8): string[] {
  const freq = new Map<string, number>();
  for (const tok of notebookTokens(text)) {
    if (tok.length >= 5) freq.set(tok, (freq.get(tok) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([t]) => t);
}

// ---- Chunking (never splits tables / code / math mid-block) ----

export type ChunkInput = {
  sectionId: string;
  headingPath: string[];
  ordinalInSection: number;
  text: string;
  tokenCount: number;
  structured: boolean; // whole-block chunk (table/code/equation)
};

function splitSentences(paragraph: string): string[] {
  // Protect common abbreviations before splitting.
  const protected_ = paragraph.replace(/\b(e\.g|i\.e|vs|etc|Mr|Mrs|Ms|Dr|Fig|Eq|Sec|Ch)\./gi, (m) => m.replace(/\./g, "\u0001"));
  const parts = protected_.split(/(?<=[.!?…])\s+(?=[A-Z0-9"'“\(\[])/);
  return parts.map((p) => p.replace(/\u0001/g, ".").trim()).filter(Boolean);
}

/** Split section text into block units; structured blocks stay atomic. */
function sectionBlocks(text: string): Array<{ text: string; structured: boolean }> {
  const lines = text.split("\n");
  const blocks: Array<{ text: string; structured: boolean }> = [];
  let current: string[] = [];
  let currentIsTable: boolean | null = null;
  let inFence = false;
  let fenceBuf: string[] = [];
  const flushPara = () => {
    const t = current.join("\n").trim();
    if (t) {
      // Further split oversized prose by blank-line paragraphs.
      for (const para of t.split(/\n{2,}/)) {
        const p = para.trim();
        if (p) blocks.push({ text: p, structured: false });
      }
    }
    current = [];
    currentIsTable = null;
  };
  const pushLine = (line: string, isTable: boolean) => {
    // Never let prose and table rows share a paragraph block.
    if (current.length && currentIsTable !== null && currentIsTable !== isTable) flushPara();
    currentIsTable = isTable;
    current.push(line);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      if (!inFence) {
        flushPara();
        inFence = true;
        fenceBuf = [line];
      } else {
        fenceBuf.push(line);
        blocks.push({ text: fenceBuf.join("\n"), structured: true });
        fenceBuf = [];
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|.-]*$/.test(line)) {
      // Table row: accumulates in `current`, regrouped into one atomic
      // block below.
      pushLine(line, true);
      continue;
    }
    if (/^\$\$/.test(trimmed)) {
      flushPara();
      blocks.push({ text: line, structured: true });
      continue;
    }
    pushLine(line, false);
  }
  if (inFence && fenceBuf.length) blocks.push({ text: fenceBuf.join("\n"), structured: true });
  flushPara();
  // Regroup: pure table-row paragraphs merge into single atomic blocks so a
  // table is never split mid-block.
  const isTableRow = (t: string) => /^\s*\|.*\|\s*$/.test(t) || /^\s*\|?[\s:|-]+\|[\s:|.-]*$/.test(t);
  const regrouped: Array<{ text: string; structured: boolean }> = [];
  let tableBuf: string[] = [];
  const flushTable = () => {
    if (tableBuf.length) {
      regrouped.push({ text: tableBuf.join("\n"), structured: true });
      tableBuf = [];
    }
  };
  for (const b of blocks) {
    if (!b.structured && b.text.split("\n").every((l) => isTableRow(l))) {
      tableBuf.push(b.text);
    } else {
      flushTable();
      regrouped.push(b);
    }
  }
  flushTable();
  return regrouped;
}

export function chunkSections(
  sections: Array<{ sectionId: string; headingPath: string[]; text: string }>,
  options?: { maxTokens?: number; overlapSentences?: number }
): ChunkInput[] {
  const maxTokens = options?.maxTokens || 400;
  const overlap = options?.overlapSentences ?? 1;
  const out: ChunkInput[] = [];
  for (const section of sections) {
    let ordinal = 0;
    let carry: string[] = [];
    const push = (text: string, structured: boolean) => {
      const t = text.trim();
      if (!t) return;
      out.push({ sectionId: section.sectionId, headingPath: section.headingPath, ordinalInSection: ordinal++, text: t, tokenCount: estimateTokens(t), structured });
    };
    for (const block of sectionBlocks(section.text)) {
      if (block.structured) {
        // Atomic: an oversized table/code block becomes its own chunk.
        if (carry.length) {
          push(carry.join(" "), false);
          carry = [];
        }
        push(block.text, true);
        continue;
      }
      for (const sentence of splitSentences(block.text)) {
        const trial = [...carry, sentence].join(" ");
        if (estimateTokens(trial) > maxTokens && carry.length) {
          push(carry.join(" "), false);
          carry = carry.slice(-overlap);
        }
        carry.push(sentence);
        if (estimateTokens(carry.join(" ")) > maxTokens * 1.5) {
          push(carry.join(" "), false);
          carry = [];
        }
      }
    }
    if (carry.length) push(carry.join(" "), false);
  }
  return out;
}

// ---- Chat routing (cheap-first, deterministic heuristics) ----

export type RouteAction = "conversational_reply" | "retrieve" | "outside_files";

const CONVERSATIONAL_PATTERN = /^(hi|hii+|hello|hey|yo|thanks|thank you|thx|bye|goodbye|ok|okay|got it|great|perfect|nice|cool)[!.?…\s]*$/i;
const OFF_TOPIC_HINTS = /\b(weather|forecast|rain|recipe|cook|cooking|football|soccer|basketball|match score|lottery|horoscope|stock price|bitcoin price|birthday|joke|movie|netflix|flight|hotel)\b/i;
const SESSION_WIDE_PATTERN = /\b(summariz(e|ing|ation)?\b.{0,30}\b(all|everything|every|entire|whole|files|documents|corpus)\b|\bwhat\b.{0,30}\b(these|those|the|my)\b.{0,20}\b(files|documents|docs)\b.{0,20}\b(about|cover|contain)\b|\bwhat\s+(?:is|are|['’]s)\s+(?:this|it|these|those|the\s+(?:files?|documents?|docs?))(?:\s+\w+){0,3}\s+about\b|\boverview\b.{0,20}\b(of\b.{0,20})?(these|those|the|my|all)\b|\blist\b.{0,20}\b(all|every)\b.{0,20}\b(headings|sections|topics|files|documents)\b)/i;

export function isSessionWideAsk(text: string): boolean {
  return SESSION_WIDE_PATTERN.test((text || "").trim());
}

const POLITENESS_PATTERN = /\b(please|can you|could you|would you|tell me|show me|i want to know|i'd like to know)\b/gi;

/** Compact rewritten search query: strip politeness + punctuation. */
export function rewriteQuery(text: string): string {
  return (text || "")
    .replace(POLITENESS_PATTERN, " ")
    .replace(/[?!.…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function routeMessageHeuristic(text: string, sessionTermSet: Set<string>): { action: RouteAction; query: string } {
  const trimmed = (text || "").trim();
  if (!trimmed) return { action: "conversational_reply", query: "" };
  if (trimmed.length < 40 && CONVERSATIONAL_PATTERN.test(trimmed)) {
    return { action: "conversational_reply", query: trimmed };
  }
  const query = rewriteQuery(trimmed);
  if (OFF_TOPIC_HINTS.test(trimmed)) {
    // Off-topic only when nothing in the session echoes the terms.
    const terms = meaningfulQueryTerms(trimmed);
    const overlaps = terms.some((t) => sessionTermSet.has(t));
    if (!overlaps) return { action: "outside_files", query };
  }
  return { action: "retrieve", query: query || trimmed };
}

// ---- Groundedness gate ----

export function gateDecision(query: string, bestSemantic: number, retrievedTexts: string[], bestLexical = 0): { refused: boolean; reason?: string } {
  const terms = meaningfulQueryTerms(query);
  const haystack = retrievedTexts.join("\n").toLowerCase();
  const literalHits = terms.filter((t) => haystack.includes(t)).length;
  // Semantic vectors can be unavailable or from a different embedding space
  // than the current Settings selection. A strong lexical hit is still valid
  // evidence and must not be rejected by the hallucination guard.
  if (bestSemantic < 0.08 && bestLexical < 0.2 && literalHits === 0) {
    return { refused: true, reason: "no semantic or lexical evidence matched the question" };
  }
  return { refused: false };
}

// ---- Context composition (bounded, deduped) ----

export function composeContextBlock(
  chunks: Array<{ headingPath: string[]; text: string; summary?: string }>,
  maxChars = 12000
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let used = 0;
  chunks.forEach((chunk, i) => {
    const key = sha256Hex(chunk.text).slice(0, 16);
    if (seen.has(key)) return;
    seen.add(key);
    const head = `[S${i + 1}] ${(chunk.headingPath || []).join(" › ") || "Document"}`;
    const summary = chunk.summary ? `\nSection summary: ${chunk.summary}` : "";
    const block = `${head}\n${chunk.text.slice(0, 1800)}${summary}`;
    if (used + block.length > maxChars && parts.length > 0) return;
    parts.push(block);
    used += block.length;
  });
  return parts.join("\n\n");
}
