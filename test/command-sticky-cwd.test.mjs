import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdirScratch } from "./helpers/scratch.mjs";
import { executeCommand, beginCommandRun, endCommandRun, getSessionShellCwd } from "../dist-electron/command-service.js";

test("sticky cwd: subsequent commands remember cd directory in the same runId", async () => {
  const root = await mkdirScratch("nexus-sticky-cwd-");
  const sub = path.join(root, "packages", "core");
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(sub, "package.json"), JSON.stringify({ name: "core" }), "utf8");

  const runId = `sticky-${Date.now()}`;
  beginCommandRun(runId);
  try {
    // 1. Initial command in sub directory
    const r1 = await executeCommand(root, "cd packages/core && node -e \"console.log(process.cwd())\"", { runId });
    assert.equal(r1.exitCode, 0);
    assert.ok(r1.output.toLowerCase().includes("core"));

    // Verify sessionShellCwd was updated
    const savedCwd = getSessionShellCwd(runId);
    assert.ok(savedCwd);
    assert.equal(path.resolve(savedCwd), path.resolve(sub));

    // 2. Second command without cd runs in the sticky directory!
    const r2 = await executeCommand(root, "node -e \"console.log(process.cwd())\"", { runId });
    assert.equal(r2.exitCode, 0);
    assert.ok(r2.output.toLowerCase().includes("core"), `Expected output to include core, got: ${r2.output}`);

    // 3. Cd back to root
    const r3 = await executeCommand(root, "cd ../..", { runId });
    assert.equal(r3.exitCode, 0);
    const savedCwdRoot = getSessionShellCwd(runId);
    assert.equal(path.resolve(savedCwdRoot), path.resolve(root));

    // 4. Failing command preserves non-zero exit code, updates CWD if cd preceded failure, and never leaks sentinel in onOutput
    let streamed = "";
    const r4 = await executeCommand(root, "cd packages/core && git --invalid-flag-xyz", {
      runId,
      onOutput: (chunk) => { streamed += chunk; },
    });
    assert.notEqual(r4.exitCode, 0, "Failing command must not have its non-zero exit code swallowed");
    assert.ok(!r4.output.includes("__NEXUS_PWD_"), "Output must not leak sentinel tag");
    assert.ok(!streamed.includes("__NEXUS_PWD_"), "Streamed output must not leak sentinel tag");
    assert.equal(path.resolve(getSessionShellCwd(runId)), path.resolve(sub));
  } finally {
    endCommandRun(runId);
    await fs.rm(root, { recursive: true, force: true });
  }
});
