// Deterministic Home deliverable generation: the `create_deliverable` tool.
//
// Small models cannot reliably author working python-pptx/python-docx/
// openpyxl/reportlab scripts (broken imports, malformed code, pip bootstrap
// failures, truncated one-shot scripts). They CAN write well-structured
// Markdown content. This tool inverts the old pipeline: the model supplies
// CONTENT, Nexus renders the file with the deterministic JS engines that ship
// with the app (docx / pptxgenjs / SheetJS / offscreen printToPDF) and then
// validates + content-inspects the artifact inline, so a repair round costs
// one tool call instead of a full verify loop.
//
// The generator-script path (bundled skills + user skills) stays available
// for custom designs; this is the fast, reliable default.

import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { z } from "zod";
import { tool, type AgentTool } from "./agentcore/tools.js";
import {
  markdownToReportPlan,
  markdownToSlidesPlan,
  renderDocx,
  renderPdf,
  renderPptx,
  safeStem,
} from "./notebook-documents.js";
import { validateHomeArtifact } from "./home-artifact-service.js";
import { inspectDeliverable } from "./deliverable-inspect.js";

export type DeliverableFormat = "docx" | "pptx" | "xlsx" | "pdf" | "tex" | "md" | "csv" | "txt";

const FORMAT_EXTENSION: Record<DeliverableFormat, string> = {
  docx: ".docx",
  pptx: ".pptx",
  xlsx: ".xlsx",
  pdf: ".pdf",
  tex: ".tex",
  md: ".md",
  csv: ".csv",
  txt: ".txt",
};

const MARKDOWN_CONTRACT = `Content contract (plain Markdown — this is ALL you write, the file is rendered for you):
- Reports (docx/pdf): "# Title"; the paragraphs BEFORE the first "## " heading become the executive summary; "## Section heading" starts a section (plain paragraphs + "- " bullet key points); a "## Key takeaways" section at the end becomes the takeaways list. 2-5 substantive sections.
- Presentations (pptx): "# Deck title"; one "## Slide title" per slide with 2-5 "- " bullets under it; "> Note: text" becomes a highlighted callout card; a fenced code block becomes a dark code card; a standalone image line "![alt](https://...)" embeds the picture beside that slide's bullets (png/jpg/gif — find real image URLs with web_image_search first; 2-4 images across the deck). Bullets formatted "Lead — explanation" render the lead bold. The first slide is an automatic designed cover; keep 6-12 slides.
- Spreadsheets (xlsx): one "## Sheet name" heading per worksheet, each containing ONE Markdown table ("| col | col |" rows, first row = headers). 4+ data rows per sheet.
- tex/csv/md/txt: content is written to the file verbatim (for csv use comma-separated rows with a header row).`;

