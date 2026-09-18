// Evidence collection tests (plain Node, crafted library, local embeddings).
// Covers: per-file quotas in full mode (no starvation), per-file coverage
// reporting, targeted topic retrieval spanning files, file scope filtering.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-evidence-"));
const originCwd = process.cwd();
process.chdir(tmp);
process.on("exit", () => {
  try {
    process.chdir(originCwd);
  } catch { /* already gone */ }
});

const docs = await import("../dist-electron/notebook-documents.js");

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

console.log("\n=== Notebook Evidence Tests ===");
console.log(`  (working dir: ${tmp})`);

const NB = "nb1";
const sessionDir = path.join(tmp, ".nexus-data", "notebooks", NB);

function chunk(fileId, sectionId, heading, text, i) {
  return {
    id: `c-${fileId}-${i}`,
    sessionId: NB,
    fileId,
    sectionId,
    headingPath: [heading],
    ordinalInSection: i,
    docIndex: i,
    text,
    tokenCount: text.split(/\s+/).length,
    structured: false,
    prevId: null,
    nextId: null,
  };
}

// fileA: 30 sections x 3 chunks (90 chunks, photosynthesis theme).
// fileB: 2 sections x 2 chunks (4 chunks, blockchain theme).
const documents = {
  fileA: { id: "fileA", sessionId: NB, filename: "lecture-a.pdf", fingerprint: "a", parser: "txt", sectionIds: [], chunkCount: 90, updatedAt: new Date().toISOString() },
  fileB: { id: "fileB", sessionId: NB, filename: "lecture-b.pdf", fingerprint: "b", parser: "txt", sectionIds: [], chunkCount: 4, updatedAt: new Date().toISOString() },
};
const sections = {};
const chunks = {};
const order = [];
let n = 0;
for (let s = 0; s < 30; s++) {
  const secId = `secA${s}`;
  sections[secId] = { id: secId, sessionId: NB, fileId: "fileA", heading: `Section A${s}`, level: 2, headingPath: [`Section A${s}`], text: "", summary: "", keyTerms: ["photosynthesis"], tableCount: 0, codeBlockCount: 0, chunkIds: [] };
  documents.fileA.sectionIds.push(secId);
  for (let k = 0; k < 3; k++) {
    const c = chunk("fileA", secId, `Section A${s}`, `Photosynthesis converts light energy into chemical energy through chlorophyll reactions in section ${s} part ${k}.`, n++);
    chunks[c.id] = c;
    sections[secId].chunkIds.push(c.id);
    order.push(c.id);
  }
}
for (let s = 0; s < 2; s++) {
  const secId = `secB${s}`;
  sections[secId] = { id: secId, sessionId: NB, fileId: "fileB", heading: `Section B${s}`, level: 2, headingPath: [`Section B${s}`], text: "", summary: "", keyTerms: ["blockchain"], tableCount: 0, codeBlockCount: 0, chunkIds: [] };
  documents.fileB.sectionIds.push(secId);
  for (let k = 0; k < 2; k++) {
    const c = chunk("fileB", secId, `Section B${s}`, `Blockchain consensus protocols order distributed ledger transactions securely in section ${s} part ${k}.`, n++);
    chunks[c.id] = c;
    sections[secId].chunkIds.push(c.id);
    order.push(c.id);
  }
}
await fs.mkdir(sessionDir, { recursive: true });
await fs.writeFile(
  path.join(sessionDir, "library.json"),
  JSON.stringify({ sessionId: NB, updatedAt: new Date().toISOString(), documents, sections, chunks, order })
);

await test("full mode: big file cannot starve small files", async () => {
  const ev = await docs.collectDocumentEvidence(NB, "");
  assert.equal(ev.coverage.mode, "full");
  assert.equal(ev.coverage.filesTotal, 2);
  assert.equal(ev.coverage.filesUsed, 2);
  const a = ev.coverage.perFile.find((f) => f.sourceId === "fileA");
  const b = ev.coverage.perFile.find((f) => f.sourceId === "fileB");
  assert.equal(a.total, 90);
  assert.equal(b.total, 4);
  assert.equal(b.used, 4, "small file must be fully included");
  assert.equal(ev.ranked.length, 60, "budget filled to the 60-chunk cap");
  assert.equal(a.used, 56, "big file gets its 30 quota plus the leftover fill");
  const names = new Set(ev.ranked.map((r) => r.sourceName));
  assert.ok(names.has("lecture-a.pdf") && names.has("lecture-b.pdf"));
});

await test("full mode: file scope restricts to selected files", async () => {
  const ev = await docs.collectDocumentEvidence(NB, "", ["fileB"]);
  assert.equal(ev.coverage.filesTotal, 1);
  assert.equal(ev.coverage.filesUsed, 1);
  assert.ok(ev.ranked.every((r) => r.sourceId === "fileB"));
});

await test("targeted mode: topic pulls the right file with per-file counts", async () => {
  const ev = await docs.collectDocumentEvidence(NB, "blockchain consensus ledger");
  assert.equal(ev.coverage.mode, "targeted");
  assert.ok(ev.ranked.length > 0);
  const b = ev.coverage.perFile.find((f) => f.sourceId === "fileB");
  assert.ok(b.used > 0, "blockchain file must contribute passages");
});

await test("empty library returns empty evidence", async () => {
  const ev = await docs.collectDocumentEvidence("missing-notebook", "");
  assert.equal(ev.ranked.length, 0);
  assert.equal(ev.coverage.usedChunks, 0);
});

console.log(`\nnotebook-evidence: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
