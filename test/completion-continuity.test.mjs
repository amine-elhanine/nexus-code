import assert from "node:assert/strict";
import { detectIncompleteAgentTurn } from "../dist-electron/agent/completion-guard.js";
import { runAgentLoop } from "../dist-electron/agentcore/loop.js";
import { inferCodeTaskContract } from "../dist-electron/code-task-service.js";
import { loopPreventionMiddleware } from "../dist-electron/loop-prevention.js";
import { decideHomeVerification } from "../dist-electron/agent/verify-home.js";

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

console.log("\n=== Completion Continuity Tests ===");

await test("detectIncompleteAgentTurn flags truncated length stopReason", () => {
  const res = detectIncompleteAgentTurn({
    response: "Partial answer that got cut",
    stopReason: "length",
    mode: "auto",
    isGeneral: false,
    expectsChanges: false,
    expectsOutput: false,
    changedFilesCount: 0,
    createdDeliverable: false,
    planItems: null,
    toolCallCount: 1,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(res.incomplete, true);
  assert.equal(res.reason, "truncated");
});

await test("detectIncompleteAgentTurn flags unfinished write_todos plan", () => {
  const res = detectIncompleteAgentTurn({
    response: "Completed step 1 cleanly.",
    stopReason: "stop",
    mode: "auto",
    isGeneral: true,
    expectsChanges: false,
    expectsOutput: true,
    changedFilesCount: 1,
    createdDeliverable: true,
    planItems: [
      { id: "1", content: "Create deck.pptx", status: "completed" },
      { id: "2", content: "Create summary.docx", status: "pending" },
    ],
    toolCallCount: 4,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(res.incomplete, true);
  assert.equal(res.reason, "unfinished-plan");
});

await test("detectIncompleteAgentTurn catches forward narration without tool calls but ignores polite closing", () => {
  const narration = detectIncompleteAgentTurn({
    response: "I found the bug in auth.ts. Now I'll edit auth.ts to handle missing tokens",
    stopReason: "stop",
    mode: "auto",
    isGeneral: false,
    expectsChanges: true,
    expectsOutput: false,
    changedFilesCount: 0,
    createdDeliverable: false,
    planItems: null,
    toolCallCount: 2,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(narration.incomplete, true);
  assert.equal(narration.reason, "promise-only");

  const closing = detectIncompleteAgentTurn({
    response: "Updated auth.ts and verified tests pass. Let me know if you want anything else!",
    stopReason: "stop",
    mode: "auto",
    isGeneral: false,
    expectsChanges: true,
    expectsOutput: false,
    changedFilesCount: 1,
    createdDeliverable: false,
    planItems: null,
    toolCallCount: 3,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(closing.incomplete, false);
});

await test("detectIncompleteAgentTurn catches explicit deferral but skips genuine blockers and git tips", () => {
  const deferred = detectIncompleteAgentTurn({
    response: "Updated module A.\n\n### Remaining Work\n- Update module B and run tests",
    stopReason: "stop",
    mode: "auto",
    isGeneral: false,
    expectsChanges: true,
    expectsOutput: false,
    changedFilesCount: 1,
    createdDeliverable: false,
    planItems: null,
    toolCallCount: 3,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(deferred.incomplete, true);
  assert.equal(deferred.reason, "deferred");

  const gitTip = detectIncompleteAgentTurn({
    response: "All changes implemented and tests passed.\n\n### Next Steps\nYou can run git commit and push when ready.",
    stopReason: "stop",
    mode: "auto",
    isGeneral: false,
    expectsChanges: true,
    expectsOutput: false,
    changedFilesCount: 2,
    createdDeliverable: false,
    planItems: null,
    toolCallCount: 4,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(gitTip.incomplete, false);

  const blocker = detectIncompleteAgentTurn({
    response: "Cannot complete integration check because API key is missing in environment.",
    stopReason: "stop",
    mode: "auto",
    isGeneral: false,
    expectsChanges: true,
    expectsOutput: false,
    changedFilesCount: 0,
    createdDeliverable: false,
    planItems: null,
    toolCallCount: 1,
    continuationsUsed: 0,
    maxContinuations: 8,
  });
  assert.equal(blocker.incomplete, false);
});

await test("runAgentLoop auto-continues when stopReason === 'length' without tool calls", async () => {
  let calls = 0;
  const mockClient = {
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: "text", delta: "First half..." };
        yield { type: "done", text: "First half...", toolCalls: [], stopReason: "length" };
        return;
      }
      yield { type: "text", delta: "Done cleanly." };
      yield { type: "done", text: "Done cleanly.", toolCalls: [], stopReason: "stop" };
    },
  };

  const messages = [{ role: "user", content: "Explain the architecture in detail" }];
  const iter = runAgentLoop({
    client: mockClient,
    messages,
    tools: [],
    stepBudget: 6,
  });
  // Drain async generator return value
  let result;
  for (;;) {
    const step = await iter.next();
    if (step.done) {
      result = step.value;
      break;
    }
  }
  assert.equal(calls, 2);
  assert.equal(result.answer, "Done cleanly.");
  assert.equal(result.stopReason, "stop");
});

await test("inferCodeTaskContract recognizes compound investigate+fix requests while keeping pure reads read-only", () => {
  assert.equal(inferCodeTaskContract("check why the auth tests fail and fix them").expectsChanges, true);
  assert.equal(inferCodeTaskContract("review src/routes.ts and update input validation").expectsChanges, true);
  assert.equal(inferCodeTaskContract("investigate the memory leak and patch it").expectsChanges, true);
  assert.equal(inferCodeTaskContract("read src/routes.ts and explain how routing works").expectsChanges, false);
  assert.equal(inferCodeTaskContract("review src/routes.ts for bugs").expectsChanges, false);
});

await test("loopPreventionMiddleware allows paginated read_file ranges and distinct grep patterns", async () => {
  const middleware = loopPreventionMiddleware();
  const next = async (req) => `ok:${req.call.name}:${JSON.stringify(req.call.args)}`;

  const offsets = [1, 101, 201, 301];
  for (let i = 0; i < offsets.length; i++) {
    const res = await middleware.wrapToolCall(
      { call: { id: `r${i}`, name: "read_file", args: { file_path: "src/large.ts", offset: offsets[i], limit: 100 } }, toolCallId: `r${i}` },
      next
    );
    const txt = String(typeof res === "string" ? res : res?.content ?? "");
    assert.ok(!txt.includes("[Notice:"), `paginated read ${i} must not warn: ${txt}`);
    assert.ok(!txt.includes("[LOOP PREVENTION NOTICE]"), `paginated read ${i} must not block`);
  }

  const patterns = ["alpha", "beta", "gamma", "delta"];
  for (let i = 0; i < patterns.length; i++) {
    const res = await middleware.wrapToolCall(
      { call: { id: `g${i}`, name: "grep", args: { path: "src", pattern: patterns[i] } }, toolCallId: `g${i}` },
      next
    );
    const txt = String(typeof res === "string" ? res : res?.content ?? "");
    assert.ok(!txt.includes("[Notice:"), `distinct grep ${i} must not warn: ${txt}`);
    assert.ok(!txt.includes("[LOOP PREVENTION NOTICE]"), `distinct grep ${i} must not block`);
  }
});

await test("loopPreventionMiddleware skips deliverable-ready block while pending plan items remain", async () => {
  let pending = true;
  const middleware = loopPreventionMiddleware({
    general: true,
    outputRequired: true,
    checkDeliverableReady: async () => ({ ready: true, files: ["part1.docx"], summary: "valid" }),
    hasPendingPlan: () => pending,
  });
  let ran = 0;
  const next = async () => {
    ran++;
    return "wrote part 2";
  };

  for (let i = 0; i < 3; i++) {
    const res = await middleware.wrapToolCall(
      { call: { id: `w${i}`, name: "write_file", args: { file_path: "part2.md", content: "hi" } }, toolCallId: `w${i}` },
      next
    );
    const txt = String(typeof res === "string" ? res : res?.content ?? "");
    assert.ok(!txt.includes("[DELIVERABLE ALREADY VERIFIED]"), "must not block second deliverable while plan has pending items");
  }
  assert.equal(ran, 3);
});

await test("decideHomeVerification does not escape via chat-answer when pending plan items exist", () => {
  const planItems = [
    { id: "1", content: "Gather data", status: "completed" },
    { id: "2", content: "Write executive report", status: "pending" },
  ];
  const noFileYet = decideHomeVerification({
    request: "Research Q3 sales trends and build the executive summary",
    response: "Here is the initial chart.\n```bar\nA: 10\n```\n[[answer-in-chat]]",
    currentRepairs: 0,
    maxRepairs: 2,
    wantsDeliverable: true,
    freshFiles: [],
    createdDeliverable: false,
    artifactValid: false,
    invalidArtifacts: [],
    missingFormats: [],
    contentInspections: [],
    mdFilesWithCharts: [],
    planItems,
    evidenceActions: [],
    homeReadOnlyStreak: 0,
    failedSkillNames: [],
  });
  assert.notEqual(noFileYet.outcome, "chat-answer");
  assert.equal(noFileYet.outcome, "failed-structure");

  const part1Created = decideHomeVerification({
    request: "Research Q3 sales trends and build the executive summary",
    response: "Here is part 1 chart.\n```bar\nA: 10\n```",
    currentRepairs: 0,
    maxRepairs: 2,
    wantsDeliverable: true,
    freshFiles: ["notes.docx"],
    createdDeliverable: true,
    artifactValid: true,
    invalidArtifacts: [],
    missingFormats: [],
    contentInspections: [],
    mdFilesWithCharts: [],
    planItems,
    evidenceActions: [],
    homeReadOnlyStreak: 0,
    failedSkillNames: [],
  });
  assert.equal(part1Created.outcome, "failed-plan");
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
