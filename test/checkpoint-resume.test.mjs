// Regression test: a mid-run provider failure must resume the agent from the
// furthest complete superstep (checkpoint), not restart the task. Runs against
// the real deepagents stack with a scripted model that throws the exact 429.
import assert from "node:assert/strict";
import { createDeepAgent } from "deepagents";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { withRateLimitRetry, createProgressTracker, sanitizeResumeCheckpoint } from "../dist-electron/rate-limit.js";

const rateLimitError = () =>
  Object.assign(new Error("429 The service may be temporarily overloaded, please try again later"), { status: 429 });

const tool = {
  name: "echo",
  description: "echoes text",
  invoke: async (args) => `echo:${args.text}`,
};

// Script: superstep 1 calls the tool, superstep 2 calls it again, superstep 3
// throws the 429 mid-superstep, then the model answers. .calls records every
// invocation so we can see whether attempt 2 resumed or restarted.
const model = fakeModel()
  .respondWithTools([{ name: "echo", args: { text: "one" }, id: "c1" }])
  .respondWithTools([{ name: "echo", args: { text: "two" }, id: "c2" }])
  .respond(rateLimitError())
  .respond(new AIMessage("final answer"));

const deepAgent = await createDeepAgent({
  model,
  tools: [tool],
  systemPrompt: "test",
});

let runMessages = [new HumanMessage("do the task")];
const progress = createProgressTracker();
const toolCallsSeen = [];

const consumeStream = async () => {
  let finalMessages = [];
  progress.beginAttempt(runMessages.length);
  const stream = await deepAgent.stream(
    { messages: runMessages },
    { streamMode: ["values", "updates", "messages"], recursionLimit: 25 }
  );
  try {
    for await (const item of stream) {
      const [streamMode, payload] = Array.isArray(item) ? item : ["values", item];
      if (streamMode === "values" && Array.isArray(payload?.messages)) {
        finalMessages = payload.messages;
        progress.noteSuperstep(payload.messages.length);
        continue;
      }
      if (streamMode === "updates" && payload && typeof payload === "object") {
        for (const delta of Object.values(payload)) {
          for (const message of delta?.messages ?? []) {
            if (Array.isArray(message?.tool_calls)) {
              toolCallsSeen.push(message.tool_calls.map((c) => c?.args?.text));
            }
          }
        }
      }
    }
  } catch (error) {
    if (finalMessages.length > 0) runMessages = sanitizeResumeCheckpoint(finalMessages);
    throw error;
  }
  if (finalMessages.length > 0) runMessages = finalMessages;
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
console.log("model invocations:", model.callCount);
model.calls.forEach((c, i) => console.log(`  call ${i + 1}: ${c.messages.length} messages`));

assert.equal(result, "done");
// The critical assertion: attempt 2 must NOT restart from the original
// 1-message input. If it resumes, the model's 4th invocation (first of attempt 2)
// starts from >= 5 messages (system + human + 2x[ai,tool]), not 1-2.
const attempt2First = model.calls[3];
assert.ok(
  attempt2First && attempt2First.messages.length >= 5,
  `attempt 2 appears to have RESTARTED (first invocation saw ${attempt2First?.messages.length} messages) instead of resuming from the checkpoint`
);
console.log("\nPASS: retry resumed from checkpoint — attempt 2 continued from superstep 2's tool results");

// Retry-After: when the provider advertises the wait window, the retry delay
// must honor it instead of using pure exponential backoff.
{
  const { withRateLimitRetry, parseRetryAfterMs } = await import("../dist-electron/rate-limit.js");

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
  console.log("PASS: Retry-After header drives the retry delay (7000ms honored, backoff base 60000ms ignored)");
}
