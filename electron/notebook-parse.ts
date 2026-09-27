import { createHash } from "node:crypto";
import LlamaCloud from "@llamaindex/llama-cloud";

// Format parsers: raw bytes -> canonical markdown (the single intermediate
// format for ingestion). Pure functions of (buffer, filename); no fs, no
// Electron. Heavy libraries (jszip, pdf-parse) load lazily so startup and
// unit tests never pay for them unless a matching file is parsed.

export type ParsedDocument = {
  markdown: string;
  parser: string;
  truncated: boolean;
  pageCount?: number;
};

export type ImageDescriber = (buffer: Buffer, filename: string, mimeType: string) => Promise<string | null>;
export type LlamaParseConfig = {
  apiKey: string;
  baseUrl?: string;
  tier?: "fast" | "cost_effective" | "agentic" | "agentic_plus";
  version?: string;
  timeoutSeconds?: number;
};

const MAX_MARKDOWN_CHARS = 500_000;

function cap(markdown: string): { markdown: string; truncated: boolean } {
  const text = (markdown || "").replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_MARKDOWN_CHARS) return { markdown: text.slice(0, MAX_MARKDOWN_CHARS), truncated: true };
  return { markdown: text, truncated: false };
}

function decodeText(buffer: Buffer): string {
  // Strip BOM, drop NULs from UTF-16-ish misdecodes.
  let text = buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  return text;
}

function imageMime(filename: string): string {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

async function parseImage(buffer: Buffer, filename: string, describeImage?: ImageDescriber): Promise<ParsedDocument> {
  const mimeType = imageMime(filename);
  let description = "No visual description was generated. Configure a vision-capable chat provider to analyze this image.";
  let parser = "image";
  if (describeImage) {
    try {
      const generated = await describeImage(buffer, filename, mimeType);
      if (generated?.trim()) {
        description = generated.trim().slice(0, MAX_MARKDOWN_CHARS);
        parser = "image-vision";
      }
    } catch {
      // Image ingestion remains useful even when the optional vision call
      // fails; the original bytes are still retained for future re-indexing.
    }
  }
  return {
    markdown: `# ${filename}\n\n## Visual description\n${description}`,
    parser,
    truncated: false,
  };
}

// ---- Plain formats ----

function parseCsv(buffer: Buffer, delimiter: string): ParsedDocument {
  const text = decodeText(buffer);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // skip, \n handles it
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  const clean = rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
  if (!clean.length) return { markdown: "", parser: "csv", truncated: false };
  const width = Math.max(...clean.map((r) => r.length));
  const norm = clean.map((r) => [...r, ...new Array(Math.max(0, width - r.length)).fill("")]);
  const esc = (c: string) => c.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const lines = [`| ${norm[0].map(esc).join(" | ")} |`, `| ${norm[0].map(() => "---").join(" | ")} |`];
  for (const r of norm.slice(1)) lines.push(`| ${r.map(esc).join(" | ")} |`);
  const { markdown, truncated } = cap(lines.join("\n"));
  return { markdown, parser: "csv", truncated };
}

function parseHtml(buffer: Buffer): ParsedDocument {
  let html = decodeText(buffer);
  html = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1\s*>/gi, " ");
  // Tables first (atomic), then headings/paragraphs/items in document order.
  const tableRe = /<table[\s\S]*?<\/table\s*>/gi;
  const tables: string[] = [];
  html = html.replace(tableRe, (m) => {
    const rows: string[][] = [];
    const rowRe = /<tr[\s\S]*?<\/tr\s*>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(m))) {
      const cells: string[] = [];
      const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1\s*>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[0]))) {
        cells.push(cm[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      const width = Math.max(...rows.map((r) => r.length));
      const norm = rows.map((r) => [...r, ...new Array(Math.max(0, width - r.length)).fill("")]);
      const esc = (c: string) => c.replace(/\|/g, "\\|");
      tables.push(`| ${norm[0].map(esc).join(" | ")} |\n| ${norm[0].map(() => "---").join(" | ")} |\n${norm.slice(1).map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n")}`);
    }
    return "\n";
  });
  const cleanInline = (s: string) =>
    s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
  // Document-order walk over the tags we care about. The capture runs to the
  // NEXT block boundary (not just to the next "<"), so text inside inline
  // markup — `<p>Hello <b>world</b> end</p>` — is kept; cleanInline strips
  // the tags afterwards.
  const parts: string[] = [];
  const walkRe = /<(h[1-6]|p|li|div|br|tr)[^>]*>([\s\S]*?)(?=<\/?(?:h[1-6]|p|li|div|br|tr|table|tbody|thead|ul|ol|dl|section|article)[\s>/]|<\/(?:h[1-6]|p|li|div|tr)>|\s*$)/gi;
  let wm: RegExpExecArray | null;
  while ((wm = walkRe.exec(html))) {
    const tag = wm[1].toLowerCase();
    const text = cleanInline(wm[2]);
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) parts.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else if (tag === "li") parts.push(`- ${text}`);
    else parts.push(text);
  }
  for (const t of tables) parts.push(t);
  const { markdown, truncated } = cap(parts.join("\n\n"));
  return { markdown, parser: "html", truncated };
}

