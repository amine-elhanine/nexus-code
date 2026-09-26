import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createHomeTaskJournal,
  finishHomeTaskJournal,
  loadHomeTaskJournal,
  recordHomeTaskAction,
  saveHomeTaskJournal,
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
    await saveHomeTaskJournal(root, journal);

    const loaded = await loadHomeTaskJournal(root, "homesess_test");
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.actions.length, 2);
    assert.deepEqual(loaded?.outputs, ["nested/result.bin"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
