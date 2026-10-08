import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-generation-cancel-"));
const originCwd = process.cwd();
process.chdir(tmp);
process.on("exit", () => {
  try { process.chdir(originCwd); } catch { /* already restored */ }
});

const store = await import("../dist-electron/notebook-store.js");
const jobs = await import("../dist-electron/notebook-jobs.js");
const quiz = await import("../dist-electron/notebook-quiz.js");
const cards = await import("../dist-electron/notebook-flashcards.js");
const mindmaps = await import("../dist-electron/notebook-mindmaps.js");
const summaries = await import("../dist-electron/notebook-summaries.js");
const commandRuns = await import("../dist-electron/command-service.js");
const { notebookGenerationInvokeOptions } = await import("../dist-electron/notebook-generation.js");

test("direct Notebook model calls receive the run's abort signal", () => {
  const runId = "notebook-model-abort-signal-test";
  commandRuns.beginCommandRun(runId);
  try {
    const options = notebookGenerationInvokeOptions(runId);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    commandRuns.cancelCommandRun(runId);
    assert.equal(options.signal.aborted, true);
    assert.deepEqual(notebookGenerationInvokeOptions("missing-run"), {});
  } finally {
    commandRuns.endCommandRun(runId);
  }
});

const notebook = await store.createNotebook("Cancellation checks");
const source = await store.importSourceBuffer(notebook.id, "memory.md", Buffer.from(
  "# Memory consolidation\n\nThe hippocampus consolidates episodic memories during slow-wave sleep. Sleep spindles coordinate replay between the hippocampus and neocortex. Retrieval practice improves later recall.\n",
  "utf8",
));
await jobs.runIngestJob(notebook.id, source.id);

const generators = [
  { name: "quiz", run: (input) => quiz.generateNotebookQuiz(notebook.id, { topic: "memory", count: 3, quizType: "mcq", ...input }), list: quiz.listNotebookQuizzes },
  { name: "flashcards", run: (input) => cards.generateNotebookFlashcards(notebook.id, { topic: "memory", count: 3, ...input }), list: cards.listNotebookFlashcardSets },
  { name: "mind map", run: (input) => mindmaps.generateNotebookMindmap(notebook.id, { topic: "memory", maxNodes: 8, ...input }), list: mindmaps.listNotebookMindmaps },
  { name: "summary", run: (input) => summaries.generateNotebookSummary(notebook.id, { topic: "memory", length: "brief", ...input }), list: summaries.listNotebookSummaries },
];

for (const generator of generators) {
  test(`${generator.name} checks cancellation before retrieval and model calls`, async () => {
    let calls = 0;
    await assert.rejects(generator.run({
      isCancelled: () => true,
      generate: async () => { calls++; return "{}"; },
    }), (error) => error?.name === "RunCancelledError");
    assert.equal(calls, 0);
    assert.deepEqual(await generator.list(notebook.id), []);
  });

  test(`${generator.name} does not retry or persist after cancellation during a model response`, async () => {
    let cancelled = false;
    let calls = 0;
    await assert.rejects(generator.run({
      isCancelled: () => cancelled,
      generate: async () => { calls++; cancelled = true; return "malformed output"; },
    }), (error) => error?.name === "RunCancelledError");
    assert.equal(calls, 1, "cancelled model output must not trigger the malformed-response retry");
    assert.deepEqual(await generator.list(notebook.id), []);
  });
}
