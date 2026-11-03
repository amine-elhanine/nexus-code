// Tests for content-level deliverable inspection (electron/deliverable-inspect.ts).
//
// Structure validation (home-artifact-service) already proves an artifact is
// a valid package; these tests pin the CONTENT layer that catches the
// "marked complete without anyone opening the file" failure class: placeholder
// decks, thin documents, and off-topic output. Office files are crafted with
// jszip — the same library the inspection reads them back with.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const { mkdirScratch } = await import("./helpers/scratch.mjs");
const JSZip = (await import("jszip")).default;
const { inspectDeliverable, inspectDeliverables, extractRequestKeywords } = await import("../dist-electron/deliverable-inspect.js");

const REQUEST = "Generate me a presentation about the Battle of Troy and its heroes";

async function write(root, rel, content) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return rel;
}

function pptxXml(textRuns) {
  return `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x">${textRuns
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join("")}</p:sld>`;
}

async function craftPptx(root, rel, slides) {
  const zip = new JSZip();
  slides.forEach((runs, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, pptxXml(runs)));
  await write(root, rel, await zip.generateAsync({ type: "nodebuffer" }));
}

function docxXml(paras) {
  return `<?xml version="1.0"?><w:document xmlns:w="x">${paras
    .map((p) => `<w:p>${p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : ""}<w:r><w:t>${p.text}</w:t></w:r></w:p>`)
    .join("")}</w:document>`;
}

async function craftDocx(root, rel, paras) {
  const zip = new JSZip();
  zip.file("word/document.xml", docxXml(paras));
  await write(root, rel, await zip.generateAsync({ type: "nodebuffer" }));
}

