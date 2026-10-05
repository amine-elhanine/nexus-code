import assert from "node:assert/strict";
import test from "node:test";
import { listSystemSkills, filterSkillsByMcp, REQUIRED_MCP_SKILLS } from "../dist-electron/skills-service.js";

test("skills: folded-YAML descriptions are parsed, not left as '>' markers", async () => {
  const skills = await listSystemSkills();
  const optimizer = skills.find((s) => s.name === "prompt-optimizer");
  assert.ok(optimizer, "prompt-optimizer should ship");
  assert.ok(
    optimizer.description.startsWith("Analyze raw prompts"),
    `expected real description, got: ${JSON.stringify(optimizer.description)}`,
  );
  assert.ok(
    optimizer.description.includes("TRIGGER"),
    "folded block should be joined into one string",
  );

  const a11y = skills.find((s) => s.name === "frontend-a11y");
  assert.ok(a11y, "frontend-a11y should ship");
  assert.notEqual(a11y.description, ">", "description must not be the bare folded marker");
  assert.ok(a11y.description.length > 40, `description too short: ${JSON.stringify(a11y.description)}`);
});

test("skills: every listed system skill has a usable description", async () => {
  const skills = await listSystemSkills();
  for (const skill of skills) {
    assert.ok(
      skill.description && skill.description.length > 3 && !/^[>|]/.test(skill.description),
      `${skill.name} has a broken description: ${JSON.stringify(skill.description)}`,
    );
  }
});

const fake = (name, source = "system") => ({ name, description: `${name} desc`, path: `x/${name}/SKILL.md`, source, modes: [] });

test("skills: filterSkillsByMcp drops MCP-only skills when their server is absent", () => {
  assert.ok(REQUIRED_MCP_SKILLS["exa-search"], "exa-search is an MCP-dependent skill");
  const catalog = [fake("tdd-workflow"), fake("exa-search"), fake("deep-research"), fake("documentation-lookup")];

  const withoutMcp = filterSkillsByMcp(catalog, []);
  assert.deepEqual(withoutMcp.map((s) => s.name), ["tdd-workflow"]);

  const withExa = filterSkillsByMcp(catalog, ["Exa MCP Server"]);
  assert.ok(withExa.some((s) => s.name === "exa-search"), "exa server unlocks exa-search");
  assert.ok(!withExa.some((s) => s.name === "documentation-lookup"), "context7 still absent");

  const withFirecrawl = filterSkillsByMcp(catalog, ["firecrawl"]);
  assert.ok(withFirecrawl.some((s) => s.name === "deep-research"), "deep-research needs exa OR firecrawl");
});