/** Sanitizes a model-provided file name: basename only, safe characters, forced extension. */
export function sanitizeDeliverableFileName(raw: string, format: DeliverableFormat): string {
  const ext = FORMAT_EXTENSION[format];
  let name = String(raw || "").replace(/\\/g, "/").split("/").pop() || "";
  name = name.replace(/[<>:"|?*\0]/g, "").replace(/\s+/g, " ").trim();
  if (!name) name = `deliverable-${new Date().toISOString().slice(0, 10)}${ext}`;
  name = name.slice(0, 120).trim();
  if (!name.toLowerCase().endsWith(ext)) name = `${name}${ext}`;
  return name;
}

/** Parses `## Sheet name` sections containing ONE Markdown table each. */
export function markdownToSheets(md: string, fallbackName = "Sheet1"): Array<{ name: string; rows: string[][] }> {
  const sheets: Array<{ name: string; rows: string[][] }> = [];
  let current: { name: string; rows: string[][] } | null = null;
  const flush = () => {
    if (current && current.rows.length) sheets.push(current);
    current = null;
  };
  for (const raw of String(md || "").split(/\r?\n/)) {
    const heading = raw.match(/^#{1,3}\s+(.*)/);
    if (heading) {
      flush();
      const name = heading[1].replace(/^sheet\s*:\s*/i, "").trim().slice(0, 31).replace(/[\[\]:*?\/\\]/g, " ").trim() || `Sheet${sheets.length + 1}`;
      current = { name, rows: [] };
      continue;
    }
    if (!current) current = { name: fallbackName, rows: [] };
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    // Separator rows (|---|---|) are skipped.
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    current.rows.push(cells);
  }
  flush();
  return sheets;
}

/** Parses "$1,200.50" / "45.2%" / "1200" into a typed value + number format. */
function parseNumericCell(raw: string): { v: number; z?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("=")) return null; // formula — caller handles
  const currency = /^\$\s*-?[\d,]+(\.\d+)?$/.test(trimmed);
  const percent = /^-?[\d,]+(\.\d+)?\s*%$/.test(trimmed);
  const plain = /^-?[\d,]+(\.\d+)?$/.test(trimmed);
  const num = Number(trimmed.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(num) || !plain && !currency && !percent) return null;
  if (currency) return { v: num, z: "$#,##0.00" };
  if (percent) return { v: num / 100, z: "0.0%" };
  return { v: num };
}

async function renderXlsxSheets(sheets: Array<{ name: string; rows: string[][] }>): Promise<Buffer> {
  const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows.map((row) =>
      row.map((cell) => {
        const trimmed = String(cell ?? "").trim();
        if (trimmed.startsWith("=")) return { f: trimmed.slice(1) }; // native formula
        const numeric = parseNumericCell(trimmed);
        return numeric ? numeric : trimmed;
      })
    ));
    // Styled header row.
    const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
    for (let col = range.s.c; col <= range.e.c; col++) {
      const addr = XLSX.utils.encode_cell({ r: range.s.r, c: col });
      if (!worksheet[addr]) continue;
      worksheet[addr].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F3864" } } };
    }
    // Auto-fit column widths from header and cell content lengths.
    if (!worksheet["!cols"]) worksheet["!cols"] = [];
    for (let col = range.s.c; col <= range.e.c; col++) {
      let maxLen = 8;
      for (let row = range.s.r; row <= range.e.r; row++) {
        const addr = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[addr];
        const len = String(cell?.v ?? cell?.f ?? "").length;
        if (len > maxLen) maxLen = len;
      }
      worksheet["!cols"][col] = { wch: Math.min(maxLen + 3, 50) };
    }
    worksheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31) || `Sheet${sheets.length}`);
  }
  const out = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as unknown as Uint8Array);
}

/** Resolves ![alt](local-file) references from the workspace into data URIs. */
async function resolveWorkspaceImages(content: string, projectRoot: string): Promise<string> {
  const IMAGE_REF = /!\[([^\]]*)\]\((?!https?:\/\/|data:)([^)\s]+)\)/g;
  const matches = [...content.matchAll(IMAGE_REF)];
  if (!matches.length) return content;
  let resolved = content;
  for (const match of matches) {
    const alt = match[1];
    const localPath = match[2];
    const safeName = path.basename(localPath.replace(/\\/g, "/"));
    const abs = path.join(projectRoot, safeName);
    try {
      const stat = await fsPromises.stat(abs);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) continue;
      const ext = path.extname(safeName).toLowerCase();
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext];
      if (!mime) continue;
      const bytes = await fsPromises.readFile(abs);
      resolved = resolved.replace(match[0], `![${alt}](data:${mime};base64,${bytes.toString("base64")})`);
    } catch { /* file not found — leave the reference as-is */ }
  }
  return resolved;
}

export interface DeliverableCreationResult {
  ok: boolean;
  path?: string;
  message: string;
}

