import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStreamUsage, StreamUsageTracker } from '../dist-electron/context-service.js';

// Chunk shapes below mirror what the installed @langchain providers actually
// emit on the "messages" stream mode (verified against the package sources).

test('extractStreamUsage reads LangChain usage_metadata', () => {
  const usage = extractStreamUsage({ usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
});

test('extractStreamUsage falls back to additional_kwargs when response_metadata has no usage', () => {
  const usage = extractStreamUsage({
    response_metadata: { model_provider: 'mistral' },
    additional_kwargs: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
  });
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

test('extractStreamUsage falls through an all-zero usage_metadata to legacy metadata', () => {
  const usage = extractStreamUsage({
    usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    additional_kwargs: { usage: { input_tokens: 7, output_tokens: 3 } },
  });
  assert.deepEqual(usage, { inputTokens: 7, outputTokens: 3, totalTokens: 0 });
});

test('extractStreamUsage returns null for chunks without usage', () => {
  assert.equal(extractStreamUsage(null), null);
  assert.equal(extractStreamUsage({ content: 'hello' }), null);
  assert.equal(extractStreamUsage({ response_metadata: { usage: undefined } }), null);
});

test('OpenAI shape: single trailing usage chunk per invocation', () => {
  const tracker = new StreamUsageTracker();
  for (const text of ['Hello', ' world', '!']) tracker.noteChunk({ id: 'chatcmpl-1', content: text });
  tracker.noteChunk({ content: '', usage_metadata: { input_tokens: 120, output_tokens: 45, total_tokens: 165 } });
  assert.equal(tracker.inputTokens, 120);
  assert.equal(tracker.outputTokens, 45);
});

test('Anthropic legacy shape: complementary message_start/message_delta chunks are summed, not duplicated', () => {
  const tracker = new StreamUsageTracker();
  tracker.noteChunk({ id: 'msg_1', content: [], usage_metadata: { input_tokens: 500, output_tokens: 1, total_tokens: 501 } });
  for (let i = 0; i < 20; i++) tracker.noteChunk({ id: 'msg_1', content: 'x' });
  tracker.noteChunk({ content: [], usage_metadata: { input_tokens: 0, output_tokens: 210, total_tokens: 210 } });
  assert.equal(tracker.inputTokens, 500);
  assert.equal(tracker.outputTokens, 211);
});

test('Groq shape: cumulative usage repeated under one message id collapses to the final value', () => {
  const tracker = new StreamUsageTracker();
  const cumulative = [
    { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    { prompt_tokens: 80, completion_tokens: 90, total_tokens: 170 },
  ];
  for (const [i, u] of cumulative.entries()) {
    tracker.noteChunk({ id: 'groq-1', content: 'x', response_metadata: { usage: u } });
    void i;
  }
  assert.equal(tracker.inputTokens, 80);
  assert.equal(tracker.outputTokens, 90);
});

test('Google shape: id-less per-chunk deltas are summed', () => {
  const tracker = new StreamUsageTracker();
  tracker.noteChunk({ content: 'a', usage_metadata: { input_tokens: 300, output_tokens: 1, total_tokens: 301 } });
  tracker.noteChunk({ content: 'b', usage_metadata: { input_tokens: 0, output_tokens: 9, total_tokens: 9 } });
  tracker.noteChunk({ content: 'c', usage_metadata: { input_tokens: 0, output_tokens: 40, total_tokens: 40 } });
  assert.equal(tracker.inputTokens, 300);
  assert.equal(tracker.outputTokens, 50);
});

test('multi-invocation runs sum usage across distinct message ids', () => {
  const tracker = new StreamUsageTracker();
  // Invocation 1: OpenAI style
  tracker.noteChunk({ id: 'call-a', content: 'working' });
  tracker.noteChunk({ content: '', usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
  // Invocation 2: OpenAI style
  tracker.noteChunk({ id: 'call-b', content: 'done' });
  tracker.noteChunk({ content: '', usage_metadata: { input_tokens: 200, output_tokens: 70, total_tokens: 270 } });
  assert.equal(tracker.inputTokens, 300);
  assert.equal(tracker.outputTokens, 120);
});

test('addTotals adds complete invocation totals (subagent usage) on top', () => {
  const tracker = new StreamUsageTracker();
  tracker.noteChunk({ content: '', usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
  tracker.addTotals(500, 90);
  assert.equal(tracker.inputTokens, 600);
  assert.equal(tracker.outputTokens, 110);
});

test('without any exact usage, totals stay zero so callers can apply fallback estimates', () => {
  const tracker = new StreamUsageTracker();
  tracker.noteChunk({ id: 'x', content: 'plain text only' });
  assert.equal(tracker.inputTokens, 0);
  assert.equal(tracker.outputTokens, 0);
  assert.equal(tracker.sawExactInput, false);
  assert.equal(tracker.sawExactOutput, false);
});
