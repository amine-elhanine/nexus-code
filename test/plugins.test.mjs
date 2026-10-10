// Plugins-as-bundles: discovery + automatic pickup by skills and hooks.
// Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverPlugins, installMarketplacePlugin, pluginSkillDirs, pluginHookFiles, uninstallPlugin } from '../dist-electron/plugins-service.js';
import { listSkills } from '../dist-electron/skills-service.js';
import { discoverHooks } from '../dist-electron/hooks-service.js';

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
