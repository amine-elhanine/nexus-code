// Tests for the provider-safety tool-message sanitizer
// (electron/agent/message-utils.ts flattenToolMessageContent).
//
// Regression context: a Home presentation run burned 600+ steps because one
// tool result carried structured (image-part) content; the OpenAI-compatible
// provider rejected the payload shape with a 400 deserialize error on EVERY
// retry/recovery/continue until the run died. The sanitizer flattens tool
// message content to plain text at the stream boundary so no tool result can
// ever poison the transcript again.
import test from "node:test";
import assert from "node:assert/strict";
import { ToolMessage, HumanMessage, AIMessage } from "@langchain/core/messages";

const { flattenToolMessageContent } = await import("../dist-electron/agent/message-utils.js");

test("sanitize: array tool content with text parts flattens to a string", () => {
  const { messages, flattened } = flattenToolMessageContent([
    new ToolMessage({ content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }], tool_call_id: "call_1" }),
  ]);
  assert.equal(flattened, 1);
  assert.equal(messages[0].content, "line one\nline two");
  assert.equal(messages[0].tool_call_id, "call_1");
});

test("sanitize: image parts are omitted and referenced by path instead", () => {
  const { messages, omittedImages } = flattenToolMessageContent([
    new ToolMessage({
      content: [
        { type: "text", text: "Preview of sheet:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ],
      tool_call_id: "call_2",
    }),
  ]);
  assert.equal(omittedImages, 2);
  assert.match(String(messages[0].content), /^Preview of sheet:/);
  assert.match(String(messages[0].content), /2 image part\(s\) removed/);
  // The wire payload must be a plain string — this is the exact shape the
  // nvidia-class deserialize error rejected.
  assert.equal(typeof messages[0].content, "string");
});

test("sanitize: string-content tool messages and non-tool messages pass through untouched", () => {
  const tool = new ToolMessage({ content: "plain text", tool_call_id: "call_3" });
  const human = new HumanMessage([{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }]);
  const ai = new AIMessage("hi");
  const { messages, flattened, omittedImages } = flattenToolMessageContent([tool, human, ai]);
  assert.equal(flattened, 0);
  assert.equal(omittedImages, 0);
  assert.equal(messages[0], tool); // same reference — nothing to change
  assert.deepEqual(messages[1].content, human.content); // user images untouched
  assert.equal(messages[2], ai);
});

test("sanitize: image-only tool content becomes a path-reference note, never an empty string", () => {
  const { messages } = flattenToolMessageContent([
    new ToolMessage({ content: [{ type: "image_url", image_url: { url: "x" } }], tool_call_id: "call_4" }),
  ]);
  assert.equal(typeof messages[0].content, "string");
  assert.match(String(messages[0].content), /image part\(s\) removed/);
});

test("sanitize: tolerates malformed parts and non-LangChain shapes", () => {
  const { messages, flattened } = flattenToolMessageContent([
    new ToolMessage({ content: ["plain", { type: "text", text: "part" }, { weird: true }], tool_call_id: "call_5" }),
    { content: "not even a class instance" }, // no _getType → untouched
    null,
  ]);
  assert.equal(flattened, 1);
  assert.match(String(messages[0].content), /plain/);
  assert.match(String(messages[0].content), /part/);
  assert.deepEqual(messages[1], { content: "not even a class instance" });
  assert.equal(messages[2], null);
});
