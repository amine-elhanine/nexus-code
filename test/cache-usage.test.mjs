// Tests for prompt-cache token accounting in the streaming usage tracker
// (electron/context-service.ts) — the data behind the context-bar hover
// card's "Cache Hit Rate" row. Protocol adapters normalize each provider's
// wire shape into one usage object per model invocation; the tracker sums
// invocations and carries cacheRead/cacheCreation for the hit-rate row.
import test from "node:test";
import assert from "node:assert/strict";

const { StreamUsageTracker } = await import("../dist-electron/context-service.js");

test("cache usage: usage without cache accounting defaults to zero", () => {
  const tracker = new StreamUsageTracker();
  tracker.noteUsage({ inputTokens: 1_000, outputTokens: 100 });
  assert.equal(tracker.cacheReadTokens, 0);
  assert.equal(tracker.cacheCreationTokens, 0);
});

test("cache usage: tracker sums per-invocation usage and cache totals", () => {
  const tracker = new StreamUsageTracker();
  // Invocation 1 (Anthropic adapter shape: input INCLUSIVE of cached subset).
  tracker.noteUsage({ inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 8_000, cacheCreationTokens: 1_000 });
  // Invocation 2 (context grew, cache grew with it).
  tracker.noteUsage({ inputTokens: 15_000, outputTokens: 200, cacheReadTokens: 12_000, cacheCreationTokens: 1_500 });
  assert.equal(tracker.inputTokens, 25_000);
  assert.equal(tracker.outputTokens, 300);
  assert.equal(tracker.cacheReadTokens, 20_000);
  assert.equal(tracker.cacheCreationTokens, 2_500);
  // Hit rate the hover card computes: 20k of 25k input from cache.
  assert.equal(tracker.cacheReadTokens / tracker.inputTokens, 0.8);
});

test("cache usage: empty/absent usage payloads are ignored", () => {
  const tracker = new StreamUsageTracker();
  tracker.noteUsage(undefined);
  tracker.noteUsage({ inputTokens: 0, outputTokens: 0 });
  tracker.noteUsage({});
  assert.equal(tracker.inputTokens, 0);
  assert.equal(tracker.sawExactInput, false);
  assert.equal(tracker.sawExactOutput, false);
});

test("cache usage: lastObservedInputTokens tracks the largest single-call input", () => {
  const tracker = new StreamUsageTracker();
  tracker.noteUsage({ inputTokens: 10_000, outputTokens: 100 });
  tracker.noteUsage({ inputTokens: 15_000, outputTokens: 200 });
  tracker.noteUsage({ inputTokens: 12_000, outputTokens: 50 });
  assert.equal(tracker.lastObservedInputTokens, 15_000);
  assert.equal(tracker.sawExactInput, true);
  assert.equal(tracker.sawExactOutput, true);
});

test("cache usage: addTotals folds subagent aggregates on top", () => {
  const tracker = new StreamUsageTracker();
  tracker.noteUsage({ inputTokens: 1_000, outputTokens: 100 });
  tracker.addTotals(500, 50);
  assert.equal(tracker.inputTokens, 1_500);
  assert.equal(tracker.outputTokens, 150);
});
