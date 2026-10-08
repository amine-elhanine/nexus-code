import test from "node:test";
import assert from "node:assert/strict";
import { parseDisabledPromptAssets } from "../dist-electron/prompt-assets.js";

test("prompt asset ablations parse known assets, ignore duplicates, and preserve order", () => {
  assert.deepEqual(parseDisabledPromptAssets("skills, rules,skills,agents"), ["skills", "rules", "agents"]);
  assert.deepEqual(parseDisabledPromptAssets(""), []);
  assert.deepEqual(parseDisabledPromptAssets(["commands", "rules"]), ["commands", "rules"]);
});

test("prompt asset ablations reject misspelled names", () => {
  assert.throws(() => parseDisabledPromptAssets("skillz"), /Unknown prompt asset "skillz"/);
});
