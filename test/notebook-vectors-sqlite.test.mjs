// SQLite vector store tests (plain Node, no Electron).
// Covers: exact float64 round-trip through the routed API, embedding-space
// mismatch contract, per-file delete, clear, JSON migration, session cleanup.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-vecsql-"));
const originCwd = process.cwd();
process.chdir(tmp);
process.on("exit", () => {
  try {
    process.chdir(originCwd);
  } catch { /* already gone */ }
});

const lib = await import("../dist-electron/notebook-library.js");
const store = await import("../dist-electron/notebook-vectors-sqlite.js");

const root = path.join(tmp, ".nexus-data", "notebooks", "nbv");
await fs.mkdir(root, { recursive: true });

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

console.log("\n=== Notebook SQLite Vector Tests ===");
console.log(`  (working dir: ${tmp})`);
console.log(`  sqlite backend: ${(await store.sqliteVectorsAvailable()) ? "available" : "UNAVAILABLE — tests need node:sqlite"}`);
assert.equal(await store.sqliteVectorsAvailable(), true);

const V1 = [0.1, -0.2, 0.30000000000000004, 0.4, -0.5, 0.6, 0.12345678901234568, -0.9876543210987654];
const V2 = [0.9, 0.8, -0.7, 0.6, 0.5, -0.4, 0.3, 0.2];
const V3 = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8];

await test("upsert + load round-trips vectors bit-exactly", async () => {
  await lib.upsertFileVectors(root, "nbv", "local-hash/test", 8, [
    { chunkId: "c1", vector: V1 },
    { chunkId: "c2", vector: V2 },
  ]);
  const part = await lib.loadVectors(root, "nbv");
  assert.equal(part.embeddingModel, "local-hash/test");
  assert.equal(part.dims, 8);
  assert.deepEqual(part.vectors.c1, V1);
  assert.deepEqual(part.vectors.c2, V2);
});

await test("second file upserts without wiping the first", async () => {
  await lib.upsertFileVectors(root, "nbv", "local-hash/test", 8, [{ chunkId: "c3", vector: V3 }]);
  const part = await lib.loadVectors(root, "nbv");
  assert.deepEqual(part.vectors.c1, V1);
  assert.deepEqual(part.vectors.c3, V3);
});

await test("embedding-space mismatch throws the rebuild contract error", async () => {
  await assert.rejects(
    lib.upsertFileVectors(root, "nbv", "other-model", 16, [{ chunkId: "c9", vector: new Array(16).fill(0.1) }]),
    /embedding-space-mismatch/
  );
  const part = await lib.loadVectors(root, "nbv");
  assert.equal(part.vectors.c9, undefined);
});

await test("removeFileVectors deletes only the given ids", async () => {
  await lib.removeFileVectors(root, "nbv", ["c1", "c2"]);
  const part = await lib.loadVectors(root, "nbv");
  assert.equal(part.vectors.c1, undefined);
  assert.deepEqual(part.vectors.c3, V3);
});

await test("clearVectors empties the partition", async () => {
  await lib.clearVectors(root, "nbv");
  const part = await lib.loadVectors(root, "nbv");
  assert.deepEqual(part.vectors, {});
  assert.equal(part.embeddingModel, "");
});

await test("vectors.json migrates once, then is removed", async () => {
  const root2 = path.join(tmp, ".nexus-data", "notebooks", "nbm");
  await fs.mkdir(root2, { recursive: true });
  await fs.writeFile(
    path.join(root2, "vectors.json"),
    JSON.stringify({ sessionId: "nbm", embeddingModel: "m", dims: 2, updatedAt: new Date().toISOString(), vectors: { m1: [0.5, -0.25] } })
  );
  const part = await lib.loadVectors(root2, "nbm");
  assert.deepEqual(part.vectors.m1, [0.5, -0.25]);
  assert.equal(part.embeddingModel, "m");
  let jsonGone = false;
  try {
    await fs.access(path.join(root2, "vectors.json"));
  } catch {
    jsonGone = true;
  }
  assert.equal(jsonGone, true);
  assert.equal(await fs.stat(path.join(root2, "vectors.sqlite")).then((s) => s.isFile()).catch(() => false), true);
});

await test("deleteSessionLibrary removes sqlite artifacts", async () => {
  await lib.deleteSessionLibrary(root);
  for (const f of ["library.json", "vectors.json", "vectors.sqlite", "vectors.sqlite-wal", "vectors.sqlite-shm"]) {
    let gone = false;
    try {
      await fs.access(path.join(root, f));
    } catch {
      gone = true;
    }
    assert.equal(gone, true, `${f} should be gone`);
  }
});

console.log(`\nnotebook-vectors-sqlite: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
