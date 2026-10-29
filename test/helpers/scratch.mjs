// Shared scratch-directory mechanism for the test suite.
//
// Why this exists: most tests build throwaway project/home trees with
// `fs.mkdtemp(path.join(os.tmpdir(), ...))`. On Windows in restricted
// environments (relocated user profiles, locked-down CI runners, network
// TMP, or sandboxes that deny `git init` / atomic rename under the system
// temp) those calls or the operations that follow them (git init, write +
// rename "atomic write" tests) can fail with EPERM instead of sandbox
// bugs. Redirecting scratch space via the NEXUS_TEST_SCRATCH_DIR env var
// lets runners point tests at writable storage without editing suites.
//
// Resolution order for the scratch base:
//   1. NEXUS_TEST_SCRATCH_DIR env var — must exist and be writable.
//   2. os.tmpdir() — created/verified writable.
//   3. <repo>/test/.scratch — last-resort local fallback.
//
// Never weaken production behavior: this helper only manages where tests
// scratch, it does not touch atomic-write or path-containment logic.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PREFIX = "nexus-scratch-";

let cachedBase = null;

async function looksWritable(dir) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.scratch-write-probe-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Resolve (and cache) the scratch base directory for this process. */
export async function scratchBase() {
  if (cachedBase) return cachedBase;
  const candidates = [];
  const envBase = process.env.NEXUS_TEST_SCRATCH_DIR;
  if (envBase && envBase.trim()) {
    candidates.push({ label: "NEXUS_TEST_SCRATCH_DIR", dir: path.resolve(envBase.trim()) });
  }
  candidates.push({ label: "os.tmpdir()", dir: os.tmpdir() });
  candidates.push({ label: "repo fallback", dir: path.join(TEST_ROOT, ".scratch") });
  for (const candidate of candidates) {
    if (await looksWritable(candidate.dir)) {
      cachedBase = candidate.dir;
      return cachedBase;
    }
  }
  // Fail loudly with a clear instruction, guarded by a clearly-scoped
  // error message naming the env var.
  throw new Error(
    `No writable scratch directory available for tests. Tried: ${candidates.map((c) => `${c.dir} (${c.label})`).join(", ")}. ` +
    "Set NEXUS_TEST_SCRATCH_DIR to a writable directory and re-run."
  );
}

/**
 * Synchronous base resolution for tests that must create scratch state
 * before top-level awaited imports (e.g. setting NEXUS_HOME_ROOT). Applies
 * the same candidate order as scratchBase(), including the repos-local
 * fallback, using synchronous write probes.
 */
export function scratchBaseSync() {
  const candidates = [];
  const envBase = process.env.NEXUS_TEST_SCRATCH_DIR;
  if (envBase && envBase.trim()) candidates.push(path.resolve(envBase.trim()));
  candidates.push(os.tmpdir());
  candidates.push(path.join(TEST_ROOT, ".scratch"));
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.scratch-write-probe-${process.pid}`);
      writeFileSync(probe, "ok");
      rmSync(probe, { force: true });
      return dir;
    } catch { /* try next candidate */ }
  }
  throw new Error(
    `No writable scratch directory available for tests. Tried: ${candidates.join(", ")}. ` +
    "Set NEXUS_TEST_SCRATCH_DIR to a writable directory and re-run."
  );
}

/**
 * Create a unique scratch subdirectory under the resolved base, e.g.
 * `mkdirScratch("nexus-gate-auto-")` — drop-in replacement for
 * `fs.mkdtemp(path.join(os.tmpdir(), "nexus-gate-auto-"))`.
 */
export async function mkdirScratch(prefix = DEFAULT_PREFIX) {
  const base = await scratchBase();
  return mkdtemp(path.join(base, prefix || DEFAULT_PREFIX));
}

/** Synchronous variant for tests without top-level await. Does not apply
 * the last-resort repo fallback (that needs an async probe); if neither
 * the env base nor the OS temp is usable the call surfaces the raw error. */
export function mkdirScratchSync(prefix = DEFAULT_PREFIX) {
  const envBase = process.env.NEXUS_TEST_SCRATCH_DIR;
  const base = (envBase && envBase.trim() ? path.resolve(envBase.trim()) : os.tmpdir());
  return mkdtempSync(path.join(base, prefix || DEFAULT_PREFIX));
}

/**
 * Remove a scratch tree, best effort. Never throws — scratch cleanup
 * failures on Windows (EBUSY/EPERM from AV scanners) must not fail tests.
 */
export async function removeScratch(dir) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    /* best effort */
  }
}
