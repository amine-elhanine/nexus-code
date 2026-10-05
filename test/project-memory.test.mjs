// Code-mode memory parity: entry-based rolling logs (appendEntryLog),
// boundary-aware prompt tails (tailEntries), the memory item cap
// (capMemoryItems), and the project facts store (updateProjectFacts RMW +
// persistence + parallel-merge safety).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendEntryLog } from "../dist-electron/agent-service.js";
import { tailEntries } from "../dist-electron/agent-prompt.js";
import { addMemoryFact, capMemoryItems, parseHomeMemory } from "../dist-electron/home-memory-service.js";

test("appendEntryLog: keeps whole entries, never cuts mid-entry", () => {
  const separator = "\n\n";
  const existing = "aaaa\n\nbbbb\n\ncccc";
  const out = appendEntryLog(existing, "dddd", { maxEntries: 10, maxChars: 14, separator });
  // 14 chars fits "dddd" (4) + "cccc" (4) + separator (2) = 10; "bbbb" would exceed.
  assert.ok(!out.includes("aaaa"));
  assert.ok(!out.includes("bbbb"), "older entries are dropped WHOLE");
  assert.ok(out.includes("cccc") && out.includes("dddd"));
  // Every surviving entry is intact — no fragment at the start.
  assert.equal(out.split(separator).every((p) => p.length > 0), true);
});

test("appendEntryLog: entry cap and separator handling", () => {
  const out = appendEntryLog("one\ntwo", "three", { maxEntries: 2, maxChars: 1000, separator: "\n" });
  assert.equal(out, "two\nthree");
  // Legacy strings with pre-existing fragments roll out as entries age.
  const spaced = appendEntryLog("", "first", { maxEntries: 3, maxChars: 1000, separator: "\n\n" });
  assert.equal(spaced, "first");
  assert.equal(appendEntryLog(undefined, "solo", { maxEntries: 3, maxChars: 1000, separator: "\n" }), "solo");
});

test("tailEntries: drops oldest whole entries instead of char-cutting", () => {
  const value = ["e".repeat(30), "f".repeat(30), "g".repeat(30)].join("\n\n");
  const out = tailEntries(value, 64);
  assert.ok(out.length <= 64 + "…[older memory trimmed]\n".length);
  assert.ok(out.includes("g".repeat(30)), "newest entry always survives");
  assert.ok(!out.includes("e".repeat(30)), "oldest dropped first");
  // Under-cap text passes through untouched.
  assert.equal(tailEntries("short", 64), "short");
  assert.equal(tailEntries(undefined, 64), "");
  // Single giant entry falls back to the char tail rather than vanishing.
  const huge = "h".repeat(100);
  const fallback = tailEntries(huge, 50);
  assert.ok(fallback.includes("h".repeat(30)));
});

