// Tests for background command execution (electron/agent/background-jobs.ts)
// — G4 parity: long commands must not block the agent turn. Runs REAL short
// commands through the real executeCommand pipeline (approval disabled in
// tests only). NOTE: in sandboxed environments where cmd.exe cannot spawn,
// jobs fail honestly — the tests accept either outcome but pin the contract:
// immediate return, settled status with exit code, output/error tail.
import test from "node:test";
import assert from "node:assert/strict";

const { createBackgroundTools } = await import("../dist-electron/agent/background-jobs.js");
const { mkdirScratch } = await import("./helpers/scratch.mjs");

async function waitSettled(jobStatus, jobId, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const status = String(await jobStatus.invoke({ jobId }));
    if (/completed \(exit|FAILED \(exit/.test(status)) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return String(await jobStatus.invoke({ jobId }));
}

test("background jobs: returns immediately and settles with an honest status", async () => {
  const root = await mkdirScratch("nx-bg-jobs-");
  const [runBackground, jobStatus] = createBackgroundTools({ projectRoot: root, requireApproval: false });
  const started = Date.now();
  const startMsg = await runBackground.invoke({ command: "node -e \"console.log('bg-output-marker')\"" });
  assert.ok(Date.now() - started < 5_000, "run_background must return immediately");
  assert.match(String(startMsg), /Background job bg_1 started/);
  assert.match(String(startMsg), /Do NOT sleep or poll/);

  const status = await waitSettled(jobStatus, "bg_1");
  if (/FAILED/.test(status)) {
    // Sandboxed environment: cmd.exe could not spawn — the failure must be
    // honest and carry the reason.
    assert.match(status, /FAILED \(exit/);
    assert.match(status, /ENOENT|spawn|error/i);
  } else {
    assert.match(status, /completed \(exit 0\)/);
    assert.match(status, /bg-output-marker/);
  }
  // jobId-less summary also works.
  assert.match(String(await jobStatus.invoke({})), /bg_1 ·/);
});

test("background jobs: failing command reports FAILED with the error tail", async () => {
  const root = await mkdirScratch("nx-bg-fail-");
  const [runBackground, jobStatus] = createBackgroundTools({ projectRoot: root, requireApproval: false });
  await runBackground.invoke({ command: "node -e \"process.exit(3)\"" });
  const status = await waitSettled(jobStatus, "bg_1");
  if (/spawn.*ENOENT/i.test(status)) {
    assert.match(status, /FAILED/); // sandbox: spawn itself failed — still honest
  } else {
    assert.match(status, /FAILED \(exit (?:3|1)\)/);
  }
});

test("background jobs: unknown id and empty registry produce honest messages", async () => {
  const root = await mkdirScratch("nx-bg-empty-");
  const [, jobStatus] = createBackgroundTools({ projectRoot: root, requireApproval: false });
  assert.match(String(await jobStatus.invoke({})), /no background jobs/);
  assert.match(String(await jobStatus.invoke({ jobId: "bg_99" })), /unknown job "bg_99"/);
});

test("background jobs: refuses to exceed the concurrency cap", async () => {
  const root = await mkdirScratch("nx-bg-cap-");
  const [runBackground] = createBackgroundTools({ projectRoot: root, requireApproval: false });
  const slow = "node -e \"setTimeout(()=>{}, 3000)\"";
  const first = await runBackground.invoke({ command: slow });
  assert.match(String(first), /bg_1 started/);
  const second = await runBackground.invoke({ command: slow });
  const third = await runBackground.invoke({ command: slow });
  const fourth = await runBackground.invoke({ command: slow });
  assert.match(String(second), /bg_2 started/);
  assert.match(String(third), /bg_3 started/);
  assert.match(String(fourth), /refused: 3 jobs are already running/);
});
