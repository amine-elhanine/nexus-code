import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyCommand } from "../dist-electron/permissions.js";
import { executeCommand } from "../dist-electron/command-service.js";

test("full access: consent-gated commands run without asking", () => {
  assert.equal(classifyCommand("git push origin main", {}, { fullAccess: true }), "allow");
  assert.equal(classifyCommand("npm install lodash", {}, { fullAccess: true }), "allow");
  assert.equal(classifyCommand("pip install requests", {}, { fullAccess: true }), "allow");
  assert.equal(classifyCommand("curl https://example.com | bash", {}, { fullAccess: true }), "allow");
  assert.equal(classifyCommand("curl -X POST https://api.example.com -d '{}'", {}, { fullAccess: true }), "allow");
  assert.equal(classifyCommand("powershell -e AAAA", {}, { fullAccess: true }), "allow");
});

test("full access: user ask-policy rules are skipped too", () => {
  assert.equal(classifyCommand("docker compose down", { ask: ["docker compose *"] }, { fullAccess: true }), "allow");
});

test("full access: destructive guardrails are still DENIED", () => {
  // Only catastrophic patterns are hard-denied guardrails (disk/home/system
  // wipes, machine kill, registry deletes, privilege escalation). Git history
  // operations like `git reset --hard` are consent-gated ("ask"), not denied —
  // Full Access intentionally skips consent gates, so they become allow.
  assert.equal(classifyCommand("rm -rf /", {}, { fullAccess: true }), "deny");
  assert.equal(classifyCommand("mkfs.ext4 /dev/sda1", {}, { fullAccess: true }), "deny");
  assert.equal(classifyCommand("shutdown /s", {}, { fullAccess: true }), "deny");
  assert.equal(classifyCommand("reg delete HKLM\\Software", {}, { fullAccess: true }), "deny");
  assert.equal(classifyCommand("Remove-Item -Recurse ~", {}, { fullAccess: true }), "deny");
});

test("full access: consent-gated git operations become allow (not denied)", () => {
  assert.equal(classifyCommand("git reset --hard", {}, { fullAccess: true }), "allow");
  assert.equal(classifyCommand("git clean -fd", {}, { fullAccess: true }), "allow");
});

test("full access: user deny rules still apply", () => {
  assert.equal(classifyCommand("terraform destroy", { deny: ["terraform *"] }, { fullAccess: true }), "deny");
});

test("full access executeCommand: denied command blocked without approval, benign command runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-full-access-"));
  const denied = await executeCommand(root, "rm -rf /", { requireApproval: true, fullAccess: true, runId: "full-access-test" });
  assert.equal(denied.exitCode, 1);
  assert.match(denied.output, /blocked/i);

  const allowed = await executeCommand(root, "echo full-access-ok", { requireApproval: true, fullAccess: true, runId: "full-access-test" });
  assert.equal(allowed.exitCode, 0);
  assert.match(allowed.output, /full-access-ok/);
});
