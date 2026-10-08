import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSkills, recommendSkills } from "../dist-electron/skills-service.js";
import { discoverProjectRules } from "../dist-electron/rules-service.js";

test("evaluation skill and rule fixtures load through the real prompt asset services", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cases = JSON.parse(await fs.readFile(path.join(repoRoot, "evals", "cases.json"), "utf8"));
  const skillCase = cases.find((item) => item.requireSkillRead);
  const ruleCase = cases.find((item) => item.requireProjectRules);
  assert.ok(skillCase && ruleCase, "both targeted prompt-asset cases must exist");

  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-eval-skill-"));
  t.after(async () => fs.rm(skillRoot, { recursive: true, force: true }));
  const skillFile = path.join(skillRoot, ".nexus", "skills", "port-parser", "SKILL.md");
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, skillCase.files[".nexus/skills/port-parser/SKILL.md"], "utf8");
  const skills = await listSkills(skillRoot);
  const recommended = recommendSkills(skills, skillCase.request, 3, "code");
  assert.ok(recommended.some((skill) => skill.name === "port-parser"), "the task should recommend its project skill in Code mode");
  assert.ok(!recommendSkills(skills, skillCase.request, 3, "home").some((skill) => skill.name === "port-parser"), "the Code-scoped skill should not leak into Home mode");

  const rulesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-eval-rules-"));
  t.after(async () => fs.rm(rulesRoot, { recursive: true, force: true }));
  const ruleFile = path.join(rulesRoot, ".nexus", "rules", "slug-policy.md");
  await fs.mkdir(path.dirname(ruleFile), { recursive: true });
  await fs.writeFile(ruleFile, ruleCase.files[".nexus/rules/slug-policy.md"], "utf8");
  const discovered = await discoverProjectRules(rulesRoot);
  assert.equal(discovered.hasRules, true);
  assert.match(discovered.combinedPromptSection, /Slug policy: a valid slug/);
});
