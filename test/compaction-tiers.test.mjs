// Tests for tiered transcript compaction (electron/agent/compaction.ts) —
// microcompaction, the shrink ladder, and brief-carrying compaction.
// Parity target: OpenCode's shrink ladder + ZCode's microcompaction between
// steps. Invariants pinned here: the original request survives verbatim at
// every level, AI↔tool pairing is never broken, and the newest user turns
// keep verbatim tool results.
import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const { microcompactToolResults, shrinkToBudget, shrinkWithBrief, buildDroppedWorkDigest } = await import("../dist-electron/agent/compaction.js");
const { estimateMessagesTokens } = await import("../dist-electron/context-service.js");

// Fixture: request + 3 old tool exchanges (huge results) + recent turn (request + 2 tool exchanges).
function buildTranscript(resultChars = 4000) {
  const big = (i) => `result-${i}: ` + "x".repeat(resultChars);
  const exchange = (i) => [
    new AIMessage({ content: "", tool_calls: [{ id: `call_${i}`, name: "web_search", args: { q: `troy ${i}` } }] }),
    new ToolMessage({ content: big(i), tool_call_id: `call_${i}`, name: "web_search" }),
  ];
  return [
    new HumanMessage("Generate me a presentation about the Battle of Troy"),
    ...exchange(1), ...exchange(2), ...exchange(3),
    new HumanMessage("continue"),
    ...exchange(4), ...exchange(5),
    new HumanMessage("wrap it up soon"),
    new AIMessage("Working on the deck now."),
  ];
}

test("microcompact: old tool results become stubs, recent turns keep verbatim", () => {
  const transcript = buildTranscript();
  const { messages, cleared } = microcompactToolResults(transcript, { keepUserTurns: 2 });
  // Old exchanges (1..3) cleared; recent ones (4,5) untouched.
  assert.equal(cleared, 3);
  assert.match(String(messages[2].content), /Tool result cleared to preserve context/);
  assert.match(String(messages[2].content), /web_search/);
  assert.match(String(messages[2].content), /result-1/); // preview carries the marker
  assert.ok(String(messages[2].content).length < 400);
  assert.equal(messages[9].content, `result-4: ` + "x".repeat(4000)); // recent turn verbatim
  // Pairing preserved.
  assert.equal(messages[2].tool_call_id, "call_1");
  // Pure: input untouched.
  assert.equal(transcript[2].content, `result-1: ` + "x".repeat(4000));
});

test("microcompact: small results and results within the recent window are never touched", () => {
  const transcript = [
    new HumanMessage("task"),
    new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "ls", args: {} }] }),
    new ToolMessage({ content: "a.txt\nb.txt", tool_call_id: "c1", name: "ls" }),
  ];
  const { messages, cleared } = microcompactToolResults(transcript, { keepUserTurns: 2 });
  assert.equal(cleared, 0);
  assert.equal(messages[2].content, "a.txt\nb.txt");
});

test("microcompact: no-op when there are fewer user turns than the keep window", () => {
  const transcript = buildTranscript();
  const { messages, cleared } = microcompactToolResults(transcript, { keepUserTurns: 10 });
  assert.equal(cleared, 0);
  assert.deepEqual(messages, transcript);
});

test("shrink ladder: returns 'none' when the transcript already fits", () => {
  const small = [new HumanMessage("hi"), new AIMessage("hello")];
  const result = shrinkToBudget(small, 10_000);
  assert.equal(result.level, "none");
  assert.equal(result.messages, small);
});

test("shrink ladder: escalates through tiers and always preserves the original request + newest exchange", () => {
  // Budget small enough that trimming alone cannot fit → ladder must escalate.
  const transcript = buildTranscript(30_000);
  const totalTokens = estimateMessagesTokens(transcript);
  assert.ok(totalTokens > 20_000);
  const budget = Math.floor(totalTokens * 0.35);
  const result = shrinkToBudget(transcript, budget);
  assert.ok(["trim", "clip-outputs", "drop-outputs", "last-resort"].includes(result.level), result.level);
  assert.ok(result.tokensAfter <= budget, `after=${result.tokensAfter} budget=${budget}`);
  // Original request survives — verbatim as group 0, or inside the
  // condensation digest when the budget is too tight to keep it as-is.
  const head = String(result.messages[0].content);
  assert.match(
    head + result.messages.slice(1, 3).map((m) => String(m.content)).join(" "),
    /Generate me a presentation about the Battle of Troy/
  );
  // Newest exchange (last AI message) survives.
  assert.equal(result.messages[result.messages.length - 1].content, "Working on the deck now.");
  // Pairing: every tool message's call id still appears in some AI tool_calls.
  const callIds = new Set(result.messages.flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.id) : [])));
  for (const m of result.messages) {
    if ((m?._getType?.() ?? m?.type) === "tool") assert.ok(callIds.has(m.tool_call_id), `orphan tool result ${m.tool_call_id}`);
  }
});

test("shrink ladder: microcompact level fires when clearing alone frees enough", () => {
  // Huge old results, tiny budget only slightly below current — clearing stubs suffices.
  const transcript = buildTranscript(6_000);
  const total = estimateMessagesTokens(transcript);
  const result = shrinkToBudget(transcript, Math.floor(total * 0.75));
  assert.equal(result.level, "microcompact");
  assert.ok(result.touched > 0);
  assert.equal(result.messages[0].content, "Generate me a presentation about the Battle of Troy");
});

test("shrinkWithBrief: the journal brief always survives compaction", () => {
  const transcript = buildTranscript(30_000);
  const total = estimateMessagesTokens(transcript);
  const brief = "[Durable Home Task Context] Goal: Troy deck. Done: research. Pending: slides 4-10.";
  const result = shrinkWithBrief(transcript, Math.floor(total * 0.3), brief);
  assert.ok(result.messages.some((m) => String(m.content).includes("Durable Home Task Context")), "brief must survive");
  assert.equal(result.messages[0].content, "Generate me a presentation about the Battle of Troy");
});

test("buildDroppedWorkDigest: structured work-state lines from dropped messages", () => {
  const transcript = buildTranscript();
  const digest = buildDroppedWorkDigest(transcript.slice(0, 6));
  assert.match(digest, /Condensed earlier work/);
  assert.match(digest, /called web_search/);
  assert.match(digest, /web_search →/);
});
