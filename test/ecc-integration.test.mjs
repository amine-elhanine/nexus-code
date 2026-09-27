import assert from "node:assert/strict";
import test from "node:test";
import {
  listSystemSkills,
  recommendSkills,
  readSkillContent,
  listAllSkills,
} from "../dist-electron/skills-service.js";
import {
  SUBAGENT_CONFIGS,
  SUBAGENT_ROLES,
  getSystemAgents,
  getAllSubagentRoles,
} from "../dist-electron/subagent-service.js";
import {
  BUILTIN_COMMANDS,
  discoverCustomCommands,
} from "../dist-electron/custom-commands-service.js";
import {
  discoverSystemRules,
  discoverAllRules,
} from "../dist-electron/rules-service.js";

test("ECC Integration: listSystemSkills discovers the full curated catalog", async () => {
  const systemSkills = await listSystemSkills();
  assert.ok(systemSkills.length >= 120, `Expected the full curated catalog (~130), got ${systemSkills.length}`);
  const codeSkills = systemSkills.filter((s) => !s.modes.length || s.modes.includes("code"));
  assert.ok(codeSkills.length >= 110, `Expected the full code-scoped catalog (~120), got ${codeSkills.length}`);

  const names = systemSkills.map((s) => s.name);
  assert.ok(names.includes("tdd-workflow"), "tdd-workflow should be present");
  assert.ok(names.includes("security-review"), "security-review should be present");
  assert.ok(names.includes("verification-loop"), "verification-loop should be present");
  assert.ok(names.includes("search-first"), "search-first should be present");
  assert.ok(names.includes("error-handling"), "error-handling should be present");
  assert.ok(names.includes("postgres-patterns"), "postgres-patterns should be present");
  assert.ok(names.includes("docker-patterns"), "docker-patterns should be present");
  assert.ok(names.includes("react-patterns"), "react-patterns should be present");

  // Read content of a system skill
  const tddSkill = systemSkills.find((s) => s.name === "tdd-workflow");
  assert.ok(tddSkill, "tddSkill should exist");
  const content = await readSkillContent(tddSkill.path);
  assert.ok(content.includes("Test-Driven Development Workflow"), "content should contain skill title");
});

test("ECC Integration: recommendSkills matches relevant ECC skills for coding queries", async () => {
  const systemSkills = await listSystemSkills();

  // TDD query
  const tddRecs = recommendSkills(systemSkills, "tdd workflow for code development", 3, "code");
  assert.ok(tddRecs.some((s) => s.name === "tdd-workflow"), "Should recommend tdd-workflow");

  // Security query
  const secRecs = recommendSkills(systemSkills, "Check this codebase for security vulnerabilities and secrets", 3, "code");
  assert.ok(secRecs.some((s) => s.name === "security-review"), "Should recommend security-review");

  // React patterns query
  const reactRecs = recommendSkills(systemSkills, "Optimize my React components and hooks", 3, "code");
  assert.ok(reactRecs.some((s) => s.name === "react-patterns"), "Should recommend react-patterns");
});

test("ECC Integration: discovers all 68+ specialized ECC subagents", () => {
  const allRoles = getAllSubagentRoles();
  assert.ok(allRoles.length >= 68, `Expected at least 68 subagents, got ${allRoles.length}`);

  const systemAgents = getSystemAgents();
  assert.ok(systemAgents.size >= 68, `Expected at least 68 system agents, got ${systemAgents.size}`);

  // Spot-check key specialists
  assert.ok(systemAgents.has("code-reviewer") || SUBAGENT_CONFIGS["code-reviewer"], "code-reviewer configured");
  assert.ok(systemAgents.has("architect") || SUBAGENT_CONFIGS["architect"], "architect configured");
  assert.ok(systemAgents.has("security-reviewer") || SUBAGENT_CONFIGS["security-reviewer"], "security-reviewer configured");
  assert.ok(systemAgents.has("tdd-guide") || SUBAGENT_CONFIGS["tdd-guide"], "tdd-guide configured");
  assert.ok(systemAgents.has("build-error-resolver") || SUBAGENT_CONFIGS["build-error-resolver"], "build-error-resolver configured");
  assert.ok(systemAgents.has("refactor-cleaner") || SUBAGENT_CONFIGS["refactor-cleaner"], "refactor-cleaner configured");
  assert.ok(systemAgents.has("database-reviewer") || SUBAGENT_CONFIGS["database-reviewer"], "database-reviewer configured");
});

test("ECC Integration: discovers curated slash commands", async () => {
  const commands = await discoverCustomCommands();
  assert.ok(commands.length >= 45, `Expected at least 45 commands, got ${commands.length}`);

  const cmdNames = commands.map((c) => c.command);
  assert.ok(cmdNames.includes("/plan"), "/plan should be present");
  assert.ok(cmdNames.includes("/tdd"), "/tdd should be present");
  assert.ok(cmdNames.includes("/quality-gate"), "/quality-gate should be present");
  assert.ok(cmdNames.includes("/build-fix"), "/build-fix should be present");
  assert.ok(cmdNames.includes("/code-review"), "/code-review should be present");
  assert.ok(cmdNames.includes("/security"), "/security should be present");
  assert.ok(cmdNames.includes("/test-coverage"), "/test-coverage should be present");
});

test("ECC Integration: discovers ECC system rules", async () => {
  const rules = await discoverSystemRules();
  assert.ok(rules.length >= 8, `Expected at least 8 common rules, got ${rules.length}`);
  const filenames = rules.map((r) => r.filename);
  assert.ok(filenames.includes("security.md"), "security.md rule should be discovered");
  assert.ok(filenames.includes("coding-style.md"), "coding-style.md rule should be discovered");
  assert.ok(filenames.includes("testing.md"), "testing.md rule should be discovered");
});
