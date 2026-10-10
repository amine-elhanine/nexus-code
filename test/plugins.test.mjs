// Plugins-as-bundles: discovery + automatic pickup by skills and hooks.
// Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverPlugins, installMarketplacePlugin, normalizePluginModes, pluginSkillDirs, pluginHookFiles, pluginAgentDirs, pluginCommandDirs, pluginRuleDirs, uninstallPlugin, detectPluginCapabilities } from '../dist-electron/plugins-service.js';
import { listSkills, skillAppliesToMode } from '../dist-electron/skills-service.js';
import { discoverHooks } from '../dist-electron/hooks-service.js';
import { getAvailableAgents, getAllSubagentRoles, buildSubagentCatalog } from '../dist-electron/subagent-service.js';
import { discoverCustomCommands } from '../dist-electron/custom-commands-service.js';
import { discoverPluginRules, discoverAllRules } from '../dist-electron/rules-service.js';

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

await test('discoverPlugins finds plugin dirs; manifest optional, malformed tolerated', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugins-'));
  try {
    assert.deepEqual(await discoverPlugins(tempDir), [], 'no plugins dir → empty');
    const withManifest = path.join(tempDir, '.nexus', 'plugins', 'acme-tools');
    await fs.mkdir(withManifest, { recursive: true });
    await fs.writeFile(path.join(withManifest, 'manifest.json'), JSON.stringify({ name: 'Acme Tools', description: 'demo', version: '1.0.0' }), 'utf8');
    const withoutManifest = path.join(tempDir, '.nexus', 'plugins', 'bare-bones');
    await fs.mkdir(withoutManifest, { recursive: true });
    const malformed = path.join(tempDir, '.nexus', 'plugins', 'broken');
    await fs.mkdir(malformed, { recursive: true });
    await fs.writeFile(path.join(malformed, 'manifest.json'), '{not json', 'utf8');

    const plugins = await discoverPlugins(tempDir);
    assert.equal(plugins.length, 3, `all three dirs discovered, got ${plugins.length}`);
    const acme = plugins.find((p) => p.name === 'Acme Tools');
    assert.ok(acme, 'manifest name wins');
    assert.ok(plugins.find((p) => p.name === 'bare-bones'), 'dir name is the fallback');
    assert.ok(plugins.find((p) => p.name === 'broken'), 'malformed manifest still a plugin');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('plugin skills and hooks are picked up automatically', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugins2-'));
  try {
    const pluginDir = path.join(tempDir, '.nexus', 'plugins', 'acme-tools');
    const skillDir = path.join(pluginDir, 'skills', 'deploy-checklist');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: deploy-checklist\ndescription: Pre-deploy verification steps\n---\n\nCheck these before shipping.', 'utf8');
    await fs.writeFile(path.join(pluginDir, 'hooks.json'), JSON.stringify({ hooks: [{ event: 'run:end', command: 'node notify.js' }] }), 'utf8');

    assert.deepEqual(await pluginSkillDirs(tempDir), [path.join(pluginDir, 'skills')]);
    const skills = await listSkills(tempDir);
    assert.ok(skills.some((s) => s.name === 'deploy-checklist' && s.source === 'project'), `plugin skill listed, got: ${skills.map((s) => s.name).join(', ')}`);

    const hooks = await discoverHooks(tempDir);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].event, 'run:end');
    assert.equal(hooks[0].command, 'node notify.js');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('Marketplace installs a local bundle transactionally and makes its skill available', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-market-install-'));
  try {
    const source = path.join(tempDir, 'release-notes');
    await fs.mkdir(path.join(source, 'skills', 'release-notes'), { recursive: true });
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ id: 'release-notes', name: 'Release Notes', version: '1.2.0' }), 'utf8');
    await fs.writeFile(path.join(source, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Draft release notes\n---\n\nCreate release notes.', 'utf8');

    const project = path.join(tempDir, 'project');
    await fs.mkdir(project, { recursive: true });
    const installed = await installMarketplacePlugin(project, { id: 'release-notes', name: 'Release Notes', source });
    assert.equal(installed.name, 'Release Notes');
    assert.equal(installed.manifest.version, '1.2.0');
    assert.equal(await fs.readFile(path.join(project, '.nexus', 'plugins', 'release-notes', 'manifest.json'), 'utf8').then(JSON.parse).then((manifest) => manifest.id), 'release-notes');
    const skills = await listSkills(project);
    assert.ok(skills.some((skill) => skill.name === 'release-notes'), 'installed plugin skill should be active immediately');

    await uninstallPlugin(project, 'release-notes');
    assert.equal((await discoverPlugins(project)).length, 0, 'uninstall removes the installed bundle');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('Plugin manifest modes scope skills by default; skill frontmatter overrides; hooks filtered by mode', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugin-modes-'));
  try {
    const pluginDir = path.join(tempDir, '.nexus', 'plugins', 'scoped');
    await fs.mkdir(path.join(pluginDir, 'skills', 'a-skill'), { recursive: true });
    await fs.mkdir(path.join(pluginDir, 'skills', 'b-skill'), { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'scoped', name: 'Scoped', modes: ['code'] }), 'utf8');
    await fs.writeFile(path.join(pluginDir, 'skills', 'a-skill', 'SKILL.md'), '---\nname: a-skill\ndescription: Inherits plugin modes\n---\n\nHi.', 'utf8');
    await fs.writeFile(path.join(pluginDir, 'skills', 'b-skill', 'SKILL.md'), '---\nname: b-skill\ndescription: Overrides plugin modes\nmodes: home\n---\n\nHi.', 'utf8');
    await fs.writeFile(path.join(pluginDir, 'hooks.json'), JSON.stringify({ hooks: [{ event: 'run:end', command: 'node x.js' }] }), 'utf8');

    assert.deepEqual(normalizePluginModes('code, bogus, HOME'), ['code', 'home'], 'unknown modes dropped, case normalized');

    const skills = await listSkills(tempDir);
    const a = skills.find((s) => s.name === 'a-skill');
    const b = skills.find((s) => s.name === 'b-skill');
    assert.ok(a, 'inheriting skill listed');
    assert.deepEqual(a.modes, ['code'], 'skill without modes inherits plugin default');
    assert.ok(skillAppliesToMode(a, 'code'), 'inherited skill eligible in code');
    assert.ok(!skillAppliesToMode(a, 'home'), 'inherited skill blocked in home');
    assert.ok(b, 'overriding skill listed');
    assert.deepEqual(b.modes, ['home'], 'explicit skill modes win over plugin default');

    assert.equal((await discoverHooks(tempDir, 'code')).length, 1, 'plugin hooks fire in an allowed mode');
    assert.equal((await discoverHooks(tempDir, 'home')).length, 0, 'plugin hooks skipped in other modes');
    assert.equal((await discoverHooks(tempDir)).length, 1, 'no mode filter keeps old behavior');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('Plugin agents are discovered and available for subagent delegation and catalog', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugin-agents-'));
  try {
    const pluginDir = path.join(tempDir, '.nexus', 'plugins', 'db-tools');
    const agentsDir = path.join(pluginDir, 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'db-tools', name: 'Database Tools', modes: ['code'] }), 'utf8');
    await fs.writeFile(path.join(agentsDir, 'db-optimizer.md'), '---\nname: db-optimizer\ndescription: SQL and indexing optimization expert\n---\n\nAnalyze query performance and indexes.', 'utf8');

    const agentDirs = await pluginAgentDirs(tempDir);
    assert.deepEqual(agentDirs, [agentsDir]);

    const available = getAvailableAgents(tempDir);
    assert.ok(available.has('db-optimizer'), 'plugin subagent should be available in getAvailableAgents');
    const opt = available.get('db-optimizer');
    assert.equal(opt.title, 'Db Optimizer');
    assert.equal(opt.description, 'SQL and indexing optimization expert');
    assert.equal(opt.source, 'plugin');

    const roles = getAllSubagentRoles(tempDir);
    assert.ok(roles.includes('db-optimizer'), 'plugin subagent role included in getAllSubagentRoles');

    const catalog = buildSubagentCatalog(tempDir);
    assert.ok(catalog.includes('`db-optimizer`'), 'catalog should include plugin subagent');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('Plugin commands are discovered and parsed as custom slash commands', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugin-commands-'));
  try {
    const pluginDir = path.join(tempDir, '.nexus', 'plugins', 'devops-pack');
    const commandsDir = path.join(pluginDir, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'devops-pack', name: 'DevOps Pack', modes: ['code'] }), 'utf8');
    await fs.writeFile(path.join(commandsDir, 'deploy-staging.md'), '---\nname: Deploy Staging\ndescription: Deploy current commit to staging environment\n---\n\nDeploy to staging cluster: {{input}}', 'utf8');

    const commandDirs = await pluginCommandDirs(tempDir);
    assert.deepEqual(commandDirs, [commandsDir]);

    const cmds = await discoverCustomCommands(tempDir, 'code');
    const deployCmd = cmds.find((c) => c.command === '/deploy-staging');
    assert.ok(deployCmd, 'plugin custom command /deploy-staging should be discovered');
    assert.equal(deployCmd.name, 'Deploy Staging');
    assert.equal(deployCmd.description, 'Deploy current commit to staging environment');

    // Filtered out in home area because plugin is scoped to 'code'
    const homeCmds = await discoverCustomCommands(tempDir, 'home');
    assert.ok(!homeCmds.some((c) => c.command === '/deploy-staging'), 'command scoped to code should not appear in home area');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('Plugin rules are discovered and appended to prompt section', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugin-rules-'));
  try {
    const pluginDir = path.join(tempDir, '.nexus', 'plugins', 'team-standards');
    const rulesDir = path.join(pluginDir, 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'team-standards', name: 'Team Standards' }), 'utf8');
    await fs.writeFile(path.join(rulesDir, 'code-style.md'), 'Always write unit tests for public methods.', 'utf8');

    const ruleDirs = await pluginRuleDirs(tempDir);
    assert.deepEqual(ruleDirs, [rulesDir]);

    const pluginRules = await discoverPluginRules(tempDir);
    assert.equal(pluginRules.length, 1);
    assert.equal(pluginRules[0].filename, 'code-style.md');
    assert.equal(pluginRules[0].source, 'plugin');
    assert.ok(pluginRules[0].content.includes('Always write unit tests'));

    const allRules = await discoverAllRules(tempDir);
    assert.ok(allRules.hasRules);
    assert.ok(allRules.combinedPromptSection.includes('Plugin-Provided Rules & Standards'));
    assert.ok(allRules.combinedPromptSection.includes('Always write unit tests for public methods.'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('detectPluginCapabilities auto-detects skills, agents, commands, rules, and hooks', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-plugin-caps-'));
  try {
    const pluginDir = path.join(tempDir, '.nexus', 'plugins', 'full-bundle');
    await fs.mkdir(path.join(pluginDir, 'skills'), { recursive: true });
    await fs.mkdir(path.join(pluginDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(pluginDir, 'commands'), { recursive: true });
    await fs.mkdir(path.join(pluginDir, 'rules'), { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'hooks.json'), JSON.stringify({ hooks: [] }), 'utf8');

    const caps = detectPluginCapabilities(pluginDir);
    assert.deepEqual(caps.sort(), ['agents', 'commands', 'hooks', 'rules', 'skills']);

    const plugins = await discoverPlugins(tempDir);
    const full = plugins.find((p) => p.name === 'full-bundle');
    assert.ok(full);
    assert.deepEqual(full.manifest.capabilities.sort(), ['agents', 'commands', 'hooks', 'rules', 'skills']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
