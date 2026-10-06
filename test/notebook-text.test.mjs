// Unit tests for the deterministic notebook core (plain Node, no Electron).
import assert from "node:assert/strict";
import {
  uuid5,
  stableChunkId,
  sha256Hex,
  validateUpload,
  cleanMarkdown,
  extractStructure,
  oneSentenceSummary,
  keyTerms,
  chunkSections,
  notebookTokens,
  meaningfulQueryTerms,
  rewriteQuery,
  routeMessageHeuristic,
  isSessionWideAsk,
  gateDecision,
  composeContextBlock,
  evaluateCitationCoverage,
} from "../dist-electron/notebook-text.js";

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

console.log("\n=== Notebook Text Core Tests ===");

await test("uuid5 is stable and well-formed", () => {
  const a = uuid5("hello");
  const b = uuid5("hello");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(uuid5("hello"), uuid5("world"));
});

await test("stable chunk IDs are deterministic across re-runs", () => {
  const hash = sha256Hex("some content").slice(0, 16);
  const a = stableChunkId("sess", "file", "sec", 0, hash);
  const b = stableChunkId("sess", "file", "sec", 0, hash);
  assert.equal(a, b);
  assert.notEqual(a, stableChunkId("sess", "file", "sec", 1, hash));
  assert.notEqual(a, stableChunkId("other", "file", "sec", 0, hash));
});

await test("validateUpload enforces whitelist + size at the edge", () => {
  assert.equal(validateUpload("notes.txt", 100).ok, true);
  assert.equal(validateUpload("deck.pptx", 100).ok, true);
  assert.equal(validateUpload("evil.exe", 100).ok, false);
  assert.equal(validateUpload("big.pdf", 20 * 1024 * 1024).ok, false);
  assert.equal(validateUpload("empty.md", 0).ok, false);
});

await test("cleanMarkdown removes boilerplate but keeps tables/code/headings", () => {
  const md = [
    "# Real Heading",
    "",
    "Page 1 of 10",
    "Quarterly Report",
    "Some body text here.",
    "Quarterly Report",
    "More body text here.",
    "Quarterly Report",
    "Even more body text.",
    "1 / 12",
    "Item A .... 12",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```python",
    "Page 1 of 10",
    "print('keep me')",
    "```",
    "",
    "© 2026 All rights reserved",
  ].join("\n");
  const { cleaned, removedLines } = cleanMarkdown(md);
  assert.ok(removedLines >= 4, `expected boilerplate removals, got ${removedLines}`);
  assert.ok(cleaned.includes("# Real Heading"), "heading kept");
  assert.ok(cleaned.includes("| a | b |"), "table kept");
  assert.ok(cleaned.includes("print('keep me')"), "code kept");
  assert.ok(cleaned.includes("Page 1 of 10\nprint"), "code fence boilerplate-like line kept");
  assert.ok(!cleaned.split("\n").some((l) => l.trim() === "Quarterly Report"), "repeated header dropped");
  assert.ok(!/^1 \/ 12$/m.test(cleaned), "page counter dropped");
});

