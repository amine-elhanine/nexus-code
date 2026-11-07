// Tests for agentcore/message-utils flattenToolMessageContent: legacy
// structured tool results must normalize to plain string content before a
// stream attempt (structured tool content permanently 400s OpenAI-compatible
// providers).
import test from "node:test";
import assert from "node:assert/strict";
import { toolMsg, userMsg, assistantMsg } from "../dist-electron/agentcore/messages.js";

const { flattenToolMessageContent } = await import("../dist-electron/agent/message-utils.js");

test("sanitize: array tool content with text parts flattens to a string", () => {
  const { messages, flattened } = flattenToolMessageContent([
    { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] },
  ]);
  assert.equal(flattened, 1);
  assert.equal(messages[0].content, "line one\nline two");
  assert.equal(messages[0].toolCallId, "call_1");
});

test("sanitize: image parts are omitted and referenced by path instead", () => {
  const { messages, omittedImages } = flattenToolMessageContent([
    {
      role: "tool",
      toolCallId: "call_2",
      content: [
        { type: "text", text: "Preview of sheet:" },
        { type: "image", url: "data:image/png;base64,AAAA" },
        { type: "image", url: "data:image/png;base64,BBBB" },
      ],
    },
  ]);
  assert.equal(omittedImages, 2);
  assert.match(String(messages[0].content), /^Preview of sheet:/);
  assert.match(String(messages[0].content), /2 image part\(s\) removed/);
  // The wire payload must be a plain string — this is the exact shape the
  // nvidia-class deserialize error rejected.
  assert.equal(typeof messages[0].content, "string");
});

test("sanitize: string-content tool messages and non-tool messages pass through untouched", () => {
  const tool = toolMsg("call_3", "plain text");
  const human = userMsg([{ type: "text", text: "hello" }, { type: "image", url: "data:image/png;base64,x" }]);
  const ai = assistantMsg("hi");
  const { messages, flattened, omittedImages } = flattenToolMessageContent([tool, human, ai]);
  assert.equal(flattened, 0);
  assert.equal(omittedImages, 0);
  assert.equal(messages[0], tool); // same reference — nothing to change
  assert.deepEqual(messages[1].content, human.content); // user images untouched
  assert.equal(messages[2], ai);
});

test("sanitize: image-only tool content becomes a path-reference note, never an empty string", () => {
  const { messages } = flattenToolMessageContent([
    { role: "tool", toolCallId: "call_4", content: [{ type: "image", url: "x" }] },
  ]);
  assert.equal(typeof messages[0].content, "string");
  assert.match(String(messages[0].content), /image part\(s\) removed/);
});

test("sanitize: tolerates malformed parts and legacy shapes", () => {
  const { messages, flattened } = flattenToolMessageContent([
    { role: "tool", toolCallId: "call_5", content: ["plain", { type: "text", text: "part" }, { weird: true }] },
    { content: "not even a message object" }, // no role → untouched
    null,
  ]);
  assert.equal(flattened, 1);
  assert.match(String(messages[0].content), /plain/);
  assert.match(String(messages[0].content), /part/);
  assert.deepEqual(messages[1], { content: "not even a class instance".replace("class instance", "message object") } && { content: "not even a message object" });
  assert.equal(messages[2], null);
});
