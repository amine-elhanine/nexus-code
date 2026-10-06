// Unit tests for the relational library + vector partition (plain Node).
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sectionIdFor,
  loadLibrary,
  replaceFileEntries,
  deleteFileEntries,
  listChunks,
  chunkById,
  chunkNeighbors,
  sessionOutline,
  sessionSummary,
  loadVectors,
  upsertFileVectors,
  removeFileVectors,
  clearVectors,
  wipeFileDerivedData,
} from "../dist-electron/notebook-library.js";

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

console.log("\n=== Notebook Library Tests ===");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-lib-"));
const SID = "sess1";

function makeFile(fileId, nChunks = 3) {
  const sections = [
    { id: sectionIdFor(SID, fileId, ["Doc", "Intro"], 0), sessionId: SID, fileId, heading: "Intro", level: 1, headingPath: ["Doc", "Intro"], text: "intro text", summary: "Intro summary.", keyTerms: ["intro"], tableCount: 0, codeBlockCount: 0, chunkIds: [] },
  ];
  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    chunks.push({
      id: `chunk-${fileId}-${i}`,
      sessionId: SID,
      fileId,
      sectionId: sections[0].id,
      headingPath: ["Doc", "Intro"],
      ordinalInSection: i,
      docIndex: i,
      text: `chunk text ${i} of ${fileId}`,
      tokenCount: 10,
      structured: false,
      prevId: i > 0 ? `chunk-${fileId}-${i - 1}` : null,
      nextId: i + 1 < nChunks ? `chunk-${fileId}-${i + 1}` : null,
    });
  }
  sections[0].chunkIds = chunks.map((c) => c.id);
  const doc = { id: fileId, sessionId: SID, filename: `${fileId}.txt`, fingerprint: "abc", parser: "text", sectionIds: [sections[0].id], chunkCount: nChunks, updatedAt: new Date().toISOString() };
  return { doc, sections, chunks };
}

await test("section IDs are deterministic", () => {
  assert.equal(sectionIdFor(SID, "f", ["A", "B"], 0), sectionIdFor(SID, "f", ["A", "B"], 0));
  assert.notEqual(sectionIdFor(SID, "f", ["A", "B"], 0), sectionIdFor(SID, "f", ["A", "B"], 1));
});

await test("replace-not-append: re-running converges, no duplicates", async () => {
  const { doc, sections, chunks } = makeFile("f1", 3);
  await replaceFileEntries(tmp, doc, sections, chunks);
  await replaceFileEntries(tmp, doc, sections, chunks);
  const listed = await listChunks(tmp, SID);
  assert.equal(listed.length, 3);
  const again = await listChunks(tmp, SID, ["f1"]);
  assert.equal(again.length, 3);
});

await test("neighbors resolve via prev/next links", async () => {
  const mid = await chunkById(tmp, SID, "chunk-f1-1");
  assert.ok(mid);
  const { prev, next } = await chunkNeighbors(tmp, SID, "chunk-f1-1");
  assert.equal(prev.id, "chunk-f1-0");
  assert.equal(next.id, "chunk-f1-2");
  const missing = await chunkNeighbors(tmp, SID, "nope");
  assert.equal(missing.chunk, null);
});

await test("file-scoped listing filters correctly", async () => {
  const second = makeFile("f2", 2);
  await replaceFileEntries(tmp, second.doc, second.sections, second.chunks);
  assert.equal((await listChunks(tmp, SID)).length, 5);
  assert.equal((await listChunks(tmp, SID, ["f2"])).length, 2);
  assert.equal((await listChunks(tmp, SID, ["f1"])).length, 3);
});

await test("outline + summary expose headings and terms", async () => {
  const outline = await sessionOutline(tmp, SID);
  assert.equal(outline.length, 2);
  assert.ok(outline[0].headings[0].path.includes("Intro"));
  const summary = await sessionSummary(tmp, SID);
  assert.ok(summary.files.includes("f1.txt"));
  assert.ok(summary.terms.includes("intro"));
});