await test("extractStructure builds heading paths", () => {
  const md = "# Alpha\n\nintro\n\n## Beta\n\nbody\n\n### Gamma\n\ndeep\n\n## Delta\n\ntail";
  const sections = extractStructure(md, "Doc");
  assert.equal(sections.length, 4);
  assert.deepEqual(sections[2].headingPath, ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(sections[3].headingPath, ["Alpha", "Delta"]);
});

await test("extractStructure infers plain headings", () => {
  const md = "Introduction\n\nThis is the intro paragraph with real content.\n\nConclusion\n\nFinal words here.";
  const sections = extractStructure(md, "Doc");
  assert.ok(sections.some((s) => s.heading === "Introduction"));
  assert.ok(sections.some((s) => s.heading === "Conclusion"));
});

await test("oneSentenceSummary + keyTerms are deterministic", () => {
  const text = "The hippocampus consolidates memory during sleep. Sleep spindles coordinate memory replay across the hippocampus and neocortex.";
  assert.ok(oneSentenceSummary(text).startsWith("The hippocampus consolidates"));
  const terms = keyTerms(text);
  assert.ok(terms.includes("hippocampus"));
  assert.deepEqual(terms, keyTerms(text));
});

await test("chunking never splits tables or code mid-block", () => {
  const bigTable = Array.from({ length: 30 }, (_, i) => `| row${i} cell a very long cell value ${i} | row${i} cell b |`).join("\n");
  const sections = [{ sectionId: "s1", headingPath: ["Doc"], text: `Intro paragraph one with some words.\n\n${bigTable}\n\n\`\`\`python\n${"x = 1\n".repeat(60)}\n\`\`\`` }];
  const chunks = chunkSections(sections, { maxTokens: 60, overlapSentences: 1 });
  const tableChunks = chunks.filter((c) => c.text.includes("| row0"));
  assert.equal(tableChunks.length, 1, "whole table stays one chunk");
  assert.ok(tableChunks[0].structured, "table chunk flagged structured");
  const codeChunks = chunks.filter((c) => c.text.includes("x = 1"));
  assert.equal(codeChunks.length, 1, "whole code block stays one chunk");
  assert.ok(codeChunks[0].structured);
});

await test("routing: greetings, off-topic, retrieve, session-wide", () => {
  const terms = new Set(["hippocampus", "memory", "sleep", "report"]);
  assert.equal(routeMessageHeuristic("hello!", terms).action, "conversational_reply");
  assert.equal(routeMessageHeuristic("thanks", terms).action, "conversational_reply");
  assert.equal(routeMessageHeuristic("what is the weather in Paris?", terms).action, "outside_files");
  // Off-topic words WITH session overlap still retrieve.
  assert.equal(routeMessageHeuristic("how did they cook the data in the memory report?", terms).action, "retrieve");
  assert.equal(routeMessageHeuristic("What does the hippocampus do during sleep?", terms).action, "retrieve");
  assert.equal(isSessionWideAsk("summarize everything"), true);
  assert.equal(isSessionWideAsk("what are these files about?"), true);
  assert.equal(isSessionWideAsk("what is it about"), true);
  assert.equal(isSessionWideAsk("what does the hippocampus do?"), false);
});

await test("rewriteQuery strips politeness", () => {
  assert.equal(rewriteQuery("Please tell me what the report says?"), "what the report says");
});

await test("gate refuses only when score low AND no literal terms", () => {
  assert.equal(gateDecision("quantum zebra funding", 0.02, ["the hippocampus and sleep"]).refused, true);
  assert.equal(gateDecision("quantum zebra funding", 0.5, ["unrelated"]).refused, false);
  assert.equal(gateDecision("hippocampus sleep", 0.02, ["the hippocampus and sleep"]).refused, false);
});

await test("composeContextBlock dedupes and caps", () => {
  const chunks = [
    { headingPath: ["A"], text: "same text" },
    { headingPath: ["A"], text: "same text" },
    { headingPath: ["B"], text: "x".repeat(20000) },
  ];
  const block = composeContextBlock(chunks, 1000);
  assert.equal((block.match(/same text/g) || []).length, 1);
  assert.ok(block.length <= 1200);
  assert.ok(block.includes("[S1]"));
});

await test("notebookTokens + meaningfulQueryTerms filter noise", () => {
  assert.ok(!notebookTokens("the and of a").length);
  assert.ok(meaningfulQueryTerms("What is the hippocampus?").includes("hippocampus"));
});

await test("evaluateCitationCoverage: fully cited answer is grounded", () => {
  const answer = "Revenue grew 12 percent [S1]. Margin reached 24 percent [S2].";
  const ev = evaluateCitationCoverage(answer, 5);
  assert.equal(ev.verdict, "grounded");
  assert.equal(ev.citationCoverage, 1);
  assert.deepEqual(ev.issues, []);
});

await test("evaluateCitationCoverage: sparse citations are partial", () => {
  const answer = "Revenue grew 12 percent [S1]. Margin reached 24 percent. Costs fell. Hiring slowed.";
  const ev = evaluateCitationCoverage(answer, 5);
  assert.equal(ev.verdict, "partial");
  assert.ok(ev.citationCoverage > 0 && ev.citationCoverage < 0.6);
});

await test("evaluateCitationCoverage: no markers at all is ungrounded", () => {
  const ev = evaluateCitationCoverage("Revenue grew. Margin held.", 5);
  assert.equal(ev.verdict, "ungrounded");
  assert.equal(ev.citationCoverage, 0);
  assert.ok(ev.issues.some((i) => i.includes("no [Sn]")));
});

await test("evaluateCitationCoverage: markers past the registry cap the verdict at partial", () => {
  const ev = evaluateCitationCoverage("Claim one [S1]. Claim two [S9].", 2);
  assert.equal(ev.verdict, "partial");
  assert.ok(ev.issues.some((i) => i.includes("point past")));
});

await test("evaluateCitationCoverage: code fences and tables do not dilute coverage", () => {
  const answer = "Growth was strong [S1]." + "\\n\\n```json\\n{ \"revenue\": 12 }\\n```\\n" + "| a | b |\\n|---|---|\\n| 1 | 2 |" + "\\n\\nMargin held [S2].";
  const ev = evaluateCitationCoverage(answer, 3);
  assert.equal(ev.verdict, "grounded");
  assert.equal(ev.citationCoverage, 1);
});

await test("evaluateCitationCoverage: empty answer with no markers is ungrounded", () => {
  const ev = evaluateCitationCoverage("", 3);
  assert.equal(ev.verdict, "ungrounded");
});

console.log(`\nnotebook-text: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
