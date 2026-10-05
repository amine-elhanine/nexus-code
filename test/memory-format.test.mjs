// Renderer-side memory parsers (memory-format.ts) — direct src import,
// node 24 strips types natively (same pattern as chart-blocks.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { parseMemorySections, parseWorkLog } from "../src/utils/memory-format.ts";

test("parseMemorySections: parses the backend's section format", () => {
  const raw = [
    "## User Profile",
    "- backend engineer, owns the payments service",
    "",
    "## Preferences",
    "- vitest, never jest",
    "",
    "## Remembered Facts",
    "- tests need DATABASE_URL set",
    "",
    "## Project Context",
    "- v2 migration in progress",
  ].join("\n");
  const parsed = parseMemorySections(raw);
  assert.deepEqual(parsed.profile, ["backend engineer, owns the payments service"]);
  assert.deepEqual(parsed.preferences, ["vitest, never jest"]);
  assert.deepEqual(parsed.facts, ["tests need DATABASE_URL set"]);
  assert.deepEqual(parsed.context, ["v2 migration in progress"]);
});

test("parseMemorySections: dedupes case-insensitively and skips stray bullets", () => {
  const raw = "## Remembered Facts\n- Alpha\n- alpha\n- 12\nrandom prose line\n- Beta";
  const parsed = parseMemorySections(raw);
  assert.deepEqual(parsed.facts, ["Alpha", "12", "Beta"]);
});

test("parseMemorySections: empty and headerless input", () => {
  assert.deepEqual(parseMemorySections(""), { profile: [], preferences: [], facts: [], context: [] });
  assert.deepEqual(parseMemorySections(undefined), { profile: [], preferences: [], facts: [], context: [] });
  // Unknown sections and loose legacy text contribute nothing (display-only parser).
  assert.deepEqual(parseMemorySections("## Custom Notes\n- thing").facts, []);
});

test("parseWorkLog: parses Recent/Interrupted entries, skips other lines", () => {
  const raw = [
    "Recent work (2026-10-04): fix login redirect → patched AuthGate.tsx, typecheck green",
    "Interrupted work (2026-10-03): refactor parser; resumable via continue",
    "Task: something else that is not a work-log line",
    "",
    "Recent work (2026-10-01): scaffold Vite app → build passes",
  ].join("\n");
  const entries = parseWorkLog(raw);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "work");
  assert.equal(entries[0].date, "2026-10-04");
  assert.ok(entries[0].text.includes("fix login redirect"));
  assert.equal(entries[1].kind, "interrupted");
  assert.equal(entries[2].date, "2026-10-01");
});

test("parseWorkLog: empty input", () => {
  assert.deepEqual(parseWorkLog(""), []);
  assert.deepEqual(parseWorkLog(undefined), []);
});
