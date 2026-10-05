import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverSystemRules,
  discoverAllRules,
} from "../dist-electron/rules-service.js";

function makeProject(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-rules-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

function stackDirs(rules) {
  return new Set(rules.map((r) => r.relativePath.split("/")[1]));
}

test("rules: common standards always load, even with no project", async () => {
  const rules = await discoverSystemRules();
  assert.ok(rules.length >= 8, `expected the common corpus, got ${rules.length}`);
  assert.ok(rules.every((r) => r.source === "system"));
});

test("rules: empty project detects no stacks beyond common", async () => {
  const dir = makeProject();
  try {
    const rules = await discoverSystemRules(dir);
    assert.deepEqual(stackDirs(rules), new Set(["common"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rules: pom.xml project loads java standards", async () => {
  const dir = makeProject({ "pom.xml": "<project/>" });
  try {
    const stacks = stackDirs(await discoverSystemRules(dir));
    assert.ok(stacks.has("java"), `java missing from ${[...stacks]}`);
    assert.ok(!stacks.has("web"), "no package.json — web standards must not load");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rules: composer.json project loads php standards", async () => {
  const dir = makeProject({ "composer.json": "{}" });
  try {
    const stacks = stackDirs(await discoverSystemRules(dir));
    assert.ok(stacks.has("php"), `php missing from ${[...stacks]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rules: Gemfile project loads ruby, pubspec.yaml loads dart", async () => {
  const rubyDir = makeProject({ Gemfile: "source 'https://rubygems.org'" });
  const dartDir = makeProject({ "pubspec.yaml": "name: app" });
  try {
    assert.ok(stackDirs(await discoverSystemRules(rubyDir)).has("ruby"));
    assert.ok(stackDirs(await discoverSystemRules(dartDir)).has("dart"));
  } finally {
    rmSync(rubyDir, { recursive: true, force: true });
    rmSync(dartDir, { recursive: true, force: true });
  }
});

test("rules: CMakeLists.txt loads cpp, Package.swift loads swift", async () => {
  const cppDir = makeProject({ "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)" });
  const swiftDir = makeProject({ "Package.swift": "// swift-tools-version:5.9" });
  try {
    assert.ok(stackDirs(await discoverSystemRules(cppDir)).has("cpp"));
    assert.ok(stackDirs(await discoverSystemRules(swiftDir)).has("swift"));
  } finally {
    rmSync(cppDir, { recursive: true, force: true });
    rmSync(swiftDir, { recursive: true, force: true });
  }
});

test("rules: .csproj and .fsproj select the right .NET stacks", async () => {
  const csDir = makeProject({ "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"/>" });
  const fsDir = makeProject({ "App.fsproj": "<Project Sdk=\"Microsoft.NET.Sdk\"/>" });
  try {
    assert.ok(stackDirs(await discoverSystemRules(csDir)).has("csharp"));
    assert.ok(!stackDirs(await discoverSystemRules(csDir)).has("fsharp"));
    assert.ok(stackDirs(await discoverSystemRules(fsDir)).has("fsharp"));
  } finally {
    rmSync(csDir, { recursive: true, force: true });
    rmSync(fsDir, { recursive: true, force: true });
  }
});

test("rules: node project with react+typescript gets web+ts+react, not python", async () => {
  const dir = makeProject({
    "package.json": JSON.stringify({
      dependencies: { react: "^18.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
    "tsconfig.json": "{}",
  });
  try {
    const stacks = stackDirs(await discoverSystemRules(dir));
    for (const expected of ["web", "typescript", "react"]) {
      assert.ok(stacks.has(expected), `${expected} missing from ${[...stacks]}`);
    }
    assert.ok(!stacks.has("python") && !stacks.has("java"), "unrelated stacks must not fire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rules: nuxt dependency selects the nuxt standards", async () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ dependencies: { nuxt: "^3.0.0" } }),
  });
  try {
    const stacks = stackDirs(await discoverSystemRules(dir));
    assert.ok(stacks.has("nuxt"), `nuxt missing from ${[...stacks]}`);
    assert.ok(stacks.has("vue"), "nuxt implies vue standards");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rules: combined prompt labels the system corpus as Nexus standards", async () => {
  const dir = makeProject();
  try {
    const result = await discoverAllRules(dir);
    assert.ok(result.hasRules);
    assert.ok(
      result.combinedPromptSection.includes("Nexus Engineering Standards"),
      "system section header should be Nexus-branded",
    );
    assert.ok(!result.combinedPromptSection.includes("ECC"), "no foreign branding in injected prompts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
