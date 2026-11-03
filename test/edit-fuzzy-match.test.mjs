// Tests for the edit tool's fuzzy matching tiers + miss hints
// (electron/edit-tools.ts applySearchReplaceBlocks) — G5 parity:
// OpenCode-style typographic normalization and actionable miss hints.
import test from "node:test";
import assert from "node:assert/strict";

const { applySearchReplaceBlocks } = await import("../dist-electron/edit-tools.js");

const block = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>>`;

test("tier 1-3 regression: exact, trailing-whitespace, and indentation-tolerant matches still work", () => {
  const file = "function a() {\n  return 1;\n}\n";
  assert.equal(applySearchReplaceBlocks(file, block("return 1;", "return 2;")), "function a() {\n  return 2;\n}\n");
  assert.equal(applySearchReplaceBlocks(file, block("return 1;   ", "return 2;")), "function a() {\n  return 2;\n}\n");
  assert.equal(applySearchReplaceBlocks(file, block("    return 1;", "return 2;")), "function a() {\n  return 2;\n}\n");
});

test("tier 4: typographic quotes/dashes in the search block still match ASCII file content", () => {
  // Model copied content from rendered output: smart quotes + em-dash.
  const search = "const greeting = \u201Chello\u201D; // caf\u00E9 \u2014 best";
  const file = 'const greeting = "hello"; // caf\u00E9 - best\nconsole.log(greeting);\n';
  const result = applySearchReplaceBlocks(file, block(search, 'const greeting = "hi";'));
  assert.equal(result, 'const greeting = "hi";\nconsole.log(greeting);\n');
});

test("tier 4: non-breaking spaces and ellipsis normalize too", () => {
  const file = "wait\u00A0for it\u2026 done\n";
  const result = applySearchReplaceBlocks(file, block("wait for it… done", "finished"));
  assert.equal(result, "finished\n");
});

test("tier 4: replacement is used verbatim (never typographically mangled)", () => {
  const file = "say \u201Chi\u201D now\n";
  const result = applySearchReplaceBlocks(file, block("say \u201Chi\u201D now", "say \u201Chello\u201D loudly"));
  assert.equal(result, "say \u201Chello\u201D loudly\n");
});

test("miss hint: replacement already present tells the model the edit may be applied", () => {
  const file = "const done = true;\nconsole.log(done);\n";
  let message = "";
  try {
    applySearchReplaceBlocks(file, block("const done = false;", "const done = true;"));
  } catch (error) {
    message = String(error.message);
  }
  assert.match(message, /Search block not found in target file/);
  assert.match(message, /ALREADY PRESENT/);
  assert.match(message, /Hints:/);
});

test("miss hint: closest match region with line number and match score", () => {
  const file = "alpha one\nbeta two\ngamma three\ndelta four\n";
  let message = "";
  try {
    // Model misremembered one line of a 3-line block.
    applySearchReplaceBlocks(file, block("beta two\ngamma THREE\ndelta four", "replaced"));
  } catch (error) {
    message = String(error.message);
  }
  assert.match(message, /Closest match near line 2 \(2 of 3 lines matched\)/);
  assert.match(message, /gamma three/);
});

test("miss hint: a perfect-but-scattered mismatch still names the best window", () => {
  let message = "";
  try {
    applySearchReplaceBlocks("only one line here\n", block("another line entirely", "x"));
  } catch (error) {
    message = String(error.message);
  }
  assert.match(message, /Search block not found in target file/);
});