await test("vector partition upserts, deletes by file, clears", async () => {
  await upsertFileVectors(tmp, SID, "m", 3, [
    { chunkId: "chunk-f1-0", vector: [1, 0, 0] },
    { chunkId: "chunk-f2-0", vector: [0, 1, 0] },
  ]);
  let part = await loadVectors(tmp, SID);
  assert.equal(Object.keys(part.vectors).length, 2);
  // Re-upsert same file replaces (no growth).
  await upsertFileVectors(tmp, SID, "m", 3, [{ chunkId: "chunk-f1-0", vector: [0.5, 0.5, 0] }]);
  part = await loadVectors(tmp, SID);
  assert.equal(Object.keys(part.vectors).length, 2);
  await removeFileVectors(tmp, SID, ["chunk-f1-0"]);
  part = await loadVectors(tmp, SID);
  assert.ok(!part.vectors["chunk-f1-0"]);
  assert.ok(part.vectors["chunk-f2-0"]);
  // Dimension mismatch must throw (caller rebuilds from relational chunks).
  await assert.rejects(upsertFileVectors(tmp, SID, "m2", 5, [{ chunkId: "x", vector: [1, 2, 3, 4, 5] }]), /embedding-space-mismatch/);
  await clearVectors(tmp, SID);
  part = await loadVectors(tmp, SID);
  assert.equal(Object.keys(part.vectors).length, 0);
});

await test("delete file removes relational + vector data, others unaffected", async () => {
  await upsertFileVectors(tmp, SID, "m", 2, [
    { chunkId: "chunk-f1-0", vector: [1, 0] },
    { chunkId: "chunk-f2-0", vector: [0, 1] },
  ]);
  const removed = await deleteFileEntries(tmp, SID, "f1");
  assert.equal(removed.length, 3);
  assert.equal((await listChunks(tmp, SID)).length, 2);
  const part = await loadVectors(tmp, SID);
  assert.ok(!part.vectors["chunk-f1-0"]);
  assert.ok(part.vectors["chunk-f2-0"]);
});

await test("wipeFileDerivedData clears one file completely", async () => {
  await wipeFileDerivedData(tmp, SID, "f2");
  assert.equal((await listChunks(tmp, SID)).length, 0);
  const part = await loadVectors(tmp, SID);
  assert.equal(Object.keys(part.vectors).length, 0);
});

await test("loadLibrary cache serves fresh data after replaceFileEntries", async () => {
  const doc = { id: "cachedoc", sessionId: SID, filename: "cache.txt", fingerprint: "fp", parser: "text", sectionIds: ["sec"], chunkCount: 1, updatedAt: new Date().toISOString() };
  const section = { id: "sec", sessionId: SID, fileId: "cachedoc", heading: "Cache", level: 1, headingPath: ["Cache"], text: "cached body", summary: "s", keyTerms: [], tableCount: 0, codeBlockCount: 0, chunkIds: ["ch"] };
  const chunk = { id: "ch", sessionId: SID, fileId: "cachedoc", sectionId: "sec", headingPath: ["Cache"], ordinalInSection: 0, docIndex: 0, text: "cached body", tokenCount: 2, structured: false, prevId: null, nextId: null };
  await replaceFileEntries(tmp, doc, [section], [chunk]);
  const first = await loadLibrary(tmp, SID);
  assert.equal(first.chunks["ch"].text, "cached body");
  // Replace again through the same in-process path: the cache must not serve
  // the pre-write snapshot.
  const chunk2 = { ...chunk, id: "ch2", text: "updated body" };
  await replaceFileEntries(tmp, doc, [section], [chunk2]);
  const second = await loadLibrary(tmp, SID);
  assert.equal(second.chunks["ch2"].text, "updated body");
  assert.equal(second.chunks["ch"], undefined);
  // And deleteFileEntries clears it again.
  await deleteFileEntries(tmp, SID, "cachedoc");
  const third = await loadLibrary(tmp, SID);
  assert.equal(third.chunks["ch2"], undefined);
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nnotebook-library: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
