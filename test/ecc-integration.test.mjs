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
  buildSubagentCatalog,
} from "../dist-electron/subagent-service.js";
import {
  BUILTIN_COMMANDS,
  discoverCustomCommands,
} from "../dist-electron/custom-commands-service.js";
import {
  discoverSystemRules,
  discoverAllRules,
} from "../dist-electron/rules-service.js";

test("System libraries: listSystemSkills discovers the full curated catalog", async () => {
  const systemSkills = await listSystemSkills();
  assert.ok(systemSkills.length >= 40, `Expected the curated catalog (46 shipped), got ${systemSkills.length}`);
  const codeSkills = systemSkills.filter((s) => !s.modes.length || s.modes.includes("code"));
  assert.ok(codeSkills.length >= 40, `Expected the code-scoped catalog (~43: all/ + code/), got ${codeSkills.length}`);

  const names = systemSkills.map((s) => s.name);
  assert.ok(names.includes("tdd-workflow"), "tdd-workflow should be present");
  assert.ok(names.includes("security-review"), "security-review should be present");
  assert.ok(names.includes("python-testing"), "python-testing should be present");
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

test("System libraries: recommendSkills matches relevant skills for coding queries", async () => {
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

test("System libraries: discovers the curated subagent catalog", () => {
  const allRoles = getAllSubagentRoles();
  // 51 bundled specialist files + 3 tuned non-file roles (researcher/tester/coder).
  assert.ok(allRoles.length >= 50, `Expected at least 50 subagents, got ${allRoles.length}`);

  const systemAgents = getSystemAgents();
  assert.ok(systemAgents.size >= 50, `Expected at least 51 system agents, got ${systemAgents.size}`);

  // The 7 formerly-shadowed .md files are deleted; the tuned hardcoded
  // configs remain the source of truth for these roles.
  assert.ok(SUBAGENT_CONFIGS["code-reviewer"], "code-reviewer configured");
  assert.ok(SUBAGENT_CONFIGS["architect"], "architect configured");
  assert.ok(SUBAGENT_CONFIGS["security-reviewer"], "security-reviewer configured");
  assert.ok(SUBAGENT_CONFIGS["tdd-guide"], "tdd-guide configured");
  assert.ok(SUBAGENT_CONFIGS["build-error-resolver"], "build-error-resolver configured");
  assert.ok(SUBAGENT_CONFIGS["refactor-cleaner"], "refactor-cleaner configured");
  assert.ok(SUBAGENT_CONFIGS["database-reviewer"], "database-reviewer configured");
});

test("System libraries: role catalog lists every role with a description", () => {
  const catalog = buildSubagentCatalog();
  const roles = getAllSubagentRoles();
  for (const role of roles) {
    assert.ok(catalog.includes(`\`${role}\``), `catalog should list role ${role}`);
  }
  // The model must never see a placeholder description in the catalog.
  assert.ok(!catalog.includes("undefined"), "catalog descriptions must be defined");
  assert.ok(catalog.split("\n").length >= roles.length, "one line per role");
});

test("System libraries: discovers curated slash commands", async () => {
  const commands = await discoverCustomCommands();
  // 14 builtins + 33 bundled files (the 5 broken orch-* commands were removed).
  assert.ok(commands.length >= 42, `Expected at least 42 commands, got ${commands.length}`);

  const cmdNames = commands.map((c) => c.command);
  assert.ok(cmdNames.includes("/plan"), "/plan should be present");
  assert.ok(cmdNames.includes("/tdd"), "/tdd should be present");
  assert.ok(cmdNames.includes("/quality-gate"), "/quality-gate should be present");
  assert.ok(cmdNames.includes("/build-fix"), "/build-fix should be present");
  assert.ok(cmdNames.includes("/code-review"), "/code-review should be present");
  assert.ok(cmdNames.includes("/security"), "/security should be present");
  assert.ok(cmdNames.includes("/test-coverage"), "/test-coverage should be present");
  // The orch-* commands referenced skills that never shipped; they must stay
  // out unless their skill pipeline ships with them.
  for (const cmd of cmdNames) {
    assert.ok(!cmd.startsWith("/orch-"), `broken orch-* command leaked back in: ${cmd}`);
  }
});

test("System libraries: discovers system rules", async () => {
  const rules = await discoverSystemRules();
  assert.ok(rules.length >= 8, `Expected at least 8 common rules, got ${rules.length}`);
  const filenames = rules.map((r) => r.filename);
  assert.ok(filenames.includes("security.md"), "security.md rule should be discovered");
  assert.ok(filenames.includes("coding-style.md"), "coding-style.md rule should be discovered");
  assert.ok(filenames.includes("testing.md"), "testing.md rule should be discovered");
});
