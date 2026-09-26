import test from "node:test";
import assert from "node:assert/strict";
import {
  createCodeTaskJournal,
  finishCodeTaskJournal,
  inferCodeTaskContract,
  recordCodeTaskPlan,
  recordCodeTaskAction,
} from "../dist-electron/code-task-service.js";

test("Code task journal records phases, progress, files, and verification", () => {
  let journal = createCodeTaskJournal({ sessionId: "s1", goal: "Implement feature", mode: "auto" });
  journal = recordCodeTaskPlan(journal, [{ content: "Implement feature", status: "in_progress" }]);
  journal = recordCodeTaskAction(journal, {
    tool: "read_file",
    summary: "Read source",
    progressed: false,
    phase: "planning",
  });
  journal = recordCodeTaskAction(journal, {
    tool: "apply_patch",
    summary: "Changed source",
    progressed: true,
    phase: "implementation",
    changedFiles: ["src/app.ts"],
  });
  journal = recordCodeTaskAction(journal, {
    tool: "execute",
    summary: "Ran tests",
    progressed: true,
    phase: "verification",
    verification: { command: "npm test", passed: true },
  });
  assert.equal(journal.phase, "verification");
  assert.equal(journal.plan.length, 1);
  assert.deepEqual(journal.changedFiles, ["src/app.ts"]);
  assert.equal(journal.verification[0].passed, true);
  assert.equal(journal.noProgressCount, 0);
  assert.equal(finishCodeTaskJournal(journal, "completed").status, "completed");
});

test("Code task contract requires implementation only for change requests", () => {
  assert.equal(inferCodeTaskContract("Fix the authentication bug").expectsChanges, true);
  assert.equal(inferCodeTaskContract("Review the authentication flow").expectsChanges, false);
  assert.equal(inferCodeTaskContract("Explain how authentication works").needsVerification, false);
  assert.equal(inferCodeTaskContract("Run the test suite").needsVerification, true);
});
