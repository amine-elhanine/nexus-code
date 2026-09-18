import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-agentic-"));
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

console.log("\n=== Notebook Agentic RAG Acceptance Tests ===");
console.log(`  (working dir: ${tmp})`);

const DOC = [
  "# Transformer Architecture",
  "",
  "Self-attention allows the model to attend to tokens across positions in parallel.",
  "",
  "## Multi-Head Attention",
  "",
  "Multi-head attention projects queries, keys, and values into multiple subspaces.",
].join("\n");

const nb = await store.createNotebook("Transformer Study");
const rec = await store.importSourceBuffer(nb.id, "transformer.md", Buffer.from(DOC, "utf8"));
await jobs.runIngestJob(nb.id, rec.id);

await test("R1: question with custom generator returns agentic steps and evaluation", async () => {
  const toolEvents = [];
  const statusEvents = [];
  const result = await rag.answerNotebookQuestion(nb.id, "Explain multi-head attention", [], {
    onStatus: (text) => statusEvents.push(text),
    onTool: (name, summary, detail) => toolEvents.push({ name, summary, detail }),
    generate: async () => "Multi-head attention projects queries, keys, and values [S1].",
  });

  assert.ok(result.answer.includes("Multi-head attention"));
  assert.ok(Array.isArray(result.steps), "result.steps must be an array");
  assert.ok(result.steps.length > 0, "result.steps must have at least 1 step");
  assert.equal(result.steps[0].status, "completed");
  assert.ok(result.evaluation, "evaluation must be present");
  assert.equal(result.evaluation.verdict, "grounded");
  assert.ok(result.sources.length > 0, "sources citations must exist");
  assert.equal(result.sources[0].sourceName, "transformer.md");
});

await test("R2: conversational question produces conversational step without querying files", async () => {
  const result = await rag.answerNotebookQuestion(nb.id, "Hello!", [], {
    generate: async () => "Hello! I am your notebook research assistant.",
  });

  assert.ok(result.steps.some((s) => s.name === "conversational_reply"));
  assert.equal(result.sources.length, 0);
  assert.equal(result.metadata.refused, false);
});

await test("R3: ungrounded query triggers groundedness gate step", async () => {
  const result = await rag.answerNotebookQuestion(nb.id, "What is the capital of Atlantis?", [], {
    generate: async () => "Atlantis",
  });

  assert.ok(result.steps.some((s) => s.name === "groundedness_gate"));
  assert.equal(result.metadata.refused, true);
  assert.equal(result.sources.length, 0);
});

await test("R4: chat message persistence preserves steps", async () => {
  const chat = await store.createNotebookChat(nb.id, "Attention chat");
  const msg = {
    role: "assistant",
    text: "Multi-head attention explanation [S1].",
    createdAt: new Date().toISOString(),
    citations: [{ index: 1, sourceId: rec.id, sourceName: "transformer.md", chunkId: "c1", heading: "Multi-Head", excerpt: "ex", snippet: "sn", score: 0.95 }],
    steps: [
      { id: "s1", name: "search_notebook_sources", title: "Search: multi-head", detail: "1 match", status: "completed" },
      { id: "s2", name: "evaluate_evidence", title: "Evidence check: sufficient", detail: "Full coverage", status: "completed" },
    ],
    evaluation: { groundedness: 9, verdict: "grounded", issues: [] },
  };

  const updated = await store.appendNotebookMessage(nb.id, chat.id, msg);
  const savedMsg = updated.messages.find((m) => m.text.includes("Multi-head attention"));
  assert.ok(savedMsg);
  assert.equal(savedMsg.steps?.length, 2);
  assert.equal(savedMsg.steps[0].name, "search_notebook_sources");
  assert.equal(savedMsg.steps[1].name, "evaluate_evidence");
  assert.equal(savedMsg.evaluation?.groundedness, 9);
});

await test("R5: buildSkillMounts resolves system skills across route permutations on Windows & POSIX", async () => {
  const { buildSkillMounts, systemSkillsDir } = await import("../dist-electron/skills-service.js");
  const { CompositeBackend, FilesystemBackend } = await import("deepagents");

  const systemBackend = new FilesystemBackend({ rootDir: systemSkillsDir(), virtualMode: true });
  const mounts = buildSkillMounts(null, systemBackend);
  const composite = new CompositeBackend(new FilesystemBackend({ rootDir: tmp, virtualMode: true }), mounts);

  const paths = [
    "/system-skills/all/pptx/SKILL.md",
    "//system-skills/all/pptx/SKILL.md",
    "/system-skill/all/pptx/SKILL.md",
    "system-skills/all/pptx/SKILL.md",
    "system-skill/all/pptx/SKILL.md",
  ];

  for (const p of paths) {
    const res = await composite.read(p);
    assert.ok(!res.error, `Reading ${p} failed: ${res.error}`);
    assert.ok(res.totalLines > 50, `Expected content for ${p}`);
  }
});

await test("R6: fileBackend with id enables command execution in CompositeBackend", async () => {
  const { CompositeBackend, FilesystemBackend } = await import("deepagents");
  const fileBackend = new FilesystemBackend({ rootDir: tmp, virtualMode: true });
  fileBackend.id = "notebook-test";
  fileBackend.execute = async (cmd) => ({ output: `ok: ${cmd}`, exitCode: 0, truncated: false });

  const composite = new CompositeBackend(fileBackend, {});
  assert.equal(composite.id, "notebook-test");
  const res = await composite.execute("echo test");
  assert.equal(res.output, "ok: echo test");
  assert.equal(res.exitCode, 0);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
