// End-to-end notebook acceptance tests (plain Node, temp cwd, local embeddings).
// Covers: ingestion statuses, citation correctness, refusal, file scoping,
// crash recovery, cross-session isolation, delete-then-ask.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-pipe-"));
const originCwd = process.cwd();
process.chdir(tmp);
process.on("exit", () => {
  try {
    process.chdir(originCwd);
  } catch { /* already gone */ }
});

const store = await import("../dist-electron/notebook-store.js");
const jobs = await import("../dist-electron/notebook-jobs.js");
const rag = await import("../dist-electron/notebook-rag.js");

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

console.log("\n=== Notebook Pipeline Acceptance Tests ===");
console.log(`  (working dir: ${tmp})`);

const MESSY = [
  "# Quarterly Findings",
  "",
  "Page 1 of 3",
  "Acme Corp — Internal",
  "Revenue grew 12 percent in Q3 driven by cloud storage demand.",
  "Acme Corp — Internal",
  "Operating margin reached 24 percent on cost discipline.",
  "Acme Corp — Internal",
  "1 / 3",
  "",
  "## Risks",
  "",
  "Supply chain delays persisted into October.",
  "",
  "| metric | value |",
  "|---|---|",
  "| revenue growth | 12% |",
  "| margin | 24% |",
  "",
  "```python",
  "print('keep this code')",
  "```",
].join("\n");

const BRAIN = [
  "# Memory Systems",
  "",
  "The hippocampus consolidates episodic memory during slow-wave sleep.",
  "",
  "## Sleep Spindles",
  "",
  "Sleep spindles coordinate memory replay between hippocampus and neocortex.",
].join("\n");

let nb1;
let messyId;
let brainId;

await test("A1: messy file progresses to ready; headings kept; no boilerplate in chunks", async () => {
  nb1 = await store.createNotebook("Research");
  const rec = await store.importSourceBuffer(nb1.id, "findings.txt", Buffer.from(MESSY, "utf8"));
  messyId = rec.id;
  assert.equal(rec.status, "uploaded", "upload returns immediately as uploaded");
  await jobs.runIngestJob(nb1.id, messyId);
  const source = await store.getNotebookSource(nb1.id, messyId);
  assert.equal(source.status, "ready");
  assert.ok(source.chunks > 0);
  assert.ok(source.chars > 0);
  const { listChunks } = await import("../dist-electron/notebook-library.js");
  const root = store.notebookSessionDir(nb1.id);
  const chunks = await listChunks(root, nb1.id);
  assert.ok(chunks.length > 0, "relational chunks exist");
  const { loadVectors } = await import("../dist-electron/notebook-library.js");
  const part = await loadVectors(root, nb1.id);
  assert.equal(Object.keys(part.vectors).length, chunks.length, "vector points match chunks");
  assert.ok(chunks.some((c) => c.headingPath.includes("Risks")), "heading paths preserved");
  for (const c of chunks) {
    assert.ok(!/^Page 1 of 3$/m.test(c.text), "page counter leaked into chunk");
    assert.ok(!c.text.includes("Acme Corp — Internal"), "repeated header leaked into chunk");
  }
  assert.ok(chunks.some((c) => c.structured && c.text.includes("revenue growth")), "table chunk intact");
});

await test("A2: covered question returns cited sources (file + heading + snippet + score)", async () => {
  const rec = await store.importSourceBuffer(nb1.id, "memory.md", Buffer.from(BRAIN, "utf8"));
  brainId = rec.id;
  await jobs.runIngestJob(nb1.id, brainId);
  let generateCalled = false;
  const result = await rag.answerNotebookQuestion(nb1.id, "What does the hippocampus do during sleep?", [], {
    generate: async () => {
      generateCalled = true;
      return "It consolidates episodic memory [S1].";
    },
  });
  assert.ok(generateCalled);
  assert.equal(result.metadata.refused, false);
  assert.ok(result.sources.length > 0);
  assert.equal(result.sources[0].sourceName, "memory.md");
  assert.ok(result.sources[0].heading.length > 0, "heading present");
  assert.ok(result.sources[0].snippet.length > 0, "snippet present");
  assert.ok(typeof result.sources[0].score === "number", "score present");
});

