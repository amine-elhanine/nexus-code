import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  substituteCommandPlaceholders,
  expandSlashCommand,
} from "../dist-electron/custom-commands-service.js";

test("placeholders: {{input}} and $ARGUMENTS both expand", () => {
  assert.equal(substituteCommandPlaceholders("Do it to: {{input}}", { input: "the auth module" }), "Do it to: the auth module");
  assert.equal(substituteCommandPlaceholders("Input: $ARGUMENTS", { input: "PR 42" }), "Input: PR 42");
  // Missing input degrades to an empty string, never the literal placeholder.
  assert.equal(substituteCommandPlaceholders("Input: $ARGUMENTS", {}), "Input:");
  assert.equal(substituteCommandPlaceholders("Review {{activeFile}}", { activeFile: "src/app.ts" }), "Review src/app.ts");
});

test("expandSlashCommand: bundled command expands with its input", async () => {
  const expanded = await expandSlashCommand("/code-review PR 42");
  assert.ok(expanded.includes("Code Review"), "should expand to the code-review template");
  assert.ok(expanded.includes("PR 42"), "the text after the command becomes $ARGUMENTS/{{input}}");
  assert.ok(!expanded.includes("$ARGUMENTS"), "placeholder must not survive expansion");
});

test("expandSlashCommand: builtin command with {{input}}", async () => {
  const expanded = await expandSlashCommand("/tdd write a stack");
  assert.ok(expanded.includes("TDD"), "should expand to the TDD template");
  assert.ok(expanded.includes("write a stack"), "input injected at {{input}}");
});

test("expandSlashCommand: no input expands to the bare template", async () => {
  const expanded = await expandSlashCommand("/quality-gate");
  assert.ok(expanded.length > 20, "template body present");
  assert.ok(!expanded.includes("{{input}}") && !expanded.includes("$ARGUMENTS"), "no placeholder survives");
});

test("expandSlashCommand: unknown command passes through untouched", async () => {
  const req = "/definitely-not-a-real-command fix the thing";
  assert.equal(await expandSlashCommand(req), req);
});

test("expandSlashCommand: plain text and non-command slashes pass through", async () => {
  assert.equal(await expandSlashCommand("fix the auth bug"), "fix the auth bug");
  assert.equal(await expandSlashCommand("100 / 2 = ?"), "100 / 2 = ?");
  assert.equal(await expandSlashCommand("see /usr/bin/env for details"), "see /usr/bin/env for details");
});

test("expandSlashCommand: multiline input is captured in full", async () => {
  const expanded = await expandSlashCommand("/tdd first line\nsecond line");
  assert.ok(expanded.includes("first line"), "first input line present");
  assert.ok(expanded.includes("second line"), "second input line present");
});

test("evaluation project-command cases expand in their declared assistant scope", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const evalCases = JSON.parse(await fs.readFile(path.join(repoRoot, "evals", "cases.json"), "utf8"));
  const commandCases = evalCases.filter((item) => item.requireCommandExpansion);
  assert.deepEqual(commandCases.map((item) => item.id).sort(), ["code-project-command-expansion", "home-project-command-expansion"]);

  for (const benchmark of commandCases) {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-command-eval-"));
    t.after(async () => fs.rm(projectRoot, { recursive: true, force: true }));
    for (const [relative, content] of Object.entries(benchmark.files)) {
      const target = path.join(projectRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    const scope = benchmark.taskKind === "general" ? "home" : "code";
    const expanded = await expandSlashCommand(benchmark.request, projectRoot, scope);
    assert.ok(!expanded.startsWith("/"), `${benchmark.id} must resolve its project command`);
    assert.ok(!expanded.includes("{{input}}"), `${benchmark.id} must substitute command input`);
    assert.match(expanded, /eval\.test\.mjs|service-facts\.md/);
    const wrongScope = scope === "home" ? "code" : "home";
    assert.equal(await expandSlashCommand(benchmark.request, projectRoot, wrongScope), benchmark.request, "project command must stay scoped to its declared mode");
  }
});