// ---- Office formats (jszip, loaded lazily) ----

type ZipEntry = { async: (kind: "string" | "nodebuffer") => Promise<any> };
type ZipLike = { file: (name: string) => ZipEntry | null; files?: Record<string, ZipEntry & { dir?: boolean }> };

async function loadZip(buffer: Buffer): Promise<ZipLike> {
  const mod = await import("jszip");
  const JSZip = (mod as unknown as { default: new () => { loadAsync: (b: Buffer) => Promise<ZipLike> } }).default;
  return new JSZip().loadAsync(buffer);
}

async function describeEmbeddedImages(zip: ZipLike, prefix: string, describeImage?: ImageDescriber): Promise<string[]> {
  if (!describeImage || !zip.files) return [];
  const names = Object.keys(zip.files)
    .filter((name) => name.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(name) && !zip.files?.[name]?.dir)
    .slice(0, 20);
  const descriptions: string[] = [];
  for (const name of names) {
    try {
      const ext = (name.split(".").pop() || "jpg").toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const raw = await zip.files[name].async("nodebuffer");
      if (!Buffer.isBuffer(raw)) continue;
      const description = await describeImage(raw, name.split("/").pop() || name, mime);
      if (description?.trim()) descriptions.push(`### Embedded image: ${name.split("/").pop() || name}\n${description.trim().slice(0, 8000)}`);
    } catch {
      // One unreadable image must not fail the document ingestion job.
    }
  }
  return descriptions;
}

function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function parseDocx(buffer: Buffer, describeImage?: ImageDescriber): Promise<ParsedDocument> {
  const zip = await loadZip(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a valid .docx file (missing word/document.xml).");
  const xml = String(await docFile.async("string"));
  const lines: string[] = [];
  // Tables first: w:tbl blocks -> markdown tables (atomic).
  const tableRe = /<w:tbl[\s\S]*?<\/w:tbl>/g;
  const tables: string[] = [];
  let xmlNoTables = xml.replace(tableRe, (tbl) => {
    const rows: string[][] = [];
    const rowRe = /<w:tr[\s\S]*?<\/w:tr>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tbl))) {
      const cells: string[] = [];
      const cellRe = /<w:tc[\s\S]*?<\/w:tc>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[0]))) {
        const texts: string[] = [];
        const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(cm[0]))) texts.push(tm[1]);
        cells.push(xmlText(texts.join("")));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      const width = Math.max(...rows.map((r) => r.length));
      const norm = rows.map((r) => [...r, ...new Array(Math.max(0, width - r.length)).fill("")]);
      const esc = (c: string) => c.replace(/\|/g, "\\|");
      tables.push(`| ${norm[0].map(esc).join(" | ")} |\n| ${norm[0].map(() => "---").join(" | ")} |\n${norm.slice(1).map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n")}`);
    }
    return "";
  });
  const tablePlaceholders: string[] = tables;
  // Paragraphs in order, with heading styles.
  const pRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  const paras: string[] = [];
  while ((pm = pRe.exec(xmlNoTables))) {
    const p = pm[0];
    const styleM = p.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    const style = styleM ? styleM[1] : "";
    const texts: string[] = [];
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(p))) texts.push(tm[1]);
    const text = xmlText(texts.join(""));
    if (!text) continue;
    const headingM = style.match(/^Heading([1-6])$/i);
    if (/^Title$/i.test(style)) paras.push(`# ${text}`);
    else if (headingM) paras.push(`${"#".repeat(Number(headingM[1]))} ${text}`);
    else if (/^List(Bullet|Paragraph)/i.test(style)) paras.push(`- ${text}`);
    else paras.push(text);
  }
  const all = [...paras, ...tablePlaceholders];
  const visuals = await describeEmbeddedImages(zip, "word/media/", describeImage);
  const { markdown, truncated } = cap([...all, ...visuals].join("\n\n"));
  return { markdown, parser: "docx", truncated };
}

