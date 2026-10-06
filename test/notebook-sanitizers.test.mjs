// Unit tests for the study-output generator sanitizers (plain Node). These
// parse whatever JSON the model returned, so malformed drafts must either be
// repaired into usable artifacts or throw — never produce empty/broken ones.
// Also covers the verified/unverified citation marking:
//   - model-cited [Sn] refs  -> verified: true
//   - positional fallback    -> verified: false (rendered dimmed in the UI)
import assert from "node:assert/strict";
import { sanitizeQuestions } from "../dist-electron/notebook-quiz.js";
import { sanitizeCards } from "../dist-electron/notebook-flashcards.js";
import { sanitizeRoots } from "../dist-electron/notebook-mindmaps.js";
import { sanitizeSummary } from "../dist-electron/notebook-summaries.js";

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

console.log("\n=== Notebook Sanitizer Tests ===");

function makeCitations(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    sourceId: `file${i + 1}`,
    sourceName: `source-${i + 1}.txt`,
    chunkId: `chunk-${i + 1}`,
    heading: `Heading ${i + 1}`,
    excerpt: "excerpt text",
    snippet: "snippet text",
    score: 0.9,
    verified: true,
  }));
}

const MCQ = {
  type: "mcq",
  question: "What grew 12 percent? [S1]",
  options: ["Revenue", "Costs", "Hiring", "Margin"],
  correctIndex: 0,
  explanation: "The report says revenue grew. [S1]",
};

await test("sanitizeQuestions: happy MCQ keeps model-cited [Sn] as verified", () => {
  const questions = sanitizeQuestions({ questions: [MCQ] }, 3, "mcq", makeCitations(2));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, "mcq");
  assert.equal(questions[0].correctIndex, 0);
  assert.equal(questions[0].citations.length, 1);
  assert.equal(questions[0].citations[0].verified, true);
  assert.equal(questions[0].citations[0].index, 1);
});

await test("sanitizeQuestions: True/False answers parse from booleans and strings", () => {
  const parsed = { questions: [
    { type: "boolean", question: "Revenue grew? [S2]", correctBoolean: true, explanation: "x" },
    { type: "boolean", question: "Costs doubled?", answer: "false", explanation: "y" },
    { type: "boolean", question: "Hiring stopped?", answer: "no", explanation: "z" },
  ] };
  const questions = sanitizeQuestions(parsed, 3, "truefalse", makeCitations(2));
  assert.equal(questions[0].correctBoolean, true);
  assert.equal(questions[1].correctBoolean, false);
  assert.equal(questions[2].correctBoolean, false);
  assert.equal(questions[0].citations[0].index, 2);
  assert.equal(questions[0].citations[0].verified, true);
});

await test("sanitizeQuestions: mixed alternates MCQ and boolean", () => {
  const parsed = { questions: [MCQ, { type: "boolean", question: "True?", correctBoolean: false, explanation: "e" }] };
  const questions = sanitizeQuestions(parsed, 2, "mixed", makeCitations(2));
  assert.equal(questions[0].type, "mcq");
  assert.equal(questions[1].type, "boolean");
});

await test("sanitizeQuestions: uncited questions get an UNVERIFIED positional fallback", () => {
  const uncited = { ...MCQ, question: "What grew?", explanation: "The report says revenue grew." };
  const questions = sanitizeQuestions({ questions: [uncited, uncited, uncited] }, 3, "mcq", makeCitations(2));
  // i=0 -> fallback citations[0]; i=1 -> citations[1]; i=2 -> citations[0] again
  assert.equal(questions[0].citations[0].verified, false);
  assert.equal(questions[0].citations[0].index, 1);
  assert.equal(questions[1].citations[0].verified, false);
  assert.equal(questions[1].citations[0].index, 2);
  assert.equal(questions[2].citations[0].index, 1);
});

await test("sanitizeQuestions: too few options, missing answer, and empty text all throw", () => {
  assert.throws(() => sanitizeQuestions({ questions: [{ ...MCQ, options: ["a", "b"] }] }, 1, "mcq", makeCitations(1)), /options/);
  assert.throws(() => sanitizeQuestions({ questions: [{ ...MCQ, correctIndex: 9 }] }, 1, "mcq", makeCitations(1)), /correct option/);
  assert.throws(() => sanitizeQuestions({ questions: [{ ...MCQ, question: "" }] }, 1, "mcq", makeCitations(1)), /missing text/);
  assert.throws(() => sanitizeQuestions({ questions: [] }, 1, "mcq", makeCitations(1)), /no usable questions/);
  assert.throws(() => sanitizeQuestions({}, 1, "mcq", makeCitations(1)), /questions array/);
});

