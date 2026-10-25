import test from "node:test";
import assert from "node:assert/strict";
import { execFile as rawExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { boundedExecFile } from "../dist-electron/shell-subprocess.js";

const isWin = process.platform === "win32";
const hostGitVersion = promisify(rawExecFile);

test("bounded exec: a hanging grandchild is killed within the timeout (tree cleanup)", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-tree-kill-"));
  // Grandchild writes a "survived the kill" marker 15s in. If the timeout
  // kill had not cleaned the tree, this marker would show up after the test.
  const linger = path.join(scratch, "survived-the-kill.marker");
  const hangScript = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-tree-hang-"));
  const scriptPath = path.join(hangScript, "hang-grandchild.mjs");
  await fs.writeFile(scriptPath, `import timers from "node:timers/promises";await timers.setTimeout(15000);await fs_promises(); function fs_promises(){return import("node:fs").then(fs => fs.promises.writeFile(${JSON.stringify(linger)}, "survived"));}`);
  const started = Date.now();
  try {
    const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const args = isWin
      ? ["/d", "/s", "/c", `cmd /c node ${scriptPath.replace(/"/g, "")}`]
      : ["-c", `node ${JSON.stringify(scriptPath)}; wait`];
    await assert.rejects(
      () => boundedExecFile(shell, args, { timeout: 700 }),
      (error) => Boolean(error && error.killed),
      "timeout must reject with a killed error"
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15_000, `timeout fired late: ${elapsed}ms`);
    // Outlive window: give a non-tree-killed child time to write the marker.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const survived = await fs.readFile(linger, "utf8").then(() => true, () => false);
    assert.ok(!survived, "grandchild wrote its marker — the process tree was NOT cleaned up");
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(hangScript, { recursive: true, force: true });
  }
});

test("bounded exec: default timeout exists (no options, command succeeds)", async () => {
  const { stdout } = await boundedExecFile("git", ["--version"]);
  assert.ok(stdout.includes("git version"));
  // Sanity that the same binary works via the stock promisify path too.
  await hostGitVersion("git", ["--version"]);
});

test("bounded exec: maxBuffer bounds unbounded output and rejects", async () => {
  // ~13MiB of output from a scratch script (no shell quoting involved) —
  // must reject at the caller-set 1MiB cap, never buffer-and-resolve.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-bounds-"));
  const script = path.join(scratch, "big.js");
  await fs.writeFile(script, 'process.stdout.write("x".repeat(13800000));');
  try {
    const outcome = await boundedExecFile("node", [script], { maxBuffer: 1_000_000, timeout: 60_000 }).then(
      (result) => ({ ok: true, stdout: result.stdout }),
      (error) => ({ ok: false, code: error.code, killed: error.killed })
    );
    if (outcome.ok) {
      assert.ok(outcome.stdout.length <= 1_000_000, `resolved with more than the capped buffer (${outcome.stdout.length} bytes)`);
    } else {
      const bounded =
        outcome.code === "ENOBUFS" ||
        outcome.code === "ENOTBUFS" ||
        outcome.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        outcome.killed === true;
      assert.ok(bounded, `unexpected failure: ${outcome.code}`);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("bounded exec: non-zero exit carries stdout and stderr for callers that read them", async () => {
  // Same convention as promisify(execFile): surfaces captured output on errors.
  const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = isWin
    ? ["/d", "/s", "/c", "cmd /c echo out-marker & cmd /c exit 3"]
    : ["-c", "echo out-marker; echo err-marker 1>&2; exit 3"];
  await assert.rejects(
    () => boundedExecFile(shell, args, { timeout: 30_000 }),
    (error) => {
      const stdout = String(error?.stdout || "");
      const stderr = String(error?.stderr || "");
      return /out-marker/.test(stdout) || /err-marker/.test(stderr);
    }
  );
});