async function parsePptx(buffer: Buffer, describeImage?: ImageDescriber): Promise<ParsedDocument> {
  const zip = await loadZip(buffer);
  // Slide order from presentation.xml.
  const presFile = zip.file("ppt/presentation.xml");
  const slideOrder: string[] = [];
  if (presFile) {
    const presXml = String(await presFile.async("string"));
    const idRe = /<p:sldId[^>]*r:id="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(presXml))) slideOrder.push(m[1]);
  }
  const relsFile = zip.file("ppt/presentation.xml.rels");
  const relMap = new Map<string, string>();
  if (relsFile) {
    const relsXml = String(await relsFile.async("string"));
    const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"|<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(relsXml))) {
      relMap.set(m[1] || m[4], m[2] || m[3]);
    }
  }
  const slideTargets = slideOrder.map((id) => relMap.get(id)).filter((t): t is string => Boolean(t));
  const parts: string[] = [];
  let slideNo = 0;
  const targets = slideTargets.length ? slideTargets : ["slides/slide1.xml"];
  for (const target of targets) {
    const path = target.startsWith("ppt/") ? target : `ppt/${target.replace(/^\//, "")}`;
    const file = zip.file(path);
    if (!file) continue;
    slideNo++;
    const xml = String(await file.async("string"));
    // Tables -> markdown.
    const tblRe = /<a:tbl>[\s\S]*?<\/a:tbl>/g;
    const slideTables: string[] = [];
    const xmlNoTbl = xml.replace(tblRe, (tbl) => {
      const rows: string[][] = [];
      const trRe = /<a:tr[\s\S]*?<\/a:tr>/g;
      let rm: RegExpExecArray | null;
      while ((rm = trRe.exec(tbl))) {
        const cells: string[] = [];
        const tcRe = /<a:tc>[\s\S]*?<\/a:tc>/g;
        let cm: RegExpExecArray | null;
        while ((cm = tcRe.exec(rm[0]))) {
          const texts: string[] = [];
          const tRe = /<a:t>([\s\S]*?)<\/a:t>/g;
          let tm: RegExpExecArray | null;
          while ((tm = tRe.exec(cm[0]))) texts.push(tm[1]);
          cells.push(xmlText(texts.join(" ")));
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const norm = rows.map((r) => [...r, ...new Array(Math.max(0, width - r.length)).fill("")]);
        const esc = (c: string) => c.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
        slideTables.push(`| ${norm[0].map(esc).join(" | ")} |\n| ${norm[0].map(() => "---").join(" | ")} |\n${norm.slice(1).map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n")}`);
      }
      return "";
    });
    // Text shapes in order.
    const texts: string[] = [];
    const tRe = /<a:t>([\s\S]*?)<\/a:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(xmlNoTbl))) {
      const t = xmlText(tm[1]);
      if (t) texts.push(t);
    }
    const title = texts[0] || `Slide ${slideNo}`;
    parts.push(`## Slide ${slideNo}: ${title}`);
    for (const t of texts.slice(1)) parts.push(t);
    for (const t of slideTables) parts.push(t);
  }
  if (!parts.length) throw new Error("No readable slides found in .pptx file.");
  const visuals = await describeEmbeddedImages(zip, "ppt/media/", describeImage);
  const { markdown, truncated } = cap([...parts, ...visuals].join("\n\n"));
  return { markdown, parser: "pptx", truncated };
}