test("capMemoryItems: evicts oldest from least-durable sections first", () => {
  let memory = "";
  for (let i = 1; i <= 30; i++) memory = addMemoryFact(memory, "context", `ctx item ${i}`);
  for (let i = 1; i <= 30; i++) memory = addMemoryFact(memory, "fact", `fact item ${i}`);
  const capped = capMemoryItems(memory, 50);
  const struct = parseHomeMemory(capped);
  const total = struct.profile.length + struct.preferences.length + struct.facts.length + struct.context.length;
  assert.equal(total, 50, "cap enforced across tracked sections");
  assert.equal(struct.context.length, 20, "overage evicted from context first (oldest 10)");
  assert.deepEqual(struct.context.slice(0, 2), ["ctx item 11", "ctx item 12"], "oldest context items evicted, order preserved");
  assert.equal(struct.context[struct.context.length - 1], "ctx item 30", "remaining context items kept");
  assert.equal(struct.facts.length, 30, "facts untouched while context still covers the overage");
  // Cross-section eviction: the context section is drained first (all 5 cover
  // the 5-item overage), so facts stay fully intact here.
  let memory2 = "";
  for (let i = 1; i <= 5; i++) memory2 = addMemoryFact(memory2, "context", `c2 item ${i}`);
  for (let i = 1; i <= 50; i++) memory2 = addMemoryFact(memory2, "fact", `f2 item ${i}`);
  const capped2 = capMemoryItems(memory2, 50);
  const struct2 = parseHomeMemory(capped2);
  assert.equal(struct2.context.length, 0, "context drained first");
  assert.equal(struct2.facts.length, 50);
  assert.deepEqual(struct2.facts.slice(0, 2), ["f2 item 1", "f2 item 2"]);
  assert.equal(struct2.facts[struct2.facts.length - 1], "f2 item 50");
  // Facts eviction requires the overage to exceed the context section.
  let memory3 = "";
  for (let i = 1; i <= 2; i++) memory3 = addMemoryFact(memory3, "context", `c3 item ${i}`);
  for (let i = 1; i <= 51; i++) memory3 = addMemoryFact(memory3, "fact", `f3 item ${i}`);
  const capped3 = capMemoryItems(memory3, 50);
  const struct3 = parseHomeMemory(capped3);
  assert.equal(struct3.context.length, 0);
  assert.deepEqual(struct3.facts.slice(0, 2), ["f3 item 2", "f3 item 3"], "overage beyond context evicts oldest facts (2 ctx + 1 fact)");
  // Under the cap: no-op, formatting stable.
  assert.equal(capMemoryItems("## Remembered Facts\n- alpha", 50).includes("alpha"), true);
});

// Store-level tests run against a scratch APPDATA (statePath() reads the env
// per call in plain node) so the real user's nexus-state.json is never touched.
test("updateProjectFacts: locked RMW, persistence, and parallel-merge safety", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-facts-"));
  process.env.APPDATA = scratch;
  const { upsertProject, updateProjectFacts, getProject } = await import("../dist-electron/store.js");
  try {
    const project = await upsertProject({ name: "facts-project", root: path.join(scratch, "repo") });
    assert.equal(project.facts, "", "new projects start with empty facts");

    // Basic mutate + returned record carries the new facts.
    const afterAdd = await updateProjectFacts(project.id, (current) => addMemoryFact(current, "fact", "tests need DATABASE_URL"));
    assert.ok(afterAdd.facts.includes("tests need DATABASE_URL"));
    assert.ok(afterAdd.facts.includes("## Remembered Facts"));

    // Persisted to disk (not just the in-memory cache).
    const stateFile = path.join(scratch, "nexus", "nexus-state.json");
    const onDisk = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const diskProject = onDisk.projects.find((p) => p.id === project.id);
    assert.ok(diskProject.facts.includes("tests need DATABASE_URL"), "facts survive persist");

    // Two concurrent mutations must MERGE (serialized queue re-reads current
    // state inside each run), not last-writer-wins.
    const [a, b] = await Promise.all([
      updateProjectFacts(project.id, (current) => addMemoryFact(current, "context", "migration pending on orders table")),
      updateProjectFacts(project.id, (current) => addMemoryFact(current, "preference", "user prefers vitest")),
    ]);
    const merged = await getProject(project.id);
    assert.ok(a.facts.includes("migration pending"));
    assert.ok(b.facts.includes("user prefers vitest"));
    assert.ok(merged.facts.includes("migration pending on orders table"), "first concurrent fact survived");
    assert.ok(merged.facts.includes("user prefers vitest"), "second concurrent fact survived");

    // Direct assignment (the Memory tab path) replaces wholesale.
    await updateProjectFacts(project.id, () => "## Remembered Facts\n- hand-edited fact");
    const replaced = await getProject(project.id);
    assert.equal(replaced.facts, "## Remembered Facts\n- hand-edited fact");
    assert.ok(!replaced.facts.includes("user prefers vitest"), "hand edit is authoritative");
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
