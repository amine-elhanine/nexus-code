// Phase 4.1: OS sandbox plan selection + env/argv composition, and the
// Windows env-scoping path end-to-end through executeCommand.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mkdirScratch } from "./helpers/scratch.mjs";

const { planCommandSandbox, sandboxArgvPrefix, sandboxEnvAdditions } = await import("../dist-electron/os-sandbox.js");
const { executeCommand } = await import("../dist-electron/command-service.js");

test("sandbox plan: macos sandbox-exec, linux bwrap, windows env, off", () => {
  const mac = planCommandSandbox({ projectRoot: "/tmp/proj", mode: "auto", platform: "darwin" });
  assert.equal(mac.kind, "macos-exec");
  const argv = sandboxArgvPrefix(mac);
  assert.equal(argv[0], "sandbox-exec");
  assert.ok(argv[1] === "-p" && argv[2].includes("(deny default)"), "profile inlined");
  assert.ok(argv[2].includes("/.ssh"), "credential homes denied in profile");

  const linux = planCommandSandbox({ projectRoot: "/tmp/proj", mode: "auto", platform: "linux", whichBwrap: () => true });
  assert.equal(linux.kind, "linux-bwrap");
  const bwrapArgv = sandboxArgvPrefix(linux);
  assert.equal(bwrapArgv[0], "bwrap");
  assert.ok(bwrapArgv.includes("--ro-bind"), "root read-only bind");
  assert.ok(bwrapArgv.includes("--tmpfs"), "tmpfs tmp");

  const noBwrap = planCommandSandbox({ projectRoot: "/tmp/proj", mode: "auto", platform: "linux", whichBwrap: () => false });
  assert.equal(noBwrap.kind, "none");

  const win = planCommandSandbox({ projectRoot: "C:/x/proj", mode: "auto", platform: "win32" });
  assert.equal(win.kind, "windows-env");
  assert.equal(sandboxArgvPrefix(win).length, 0, "no argv prefix on windows");
  assert.match(sandboxEnvAdditions(win).TEMP, /\.nexus[\\/]tmp$/);

  const off = planCommandSandbox({ projectRoot: "/tmp/proj", mode: "off", platform: "darwin" });
  assert.equal(off.kind, "none");
});

test("windows env scoping: executeCommand redirects TEMP into the project when enabled", async (t) => {
  // Only meaningful on win32, but the command runs on every platform.
  const dir = await mkdirScratch("nexus-os-sandbox-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Enable the sandbox through the app settings API.
  const store = await import("../dist-electron/store.js");
  await store.saveAppSettings({ commandSandbox: "auto" });
  try {
    const isWin = process.platform === "win32";
    const probe = isWin ? "echo %TEMP%" : "echo $TMPDIR";
    const result = await executeCommand(dir, probe, { runId: `sandbox-probe-${Date.now()}` });
    assert.equal(result.exitCode, 0, result.output);
    if (isWin) {
      assert.match(result.output, /\.nexus[\\/]tmp/, "TEMP resolves inside the project sandbox tmp");
    } else {
      assert.ok(result.output.length > 0);
    }
    const tmpDir = path.join(dir, ".nexus", "tmp");
    const stat = await fs.stat(tmpDir);
    assert.ok(stat.isDirectory(), "sandbox tmp dir created");
  } finally {
    await store.saveAppSettings({ commandSandbox: "off" });
  }
});