await test("sanitizeQuestions: correct answer matched by option text; extras sliced to count", () => {
  const byText = { ...MCQ, correctIndex: undefined, answer: "Costs" };
  const questions = sanitizeQuestions({ questions: [byText, MCQ, MCQ, MCQ, MCQ] }, 2, "mcq", makeCitations(1));
  assert.equal(questions.length, 2);
  assert.equal(questions[0].correctIndex, 1);
});

await test("sanitizeCards: happy path keeps verified [Sn]; fallback marks unverified", () => {
  const citations = makeCitations(2);
  const cited = { front: "Define hippocampus? [S1]", back: "It consolidates memory. [S1]" };
  const uncited = { front: "What is a spindle?", back: "A sleep oscillation." };
  const cards = sanitizeCards({ cards: [cited, uncited] }, 2, citations);
  assert.equal(cards[0].citations[0].verified, true);
  assert.equal(cards[1].citations[0].verified, false);
  assert.throws(() => sanitizeCards({ cards: [{ front: "", back: "b" }] }, 1, citations), /front/);
  assert.throws(() => sanitizeCards({ cards: [] }, 1, citations), /no usable cards/);
  assert.throws(() => sanitizeCards({}, 1, citations), /cards array/);
});

await test("sanitizeRoots: nesting, node budget, and depth caps", () => {
  const citations = makeCitations(1);
  const deep = (label, depth) => ({
    label: `${label} [S1]`,
    detail: `detail for ${label}`,
    children: depth >= 6 ? [] : [deep(`${label}.1`, depth + 1), deep(`${label}.2`, depth + 1)],
  });
  const roots = sanitizeRoots({ roots: [deep("root", 1), deep("root2", 1)] }, 8, citations);
  const count = (nodes) => nodes.reduce((sum, n) => sum + 1 + count(n.children), 0);
  assert.ok(count(roots) <= 8, "node budget enforced");
  const maxDepth = (nodes) => (nodes.length ? 1 + Math.max(...nodes.map((n) => maxDepth(n.children))) : 0);
  assert.ok(maxDepth(roots) <= 4, "depth capped at 4");
  assert.equal(roots[0].citations[0].verified, true);
  const uncitedRoots = sanitizeRoots({ roots: [{ label: "plain", detail: "no marker", children: [] }] }, 8, citations);
  assert.equal(uncitedRoots[0].citations[0].verified, false);
  assert.throws(() => sanitizeRoots({ roots: [] }, 8, citations), /no usable topics/);
  assert.throws(() => sanitizeRoots({}, 8, citations), /roots array/);
  assert.throws(() => sanitizeRoots({ roots: [{ detail: "no label" }] }, 8, citations), /no usable topics/);
});

await test("sanitizeSummary: full structure passes; thin drafts throw", () => {
  const long = "This overview sets the scene for the whole notebook corpus with plenty of substantive sentences to satisfy the length requirement.";
  const section = () => ({ heading: "Section", body: long, keyPoints: ["point one", "point two"] });
  const ok = { overview: long, sections: Array.from({ length: 5 }, section), takeaways: ["t1", "t2", "t3"] };
  const result = sanitizeSummary(ok, "standard", makeCitations(1));
  assert.equal(result.sections.length, 5);
  assert.equal(result.takeaways.length, 3);
  // Sliced to the 5 standard sections when the model returns more.
  assert.equal(sanitizeSummary({ ...ok, sections: Array.from({ length: 9 }, section) }, "standard", makeCitations(1)).sections.length, 5);
  assert.throws(() => sanitizeSummary({ ...ok, overview: "too short" }, "standard", makeCitations(1)), /thin overview/);
  assert.throws(() => sanitizeSummary({ ...ok, sections: [{ heading: "S", body: long, keyPoints: [] }] }, "standard", makeCitations(1)), /missing key points/);
  assert.throws(() => sanitizeSummary({ ...ok, takeaways: ["only one"] }, "standard", makeCitations(1)), /too few takeaways/);
  assert.throws(() => sanitizeSummary({ ...ok, sections: [] }, "standard", makeCitations(1)), /sections/);
});

process.exit(failed ? 1 : 0);