await test("A3: uncovered question refuses without calling the model", async () => {
  let generateCalled = false;
  const result = await rag.answerNotebookQuestion(nb1.id, "What is the quantum zebra funding round?", [], {
    generate: async () => {
      generateCalled = true;
      return "nope";
    },
  });
  assert.equal(generateCalled, false, "model must not be consulted");
  assert.equal(result.metadata.refused, true);
  assert.equal(result.sources.length, 0);
});

await test("A4: file scope restricts retrieval to selected files", async () => {
  const { results } = await rag.hybridRetrieve(nb1.id, "hippocampus sleep memory", 8, [brainId]);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.sourceId === brainId), "only scoped file retrieved");
  const scoped = await rag.answerNotebookQuestion(nb1.id, "hippocampus sleep", [], {
    fileIds: [messyId],
    generate: async () => "fallback",
  });
  // Messy file has no hippocampus content → gate refuses.
  assert.equal(scoped.metadata.refused, true);
});

await test("A5: crash recovery re-queues and converges without duplicates", async () => {
  const { listChunks } = await import("../dist-electron/notebook-library.js");
  const root = store.notebookSessionDir(nb1.id);
  const beforeIds = (await listChunks(root, nb1.id)).map((c) => c.id).sort();
  await store.updateSourceStatus(nb1.id, messyId, { status: "indexing" });
  const requeued = await jobs.recoverInterruptedJobs();
  assert.ok(requeued >= 1);
  await jobs.drainJobs();
  const source = await store.getNotebookSource(nb1.id, messyId);
  assert.equal(source.status, "ready");
  const afterIds = (await listChunks(root, nb1.id)).map((c) => c.id).sort();
  assert.deepEqual(afterIds, beforeIds, "stable IDs: no orphans, no duplicates");
});

await test("A6: two sessions never leak into each other", async () => {
  const nb2 = await store.createNotebook("Other");
  const rec = await store.importSourceBuffer(nb2.id, "cooking.txt", Buffer.from("# Pasta\n\nBoil water generously salted. Cook spaghetti nine minutes.", "utf8"));
  await jobs.runIngestJob(nb2.id, rec.id);
  const { results } = await rag.hybridRetrieve(nb1.id, "hippocampus", 8);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.sourceId === messyId || r.sourceId === brainId), "zero cross-session leakage");
  let generateCalled = false;
  const cross = await rag.answerNotebookQuestion(nb2.id, "What does the hippocampus do?", [], {
    generate: async () => {
      generateCalled = true;
      return "x";
    },
  });
  assert.equal(generateCalled, false);
  assert.equal(cross.metadata.refused, true);
});

await test("A7: delete file removes answers; other files unaffected", async () => {
  await store.deleteNotebookSource(nb1.id, brainId);
  let generateCalled = false;
  const gone = await rag.answerNotebookQuestion(nb1.id, "What does the hippocampus do during sleep?", [], {
    generate: async () => {
      generateCalled = true;
      return "x";
    },
  });
  assert.equal(generateCalled, false, "deleted content not retrieved");
  assert.equal(gone.metadata.refused, true);
  const stillThere = await rag.answerNotebookQuestion(nb1.id, "How much did revenue grow in Q3?", [], {
    generate: async () => "Revenue grew 12 percent [S1].",
  });
  assert.equal(stillThere.metadata.refused, false);
  assert.ok(stillThere.sources.some((s) => s.sourceName === "findings.txt"));
});

await test("activity ordering + rename", async () => {
  const before = (await store.listNotebooks()).map((n) => n.id);
  const nb3 = await store.createNotebook("Third");
  let ordered = await store.listNotebooks();
  assert.equal(ordered[0].id, nb3.id, "newest activity first");
  await store.appendNotebookMessage(nb1.id, (await store.createNotebookChat(nb1.id)).id, {
    role: "user",
    text: "hi",
    createdAt: new Date().toISOString(),
  });
  ordered = await store.listNotebooks();
  assert.equal(ordered[0].id, nb1.id, "chat activity bumps session");
  void before;
  const renamed = await store.renameNotebook(nb3.id, "Renamed");
  assert.equal(renamed.name, "Renamed");
});

process.chdir(originCwd);
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\nnotebook-pipeline: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
