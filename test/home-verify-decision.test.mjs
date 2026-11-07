// Tests for the Home verification DECISION core (electron/agent/verify-home.ts).
// This pins the branch-order contract that was previously implicit across
// 140 lines inside runProjectAgent: chat-answer escape → chart-dump rule →
// structure repair → content repair → plan contract → pass/warnings → terminal.
// A change to the ordering MUST update these tests deliberately.
import test from "node:test";
import assert from "node:assert/strict";

const { decideHomeVerification } = await import("../dist-electron/agent/verify-home.js");

const REQUEST = "Generate me a presentation about the Battle of Troy";
const base = {
  request: REQUEST,
  response: "The deck is complete.",
  currentRepairs: 0,
  maxRepairs: 3,
  wantsDeliverable: true,
  freshFiles: [],
  createdDeliverable: false,
  artifactValid: false,
  invalidArtifacts: [],
  missingFormats: [],
  contentInspections: [],
  mdFilesWithCharts: [],
  planItems: null,
  evidenceActions: [],
  homeReadOnlyStreak: 0,
  failedSkillNames: [],
};

test("order 1: chat-answer escape wins over everything (sentinel + no named format + substance)", () => {
  const decision = decideHomeVerification({
    ...base,
    // A request that names NO file format — "presentation" names one, which
    // correctly keeps the escape closed (order 1d pins that).
    request: "Write me something about the sea",
    response: "Here is the poem you asked for.\n\nThe sea was calm, the tide ran low, the gulls argued loudly about the morning light while the old harbor slept against its stones and the fishing boats knocked gently together at their moorings.\n\n[[answer-in-chat]]",
  });
  assert.equal(decision.outcome, "chat-answer");
  assert.equal(decision.hasVisualBlocks, false);
});

test("order 1b: visual blocks in chat count as the chat-answer escape", () => {
  const decision = decideHomeVerification({
    ...base,
    request: "Show me how the numbers changed, with a visual",
    response: "Here is the growth:\n\n```bar\nbar \"Q1\" 10\n```",
  });
  assert.equal(decision.outcome, "chat-answer");
  assert.equal(decision.hasVisualBlocks, true);
});

test("order 1c: sentinel alone is not enough — substance threshold applies", () => {
  const decision = decideHomeVerification({
    ...base,
    response: "short reply [[answer-in-chat]]",
  });
  assert.notEqual(decision.outcome, "chat-answer");
});

test("order 1d: the escape never fires when the request names a file format", () => {
  const decision = decideHomeVerification({
    ...base,
    request: "Generate me a presentation about Troy as a .pptx file",
    response: "Here is the poem you asked for.\n\n" + "word ".repeat(50) + "\n\n[[answer-in-chat]]",
  });
  assert.notEqual(decision.outcome, "chat-answer");
});

test("order 2: chart dumps in .md files trigger the chart rule before structure checks", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["charts.md"],
    createdDeliverable: true,
    artifactValid: true,
    mdFilesWithCharts: [{ path: "charts.md" }],
  });
  assert.equal(decision.outcome, "failed-charts");
  assert.equal(decision.repairs, 1);
  assert.match(decision.verifyFeedback, /DIRECTLY in your chat response/);
});

test("order 3: structure failures produce repair feedback naming the artifacts", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["broken.pptx"],
    createdDeliverable: true,
    artifactValid: false,
    invalidArtifacts: [{ path: "broken.pptx", error: "invalid ZIP-based document header" }],
  });
  assert.equal(decision.outcome, "failed-structure");
  assert.equal(decision.repairs, 1);
  assert.match(decision.verifyFeedback, /broken\.pptx \(invalid ZIP-based document header\)/);
});

