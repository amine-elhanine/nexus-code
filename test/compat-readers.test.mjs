// Tests for Claude/OpenCode-compatible directory readers (G11 parity):
// skills from .claude/skills + .agents/skills, commands from .claude/commands
// + .agents/commands, agents from .claude/agents + .agents/agents — all
// READ-ONLY compat: discoverable and usable, never deletable via Nexus, and
// native .nexus resources always win on name collisions.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { mkdirScratch } = await import("./helpers/scratch.mjs");
const { listSkills, readSkillContent, skillVirtualPath, deleteSkill, COMPAT_PROJECT_SKILL_DIRS } = await import("../dist-electron/skills-service.js");
const { discoverCustomCommands } = await import("../dist-electron/custom-commands-service.js");
const { discoverCompatAgents, getAvailableAgents } = await import("../dist-electron/subagent-service.js");

async function makeSkill(root, dir, name, description, body = "Useful instructions.") {
  const skillDir = path.join(root, dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return skillDir;
}

test("compat skills: .claude/skills and .agents/skills are discovered as project skills", async () => {
  const root = await mkdirScratch("nx-compat-skills-");
  await makeSkill(root, ".claude/skills", "troy-researcher", "Researches the Trojan war");
  await makeSkill(root, ".agents/skills", "alps-planner", "Plans alpine crossings");
  // Native skill with the same name as a compat copy → native wins.
  await makeSkill(root, ".claude/skills", "shared", "Claude copy");
  await makeSkill(root, ".nexus/skills", "shared", "Native copy");

  const skills = await listSkills(root);
  const names = skills.filter((s) => s.source === "project").map((s) => s.name);
  assert.ok(names.includes("troy-researcher"), "claude skill missing: " + JSON.stringify(names));
  assert.ok(names.includes("alps-planner"), "agents skill missing");
  const shared = skills.find((s) => s.name === "shared" && s.source === "project");
  assert.match(shared.description, /Native copy/, "native .nexus skill must win collisions");
});

test("compat skills: readable via readSkillContent; virtual path maps into the workspace", async () => {
  const root = await mkdirScratch("nx-compat-read-");
  await makeSkill(root, ".claude/skills", "reader-check", "Readable compat skill", "COMPAT_BODY_MARKER");
  const skills = await listSkills(root);
  const skill = skills.find((s) => s.name === "reader-check");
  const content = await readSkillContent(skill.path, root);
  assert.match(content, /COMPAT_BODY_MARKER/);
  const virtual = skillVirtualPath(skill);
  assert.equal(virtual, ".claude/skills/reader-check/SKILL.md");
});

test("compat skills: deletion through Nexus is refused (foreign library)", async () => {
  const root = await mkdirScratch("nx-compat-del-");
  const dir = await makeSkill(root, ".claude/skills", "protected", "Do not delete me");
  await assert.rejects(() => deleteSkill(path.join(dir, "SKILL.md"), root), /outside the authorized|not a skill directory|Refusing/);
  // The file must still exist.
  await fs.access(path.join(dir, "SKILL.md"));
});

test("compat commands: .claude/commands discovered with frontmatter; .nexus wins collisions", async () => {
  const root = await mkdirScratch("nx-compat-cmds-");
  await fs.mkdir(path.join(root, ".claude/commands"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".claude/commands", "review-pr.md"),
    "---\ndescription: Review the current PR\n---\nReview the diff and comment on $ARGUMENTS."
  );
  await fs.mkdir(path.join(root, ".nexus/commands"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".nexus/commands", "deploy.md"),
    "---\ndescription: Native deploy\n---\nDeploy now."
  );
  await fs.writeFile(
    path.join(root, ".claude/commands", "deploy.md"),
    "---\ndescription: Claude deploy (must lose)\n---\nDeploy differently."
  );
  const commands = await discoverCustomCommands(root, "code");
  const review = commands.find((c) => c.command === "/review-pr");
  assert.ok(review, "claude command missing");
  assert.match(review.description, /Review the current PR/);
  assert.match(review.promptTemplate, /\$ARGUMENTS/);
  const deploy = commands.find((c) => c.command === "/deploy");
  assert.match(deploy.description, /Native deploy/, "native .nexus command must win collisions");
});

test("compat agents: .claude/agents discovered; tuned configs still own their roles", async () => {
  const root = await mkdirScratch("nx-compat-agents-");
  await fs.mkdir(path.join(root, ".claude/agents"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".claude/agents", "troy-analyst.md"),
    "---\nname: troy-analyst\ndescription: Analyzes the Trojan war sources\n---\nYou are a careful analyst."
  );
  const compat = discoverCompatAgents(root);
  assert.ok(compat.has("troy-analyst"), "claude agent missing: " + JSON.stringify([...compat.keys()]));
  assert.match(compat.get("troy-analyst").description, /Trojan war/);
  // A compat file shadowing a TUNED config role (researcher) appears in the
  // available map, but the catalog still advertises the tuned config's
  // description — execution prefers SUBAGENT_CONFIGS unconditionally.
  await fs.writeFile(
    path.join(root, ".claude/agents", "researcher.md"),
    "---\nname: researcher\ndescription: Compat shadow\n---\nShadow."
  );
  const { buildSubagentCatalog } = await import("../dist-electron/subagent-service.js");
  const catalog = buildSubagentCatalog(root);
  assert.match(catalog, /researcher/);
  assert.doesNotMatch(catalog, /Compat shadow/, "tuned config must own the researcher role in the catalog");
  const available = getAvailableAgents(root);
  assert.ok(available.has("troy-analyst"), "compat agents must be in the available set");
});

test("compat roots list matches the shipped contract", () => {
  assert.deepEqual(COMPAT_PROJECT_SKILL_DIRS, [".claude/skills", ".agents/skills"]);
});
