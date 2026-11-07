// Tests for the deterministic Home deliverable engine (electron/home-deliverables.ts):
// Markdown content in → validated docx/pptx/xlsx/tex/md/csv files out, with
// inline structural + content feedback. This is the small-model fast path for
// Home file generation (no generator scripts, no pip, no shell).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirScratch } from "./helpers/scratch.mjs";

const { createDeliverable, createDeliverableTool, sanitizeDeliverableFileName, markdownToSheets } = await import("../dist-electron/home-deliverables.js");
const { inspectDeliverable } = await import("../dist-electron/deliverable-inspect.js");

const REPORT_MD = `# Remote Work Productivity Report

Remote work reshaped how teams operate. This report analyzes the productivity
effects of distributed teams across three measurable dimensions.

## Output and throughput

Distributed teams delivered 13% more completed story points per sprint after
the transition period. The largest gains appeared in deep-work tasks.

- Async communication reduced meeting load by 30%
- Focus time increased from 9 to 14 hours per week

## Collaboration quality

Cross-team review turnaround slowed initially, then recovered with documented
handoff conventions and shared dashboards tracking review latency.

## Key takeaways

- Output rose while meeting hours fell
- Written handoffs beat verbal handoffs for distributed teams
`;

const DECK_MD = `# Solar System Field Guide

A compact tour of the eight planets for students.

## The Sun anchors the system

- The Sun holds 99.8% of the system's mass
- Light takes 8 minutes to reach Earth

## Rocky inner planets

- Mercury races around the Sun in 88 days
- Venus traps heat under a crushing CO2 atmosphere
- Earth hosts liquid water and life
- Mars carries the tallest volcano in the system

## Gas giants

- Jupiter's Great Red Spot has raged for centuries
- Saturn's rings are mostly water ice

## Ice giants and beyond

- Uranus spins on its side at a 98-degree tilt
- Neptune drives the fastest winds ever measured
`;

const SHEETS_MD = `# Regional Sales Data

## Summary

| Region | Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- | --- |
| North | 120 | 135 | 150 | 168 |
| South | 98 | 104 | 133 | 141 |
| East | 77 | 90 | 101 | 119 |
| West | 143 | 121 | 158 | 171 |

## Detail

| Product | Units | Revenue |
| --- | --- | --- |
| Widgets | 1200 | 36000 |
| Gadgets | 850 | 29750 |
| Sprockets | 430 | 12900 |
| Bolts | 2210 | 22000 |
`;

test("sanitizeDeliverableFileName: basename only, safe chars, forced extension", () => {
  assert.equal(sanitizeDeliverableFileName("C:\\Users\\x\\report.docx", "docx"), "report.docx");
  assert.equal(sanitizeDeliverableFileName("Quarterly Report", "pptx"), "Quarterly Report.pptx");
  assert.equal(sanitizeDeliverableFileName("deck.PPTX", "pptx"), "deck.PPTX");
  assert.equal(sanitizeDeliverableFileName('bad<>:"|?*name', "pdf"), "badname.pdf");
  assert.equal(sanitizeDeliverableFileName("", "md").endsWith(".md"), true);
});

test("markdownToSheets: sheet headings + markdown tables, separators skipped", () => {
  const sheets = markdownToSheets(SHEETS_MD);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, "Summary");
  assert.equal(sheets[0].rows.length, 5); // header + 4 data rows
  assert.equal(sheets[0].rows[0][0], "Region");
  assert.equal(sheets[1].name, "Detail");
  const bare = markdownToSheets("| a | b |\n| 1 | 2 |");
  assert.equal(bare.length, 1);
  assert.equal(bare[0].name, "Sheet1");
});