test("order 3b: structure repairs count against MAX_REPAIRS (no unbounded no-file loop)", () => {
  // First structure repair escalates when it is the last allowed one.
  const lastChance = decideHomeVerification({ ...base, currentRepairs: 1, maxRepairs: 2 });
  assert.equal(lastChance.outcome, "failed-structure");
  assert.equal(lastChance.repairs, 2);
  assert.match(lastChance.verifyFeedback, /FINAL repair/);
  // Exhausted repairs with still no valid output → honest terminal failure,
  // NOT another identical repair prompt.
  const exhausted = decideHomeVerification({ ...base, currentRepairs: 2, maxRepairs: 2 });
  assert.equal(exhausted.outcome, "failed-terminal");
});

test("order 3c: structure feedback carries content findings for the valid siblings", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["broken.pptx", "report.docx"],
    createdDeliverable: true,
    artifactValid: false,
    invalidArtifacts: [{ path: "broken.pptx", error: "invalid ZIP-based document header" }],
    contentInspections: [
      { path: "report.docx", kind: "docx", ok: false, metrics: { kind: "docx", primaryCount: 1, wordCount: 12, titles: [], textSample: "" }, problems: ["document has only 12 words"], summary: "12 words" },
    ],
  });
  assert.equal(decision.outcome, "failed-structure");
  // One repair round reports BOTH failure classes instead of discovering
  // content problems only after structure passes.
  assert.match(decision.verifyFeedback, /broken\.pptx/);
  assert.match(decision.verifyFeedback, /Content inspection of the valid files also found/);
  assert.match(decision.verifyFeedback, /report\.docx: document has only 12 words/);
});

test("order 4: content inspection failures come with per-file targeted problems", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["deck.pptx"],
    createdDeliverable: true,
    artifactValid: true,
    contentInspections: [
      { path: "deck.pptx", kind: "pptx", ok: false, metrics: { kind: "pptx", primaryCount: 1, wordCount: 12, titles: [], textSample: "" }, problems: ["deck has only 1 slide — a finished presentation needs at least 2"], summary: "1 slide" },
    ],
  });
  assert.equal(decision.outcome, "failed-content");
  assert.equal(decision.repairs, 1);
  assert.match(decision.verifyFeedback, /deck\.pptx: deck has only 1 slide/);
  assert.match(decision.verifyFeedback, /Repair exactly these problems/);
});

test("order 5: unfinished plan items block completion even when the deliverable is valid", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["deck.pptx"],
    createdDeliverable: true,
    artifactValid: true,
    contentInspections: [
      { path: "deck.pptx", kind: "pptx", ok: true, metrics: { kind: "pptx", primaryCount: 10, wordCount: 900, titles: ["Troy"], textSample: "troy battle heroes" }, problems: [], summary: "10 slides" },
    ],
    planItems: [
      { content: "Create the Troy deck", status: "completed" },
      { content: "Cover the heroes of Troy", status: "in_progress" },
    ],
  });
  assert.equal(decision.outcome, "failed-plan");
  assert.equal(decision.repairs, 1);
  assert.match(decision.verifyFeedback, /still in_progress: Cover the heroes of Troy/);
});

test("order 5b: a completed plan item without evidence is flagged, not trusted", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["deck.pptx"],
    createdDeliverable: true,
    artifactValid: true,
    planItems: [{ content: "Research the heroes of Troy", status: "completed" }],
  });
  assert.equal(decision.outcome, "failed-plan");
  assert.match(decision.verifyFeedback, /marked completed but no evidence found.*Research the heroes of Troy/);
});

test("order 6: valid deliverable + clean inspection + satisfied plan = passed with evidence summary", () => {
  const decision = decideHomeVerification({
    ...base,
    freshFiles: ["deck.pptx"],
    createdDeliverable: true,
    artifactValid: true,
    contentInspections: [
      { path: "deck.pptx", kind: "pptx", ok: true, metrics: { kind: "pptx", primaryCount: 12, wordCount: 840, titles: ["The Battle of Troy"], textSample: "troy" }, problems: [], summary: "12 slides, ~840 words" },
    ],
    planItems: [{ content: "Create the Troy deck", status: "completed" }],
    // Deliverable content counts as plan evidence (the node passes inspection
    // text samples alongside journal actions).
    evidenceActions: ["troy battle heroes from the extracted deck text"],
  });
  assert.equal(decision.outcome, "passed");
  assert.match(decision.telemetry, /deck\.pptx \(12 slides, ~840 words\)/);
});

