// Regression test: a mid-run provider failure must resume the agent from the
// furthest complete loop step (checkpoint), not restart the task. Runs against
// the real agentcore loop with a scripted client that throws the exact 429.
import assert from "node:assert/strict";
import { userMsg } from "../dist-electron/agentcore/messages.js";
import { runAgentLoop } from "../dist-electron/agentcore/loop.js";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint } from "../dist-electron/rate-limit.js";

const rateLimitError = () =>
  Object.assign(new Error("429 The service may be temporarily overloaded, please try again later"), { status: 429 });

const echoTool = {
  name: "echo",
  description: "echoes text",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (args) => `echo:${args.text}`,
};

// Script: step 1 calls the tool, step 2 calls it again, step 3 throws the 429
// mid-stream, then the model answers. .calls records every invocation so we
// can see whether attempt 2 resumed or restarted.
class ScriptedClient {
  constructor() {
    this.calls = [];
    this.script = [];
  }
  push(fn) {
    this.script.push(fn);
    return this;
  }
  async *stream(request) {
    // Snapshot: runMessages is mutated in place by the loop, so a live
    // reference would make every call look like the final state.
    this.calls.push({ messages: [...request.messages] });
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    const outcome = step();
    if (outcome instanceof Error) throw outcome;
    if (outcome && typeof outcome === "object" && outcome.toolCall) {
      yield { type: "tool_call", id: outcome.toolCall.id, name: outcome.toolCall.name, argsDelta: JSON.stringify(outcome.toolCall.args) };
      yield { type: "done", text: "", toolCalls: [outcome.toolCall], stopReason: "tool" };
      return;
    }
    yield { type: "text", delta: String(outcome) };
    yield { type: "done", text: String(outcome), toolCalls: [], stopReason: "stop" };
  }
  async complete(request) {
    let text = "";
    for await (const event of this.stream(request)) {
      if (event.type === "text") text += event.delta;
    }
    return { text, toolCalls: [], stopReason: "stop" };
  }
}

const client = new ScriptedClient();
client.push(() => ({ toolCall: { id: "c1", name: "echo", args: { text: "one" } } }));
client.push(() => ({ toolCall: { id: "c2", name: "echo", args: { text: "two" } } }));
client.push(() => rateLimitError());
client.push(() => "final answer");

let runMessages = [userMsg("do the task")];
const progress = createProgressTracker();
const toolCallsSeen = [];

const consumeStream = async () => {
  progress.beginAttempt(runMessages.length);
  for await (const event of runAgentLoop({
    client,
    system: "test",
    messages: runMessages,
    tools: [echoTool],
    stepBudget: 12,
    onEvent: (event) => {
      if (event.type === "tool_call") toolCallsSeen.push([event.call?.args?.text]);
    },
  })) {
    void event;
  }
  return "done";
};

const retries = [];
const result = await withRateLimitRetry(consumeStream, {
  madeProgress: () => progress.madeProgress(),
  onRetry: (info) => retries.push({ attempt: info.attempt, reset: info.reset }),
});

console.log("result:", result);
console.log("retries:", JSON.stringify(retries));
console.log("tool calls emitted to UI:", JSON.stringify(toolCallsSeen));
console.log("model invocations:", client.calls.length);
client.calls.forEach((c, i) => console.log(`  call ${i + 1}: ${c.messages.length} messages`));

assert.equal(result, "done");
// The critical assertion: attempt 2 must NOT restart from the original
// 1-message input. If it resumes, the model's 4th invocation (first of
// attempt 2) starts from >= 5 messages (user + 2x[assistant,tool]), not 1-2.
const attempt2First = client.calls[3];
assert.ok(
  attempt2First && attempt2First.messages.length >= 5,
  `attempt 2 appears to have RESTARTED (first invocation saw ${attempt2First?.messages.length} messages) instead of resuming from the checkpoint`
);
console.log("\nPASS: retry resumed from checkpoint — attempt 2 continued from step 2's tool results");

// Retry-After: when the provider advertises the wait window, the retry delay
// must honor it instead of using pure exponential backoff.
{
  const { parseRetryAfterMs } = await import("../dist-electron/rate-limit.js");

  // Header form (seconds).
  const secondsError = Object.assign(new Error("429 rate limit exceeded"), {
    status: 429,
    headers: { "retry-after": "7" },
  });
  assert.equal(parseRetryAfterMs(secondsError), 7000);

  // HTTP-date form.
  const future = new Date(Date.now() + 5000).toUTCString();
  const dateError = Object.assign(new Error("429 rate limit exceeded"), {
    status: 429,
    headers: { "Retry-After": future },
  });
  const dateMs = parseRetryAfterMs(dateError);
  assert.ok(dateMs !== null && dateMs > 3000 && dateMs <= 5000, `HTTP-date Retry-After parsed to ${dateMs}ms`);

  // Nonsense header -> null (fall back to exponential backoff).
  assert.equal(parseRetryAfterMs(Object.assign(new Error("x"), { headers: { "retry-after": "soon" } })), null);
  // No header at all -> null.
  assert.equal(parseRetryAfterMs(new Error("429")), null);
  // Capped at 120s so a hostile header cannot stall the run.
  assert.equal(parseRetryAfterMs(Object.assign(new Error("x"), { headers: { "retry-after": "99999" } })), 120000);

  // End-to-end: the retry uses the advertised delay, not the default base.
  const delays = [];
  let calls = 0;
  await withRateLimitRetry(
    async () => {
      calls++;
      if (calls === 1) throw secondsError;
      return "ok";
    },
    { baseDelayMs: 60_000, onRetry: (info) => delays.push(info.delayMs) }
  );
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
  assert.equal(delays[0], 7000, `retry should wait 7000ms per Retry-After, got ${delays[0]}`);
}

console.log("\nAll checkpoint-resume checks passed.");