// ---- Spreadsheets (xlsx lib, loaded lazily) ----

function formatCellValue(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

async function parseWorkbook(buffer: Buffer, filename: string): Promise<ParsedDocument> {
  const mod = await import("xlsx");
  // CJS/ESM interop: the API may sit on default or directly on the namespace.
  const XLSX = ((mod as unknown as { default?: unknown }).default ?? mod) as {
    read: (data: Buffer, opts: Record<string, unknown>) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: { sheet_to_json: (ws: unknown, opts: Record<string, unknown>) => unknown[][] };
  };
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, sheetStubs: false });
  if (!workbook.SheetNames.length) throw new Error(`No readable sheets found in ${filename}.`);
  const MAX_SHEETS = 20;
  const MAX_ROWS = 200;
  const MAX_COLS = 50;
  const parts: string[] = [`# ${filename}`];
  let truncated = false;
  for (const name of workbook.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = workbook.Sheets[name];
    if (!ws) continue;
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
    // Drop fully-empty rows (stubs/padding) so sparse sheets stay compact.
    const rows = raw.filter((row) => Array.isArray(row) && row.some((cell) => cell !== "" && cell != null));
    if (!rows.length) continue;
    if (rows.length > MAX_ROWS || raw.length > MAX_ROWS) truncated = true;
    const clipped = rows.slice(0, MAX_ROWS).map((row) =>
      row.slice(0, MAX_COLS).map((cell) => formatCellValue(cell).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim())
    );
    if (raw.some((row) => Array.isArray(row) && row.length > MAX_COLS)) truncated = true;
    parts.push(`## Sheet: ${name}`);
    const width = Math.max(...clipped.map((r) => r.length));
    const norm = clipped.map((r) => [...r, ...new Array(Math.max(0, width - r.length)).fill("")]);
    parts.push(`| ${norm[0].join(" | ")} |`);
    parts.push(`| ${norm[0].map(() => "---").join(" | ")} |`);
    for (const r of norm.slice(1)) parts.push(`| ${r.join(" | ")} |`);
  }
  if (workbook.SheetNames.length > MAX_SHEETS) truncated = true;
  if (parts.length <= 1) throw new Error(`No readable data found in ${filename}.`);
  const { markdown, truncated: capped } = cap(parts.join("\n\n"));
  return { markdown, parser: "xlsx", truncated: truncated || capped };
}

// ---- PDF (pdf-parse v2, lazy) ----