test("createDeliverable: pptx renders a valid, content-complete deck", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await createDeliverable({
    projectRoot: dir,
    fileName: "Solar System Field Guide",
    format: "pptx",
    content: DECK_MD,
    request: "Solar System Field Guide presentation about the planets",
  });
  assert.equal(result.ok, true, result.message);
  const check = result.path;
  assert.equal(check, "Solar System Field Guide.pptx");
  const inspection = await inspectDeliverable(dir, result.path, "Solar System Field Guide presentation about the planets");
  assert.equal(inspection.ok, true, inspection.problems.join("; "));
  assert.ok(inspection.metrics.primaryCount >= 4, `expected 4+ slides, got ${inspection.metrics.primaryCount}`);
  assert.ok(inspection.metrics.wordCount >= 40, `expected 40+ words, got ${inspection.metrics.wordCount}`);
  // The cover + topic coverage: request keywords appear.
  assert.ok(!inspection.metrics.titles.every((title) => /^(title|slide \d+)$/i.test(title)));
});

test("createDeliverable: docx renders a valid report with sections", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await createDeliverable({
    projectRoot: dir,
    fileName: "remote-work-report.docx",
    format: "docx",
    content: REPORT_MD,
    request: "remote work productivity report",
  });
  assert.equal(result.ok, true, result.message);
  const inspection = await inspectDeliverable(dir, result.path, "remote work productivity report");
  assert.equal(inspection.ok, true, inspection.problems.join("; "));
  assert.ok(inspection.metrics.wordCount >= 80, `expected 80+ words, got ${inspection.metrics.wordCount}`);
  assert.ok(inspection.metrics.titles.some((title) => /Output and throughput/i.test(title)), "section headings should appear");
});

test("createDeliverable: xlsx renders named sheets from markdown tables", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await createDeliverable({
    projectRoot: dir,
    fileName: "regional-sales.xlsx",
    format: "xlsx",
    content: SHEETS_MD,
    request: "regional sales data spreadsheet",
  });
  assert.equal(result.ok, true, result.message);
  const inspection = await inspectDeliverable(dir, result.path, "regional sales data spreadsheet");
  assert.equal(inspection.ok, true, inspection.problems.join("; "));
  assert.deepEqual(inspection.metrics.sheetNames, ["Summary", "Detail"]);
  assert.ok(inspection.metrics.primaryCount >= 2);
});

test("createDeliverable: tex/md/csv are written verbatim", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tex = `\\documentclass{article}\n\\begin{document}\nFourier analysis decomposes signals into sinusoids.\n\\end{document}`;
  const texResult = await createDeliverable({ projectRoot: dir, fileName: "notes", format: "tex", content: tex });
  assert.equal(texResult.ok, true, texResult.message);
  assert.equal(await fs.readFile(path.join(dir, "notes.tex"), "utf8"), tex); // content is trimmed at the boundary

  const csvResult = await createDeliverable({ projectRoot: dir, fileName: "data.csv", format: "csv", content: "name,value\nalpha,1\nbeta,2\ngamma,3\n" });
  assert.equal(csvResult.ok, true, csvResult.message);
  const csvInspection = await inspectDeliverable(dir, "data.csv", "name value data");
  assert.equal(csvInspection.ok, true, csvInspection.problems.join("; "));
});

test("createDeliverable: pdf falls back with an actionable message outside the desktop app", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await createDeliverable({ projectRoot: dir, fileName: "r.pdf", format: "pdf", content: REPORT_MD });
  // In plain node printToPDF is unavailable; the message must point at DOCX.
  assert.equal(result.ok, false);
  assert.match(result.message, /PDF|DOCX/i);
});

test("createDeliverable: thin content surfaces PROBLEM feedback for self-repair", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await createDeliverable({
    projectRoot: dir,
    fileName: "thin-deck.pptx",
    format: "pptx",
    content: "# Thin Deck\n\n## Only Slide\n- one bullet",
    request: "quarterly business review presentation",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /PROBLEM:/);
  assert.match(result.message, /create_deliverable|fix/i);
});

