// Unit tests for the shared agent-streaming event pipeline
// (src/state/agentEventPipeline.ts) — the skeleton previously duplicated
// line-for-line between useAppController and useHomeController and drifting.
//
// Runs through scripts/run-renderer-tests.mjs, which bundles the TS module
// with rolldown; assertions here are plain node asserts.
import assert from "node:assert/strict";
import { createAgentEventSink, THINKING_DISPLAY_CAP } from "../../src/state/agentEventPipeline.js";

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

/** Build a sink with recording stubs for every callback. */
function makeSink(extra = {}) {
  const calls = {
    liveEvents: {},
    streamingTokens: [],
    streamingCleared: 0,
    contextItems: [],
    customEvents: [],
    finals: [],
    reconciles: [],
    runEnded: [],
  };
  const liveEventsRef = { current: {} };
  const thinkingAccRef = { current: {} };
  const activeSessionRef = { current: { id: "s1" } };
  const sink = createAgentEventSink({
    liveEventsRef,
    thinkingAccRef,
    activeSessionRef,
    setLiveEvents: (next) => { calls.liveEvents = next; },
    appendStreamingToken: (delta) => { calls.streamingTokens.push(delta); },
    clearStreamingText: () => { calls.streamingCleared++; },
    onContextItem: (bucket, item) => { calls.contextItems.push([bucket, item]); },
    onCustomEvent: (event) => { calls.customEvents.push(event); return extra.interceptCustom === true; },
    onFinal: (bucket, event, log) => { calls.finals.push([bucket, event, log]); },
    reconcile: (bucket, event, log) => { calls.reconciles.push([bucket, event, log]); },
    onRunEnded: (bucket) => { calls.runEnded.push(bucket); },
    ...extra.deps,
  });
  return { sink, calls, liveEventsRef, thinkingAccRef, activeSessionRef };
}

const ev = (type, overrides = {}) => ({
  type, sessionId: "s1", text: `text-${type}`, timestamp: "2026-11-12T00:00:00Z", ...overrides,
});

await test("thinking deltas fold into ONE live step per session (capped tail)", () => {
  const { sink, calls, liveEventsRef } = makeSink();
  for (let i = 0; i < 5; i++) sink(ev("thinking", { text: `chunk${i} ` }));
  const log = liveEventsRef.current.s1;
  assert.equal(log.length, 1, "one thinking step, not five rows");
  assert.equal(log[0].kind, "thinking");
  assert.ok(log[0].text.startsWith("chunk0"), "accumulates from the start when under cap");
  assert.ok(log[0].text.trim().endsWith("chunk4"), "latest chunk present");
  // Overflow: pushing past the cap keeps only the tail.
  sink(ev("thinking", { text: "x".repeat(THINKING_DISPLAY_CAP + 500) }));
  const text = liveEventsRef.current.s1[0].text;
  assert.ok(text.length <= THINKING_DISPLAY_CAP, "capped to THINKING_DISPLAY_CAP");
});

await test("tokens stream only for the active session", () => {
  const { sink, calls } = makeSink();
  sink(ev("token", { text: "hello " }));
  sink(ev("token", { sessionId: "other", text: "ignored " }));
  assert.deepEqual(calls.streamingTokens, ["hello "]);
});

await test("tool/status/plan clears pre-tool text and closes the thinking burst", () => {
  const { sink, calls, liveEventsRef } = makeSink();
  sink(ev("thinking", { text: "reasoning part 1" }));
  sink(ev("tool"));
  assert.equal(calls.streamingCleared, 1, "speculative pre-tool text cleared");
  sink(ev("thinking", { text: "reasoning part 2" }));
  const log = liveEventsRef.current.s1;
  // Tool events also push their own log row (original behavior) — the point
  // is that the thinking delta after the tool starts a FRESH step.
  assert.equal(log.length, 3, "thinking1 + tool row + thinking2");
  assert.equal(log[0].text, "reasoning part 1");
  assert.equal(log[1].kind, "tool");
  assert.equal(log[2].text, "reasoning part 2");
});

await test("context events append to the session transcript and the live log", () => {
  const { sink, calls, liveEventsRef } = makeSink();
  sink(ev("context"));
  assert.equal(calls.contextItems.length, 1);
  assert.equal(calls.contextItems[0][0], "s1");
  assert.equal(calls.liveEvents.s1.length, 1);
  assert.equal(calls.liveEvents.s1[0].kind, "context");
});

await test("assistant event drops the live log, folds via onFinal, reconciles", () => {
  const { sink, calls, liveEventsRef } = makeSink();
  sink(ev("thinking", { text: "some reasoning" }));
  sink(ev("tool"));
  sink(ev("assistant", { text: "final answer", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCost: null } }));
  assert.deepEqual(Object.keys(liveEventsRef.current), [], "live log for the session is dropped");
  assert.equal(calls.streamingCleared >= 1, true);
  assert.deepEqual(calls.runEnded, ["s1"]);
  const [bucket, event, log] = calls.finals[0];
  assert.equal(bucket, "s1");
  assert.equal(event.text, "final answer");
  assert.equal(log.length, 2, "onFinal receives the accumulated live log");
  assert.equal(calls.reconciles.length, 1);
  assert.deepEqual(calls.liveEvents, {}, "live events state cleared");
});

await test("error event takes the same final path as assistant", () => {
  const { sink, calls } = makeSink();
  sink(ev("error", { text: "boom" }));
  assert.equal(calls.finals[0][1].type, "error");
  assert.equal(calls.reconciles.length, 1);
});

await test("onCustomEvent returning true intercepts before the default push", () => {
  const { sink, calls, liveEventsRef } = makeSink({ interceptCustom: true });
  sink(ev("artifact", { artifact: { filename: "x.pptx" } }));
  assert.equal(calls.customEvents.length, 1);
  assert.equal(liveEventsRef.current.s1, undefined, "event was fully handled by the controller");
});

await test("events from an unknown-shaped session still accumulate (bucket fallback)", () => {
  const { sink, liveEventsRef } = makeSink();
  sink({ ...ev("status"), sessionId: undefined });
  assert.ok(liveEventsRef.current.unknown, "falls into the 'unknown' bucket");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
