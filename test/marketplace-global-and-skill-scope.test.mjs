import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  globalPluginsDir,
  discoverPlugins,
  installMarketplacePlugin,
  listMarketplace,
  uninstallPluginAnywhere,
} from "../dist-electron/plugins-service.js";
import {
  createSkill,
  importSkill,
  changeSkillScope,
  setSkillModes,
  listSkills,
  globalSkillsDir,
  projectSkillsDir,
} from "../dist-electron/skills-service.js";
import { discoverPluginRules } from "../dist-electron/rules-service.js";
import { discoverCustomCommands } from "../dist-electron/custom-commands-service.js";
import { getAvailableAgents } from "../dist-electron/subagent-service.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      console.error(error);
      failed++;
    });
}

// Set up temporary directories for testing global and project plugins/skills
const testGlobalDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-global-test-"));
const testProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-proj-test-"));
process.env.NEXUS_GLOBAL_PLUGINS_DIR = path.join(testGlobalDir, "plugins");
process.env.NEXUS_GLOBAL_SKILLS_DIR = path.join(testGlobalDir, "skills");

try {
  await test("Marketplace plugin installs globally and is discovered without projectRoot", async () => {
    const bundleDir = path.join(testGlobalDir, "sample-bundle");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        id: "global-suite",
        name: "Global Suite",
        version: "1.0.0",
        capabilities: ["skills", "agents", "commands", "rules"],
      }),
      "utf8"
    );

    // Add bundled skill
    const skillDir = path.join(bundleDir, "skills", "global-helper");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: global-helper\ndescription: Global skill\n---\n\nHelper content.", "utf8");

    // Add bundled agent
    const agentDir = path.join(bundleDir, "agents");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "global-bot.md"), "---\nname: Global Bot\ndescription: Global bot\nrole: global-bot\n---\n\nBot prompt", "utf8");

    // Add bundled command
    const cmdDir = path.join(bundleDir, "commands");
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(path.join(cmdDir, "global-cmd.md"), "Global command instructions", "utf8");

    // Add bundled rule
    const ruleDir = path.join(bundleDir, "rules");
    await fs.mkdir(ruleDir, { recursive: true });
    await fs.writeFile(path.join(ruleDir, "global-rule.md"), "Global rule instructions", "utf8");

    // Install globally using isTargetDir
    const installed = await installMarketplacePlugin(
      globalPluginsDir(),
      {
        id: "global-suite",
        name: "Global Suite",
        version: "1.0.0",
        source: bundleDir,
        capabilities: ["skills", "agents", "commands", "rules"],
      },
      { isTargetDir: true }
    );

    assert.ok(installed, "installed plugin info returned");
    assert.equal(installed.name, "Global Suite");

    // Discovered without any project root passed
    const globalPlugins = await discoverPlugins(undefined);
    assert.ok(globalPlugins.some((p) => p.name === "Global Suite"), "discovered globally without project");

    // Skills listed without project
    const skills = await listSkills(undefined);
    assert.ok(skills.some((s) => s.name === "global-helper"), "global plugin skill discovered without project");

    // Agent available without project
    const agents = getAvailableAgents(undefined);
    assert.ok(agents.has("global-bot"), "global plugin agent discovered without project");

    // Command available without project
    const commands = await discoverCustomCommands(undefined);
    assert.ok(commands.some((c) => c.command === "/global-cmd"), "global plugin command discovered without project");

    // Rule available without project
    const rules = await discoverPluginRules(undefined);
    assert.ok(rules.some((r) => r.relativePath.includes("global-rule")), "global plugin rule discovered without project");

    // Uninstall globally
    await uninstallPluginAnywhere("global-suite");
    const afterUninstall = await discoverPlugins(undefined);
    assert.ok(!afterUninstall.some((p) => p.name === "Global Suite"), "uninstalled cleanly from global directory");
  });

  await test("createSkill enforces Code-mode-only condition for project scope", async () => {
    // Attempting to create project skill with all modes should throw
    await assert.rejects(
      () =>
        createSkill(testProjectDir, {
          name: "invalid-proj-skill",
          scope: "project",
          modes: [], // all modes
        }),
      /Only Code-mode-only skills can be created in project scope/
    );

    // Attempting to create project skill with home mode should throw
    await assert.rejects(
      () =>
        createSkill(testProjectDir, {
          name: "invalid-proj-skill-home",
          scope: "project",
          modes: ["home"],
        }),
      /Only Code-mode-only skills can be created in project scope/
    );

    // Creating project skill with code only should succeed
    const validProjSkill = await createSkill(testProjectDir, {
      name: "valid-proj-skill",
      scope: "project",
      modes: ["code"],
    });
    assert.equal(validProjSkill.source, "project");
    assert.deepEqual(validProjSkill.modes, ["code"]);
  });

  await test("changeSkillScope allows moving code-only skill to project, but rejects non-code skills", async () => {
    // Create global code-only skill
    const codeSkill = await createSkill(testProjectDir, {
      name: "code-opt-skill",
      scope: "global",
      modes: ["code"],
    });

    // Move to project scope -> should succeed
    const movedToProj = await changeSkillScope(codeSkill.path, "project", testProjectDir);
    assert.equal(movedToProj.source, "project");

    // Create global home-only skill
    const homeSkill = await createSkill(testProjectDir, {
      name: "home-writing-skill",
      scope: "global",
      modes: ["home"],
    });

    // Attempt to move home skill to project -> must throw
    await assert.rejects(
      () => changeSkillScope(homeSkill.path, "project", testProjectDir),
      /Only Code-mode-only skills can be scoped to a project/
    );

    const globalCodeSkill = await createSkill(testProjectDir, {
      name: "global-code-null-test",
      scope: "global",
      modes: ["code"],
    });

    // Attempt to move without active project -> must throw
    await assert.rejects(
      () => changeSkillScope(globalCodeSkill.path, "project", null),
      /Cannot move skill to project scope: no active project/
    );

    // Move valid project skill back to global -> succeeds
    const movedBack = await changeSkillScope(movedToProj.path, "global", testProjectDir);
    assert.equal(movedBack.source, "global");
  });

  await test("setSkillModes automatically reverts project skill to global if modes become non-code", async () => {
    // Create project skill with code-only
    const projSkill = await createSkill(testProjectDir, {
      name: "reverting-skill",
      scope: "project",
      modes: ["code"],
    });
    assert.equal(projSkill.source, "project");

    // Change modes to include home (e.g. ["home", "code"])
    const updated = await setSkillModes(projSkill.path, ["home", "code"], testProjectDir);
    assert.equal(updated.source, "global", "auto-reverted to global library");
    assert.deepEqual(updated.modes.sort(), ["code", "home"]);

    // Verify it is no longer in project directory
    const projList = (await listSkills(testProjectDir)).filter((s) => s.name === "reverting-skill");
    assert.equal(projList.length, 1);
    assert.equal(projList[0].source, "global");
  });

  await test("importSkill rejects non-code skills when destination scope is project", async () => {
    const importSourceDir = path.join(testProjectDir, "source-skill-to-import");
    await fs.mkdir(importSourceDir, { recursive: true });
    await fs.writeFile(
      path.join(importSourceDir, "SKILL.md"),
      "---\nname: imported-home-skill\nmodes: home\n---\n\nHome instructions",
      "utf8"
    );

    await assert.rejects(
      () => importSkill(testProjectDir, importSourceDir, "project"),
      /Only Code-mode-only skills can be imported into project scope/
    );

    // Importing as global succeeds
    const importedGlobal = await importSkill(testProjectDir, importSourceDir, "global");
    assert.equal(importedGlobal.source, "global");
  });
} finally {
  await fs.rm(testGlobalDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(testProjectDir, { recursive: true, force: true }).catch(() => {});
}

if (failed > 0) {
  console.error(`\nTests failed: ${failed}`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} marketplace global and skill scope tests passed!`);
}
