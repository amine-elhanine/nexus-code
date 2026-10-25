// Regression tests for the 2026-10-24 audit fixes: binary-safe workspace
// checkpoints and undo ordering (restore survives the Nexus-commit reset).
// Plain Node against dist-electron (build:electron first).
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "../dist-electron/diff-service.js";
import { boundedExecFile } from "../dist-electron/shell-subprocess.js";

const execFileAsync = boundedExecFile;
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (error) {
    console.error(`  \u2717 ${name}`);
    console.error(error);
    failed++;
  }
}

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, timeout: 30000, maxBuffer: 1_000_000 });
}

console.log("\n=== Checkpoint Binary Safety Tests ===");

await test("undo restores a dirty binary file byte-exact (no utf8 mojibake)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-chk-bin-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "t@t");
    await git(root, "config", "user.name", "t");
    // Bytes that decode lossily as utf8: NUL + invalid high bytes + a valid
    // UTF-8 pair — the exact class the old utf8-read bug corrupted to U+FFFD.
    const binary = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xc3, 0xa9, 0x00, 0x42]);
    await fs.writeFile(path.join(root, "asset.bin"), Buffer.from([0x00, 0x01]));
    await fs.writeFile(path.join(root, "text.txt"), "line one\n", "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "initial");

    // Dirty both files, checkpoint, dirty them differently, undo.
    await fs.writeFile(path.join(root, "asset.bin"), binary);
    await fs.writeFile(path.join(root, "text.txt"), "dirty before run\n", "utf8");
    const checkpointId = `chk-${Date.now()}`;
    await createWorkspaceCheckpoint(root, checkpointId);

    await fs.writeFile(path.join(root, "asset.bin"), Buffer.from("agent wrote text", "utf8"));
    await fs.writeFile(path.join(root, "text.txt"), "agent changed it\n", "utf8");

    const ok = await restoreWorkspaceCheckpoint(root, checkpointId);
    assert.equal(ok, true);
    // Undo restores the checkpoint-time state BYTE-EXACT — the utf8-read bug
    // would have round-tripped it through U+FFFD mojibake instead.
    const restoredBinary = await fs.readFile(path.join(root, "asset.bin"));
    assert.ok(Buffer.compare(restoredBinary, binary) === 0, `binary must round-trip byte-exact, got ${restoredBinary.toString("hex")} vs ${binary.toString("hex")}`);
    assert.equal(await fs.readFile(path.join(root, "text.txt"), "utf8"), "dirty before run\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("restore keeps pre-run WIP even when the run auto-committed (reset happens before file restore)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-chk-order-"));
  try {
    await git(root, "init");
    await git(root, "config", "user.email", "t@t");
    await git(root, "config", "user.name", "t");
    await fs.writeFile(path.join(root, "tracked.txt"), "committed\n", "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "initial");
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 30000, maxBuffer: 100_000 })).stdout.trim();

    // User WIP + checkpoint taken at run start.
    await fs.writeFile(path.join(root, "tracked.txt"), "committed\nuser wip\n", "utf8");
    const checkpointId = `chk-${Date.now()}`;
    await createWorkspaceCheckpoint(root, checkpointId, { headCommit: head });

    // Agent work, then an auto-commit on the session branch (Nexus message).
    await fs.writeFile(path.join(root, "tracked.txt"), "committed\nagent edits\n", "utf8");
    await fs.writeFile(path.join(root, "new.txt"), "agent file\n", "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "Nexus auto-checkpoint");

    const ok = await restoreWorkspaceCheckpoint(root, checkpointId);
    assert.equal(ok, true);
    // The pre-run WIP must survive the hard reset that rolls the commit back.
    assert.equal(await fs.readFile(path.join(root, "tracked.txt"), "utf8"), "committed\nuser wip\n");
    // File created by the (now rolled-back) agent commit is removed.
    await assert.rejects(fs.access(path.join(root, "new.txt")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

console.log(`\ncheckpoint-binary: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
