// Project instructions (AGENTS.md / CLAUDE.md) discovery: order, fallback,
// global level, cap truncation, and the prompt section format.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverProjectInstructions, buildInstructionsSection, PROJECT_INSTRUCTIONS_CAP } from "../dist-electron/project-instructions.js";

test("project instructions: nothing found → empty section", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-instr-"));
  try {
    const result = await discoverProjectInstructions(root);
    assert.equal(result.files.length, 0);
    assert.equal(result.section, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project instructions: AGENTS.md preferred over CLAUDE.md", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-instr-"));
  try {
    await fs.writeFile(path.join(root, "AGENTS.md"), "use pnpm only");
    await fs.writeFile(path.join(root, "CLAUDE.md"), "claude only");
    const result = await discoverProjectInstructions(root);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "AGENTS.md");
    assert.equal(result.files[0].source, "project");
    assert.ok(result.section.includes("use pnpm only"));
    assert.ok(!result.section.includes("claude only"), "must not double-inject both files");
    assert.ok(result.section.includes("## Project Instructions"));
    assert.ok(result.section.includes("follow strictly"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project instructions: CLAUDE.md fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-instr-"));
  try {
    await fs.writeFile(path.join(root, "CLAUDE.md"), "claude fallback content");
    const result = await discoverProjectInstructions(root);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "CLAUDE.md");
    assert.ok(result.section.includes("claude fallback content"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project instructions: global ~/.nexus file loads alongside project file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-instr-"));
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-home-"));
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  try {
    await fs.mkdir(path.join(fakeHome, ".nexus"), { recursive: true });
    await fs.writeFile(path.join(fakeHome, ".nexus", "AGENTS.md"), "global: never commit secrets");
    await fs.writeFile(path.join(root, "AGENTS.md"), "project: vitest not jest");
    // os.homedir() reads USERPROFILE on Windows and HOME on POSIX, per call.
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    const result = await discoverProjectInstructions(root);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].source, "project");
    assert.equal(result.files[1].source, "global");
    assert.ok(result.section.includes("project: vitest not jest"));
    assert.ok(result.section.includes("global: never commit secrets"));
    assert.ok(result.section.includes("across all projects"));
  } finally {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test("project instructions: oversized file truncated at cap with marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-instr-"));
  try {
    await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(PROJECT_INSTRUCTIONS_CAP + 5000));
    const result = await discoverProjectInstructions(root);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].truncated, true);
    assert.ok(result.files[0].content.length < PROJECT_INSTRUCTIONS_CAP + 1000, "content must be capped");
    assert.ok(result.files[0].content.includes("instructions truncated"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project instructions: empty files skipped, section builder empty-safe", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-instr-"));
  try {
    await fs.writeFile(path.join(root, "AGENTS.md"), "   \n  ");
    const result = await discoverProjectInstructions(root);
    assert.equal(result.files.length, 0);
    assert.equal(result.section, "");
    // Empty file must NOT stop CLAUDE.md from being considered.
    await fs.writeFile(path.join(root, "CLAUDE.md"), "claude after empty agents");
    const result2 = await discoverProjectInstructions(root);
    assert.equal(result2.files.length, 1);
    assert.equal(result2.files[0].name, "CLAUDE.md");
    assert.equal(buildInstructionsSection([]), "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
