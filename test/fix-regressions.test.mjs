// Regression tests for the 2026-09 full-codebase fix round (plain Node).
// Covers the pure, testable surface of each fix: review-gate parsing, journal
// terminal statuses, memory matching, and notebook context/citation alignment.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCodeTaskJournal,
  finishCodeTaskJournal,
  parseBlockingReviewFindings,
} from "../dist-electron/code-task-service.js";
import {
  addMemoryFact,
  removeMemoryFact,
  parseHomeMemory,
  selectRelevantHomeMemory,
} from "../dist-electron/home-memory-service.js";
import {
  composeContextBlock,
  composeContextBlockIndexed,
} from "../dist-electron/notebook-text.js";

test("review gate: prose mentions of CRITICAL/HIGH are not blocking findings", () => {
  assert.deepEqual(parseBlockingReviewFindings("No CRITICAL or HIGH findings."), []);
  assert.deepEqual(parseBlockingReviewFindings("I found no CRITICAL issues; nothing HIGH either."), []);
  assert.deepEqual(parseBlockingReviewFindings(""), []);
});

test("review gate: formatted finding lines are parsed, severities respected", () => {
  const review = [
    "CRITICAL | src/auth.ts | Token check can be bypassed",
    "HIGH|src/api.ts|Unhandled rejection leaks the key",
    "MEDIUM | src/util.ts | Naming could be clearer",
    "low | src/x.ts | Trailing whitespace",
  ].join("\n");
  const findings = parseBlockingReviewFindings(review);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /^CRITICAL \| src\/auth\.ts/);
  assert.match(findings[1], /^HIGH\|src\/api\.ts/);
});

test("code task journal terminal statuses: interrupted/blocked/failed all write", () => {
  const base = createCodeTaskJournal({ sessionId: "s1", goal: "g", mode: "auto" });
  assert.equal(base.status, "active");
  assert.equal(finishCodeTaskJournal(base, "interrupted").status, "interrupted");
  assert.equal(finishCodeTaskJournal(base, "failed").status, "failed");
  const blocked = finishCodeTaskJournal(base, "blocked");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.phase, "blocked");
  const completed = finishCodeTaskJournal(base, "completed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "completed");
  assert.ok(completed.completedAt);
});

test("removeMemoryFact matches exact facts only (no substring collateral)", () => {
  let memory = addMemoryFact("", "fact", "lives in Paris");
  memory = addMemoryFact(memory, "context", "Paris-based projects");
  memory = addMemoryFact(memory, "preference", "short answers");
  // Forgetting the exact fact removes it…
  const afterExact = removeMemoryFact(memory, "lives in Paris");
  const structAfter = parseHomeMemory(afterExact);
  assert.ok(!structAfter.facts.includes("lives in Paris"), "exact fact removed");
  // …but a query that merely substring-matches must not delete other entries.
  const afterLoose = removeMemoryFact(memory, "Paris");
  const structLoose = parseHomeMemory(afterLoose);
  assert.ok(structLoose.facts.includes("lives in Paris"), "substring query must not delete the exact fact");
  assert.ok(structLoose.context.includes("Paris-based projects"), "substring query must not delete context");
  assert.ok(structLoose.preferences.includes("short answers"), "unrelated entries untouched");
});

test("selectRelevantHomeMemory hidden count ignores profile/preference bullets", () => {
  let memory = "";
  for (let i = 0; i < 4; i++) memory = addMemoryFact(memory, "profile", `User profile line ${i} which is long enough`);
  for (let i = 0; i < 12; i++) memory = addMemoryFact(memory, "fact", `Remembered durable fact number ${i} about topic`);
  const sliced = selectRelevantHomeMemory(memory, "tell me about topic", 20000);
  const shownFacts = (sliced.match(/^- Remembered durable fact/gm) || []).length;
  const match = sliced.match(/\[\+(\d+) more memorized item/);
  assert.ok(match, "hidden-count note present");
  const totalFacts = parseHomeMemory(memory).facts.length;
  assert.equal(Number(match[1]), totalFacts - shownFacts, "hidden count counts only facts/context, not profile bullets");
});

test("composeContextBlockIndexed renumbers contiguously over kept chunks", () => {
  const chunks = [
    { headingPath: ["Doc A", "Intro"], text: "alpha content" },
    { headingPath: ["Doc A", "Dup"], text: "alpha content" }, // duplicate → dropped
    { headingPath: ["Doc B", "Body"], text: "beta content" },
  ];
  const { block, keptIndices } = composeContextBlockIndexed(chunks, 12000);
  assert.deepEqual(keptIndices, [0, 2], "duplicate chunk dropped from kept set");
  assert.match(block, /\[S1\] Doc A › Intro/);
  assert.match(block, /\[S2\] Doc B › Body/);
  assert.ok(!block.includes("[S3]"), "no gap left by the dropped duplicate");
});

test("composeContextBlockIndexed respects the char budget and reports kept set", () => {
  const chunks = Array.from({ length: 40 }, (_, i) => ({ headingPath: [`Doc ${i}`], text: `chunk ${i} ${"x".repeat(600)}` }));
  const { block, keptIndices } = composeContextBlockIndexed(chunks, 3000);
  assert.equal(block.length, composeContextBlock(chunks, 3000).length, "block identical to the plain composer");
  assert.ok(keptIndices.length < 40, "budget kept only a subset");
  const highest = Math.max(...[...block.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])));
  assert.equal(highest, keptIndices.length, "markers run contiguously to the kept count");
});