async function parsePdf(buffer: Buffer, describeImage?: ImageDescriber): Promise<ParsedDocument> {
  const mod = await import("pdf-parse");
  const PDFParse = (mod as unknown as { PDFParse: new (opts: { data: Buffer }) => {
    getText: () => Promise<{ text: string; pages: Array<{ text: string }> }>;
    getScreenshot: (opts: { scale?: number; first?: number; last?: number }) => Promise<{ pages: Array<{ pageNumber?: number; data: Buffer }> }>;
    getImage: (opts: { imageThreshold?: number }) => Promise<{ pages: Array<{ pageNumber?: number; images: Array<{ data: Buffer; name?: string; width?: number; height?: number }> }> }>;
    destroy: () => Promise<void>;
  } }).PDFParse;
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const pages = result.pages?.length ? result.pages.map((p) => p.text) : [result.text];
    const joined = pages.map((t) => (t || "").trim()).filter(Boolean).join("\n\n");
    const { markdown, truncated } = cap(joined);
    if (markdown) {
      const visuals: string[] = [];
      if (describeImage) {
        try {
          const images = await parser.getImage({ imageThreshold: 80 });
          let count = 0;
          for (const page of images.pages || []) {
            for (const image of page.images || []) {
              if (count >= 20) break;
              const description = await describeImage(image.data, `page-${page.pageNumber || 0}-${image.name || count}.png`, "image/png");
              if (description?.trim()) visuals.push(`### PDF page ${page.pageNumber || "?"} image\n${description.trim().slice(0, 8000)}`);
              count++;
            }
          }
        } catch {
          // Text extraction remains valid when embedded-image extraction fails.
        }
      }
      const combined = visuals.length ? `${markdown}\n\n${visuals.join("\n\n")}` : markdown;
      const capped = cap(combined);
      return { markdown: capped.markdown, parser: visuals.length ? "pdf-vision" : "pdf", truncated: truncated || capped.truncated, pageCount: pages.length };
    }
    if (!describeImage) throw new Error("No extractable text found in PDF (it may be scanned images). Configure a vision-capable provider to analyze scanned pages.");
    try {
      const screenshots = await parser.getScreenshot({ scale: 1.25, first: 1, last: Math.min(pages.length || 20, 20) });
      const visualPages: string[] = [];
      for (const page of screenshots.pages || []) {
        const description = await describeImage(page.data, `page-${page.pageNumber || visualPages.length + 1}.png`, "image/png");
        if (description?.trim()) visualPages.push(`## Scanned page ${page.pageNumber || visualPages.length + 1}\n${description.trim().slice(0, 8000)}`);
      }
      if (!visualPages.length) throw new Error("No readable content found in scanned PDF pages.");
      const scanned = cap(visualPages.join("\n\n"));
      return { markdown: scanned.markdown, parser: "pdf-vision", truncated: scanned.truncated, pageCount: pages.length };
    } catch (error) {
      throw new Error(`No extractable text found in PDF (it may be scanned images). ${error instanceof Error ? error.message : "Vision analysis failed."}`);
    }
  } finally {
    try {
      await parser.destroy();
    } catch { /* best effort */ }
  }
}

// ---- Fallback for unknown/binary formats ----

function parseFallback(buffer: Buffer): ParsedDocument {
  const latin = buffer.toString("latin1");
  const runs = latin.match(/[ -~\t]{4,}|\n/g) || [];
  const text = runs.join("").replace(/[ \t]{2,}/g, " ").replace(/\u0000/g, "").trim();
  const { markdown, truncated } = cap(text);
  return { markdown, parser: "fallback", truncated };
}

// ---- Cloud parser hook (flag-gated, local fallback) ----

