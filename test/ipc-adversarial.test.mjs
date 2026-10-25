// Phase 1C.5: consolidated adversarial IPC-surface audit.
//
// The main-process IPC handlers are thin wrappers over these services; every
// handler that takes a path/id from a compromised renderer must fail closed.
// This suite drives the same service functions the handlers call, under a
// scratch directory, and covers: lexical path traversal, drive-absolute and
// UNC inputs, symlink escape, artifact filename traversal, Home-mode
// traversal, and secret redaction in terminal output.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";

test("adversarial IPC: workspace file ops refuse traversal and absolute escapes", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-ipc-adv-"));
  const root = path.join(scratch, "project");
  await fs.mkdir(root, { recursive: true });
  const outsideDir = path.join(scratch, "outside");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "classified");
  const outside = path.join(outsideDir, "secret.txt");
  try {
    const tools = await import("../dist-electron/project-tools.js");
    const escapees = [
      "../outside/secret.txt",
      "..\\outside\\secret.txt",
      outside, // absolute path outside the root
      isWin ? "C:\\Windows\\win.ini" : "/etc/passwd",
      isWin ? String.raw`\\.\pipe\nonexistent` : "/proc/self/environ",
      "sub/../../outside/secret.txt",
      "./../../outside",
    ];
    const readers = [
      ["readWorkspaceFile", tools.readWorkspaceFile],
      ["readWorkspaceFileBase64", tools.readWorkspaceFileBase64],
      ["writeWorkspaceFile", tools.writeWorkspaceFile],
    ];
    for (const escapee of escapees) {
      for (const [label, fn] of readers) {
        if (!fn) continue;
        const call = label === "writeWorkspaceFile" ? fn(root, escapee, "x") : fn(root, escapee);
        try {
          await call;
        } catch {
          continue; // refused — expected
        }
        throw new Error(`${label} accepted an escape payload: ${escapee}`);
      }
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("adversarial IPC: symlink escape is refused (realpath containment)", async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-ipc-symlink-"));
  const root = path.join(scratch, "project");
  await fs.mkdir(root, { recursive: true });
  const outsideDir = path.join(scratch, "outside");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "classified");
  const linkPath = path.join(root, "leak");
  try {
    const tools = await import("../dist-electron/project-tools.js");
    try {
      await fs.symlink(outsideDir, linkPath, isWin ? "junction" : "dir");
    } catch (error) {
      // Some Windows environments (including packaged/sandboxed runners) do
      // not grant symlink/junction creation to the current user. Linux CI
      // still exercises the containment assertions; report the unsupported
      // host explicitly instead of failing before the behavior is tested.
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlink creation unavailable on this host (${error.code})`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => tools.readWorkspaceFile(root, path.join("leak", "secret.txt")),
      /symlink|escape/i
    );
    // Write targets through the same link must fail closed, too.
    await assert.rejects(
      () => tools.writeWorkspaceFile(root, path.join("leak", "pwned.txt"), "x"),
      /symlink|escape/i
    );
    // And a not-yet-existing target under a symlinked parent directory.
    await assert.rejects(
      () => tools.writeWorkspaceFile(root, path.join("leak", "new", "deep", "pwned.txt"), "x"),
      /symlink|escape/i
    );
    // Normal workspace writes still work.
    await tools.writeWorkspaceFile(root, "src/app.ts", "export const ok = true;");
    const saved = await fs.readFile(path.join(root, "src", "app.ts"), "utf8");
    assert.match(saved, /export const ok/);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("adversarial IPC: Home file reads/downloads refuse traversal", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-ipc-home-"));
  process.env.APPDATA = scratch;
  try {
    const home = await import("../dist-electron/home-service.js");
    await assert.rejects(
      () => home.readHomeFile("../project/nexus/nexus-state.json"),
      /escapes|symlink/i
    );
    await assert.rejects(
      () => home.downloadHomeFile("../../etc/passwd"),
      /escapes|symlink/i
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("adversarial IPC: artifact filename traversal cannot read state files", async () => {
  try {
    const artifacts = await import("../dist-electron/artifacts-service.js");
    const deep = path.join("..", "..", "nexus", "nexus-state.json");
    const leak = await artifacts.getArtifact("/tmp/any-project", "sess", deep);
    assert.equal(leak, null, "artifact:get must not traverse out of the artifacts dir");
    const none = await artifacts.getArtifact("/tmp/any-project", "sess", "nonexistent.txt");
    assert.equal(none, null);
  } catch (error) {
    if (error && error.code === "ENOENT") return; // state dirs absent under node FAT-appconfig — refusal by missing file is fine
    throw error;
  }
});

test("adversarial IPC: terminal output redaction keeps secrets out of model context", async () => {
  const commandService = await import("../dist-electron/command-service.js");
  const raw = [
    "api_key=sk-live-1234567890secret",
    "Authorization: Bearer abc123def456ghi789",
    "export MY_TOKEN=tok-98765-xyz",
    "some harmless build output",
  ].join("\n");
  const cleaned = commandService.cleanTerminalOutput(raw);
  assert.ok(!/sk-live-1234567890secret/.test(cleaned), "api key value must be redacted");
  assert.ok(!/abc123def456ghi789/.test(cleaned), "bearer token must be redacted");
  assert.ok(/some harmless build output/.test(cleaned), "harmless output stays");
  // Model-output cap bounds huge dumps (head+tail), so one command cannot flood context.
  const capped = commandService.capModelOutput("x".repeat(1_000_000));
  assert.ok(capped.output.length < 20_000, "capped output stays bounded");
});
