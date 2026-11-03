// Tests for prompt-cache token extraction in the streaming usage tracker
// (electron/context-service.ts) — the data behind the context-bar hover
// card's "Cache Hit Rate" row. Providers report cached input tokens in
// different shapes; all must normalize into cacheReadTokens/cacheCreation.
import test from "node:test";
import assert from "node:assert/strict";

const { extractStreamUsage, StreamUsageTracker } = await import("../dist-electron/context-service.js");

test("cache usage: LangChain standard usage_metadata.input_token_details (Anthropic + OpenAI)", () => {
  const usage = extractStreamUsage({
    id: "msg_1",
    usage_metadata: {
      input_tokens: 10_000, // INCLUSIVE of cached subset on both providers
      output_tokens: 500,
      total_tokens: 10_500,
      input_token_details: { cache_read: 8_000, cache_creation: 1_000 },
    },
  });
  assert.equal(usage.inputTokens, 10_000);
  assert.equal(usage.cacheReadTokens, 8_000);
  assert.equal(usage.cacheCreationTokens, 1_000);
});

test("cache usage: legacy Anthropic raw usage fields", () => {
  const usage = extractStreamUsage({
    id: "msg_2",
    additional_kwargs: {
      usage: { input_tokens: 5_000, output_tokens: 200, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 500 },
    },
  });
  assert.equal(usage.cacheReadTokens, 4_000);
  assert.equal(usage.cacheCreationTokens, 500);
});

test("cache usage: legacy OpenAI prompt_tokens_details.cached_tokens", () => {
  const usage = extractStreamUsage({
    id: "msg_3",
    response_metadata: {
      tokenUsage: { prompt_tokens: 6_000, completion_tokens: 100, total_tokens: 6_100, prompt_tokens_details: { cached_tokens: 2_500 } },
    },
  });
  assert.equal(usage.cacheReadTokens, 2_500);
  assert.equal(usage.cacheCreationTokens, 0);
});

test("cache usage: usage without cache accounting defaults to zero", () => {
  const usage = extractStreamUsage({
    id: "msg_4",
    usage_metadata: { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 },
  });
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.cacheCreationTokens, 0);
});

test("cache usage: tracker collapses cumulative per-message cache totals and sums across invocations", () => {
  const tracker = new StreamUsageTracker();
  // Invocation 1: Anthropic-style repeated cumulative chunks under one id.
  tracker.noteChunk({ id: "run1", usage_metadata: { input_tokens: 10_000, output_tokens: 100, total_tokens: 10_100, input_token_details: { cache_read: 8_000, cache_creation: 1_000 } } });
  tracker.noteChunk({ id: "run1", usage_metadata: { input_tokens: 10_000, output_tokens: 100, total_tokens: 10_100, input_token_details: { cache_read: 8_000, cache_creation: 1_000 } } });
  // Invocation 2 (context grew, cache grew with it).
  tracker.noteChunk({ id: "run2", usage_metadata: { input_tokens: 15_000, output_tokens: 200, total_tokens: 15_200, input_token_details: { cache_read: 12_000, cache_creation: 1_500 } } });
  assert.equal(tracker.inputTokens, 25_000);
  assert.equal(tracker.cacheReadTokens, 20_000);
  assert.equal(tracker.cacheCreationTokens, 2_500);
  // Hit rate the hover card computes: 20k of 25k input from cache.
  assert.equal(tracker.cacheReadTokens / tracker.inputTokens, 0.8);
});