/** Renders + writes one deliverable and runs structural + content validation on it. */
export async function createDeliverable(options: {
  projectRoot: string;
  fileName: string;
  format: DeliverableFormat;
  content: string;
  title?: string;
  request?: string;
}): Promise<DeliverableCreationResult> {
  const { projectRoot, request } = options;
  const content = String(options.content || "").trim();
  if (!content) {
    return { ok: false, message: "content is empty — write the full document content in the Markdown contract." };
  }
  const format = options.format;
  const fileName = sanitizeDeliverableFileName(options.fileName, format);
  const relativePath = fileName; // workspace root, where fresh-file detection + contract validation look

  // Resolve workspace-relative image references (![alt](img.png)) into data
  // URIs so generated plots/images embed into .docx/.pptx/.pdf deliverables.
  const resolvedContent = await resolveWorkspaceImages(content, projectRoot);

  let bytes: Buffer;
  try {
    if (format === "docx") {
      const plan = markdownToReportPlan(resolvedContent, options.title || safeStem(fileName, "Report"));
      bytes = await renderDocx(plan, []);
    } else if (format === "pdf") {
      const plan = markdownToReportPlan(resolvedContent, options.title || safeStem(fileName, "Report"));
      bytes = await renderPdf(plan, []);
    } else if (format === "pptx") {
      const plan = markdownToSlidesPlan(resolvedContent, options.title || safeStem(fileName, "Presentation"));
      bytes = await renderPptx(plan, [], { coverBadge: "" });
    } else if (format === "xlsx") {
      const sheets = markdownToSheets(resolvedContent, safeStem(fileName, "Sheet1").slice(0, 31));
      if (!sheets.length) {
        return { ok: false, message: "No spreadsheet data found. Provide one '## Sheet name' heading per worksheet with a Markdown table ('| col | col |' rows, first row = headers, 4+ data rows)." };
      }
      bytes = await renderXlsxSheets(sheets);
    } else {
      bytes = Buffer.from(resolvedContent, "utf8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/PDF export needs the desktop app/i.test(message)) {
      return { ok: false, message: "PDF rendering is unavailable in this context — generate the DOCX version instead (same content contract), or fall back to the pdf skill's generator-script path." };
    }
    return { ok: false, message: `Rendering failed: ${message}. Check the content contract (${format === "pptx" ? '"## Slide title" + "- " bullets' : format === "xlsx" ? '"## Sheet name" + Markdown tables' : '"# Title" + "## Section" headings'}) and try again.` };
  }

  try {
    await fsPromises.writeFile(path.join(projectRoot, fileName), bytes);
  } catch (error) {
    return { ok: false, message: `Could not write ${fileName}: ${error instanceof Error ? error.message : String(error)}` };
  }

  // Inline structural + content validation: the model learns immediately
  // whether the artifact passes the run's completion contract — a repair is
  // one tool call, not a full verify round-trip.
  const feedback: string[] = [];
  try {
    const structural = await validateHomeArtifact(projectRoot, relativePath);
    if (!structural.valid) {
      feedback.push(`STRUCTURE: invalid — ${structural.error || "artifact does not pass the format contract"}`);
    }
    const inspection = await inspectDeliverable(projectRoot, relativePath, request || "");
    feedback.push(`CONTENT: ${inspection.summary}`);
    for (const problem of inspection.problems) feedback.push(`PROBLEM: ${problem}`);
  } catch { /* validation is advisory — the file exists either way */ }

  const okPrefix = feedback.some((f) => f.startsWith("PROBLEM:") || f.startsWith("STRUCTURE:"))
    ? "Deliverable created with issues — fix them by calling this tool again with corrected content (same file name overwrites):"
    : "Deliverable created and verified:";
  return {
    ok: !feedback.some((f) => f.startsWith("PROBLEM:") || f.startsWith("STRUCTURE:")),
    path: relativePath,
    message: `${okPrefix}\nFile: ${relativePath}\n${feedback.join("\n") || "validation passed"}`,
  };
}

export function createDeliverableTool(options: {
  projectRoot: string;
  /** The user's request — powers topic-coverage feedback on the produced file. */
  request?: string;
  runId?: string;
  /** Edit-approval gate (AppSettings.editPolicy === "ask"). */
  beforeEdit?: (info: { tool: string; files: string[] }) => Promise<string | null>;
}): AgentTool {
  return tool(
    async ({ file_name, format, content, title }: { file_name: string; format: DeliverableFormat; content: string; title?: string }) => {
      if (options.beforeEdit) {
        const denial = await options.beforeEdit({ tool: "create_deliverable", files: [file_name] });
        if (denial) return denial;
      }
      const result = await createDeliverable({
        projectRoot: options.projectRoot,
        fileName: file_name,
        format,
        content,
        title,
        request: options.request,
      });
      return result.message;
    },
    {
      name: "create_deliverable",
      description: `PREFERRED fast path for standard document files: generates a polished .docx/.pptx/.xlsx/.pdf/.tex/.md/.csv/.txt from your Markdown content — deterministic, no pip, no generator script, no shell. You write ONLY the content (title, sections, slides, tables) in the contract below; the file is rendered and validated for you, and the result reports the artifact's structure + content quality so you can fix problems in one follow-up call.
${MARKDOWN_CONTRACT}
Use the bundled skill + generator-script path instead ONLY when the user asks for a highly custom design (specific template, charts embedded in the file, exact corporate styling). Overwrite an existing file by passing the same file_name.`,
      schema: z.object({
        file_name: z.string().min(1).max(150).describe("Output file name, e.g. 'Quarterly Report.pptx' or 'study-guide.docx'. The correct extension is appended automatically."),
        format: z.enum(["docx", "pptx", "xlsx", "pdf", "tex", "md", "csv", "txt"]).describe("Target file format."),
        title: z.string().optional().describe("Fallback document title when the content has no '# Title' heading."),
        content: z.string().min(1).max(60_000).describe("Full document content in the Markdown contract from the tool description."),
      }),
    }
  );
}