test("order 6b: repairs exhausted with thin content still passes — WITH visible warnings", () => {
  const decision = decideHomeVerification({
    ...base,
    currentRepairs: 3,
    maxRepairs: 3,
    freshFiles: ["deck.pptx"],
    createdDeliverable: true,
    artifactValid: true,
    contentInspections: [
      { path: "deck.pptx", kind: "pptx", ok: false, metrics: { kind: "pptx", primaryCount: 1, wordCount: 8, titles: [], textSample: "" }, problems: ["deck has only 1 slide"], summary: "1 slide" },
    ],
  });
  assert.equal(decision.outcome, "passed-with-warnings");
  assert.match(decision.telemetry, /content warnings/);
  assert.deepEqual(decision.contentWarnings, ["deck.pptx: deck has only 1 slide"]);
});

test("order 7: wants-deliverable with nothing usable is a terminal failure", () => {
  const decision = decideHomeVerification({ ...base, currentRepairs: 5, maxRepairs: 3 });
  assert.equal(decision.outcome, "failed-terminal");
});

test("order 7b: chat-shaped requests without a contract verify as none", () => {
  const decision = decideHomeVerification({ ...base, wantsDeliverable: false });
  assert.equal(decision.outcome, "none");
});

test("repair budget: exhausted repairs skip content/plan repair rounds (no infinite loop)", () => {
  const decision = decideHomeVerification({
    ...base,
    currentRepairs: 3,
    maxRepairs: 3,
    freshFiles: ["deck.pptx"],
    createdDeliverable: true,
    artifactValid: true,
    contentInspections: [
      { path: "deck.pptx", kind: "pptx", ok: false, metrics: { kind: "pptx", primaryCount: 1, wordCount: 8, titles: [], textSample: "" }, problems: ["thin"], summary: "1 slide" },
    ],
    planItems: [{ content: "Cover Troy heroes", status: "in_progress" }],
  });
  // Content problems would fail at order 4, but repairs are exhausted — the
  // decision falls through to the honest warnings pass, never a loop.
  assert.equal(decision.outcome, "passed-with-warnings");
});

// Regression: a chart-requesting chat answer with no visual blocks must be
// bounced (failed-charts), not silently passed via the [[answer-in-chat]]
// sentinel — this is what let "add plots" requests end text-only.
const verdict = decideHomeVerification({
  request: "show me graphs of renewable energy growth by year",
  response: "Renewable energy capacity has expanded dramatically over the last decade, with solar and wind leading the transition across every major market. Here is the breakdown of growth by year and technology, with the trends that matter most.\n\n[[answer-in-chat]]",
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
  planItems: [],
  evidenceActions: [],
  homeReadOnlyStreak: 0,
  failedSkillNames: [],
});
console.log("chart-request guard:", verdict.outcome);
if (verdict.outcome !== "failed-charts") {
  throw new Error(`expected failed-charts for a chart request without visuals, got ${verdict.outcome}`);
}
const withCharts = decideHomeVerification({
  request: "show me graphs of renewable energy growth by year",
  response: "Renewable energy capacity has expanded dramatically over the last decade, and the momentum keeps building. Here is the growth picture by year and technology:\n```bar\ntitle \"Renewable growth by year\"\nx-axis \"Year\"\ny-axis \"TWh\"\nbar \"2020\" 2500\nbar \"2021\" 2900\nbar \"2022\" 3400\n```\n\n[[answer-in-chat]]",
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
  planItems: [],
  evidenceActions: [],
  homeReadOnlyStreak: 0,
  failedSkillNames: [],
});
console.log("with-charts verdict:", withCharts.outcome);
if (withCharts.outcome !== "chat-answer") {
  throw new Error(`expected chat-answer when visuals are present, got ${withCharts.outcome}`);
}
console.log("\nchart-request guard tests passed");