test("createDeliverableTool: tool wiring executes and respects the edit gate", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const denied = createDeliverableTool({
    projectRoot: dir,
    request: "solar system guide",
    beforeEdit: async () => "Edit denied by the user: create_deliverable was not approved.",
  });
  const denial = await denied.execute({ file_name: "x.pptx", format: "pptx", content: DECK_MD });
  assert.match(String(denial), /denied/i);

  const allowed = createDeliverableTool({ projectRoot: dir, request: "solar system guide" });
  const result = await allowed.execute({ file_name: "guide.pptx", format: "pptx", content: DECK_MD, title: "Solar System Field Guide" });
  assert.match(String(result), /File: guide\.pptx/);
  assert.match(String(result), /CONTENT:/);
  const stat = await fs.stat(path.join(dir, "guide.pptx"));
  assert.ok(stat.size > 1000);
});

// ---- designed renderer (renderPptx v2): theme, images, layout ----

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const IMAGE_DECK_MD = `# Solar System Field Guide

A visual tour of the planets.

## The Sun anchors the system

- The Sun holds 99.8% of the system's mass
- Light takes 8 minutes to reach Earth

![The Sun](https://images.example.com/sun.png)

## Rocky inner planets

- Mercury races around the Sun in 88 days
- Venus traps heat under a crushing CO2 atmosphere
- Earth hosts liquid water and life
- Mars carries the tallest volcano in the system
`;

test("createDeliverable: pptx embeds inline images and applies the designed theme", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Inline data-URI image (offline-deterministic); the http(s) fetch path is
  // exercised by the SSRF tests in phase1-fixes.test.mjs.
  const png = "data:image/png;base64," + TINY_PNG.toString("base64");
  const md = `# Solar System Field Guide

A visual tour of the planets.

## The Sun anchors the system

- The Sun holds 99.8% of the system's mass
- Light takes 8 minutes to reach Earth

![The Sun](${png})

## Rocky inner planets

- Mercury races around the Sun in 88 days
- Venus traps heat under a crushing CO2 atmosphere
- Earth hosts liquid water and life
- Mars carries the tallest volcano in the system
`;
  const result = await createDeliverable({
    projectRoot: dir,
    fileName: "solar-guide.pptx",
    format: "pptx",
    content: md,
    request: "solar system field guide presentation about the planets",
  });
  assert.equal(result.ok, true, result.message);

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(dir, "solar-guide.pptx")));
  const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/") && !zip.files[n].dir);
  assert.ok(media.length >= 1, "image must be embedded into ppt/media/");
  const slide1 = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.ok(slide1.includes("0F172A"), "designed ink cover");
  assert.ok(slide1.includes("FFFFFF"), "white cover title");
  const slide2 = await zip.file("ppt/slides/slide2.xml").async("string");
  assert.ok(slide2.includes("2563EB"), "accent kicker/underline on content slide");
  assert.ok(slide2.includes("•"), "footer on content slide");
  const slidesXml = await Promise.all(
    Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n)).map((n) => zip.file(n).async("string"))
  );
  assert.ok(slidesXml.some((xml) => xml.includes('b="1"')), "designed theme uses bold runs");
  assert.ok(slidesXml.some((xml) => xml.includes("<p:pic>")), "image pic element present on a slide");
});

test("createDeliverable: dense slides split into two columns", async (t) => {
  const dir = await mkdirScratch("nexus-home-deliverables-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dense = `# Dense Deck

## Six points

- Alpha leads the first column of dense content
- Beta follows with supporting detail text
- Gamma adds measured comparison numbers
- Delta covers edge cases and caveats
- Epsilon carries the deployment checklist
- Zeta closes with follow-up actions

## Wrapping up

- The dense deck check validates the two-column layout path
- Rendering must stay valid with eight bullets in one slide
- Column overflow flows into the second text box cleanly
- Footers and page numbers stay on every content slide
`;
  const result = await createDeliverable({ projectRoot: dir, fileName: "dense.pptx", format: "pptx", content: dense });
  assert.equal(result.ok, true, result.message);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(dir, "dense.pptx")));
  const slide2 = await zip.file("ppt/slides/slide2.xml").async("string");
  const col1X = Math.round(0.6 * 914400);
  const col2X = Math.round(6.85 * 914400);
  assert.ok(slide2.includes(`x="${col1X}"`), "column 1 at left margin");
  assert.ok(slide2.includes(`x="${col2X}"`), "column 2 at 6.85in");
});