async function tryCloudParser(buffer: Buffer, filename: string): Promise<ParsedDocument | null> {
  const url = (process.env.NEXUS_CLOUD_PARSER_URL || "").trim();
  if (!url) return null;
  const res = await fetch(url.replace(/\/+$/, "") + "/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, base64: buffer.toString("base64") }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { markdown?: string };
  if (!payload.markdown?.trim()) return null;
  const { markdown, truncated } = cap(payload.markdown);
  return { markdown, parser: "cloud", truncated };
}

/** Parse with the official Llama Cloud/LlamaParse API. The SDK uploads the
 * bytes, waits for the asynchronous parse job, and returns page-aware Markdown
 * that preserves tables, figures, OCR, and document layout better than local
 * text extraction. */
export async function parseWithLlamaParse(buffer: Buffer, filename: string, config: LlamaParseConfig): Promise<ParsedDocument> {
  if (!config.apiKey.trim()) throw new Error("LlamaParse API key is not configured.");
  const client = new LlamaCloud({
    apiKey: config.apiKey.trim(),
    baseURL: (config.baseUrl || "https://api.cloud.llamaindex.ai").trim().replace(/\/+$/, ""),
    timeout: Math.max(30, config.timeoutSeconds || 600) * 1000,
    maxRetries: 1,
  });
  const result = await client.parsing.parse({
    tier: config.tier || "cost_effective",
    version: config.version || "latest",
    upload_file: new File([new Uint8Array(buffer)], filename),
    expand: ["markdown", "metadata"],
  });
  const pageMarkdown = result.markdown?.pages
    ?.map((page) => "markdown" in page ? page.markdown : "")
    .filter(Boolean)
    .join("\n\n") || result.markdown_full || "";
  const { markdown, truncated } = cap(pageMarkdown);
  if (!markdown) throw new Error("LlamaParse returned no Markdown content.");
  const pageCount = result.markdown?.pages?.length || undefined;
  return { markdown, parser: "llamaparse", truncated, pageCount };
}

/** Parse raw bytes to canonical markdown. Throws on unreadable input. */
export async function parseToMarkdown(buffer: Buffer, filename: string, options?: { allowCloud?: boolean; describeImage?: ImageDescriber; llamaParse?: LlamaParseConfig }): Promise<ParsedDocument> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (options?.llamaParse) {
    try {
      return await parseWithLlamaParse(buffer, filename, options.llamaParse);
    } catch (error) {
      if (options.llamaParse) throw new Error(`LlamaParse failed for ${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
    const parsed = await parseImage(buffer, filename, options?.describeImage);
    return parsed;
  }
  if (options?.allowCloud && (ext === "pdf" || ext === "docx" || ext === "pptx")) {
    try {
      const cloud = await tryCloudParser(buffer, filename);
      if (cloud && cloud.markdown.trim()) return cloud;
    } catch { /* fall through to local parsers */ }
  }
  let parsed: ParsedDocument;
  switch (ext) {
    case "md":
    case "markdown":
    case "txt":
    case "log":
    case "tex": {
      const { markdown, truncated } = cap(decodeText(buffer));
      parsed = { markdown, parser: ext === "md" || ext === "markdown" ? "markdown" : "text", truncated };
      break;
    }
    case "json": {
      const text = decodeText(buffer).trim();
      try {
        const obj = JSON.parse(text);
        const pretty = JSON.stringify(obj, null, 2);
        const flat: string[] = [];
        const walk = (value: unknown, prefix: string) => {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
          } else if (Array.isArray(value)) {
            value.slice(0, 50).forEach((v, i) => walk(v, `${prefix}[${i}]`));
          } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            flat.push(`${prefix}: ${value}`);
          }
        };
        walk(obj, "");
        const { markdown, truncated } = cap(`${flat.join("\n")}\n\n\`\`\`json\n${pretty.slice(0, 200_000)}\n\`\`\``);
        parsed = { markdown, parser: "json", truncated };
      } catch {
        const { markdown, truncated } = cap(text);
        parsed = { markdown, parser: "text", truncated };
      }
      break;
    }
    case "csv":
      parsed = parseCsv(buffer, ",");
      break;
    case "tsv":
      parsed = parseCsv(buffer, "\t");
      break;
    case "xlsx":
    case "xls":
    case "ods":
      parsed = await parseWorkbook(buffer, filename);
      break;
    case "html":
    case "htm":
      parsed = parseHtml(buffer);
      break;
    case "docx":
      parsed = await parseDocx(buffer, options?.describeImage);
      break;
    case "pptx":
      parsed = await parsePptx(buffer, options?.describeImage);
      break;
    case "pdf":
      parsed = await parsePdf(buffer, options?.describeImage);
      break;
    default:
      parsed = parseFallback(buffer);
      break;
  }
  if (!parsed.markdown.trim()) {
    throw new Error(`Could not extract text from ${filename}. Try a .txt or .md file.`);
  }
  // Content fingerprint for stable IDs and change detection.
  const fingerprint = createHash("sha256").update(parsed.markdown, "utf8").digest("hex").slice(0, 16);
  return { ...parsed, markdown: parsed.markdown };
}

export function contentFingerprint(markdown: string): string {
  return createHash("sha256").update(markdown || "", "utf8").digest("hex").slice(0, 16);
}
