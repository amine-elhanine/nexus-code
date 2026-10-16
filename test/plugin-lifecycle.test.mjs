// Plugin lifecycle: discover → validate → enable → disable → dispose.
// Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverExecutablePlugin,
  enablePlugin,
  disablePlugin,
  disposePlugin,
  listManagedPlugins,
  clearManagedPlugins,
} from '../dist-electron/plugin-lifecycle.js';
import { listCapabilities, clearAllCapabilities } from '../dist-electron/capability-registry.js';
import { getGrantedPermissions } from '../dist-electron/plugin-permissions.js';
import { stopAllPluginProcesses } from '../dist-electron/plugin-process-host.js';

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

function reset() {
  clearManagedPlugins();
  clearAllCapabilities();
}

async function makePlugin(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-lifecycle-'));
  const pluginDir = path.join(dir, 'plug');
  await fs.mkdir(pluginDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pluginDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return { root: dir, pluginDir };
}

// Runner children hold their plugin dir as cwd (Windows locks it).
// Always stop processes BEFORE removing temp dirs.
async function teardown(root) {
  await stopAllPluginProcesses().catch(() => undefined);
  clearManagedPlugins();
  clearAllCapabilities();
  // Brief grace for the OS to release directory locks.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

await test('discover validates strict manifest; invalid fails deterministically', async () => {
  reset();
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({ id: 'good', name: 'Good', version: '1.0.0', capabilities: ['skills'] }),
  });
  try {
    const record = await discoverExecutablePlugin(pluginDir);
    assert.equal(record.status, 'discovered');
    assert.equal(record.id, 'good');
    const bad = await makePlugin({ 'manifest.json': JSON.stringify({ id: 'bad', name: 'Bad', capabilities: ['tools'] }) });
    try {
      const failedRecord = await discoverExecutablePlugin(bad.pluginDir);
      assert.equal(failedRecord.status, 'failed');
      assert.ok(failedRecord.error);
    } finally {
      await teardown(bad.root);
    }
  } finally {
    await teardown(root);
  }
});

await test('enable registers sandboxed tools+commands; disable cleans up', async () => {
  reset();
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'hello-tool',
      name: 'Hello Tool',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['tools', 'commands'],
      modes: ['home', 'code'],
      permissions: [],
      entry: './dist/index.js',
    }),
    'dist/index.js': 'nexus.registerTool({ name: "greet", description: "Greet" });\nnexus.registerCommand({ name: "hello", description: "Hi" });\n',
  });
  try {
    await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'hello-tool', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true);
    const caps = listCapabilities({ owner: 'hello-tool' });
    assert.ok(caps.some((c) => c.id === 'hello-tool:greet'), `expected tool, got ${caps.map((c) => c.id)}`);
    assert.ok(caps.some((c) => c.id === 'hello-tool:hello'), `expected command, got ${caps.map((c) => c.id)}`);
    assert.deepEqual(getGrantedPermissions('hello-tool'), []);
    await disablePlugin('hello-tool');
    assert.equal(listCapabilities({ owner: 'hello-tool' }).length, 0, 'disable must remove all capabilities');
    assert.deepEqual(getGrantedPermissions('hello-tool'), [], 'disable must clear grants');
  } finally {
    await teardown(root);
  }
});

await test('enable fails on missing dependency and leaves no stale state', async () => {
  reset();
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'needy',
      name: 'Needy',
      version: '1.0.0',
      capabilities: ['skills'],
      dependencies: { 'missing-dep': '^1.0.0' },
    }),
  });
  try {
    await discoverExecutablePlugin(pluginDir);
    const result = await enablePlugin({ id: 'needy', appVersion: '0.4.5', approvedPermissions: [], availablePluginIds: [] });
    assert.equal(result.ok, false);
    assert.ok(String(result.error).includes('missing dependency'));
    assert.equal(listCapabilities({ owner: 'needy' }).length, 0);
  } finally {
    await teardown(root);
  }
});

await test('enable fails when permissions not approved; duplicate enable rolls back cleanly', async () => {
  reset();
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'perm-plug',
      name: 'Perm',
      version: '1.0.0',
      capabilities: ['skills'],
      permissions: ['workspace.read'],
    }),
  });
  try {
    await discoverExecutablePlugin(pluginDir);
    const denied = await enablePlugin({ id: 'perm-plug', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(denied.ok, false);
    const allowed = await enablePlugin({ id: 'perm-plug', appVersion: '0.4.5', approvedPermissions: ['workspace.read'] });
    assert.equal(allowed.ok, true);
    await disposePlugin('perm-plug');
    assert.equal(listManagedPlugins().find((p) => p.id === 'perm-plug'), undefined);
  } finally {
    await teardown(root);
  }
});

await test('malicious entry (require/process) cannot escape the sandbox', async () => {
  reset();
  // Top-level require() without a catch: ReferenceError in the sandbox → enable fails safely.
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'evil-entry',
      name: 'Evil',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['tools'],
      entry: './dist/index.js',
    }),
    'dist/index.js': 'nexus.registerTool({ name: "t", description: "t" });\nrequire("fs");\n',
  });
  try {
    await discoverExecutablePlugin(pluginDir);
    const result = await enablePlugin({ id: 'evil-entry', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(result.ok, false);
    assert.equal(listCapabilities({ owner: 'evil-entry' }).length, 0, 'failed enable must not leave capabilities');
  } finally {
    await teardown(root);
  }
});

await test('sandboxed entry that handles blocked globals still registers safely', async () => {
  reset();
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'caught-entry',
      name: 'Caught',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['tools'],
      entry: './dist/index.js',
    }),
    'dist/index.js': 'nexus.registerTool({ name: "t", description: "t" });\ntry { require("fs"); } catch (e) { nexus.log("blocked"); }\n',
  });
  try {
    await discoverExecutablePlugin(pluginDir);
    const result = await enablePlugin({ id: 'caught-entry', appVersion: '0.4.5', approvedPermissions: [] });
    // Caught ReferenceError: entry completes, tool registers through the gated registry.
    assert.equal(result.ok, true);
    assert.ok(listCapabilities({ owner: 'caught-entry' }).some((c) => c.id === 'caught-entry:t'));
    await disablePlugin('caught-entry');
  } finally {
    await teardown(root);
  }
});

console.log(`\nplugin-lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
