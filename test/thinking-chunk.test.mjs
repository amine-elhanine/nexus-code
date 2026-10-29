import test from "node:test";
import assert from "node:assert/strict";
import { chunkThinking } from "../dist-electron/thinking-chunk.js";

test("chunkThinking extracts Anthropic extended-thinking content blocks", () => {
  const chunk = { content: [{ type: "thinking", thinking: "Let me plan the edit." }, { type: "text", text: "Visible text" }] };
  assert.equal(chunkThinking(chunk), "Let me plan the edit.");
});

test("chunkThinking extracts DeepSeek-style reasoning_content kwargs", () => {
  const chunk = { content: "", additional_kwargs: { reasoning_content: "I should check the config first." } };
  assert.equal(chunkThinking(chunk), "I should check the config first.");
});

test("chunkThinking extracts generic reasoning kwarg (string and object forms)", () => {
  assert.equal(chunkThinking({ additional_kwargs: { reasoning: "step by step" } }), "step by step");
  assert.equal(chunkThinking({ additional_kwargs: { reasoning: { content: "step by step" } } }), "step by step");
});

test("chunkThinking returns empty for plain text chunks", () => {
  assert.equal(chunkThinking({ content: "just the answer" }), "");
  assert.equal(chunkThinking({ content: [{ type: "text", text: "plain" }] }), "");
  assert.equal(chunkThinking(null), "");
  assert.equal(chunkThinking(undefined), "");
});
