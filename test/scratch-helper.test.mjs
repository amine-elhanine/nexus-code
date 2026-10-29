// Tests for the shared scratch-directory helper (test/helpers/scratch.mjs).
// The helper is what lets the suite run on restricted Windows environments,
// so its own contract gets explicit coverage: env-var override, unique
// subdirectories, and safe cleanup.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const { scratchBase, mkdirScratch, mkdirScratchSync, removeScratch } = await import("./helpers/scratch.mjs");

test("scratchBase resolves an existing writable directory", async () => {
  const base = await scratchBase();
  assert.equal(typeof base, "string");
  assert.equal(existsSync(base), true, `scratch base should exist: ${base}`);
  // Must actually be writable — the helper verifies with a write probe.
  const probe = path.join(base, "scratch-helper-verify");
  await rm(probe, { recursive: true, force: true });
  const sub = await mkdtemp(path.join(base, "scratch-helper-verify-"));
  assert.equal(existsSync(sub), true);
  await rm(probe, { recursive: true, force: true });
});

test("mkdirScratch creates unique subdirectories under the base", async () => {
  const base = await scratchBase();
  const a = await mkdirScratch("scratch-helper-a-");
  const b = await mkdirScratch("scratch-helper-b-");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(base), `child ${a} should live under base ${base}`);
  assert.ok(b.startsWith(base), `child ${b} should live under base ${base}`);
  assert.equal(existsSync(a), true);
  assert.equal(existsSync(b), true);
  await removeScratch(a);
  await removeScratch(b);
  assert.equal(existsSync(a), false, "removeScratch should remove trees");
});

test("mkdirScratchSync is synchronous and honors defaults", async () => {
  const dir = mkdirScratchSync("scratch-helper-sync-");
  assert.equal(existsSync(dir), true);
  const base = await scratchBase();
  assert.ok(dir.startsWith(base));
  await removeScratch(dir);
});

test("NEXUS_TEST_SCRATCH_DIR override is honored by mkdirScratch", async () => {
  const baseBefore = await scratchBase();
  // The base is cached per process, so spawn a child to verify fresh
  // resolution honors the override.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const override = await mkdtemp(path.join(baseBefore, "scratch-helper-override-"));
  try {
    const scriptPath = path.join(override, "check.mjs");
    // The override dir is outside the repo, so the child script needs the
    // helper's absolute location — derived from this test file's URL.
    const helperUrl = new URL("./helpers/scratch.mjs", import.meta.url).href;
    await writeFile(
      scriptPath,
      [
        `import { mkdirScratch, scratchBase } from ${JSON.stringify(helperUrl)};`,
        'const created = await mkdirScratch("nexus-override-");',
        'console.log(JSON.stringify({ created, base: await scratchBase() }));',
      ].join("\n"),
      "utf8"
    );
    const env = { ...process.env, NEXUS_TEST_SCRATCH_DIR: override };
    const result = await run(process.execPath, [scriptPath], { env });
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.ok(parsed.created.startsWith(override), `created ${parsed.created} should be under override ${override}`);
    assert.equal(parsed.base, override);
  } finally {
    await rm(override, { recursive: true, force: true });
  }
});
