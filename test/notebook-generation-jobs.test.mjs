// Generation job table: persisted lifecycle + startup recovery + cap.
// Runs under plain node with cwd redirected to a scratch dir — under plain
// node notebooksDataRoot() resolves to process.cwd()/.nexus-data/notebooks.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function withScratch(fn) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-genjobs-"));
  const prevCwd = process.cwd();
  process.chdir(scratch);
  try {
    return await fn(scratch);
  } finally {
    process.chdir(prevCwd);
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

test("generation jobs: begin/finish lifecycle persists and lists", async () => {
  await withScratch(async () => {
    const jobs = await import("../dist-electron/notebook-generation-jobs.js");
    const id = await jobs.beginGenerationJob("nb_x", "quiz", "chapter 3");
    let list = await jobs.listGenerationJobs("nb_x");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].status, "running");
    assert.equal(list[0].topic, "chapter 3");
    await jobs.finishGenerationJob(id);
    list = await jobs.listGenerationJobs("nb_x");
    assert.equal(list[0].status, "done");
    assert.ok(list[0].endedAt);
    // Failure path records the error.
    const id2 = await jobs.beginGenerationJob("nb_x", "document");
    await jobs.finishGenerationJob(id2, "model exploded");
    list = await jobs.listGenerationJobs("nb_x");
    assert.equal(list[0].status, "failed");
    assert.equal(list[0].error, "model exploded");
    // Notebook filter excludes other notebooks.
    await jobs.beginGenerationJob("nb_y", "summary");
    assert.equal((await jobs.listGenerationJobs("nb_y")).length, 1);
    assert.equal((await jobs.listGenerationJobs("nb_x")).length, 2);
  });
});

test("generation jobs: startup recovery marks running as failed", async () => {
  await withScratch(async () => {
    const jobs = await import("../dist-electron/notebook-generation-jobs.js");
    await jobs.beginGenerationJob("nb_z", "mindmap");
    await jobs.beginGenerationJob("nb_z", "audio");
    const recovered = await jobs.recoverInterruptedGenerationJobs();
    assert.equal(recovered, 2);
    const list = await jobs.listGenerationJobs("nb_z");
    assert.ok(list.every((j) => j.status === "failed" && /restarted/i.test(j.error || "")));
    // Idempotent: nothing left running.
    assert.equal(await jobs.recoverInterruptedGenerationJobs(), 0);
  });
});

test("generation jobs: table cap keeps running records, drops oldest finished", async () => {
  await withScratch(async () => {
    const jobs = await import("../dist-electron/notebook-generation-jobs.js");
    // One long-running job + 350 finished ones.
    const pinned = await jobs.beginGenerationJob("nb_cap", "quiz", "pinned");
    await jobs.finishGenerationJob(pinned);
    for (let i = 0; i < 350; i++) {
      const id = await jobs.beginGenerationJob(`nb_${i % 7}`, "flashcards");
      await jobs.finishGenerationJob(id);
    }
    const all = await jobs.listGenerationJobs();
    assert.ok(all.length <= 300, `table bounded (got ${all.length})`);
    // The cap drops the OLDEST finished records — the pinned one (350 finished
    // ago) is gone; the newest survives.
    assert.ok(!all.some((j) => j.id === pinned), "oldest finished record dropped under cap");
    assert.ok(all.length > 0, "recent records survive");
    assert.ok(all.every((j) => j.status !== "running"), "no running records dropped");
  });
});
