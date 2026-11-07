// Wire-shape regression tests for the OpenAI-compatible adapter.
// Pins the exact message shapes that openai-compatible gateways accept:
// - assistant messages on tool-call turns carry `content: ""` (string), never
//   `null` — null permanently 400s strict gateways ("invalid message content
//   type: <nil>"), and the pre-agentcore runtime always sent "".
// - tool results are plain string content with their tool_call_id.
// - system messages ride as role:"system" strings.
import test from "node:test";
import assert from "node:assert/strict";

const { createOpenAICompatClient } = await import("../dist-electron/agentcore/llm/openai-compat.js");
const { userMsg, assistantMsg, toolMsg } = await import("../dist-electron/agentcore/messages.js");

const SSE = (payload) =>
  new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });

function sseChunk(delta, finishReason) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason ?? null }] })}\n\n`;
}

test("openai wire: assistant tool-call turns send content \"\" — never null", async () => {
  const bodies = [];
  const originalFetch = globalThis.fetch;
  let turn = 0;
  globalThis.fetch = async (_url, init) => {
    turn++;
    bodies.push(JSON.parse(init.body));
    if (turn === 1) {
      return SSE(
        sseChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"file_path"' } }] }) +
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: ': "src/a.ts"}' } }] }) +
        sseChunk({}, "tool_calls") +
        "data: [DONE]\n"
      );
    }
    return SSE(sseChunk({ content: "done" }) + sseChunk({}, "stop") + "data: [DONE]\n");
  };
  try {
    const client = createOpenAICompatClient({
      providerId: "t", label: "T", apiKey: "k", model: "m", baseUrl: "https://api.example.com/v1",
    });
    // Turn 1: model requests a tool call.
    let toolCalls = [];
    for await (const event of client.stream({ messages: [userMsg("hello")] })) {
      if (event.type === "done") toolCalls = event.toolCalls;
    }
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].args.file_path, "src/a.ts");
    // Turn 2: replay with the tool result appended.
    let answer = "";
    for await (const event of client.stream({
      messages: [
        userMsg("hello"),
        assistantMsg("", toolCalls),
        toolMsg("call_1", "file body", "read_file"),
      ],
    })) {
      if (event.type === "text") answer += event.delta;
    }
    assert.equal(answer, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Turn 1: assistant with tool calls.
  const first = bodies[0].messages[0];
  assert.equal(first.role, "user");
  assert.equal(typeof first.content, "string");

  // Turn 2 replays the assistant tool-call turn: content must be "" (string).
  const assistant = bodies[1].messages[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "");
  assert.ok(!("content" in assistant) || assistant.content !== null);
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { file_path: 'src/a.ts' });

  // Turn 2's tool result: string content + tool_call_id.
  const toolResult = bodies[1].messages[2];
  assert.equal(toolResult.role, "tool");
  assert.equal(toolResult.tool_call_id, "call_1");
  assert.equal(typeof toolResult.content, "string");
});

test("openai wire: pre-built assistant/tool messages keep their shapes", () => {
  // Sanity: the internal ChatMessage factories produce shapes the wire mapper
  // accepts without inventing nulls.
  const assistant = assistantMsg("", [{ id: "c1", name: "t", args: { a: 1 } }]);
  const result = toolMsg("c1", "result text", "t");
  assert.equal(assistant.content, "");
  assert.equal(typeof result.content, "string");
  assert.equal(result.toolCallId, "c1");
});

test("openai wire: gateway dialects — message-final chunk, delta.text, part {content}", async () => {
  const { createOpenAICompatClient: createClient } = await import("../dist-electron/agentcore/llm/openai-compat.js");
  const { userMsg: um } = await import("../dist-electron/agentcore/messages.js");

  // Dialect 1: gateway sends the final chunk as a whole message (no delta).
  let client = createClient({ providerId: "t", label: "T", apiKey: "k", model: "m", baseUrl: "https://api.example.com/v1" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    'data: {"choices":[{"message":{"role":"assistant","content":"final whole-message answer"}}],"finish_reason":null}\n\n' +
    'data: [DONE]\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  try {
    let text = "";
    for await (const event of client.stream({ messages: [um("hi")] })) {
      if (event.type === "text") text += event.delta;
    }
    assert.equal(text, "final whole-message answer", "whole-message final chunk must be extracted");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Dialect 2: legacy delta.text + content parts carrying {content}.
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"text":"legacy "}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":[{"type":"text","content":"part-content"}]}}]}\n\n' +
    'data: [DONE]\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
  try {
    let text = "";
    for await (const event of client.stream({ messages: [um("hi")] })) {
      if (event.type === "text") text += event.delta;
    }
    assert.equal(text, "legacy part-content", "delta.text and {content} parts must be extracted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