async function craftXlsx(root, rel, sheetNames, rowsPerSheet) {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook>${sheetNames.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}"/>`).join("")}</workbook>`);
  sheetNames.forEach((_n, i) => {
    const rows = Array.from({ length: rowsPerSheet }, (_r, r) => `<row r="${r + 1}"><c><v>${r}</v></c></row>`).join("");
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet>${rows}</worksheet>`);
  });
  await write(root, rel, await zip.generateAsync({ type: "nodebuffer" }));
}

test("deliverable inspection: a real deck passes with a summary", async () => {
  const root = await mkdirScratch("nx-inspect-good-");
  await craftPptx(root, "troy-deck.pptx", [
    ["The Battle of Troy", "An overview of the ten-year war between the Greeks and the defenders of Troy"],
    ["The Heroes of Troy", "Hector defended the city walls while Paris started the war over Helen"],
    ["The Fall of Troy", "The wooden horse trick ended ten years of battle outside the walls of Troy"],
    ["Legacy of the Battle", "The heroes of the Troy story shaped later epic literature and legend"],
  ]);
  const result = await inspectDeliverable(root, "troy-deck.pptx", REQUEST);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.metrics.primaryCount, 4);
  assert.ok(result.metrics.wordCount > 40);
  assert.match(result.summary, /4 slides/);
  assert.deepEqual(result.problems, []);
});

test("deliverable inspection: placeholder deck fails with targeted problems", async () => {
  const root = await mkdirScratch("nx-inspect-thin-");
  await craftPptx(root, "deck.pptx", [["Title"], ["Click to add text"], ["Title"], ["Click to add text"]]);
  const result = await inspectDeliverable(root, "deck.pptx", REQUEST);
  assert.equal(result.ok, false);
  const joined = result.problems.join("\n");
  assert.match(joined, /placeholder/);
  assert.match(joined, /too thin|only ~\d+ words/);
  assert.match(joined, /key terms/);
});

test("deliverable inspection: off-topic deck fails topic coverage, on-topic passes", async () => {
  const root = await mkdirScratch("nx-inspect-topic-");
  // 4 dense slides that never mention battle/Troy/heroes.
  await craftPptx(root, "off.pptx", [
    ["Quarterly Revenue Review", "Sales grew across every region this quarter and margins improved steadily"],
    ["Cost Structure", "Operational spending stayed within the planned budget across all departments"],
    ["Hiring Plan", "Engineering and support teams expand next quarter with ten open positions"],
    ["Roadmap", "Product milestones and delivery dates for the coming year are already planned"],
  ]);
  const off = await inspectDeliverable(root, "off.pptx", REQUEST);
  assert.equal(off.ok, false);
  assert.match(off.problems.join("\n"), /key terms/);

  await craftPptx(root, "on.pptx", [
    ["The Battle of Troy", "How the war over Helen began and why the Greeks sailed against Troy"],
    ["Troy Heroes", "Hector led the defense of Troy while other heroes held the battle lines"],
    ["Battle Tactics", "Ten years of siege warfare at Troy and the wooden horse stratagem"],
    ["After the Battle", "The fall of Troy and where its surviving heroes traveled afterward"],
  ]);
  const on = await inspectDeliverable(root, "on.pptx", REQUEST);
  assert.equal(on.ok, true, JSON.stringify(on.problems));
});

test("deliverable inspection: docx word/paragraph thresholds", async () => {
  const root = await mkdirScratch("nx-inspect-docx-");
  await craftDocx(root, "thin.docx", [{ text: "Hello" }, { text: "World" }]);
  const thin = await inspectDeliverable(root, "thin.docx", REQUEST);
  assert.equal(thin.ok, false);
  assert.match(thin.problems.join("\n"), /paragraphs|words/);

  const filler = "The heroes of the battle at Troy fought for ten years before the city fell to the wooden horse trick. ";
  await craftDocx(root, "real.docx", [
    { style: "Heading1", text: "The Battle of Troy" },
    { text: filler.repeat(4) },
    { style: "Heading1", text: "Heroes of Troy" },
    { text: filler.repeat(4) },
    { text: filler.repeat(4) },
  ]);
  const real = await inspectDeliverable(root, "real.docx", REQUEST);
  assert.equal(real.ok, true, JSON.stringify(real.problems));
  assert.ok(real.metrics.titles.includes("The Battle of Troy"));
});

test("deliverable inspection: xlsx sheets and rows", async () => {
  const root = await mkdirScratch("nx-inspect-xlsx-");
  await craftXlsx(root, "data.xlsx", ["Troy casualties", "Troop strength"], 25);
  const good = await inspectDeliverable(root, "data.xlsx", REQUEST);
  assert.equal(good.ok, true, JSON.stringify(good.problems));
  assert.deepEqual(good.metrics.sheetNames, ["Troy casualties", "Troop strength"]);

  await craftXlsx(root, "empty.xlsx", [], 0);
  const empty = await inspectDeliverable(root, "empty.xlsx", REQUEST);
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join("\n"), /no named sheets|rows/);
});

test("deliverable inspection: text and csv thresholds", async () => {
  const root = await mkdirScratch("nx-inspect-text-");
  await write(root, "notes.md", "# Troy\n\nToo short.\n");
  const thin = await inspectDeliverable(root, "notes.md", REQUEST);
  assert.equal(thin.ok, false);

  await write(root, "data.csv", "hero,side,battle_role\nHector,Troy,defender in the battle\nAchilles,Greece,heroes of the siege\nParis,Troy,started the battle\n");
  const csv = await inspectDeliverable(root, "data.csv", REQUEST);
  assert.equal(csv.ok, true, JSON.stringify(csv.problems));
  assert.equal(csv.metrics.primaryCount, 3);
});

test("deliverable inspection: unreadable file surfaces as a problem, never throws", async () => {
  const root = await mkdirScratch("nx-inspect-bad-");
  await write(root, "broken.pptx", "this is not a zip file");
  const result = await inspectDeliverable(root, "broken.pptx", REQUEST);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /could not be read/);
});

test("deliverable inspection: non-inspectable kinds pass without noise", async () => {
  const root = await mkdirScratch("nx-inspect-src-");
  await write(root, "generate_deck.py", "print('x')");
  const result = await inspectDeliverable(root, "generate_deck.py", REQUEST);
  assert.equal(result.ok, true);
  assert.match(result.summary, /no content inspection/);
});

test("deliverable inspection: batch skips nothing and never throws", async () => {
  const root = await mkdirScratch("nx-inspect-batch-");
  await craftPptx(root, "deck.pptx", [
    ["The Battle of Troy heroes and their stories", "An overview of the war"],
    ["Troy battle heroes of the wooden horse", "How the city finally fell"],
    ["Troy heroes gathering before the battle", "The Greek fleet assembles"],
    ["battle at Troy heroes and the city walls", "Ten years of siege warfare"],
  ]);
  const results = await inspectDeliverables(root, ["deck.pptx", "missing-file.md"], REQUEST);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true, JSON.stringify(results[0].problems));
  assert.equal(results[1].ok, false); // missing file → could not be read
});

test("request keyword extraction drops format words and filler", () => {
  const words = extractRequestKeywords("Please write a presentation about the Battle of Troy and its heroes");
  assert.ok(!words.includes("presentation"), "format words must never be required in content");
  assert.ok(!words.includes("please") && !words.includes("write") && !words.includes("about"));
  assert.ok(words.includes("troy"));
  assert.ok(words.includes("battle"));
  assert.ok(words.includes("heroes"));
});
