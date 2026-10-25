import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createHomeTaskJournal,
  buildHomeTaskContextSummary,
  finishHomeTaskJournal,
  isHomeTaskContinuation,
  loadHomeTaskJournal,
  recordHomeTaskAction,
  saveHomeTaskJournal,
  updateHomeTaskContextSummary,
} from "../dist-electron/home-task-service.js";

test("Home task journal persists generic progress and outputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-task-"));
  try {
    let journal = createHomeTaskJournal({
      sessionId: "homesess_test",
      goal: "research and create an output",
      expectsOutput: true,
      needsResearch: true,
    });
    journal = recordHomeTaskAction(journal, {
      tool: "web_search",
      summary: "Searched official sources",
      progressed: true,
      phase: "research",
    });
    journal = recordHomeTaskAction(journal, {
      tool: "execute",
      summary: "Created output",
      progressed: true,
      phase: "execution",
      outputs: ["nested/result.bin"],
    });
    journal = finishHomeTaskJournal(journal, "completed");
    journal = updateHomeTaskContextSummary(journal);
    await saveHomeTaskJournal(root, journal);

    const loaded = await loadHomeTaskJournal(root, "homesess_test");
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.actions.length, 2);
    assert.deepEqual(loaded?.outputs, ["nested/result.bin"]);
    assert.match(loaded?.contextSummary || "", /Goal: research and create an output/);
    assert.match(loaded?.contextSummary || "", /nested\/result\.bin/);
    assert.ok((loaded?.contextSummary || "").length <= 6000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Home continuation is explicit and durable task context is bounded and task-specific", () => {
  assert.equal(isHomeTaskContinuation("continue"), true);
  assert.equal(isHomeTaskContinuation("Resume the report"), true);
  assert.equal(isHomeTaskContinuation("continue with the latest figures"), true);
  assert.equal(isHomeTaskContinuation("Create a poem about the sea"), false);

  let journal = createHomeTaskJournal({
    sessionId: "homesess_long",
    goal: "Research and prepare a detailed briefing",
    expectsOutput: true,
    needsResearch: true,
  });
  journal = recordHomeTaskAction(journal, {
    tool: "web_search",
    summary: "Checked official sources",
    result: "Source dates and compared facts",
    progressed: true,
    phase: "research",
  });
  const summary = buildHomeTaskContextSummary(journal);
  assert.match(summary, /Goal: Research and prepare a detailed briefing/);
  assert.match(summary, /official sources/);
  assert.match(updateHomeTaskContextSummary(journal).contextSummary, /phase: research/);
});

test("Home v1 journals load and upgrade to the current resumable schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-task-v1-"));
  try {
    const journal = createHomeTaskJournal({ sessionId: "legacy", goal: "Old task", expectsOutput: false, needsResearch: false });
    const legacy = { ...journal, version: 1 };
    const file = path.join(root, ".nexus", "home-tasks", "legacy.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(legacy));
    const loaded = await loadHomeTaskJournal(root, "legacy");
    assert.equal(loaded?.version, 2);
    assert.equal(loaded?.contextSummary, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
