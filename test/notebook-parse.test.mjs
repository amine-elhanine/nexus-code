// Unit tests for format parsers: bytes -> canonical markdown (plain Node).
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseToMarkdown } from "../dist-electron/notebook-parse.js";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    failed++;
  }
}

console.log("\n=== Notebook Parse Tests ===");

function docxBuffer(paragraphs, tables = []) {
  const zip = new JSZip();
  const body = [
    ...paragraphs.map((p) => {
      const style = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : "";
      const runs = p.text.split(" ").map((w) => `<w:r><w:t xml:space="preserve">${w} </w:t></w:r>`).join("");
      return `<w:p>${style}${runs}</w:p>`;
    }),
    ...tables.map((rows) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`),
  ].join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function pptxBuffer() {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId3"/></p:sldIdLst></p:presentation>`
  );
  zip.file(
    "ppt/presentation.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`
  );
  const slide = (title, bullets) =>
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
    `<p:nvSp><p:cNvPr name="Title"/></p:nvSp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>` +
    bullets.map((b) => `<p:nvSp><p:cNvPr name="Body"/></p:nvSp><p:txBody><a:p><a:r><a:t>${b}</a:t></a:r></a:p></p:txBody>`).join("") +
    `</p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", slide("Intro Deck", ["First point", "Second point"]));
  zip.file("ppt/slides/slide2.xml", slide("Results", ["Recall improved 12%"]));
  return zip.generateAsync({ type: "nodebuffer" });
}

// Minimal valid single-page PDF with Helvetica text (no xref strictness needed by pdf.js).
function minimalPdf(lines) {
  const objects = [];
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj");
  objects.push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj");
  const contentObj = `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`;
  objects.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj`);
  objects.push(contentObj);
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const o of objects) {
    offsets.push(pdf.length);
    pdf += o + "\n";
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

await test("txt passes through, md keeps headings", async () => {
  const txt = await parseToMarkdown(Buffer.from("hello world", "utf8"), "a.txt");
  assert.equal(txt.markdown, "hello world");
  assert.equal(txt.parser, "text");
  const md = await parseToMarkdown(Buffer.from("# Title\n\nbody", "utf8"), "a.md");
  assert.ok(md.markdown.includes("# Title"));
  assert.equal(md.parser, "markdown");
});

await test("csv becomes a markdown table", async () => {
  const csv = await parseToMarkdown(Buffer.from('name,recall\nhippocampus,0.9\n"sleep, deep",0.8', "utf8"), "data.csv");
  assert.ok(csv.markdown.includes("| name | recall |"));
  assert.ok(csv.markdown.includes("| hippocampus | 0.9 |"));
  assert.ok(csv.markdown.includes("sleep, deep"));
});

await test("html strips scripts and keeps headings", async () => {
  const html = `<html><head><script>evil()</script></head><body><h1>Real Title</h1><p>Body text here.</p><ul><li>Point one</li></ul></body></html>`;
  const out = await parseToMarkdown(Buffer.from(html, "utf8"), "page.html");
  assert.ok(out.markdown.includes("# Real Title"));
  assert.ok(out.markdown.includes("Body text here."));
  assert.ok(out.markdown.includes("- Point one"));
  assert.ok(!out.markdown.includes("evil()"));
});

await test("docx preserves headings and tables", async () => {
  const buf = await docxBuffer(
    [
      { style: "Title", text: "Study Report" },
      { style: "Heading1", text: "Methods" },
      { style: "", text: "We measured sleep spindles nightly." },
    ],
    [[["metric", "value"], ["recall", "0.91"]]]
  );
  const out = await parseToMarkdown(buf, "report.docx");
  assert.equal(out.parser, "docx");
  assert.ok(out.markdown.includes("# Study Report"), out.markdown.slice(0, 200));
  assert.ok(out.markdown.includes("# Methods") || out.markdown.includes("## Methods"));
  assert.ok(out.markdown.includes("sleep spindles"));
  assert.ok(out.markdown.includes("| metric | value |"));
});

await test("pptx splits slides with headings", async () => {
  const buf = await pptxBuffer();
  const out = await parseToMarkdown(buf, "deck.pptx");
  assert.equal(out.parser, "pptx");
  assert.ok(out.markdown.includes("## Slide 1: Intro Deck"));
  assert.ok(out.markdown.includes("## Slide 2: Results"));
  assert.ok(out.markdown.includes("Recall improved 12%"));
});

await test("pdf extracts text pages", async () => {
  const buf = minimalPdf(["Memory Consolidation", "The hippocampus replays memories during sleep."]);
  const out = await parseToMarkdown(buf, "paper.pdf");
  assert.equal(out.parser, "pdf");
  assert.ok(out.markdown.includes("Memory Consolidation"), out.markdown.slice(0, 300));
  assert.ok(out.markdown.includes("hippocampus"));
  assert.equal(out.pageCount, 1);
});

await test("empty/binary input throws a clear error", async () => {
  await assert.rejects(parseToMarkdown(Buffer.from("", "utf8"), "empty.txt"), /empty|extract/i);
  await assert.rejects(parseToMarkdown(Buffer.from([0, 1, 2, 3]), "x.bin"), /Unsupported|extract/i);
});

console.log(`\nnotebook-parse: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
