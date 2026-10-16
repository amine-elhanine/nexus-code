// Out-of-process runner: activate → call-tool → timeout/crash/isolation/cleanup.
// Imports from dist-electron — build first (runner cjs is copied by build:electron).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startPluginProcess,
  stopPluginProcess,
  stopAllPluginProcesses,
  getPluginProcess,
  resolvePluginEntry,
} from '../dist-electron/plugin-process-host.js';
import {
  discoverExecutablePlugin,
  enablePlugin,
  disablePlugin,
  disposePlugin,
  clearManagedPlugins,
} from '../dist-electron/plugin-lifecycle.js';
import { executePluginTool } from '../dist-electron/tool-executor.js';
import { setGrantedPermissions, clearGrantedPermissions } from '../dist-electron/plugin-permissions.js';
import { clearAllCapabilities, listCapabilities } from '../dist-electron/capability-registry.js';

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

async function makePlugin(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runner-'));
  const pluginDir = path.join(dir, 'plug');
  await fs.mkdir(pluginDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pluginDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return { root: dir, pluginDir };
}

async function cleanup(root) {
  await stopAllPluginProcesses().catch(() => undefined);
  clearManagedPlugins();
  clearAllCapabilities();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

await test('activate collects tools/commands/logs; call-tool executes the handler', async () => {
  const { root, pluginDir } = await makePlugin({
    'dist/index.js': [
      'nexus.registerTool({ name: "greet", description: "Greet", handler: (args) => `hi ${args.name}` });',
      'nexus.registerCommand({ name: "hello", description: "Hi" });',
      'nexus.log("ready");',
    ].join('\n'),
  });
  try {
    const { process: proc, activation } = await startPluginProcess('t1', pluginDir, './dist/index.js');
    assert.ok(proc.alive);
    assert.equal(activation.tools.length, 1);
    assert.equal(activation.tools[0].name, 'greet');
    assert.equal(activation.tools[0].hasHandler, true);
    assert.equal(activation.commands.length, 1);
    assert.ok(activation.logs.includes('ready'));
    const output = await proc.callTool('greet', { name: 'ada' }, 'home', 5000);
    assert.equal(output, 'hi ada');
    await stopPluginProcess('t1');
    assert.equal(getPluginProcess('t1'), undefined);
  } finally {
    await cleanup(root);
  }
});

await test('entry without handler registers metadata; call-tool reports clearly', async () => {
  const { root, pluginDir } = await makePlugin({
    'dist/index.js': 'nexus.registerTool({ name: "meta", description: "No handler" });\n',
  });
  try {
    const { activation, process: proc } = await startPluginProcess('t2', pluginDir, './dist/index.js');
    assert.equal(activation.tools[0].hasHandler, false);
    let threw = false;
    try {
      await proc.callTool('meta', {}, 'home', 3000);
    } catch (error) {
      threw = true;
      assert.ok(String(error.message).includes('no executable handler'));
    }
    assert.ok(threw);
    await stopPluginProcess('t2');
  } finally {
    await cleanup(root);
  }
});

await test('blocked globals stay blocked in the runner (require/process/fetch)', async () => {
  const { root, pluginDir } = await makePlugin({
    'dist/index.js': [
      'const results = [];',
      'try { require("fs"); results.push("require"); } catch (e) { nexus.log("no-require"); }',
      'try { process.exit(0); results.push("process"); } catch (e) { nexus.log("no-process"); }',
      'nexus.registerTool({ name: "probe", description: "Probe", handler: () => JSON.stringify({',
      '  hasRequire: typeof require !== "undefined",',
      '  hasProcess: typeof process !== "undefined",',
      '  leaked: results.join(","),',
      '}) });',
    ].join('\n'),
  });
  try {
    const { activation, process: proc } = await startPluginProcess('t3', pluginDir, './dist/index.js');
    assert.ok(activation.logs.includes('no-require'));
    assert.ok(activation.logs.includes('no-process'));
    const output = JSON.parse(await proc.callTool('probe', {}, 'home', 5000));
    assert.equal(output.hasRequire, false);
    assert.equal(output.hasProcess, false);
    assert.equal(output.leaked, '');
    await stopPluginProcess('t3');
  } finally {
    await cleanup(root);
  }
});

await test('top-level throw fails activation with the error (no silent load)', async () => {
  const { root, pluginDir } = await makePlugin({
    'dist/index.js': 'throw new Error("boom-at-load");\n',
  });
  try {
    let threw = false;
    try {
      await startPluginProcess('t4', pluginDir, './dist/index.js');
    } catch (error) {
      threw = true;
      assert.ok(String(error.message).includes('boom-at-load'));
    }
    assert.ok(threw);
    assert.equal(getPluginProcess('t4'), undefined, 'failed activation must not leak a tracked process');
  } finally {
    await cleanup(root);
  }
});

await test('hanging handler times out on the host side', async () => {
  const { root, pluginDir } = await makePlugin({
    'dist/index.js': 'nexus.registerTool({ name: "hang", description: "Hang", handler: () => new Promise(() => {}) });\n',
  });
  try {
    const { process: proc } = await startPluginProcess('t5', pluginDir, './dist/index.js');
    let threw = false;
    try {
      await proc.callTool('hang', {}, 'home', 1000);
    } catch (error) {
      threw = true;
      assert.ok(String(error.message).includes('timed out'));
    }
    assert.ok(threw, 'hanging handler must time out');
    await stopPluginProcess('t5');
  } finally {
    await cleanup(root);
  }
});

await test('entry traversal rejected before spawn', async () => {
  const { root, pluginDir } = await makePlugin({
    'dist/index.js': 'nexus.log("x");\n',
  });
  try {
    assert.throws(() => resolvePluginEntry(pluginDir, '../escape.js'), /escapes/);
    assert.throws(() => resolvePluginEntry(pluginDir, '/abs.js'), /escapes/);
  } finally {
    await cleanup(root);
  }
});

await test('lifecycle enable executes a real tool end-to-end via the runner', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'echo-plug',
      name: 'Echo',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['tools'],
      modes: ['home'],
      permissions: [],
      entry: './dist/index.js',
    }),
    'dist/index.js': 'nexus.registerTool({ name: "echo", description: "Echo back", requiresApproval: false, handler: (args) => ({ you: args.say }) });\n',
  });
  try {
    clearManagedPlugins();
    clearAllCapabilities();
    await discoverExecutablePlugin(pluginDir);
    const enabled = await enablePlugin({ id: 'echo-plug', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true);
    assert.ok(getPluginProcess('echo-plug')?.alive, 'runner process should be alive after enable');
    setGrantedPermissions('echo-plug', []);
    const result = await executePluginTool('echo-plug', 'echo', { say: 'hi' }, { pluginId: 'echo-plug', mode: 'home' }, { granted: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { you: 'hi' });
    await disablePlugin('echo-plug');
    assert.equal(getPluginProcess('echo-plug'), undefined, 'disable must kill the runner');
    assert.equal(listCapabilities({ owner: 'echo-plug' }).length, 0);
    await disposePlugin('echo-plug').catch(() => undefined);
    clearGrantedPermissions('echo-plug');
  } finally {
    await cleanup(root);
  }
});

await test('lifecycle failed enable kills the child (no orphans)', async () => {
  const { root, pluginDir } = await makePlugin({
    'manifest.json': JSON.stringify({
      id: 'bad-runner',
      name: 'Bad',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['tools'],
      entry: './dist/index.js',
    }),
    'dist/index.js': 'throw new Error("load-boom");\n',
  });
  try {
    clearManagedPlugins();
    clearAllCapabilities();
    await discoverExecutablePlugin(pluginDir);
    const result = await enablePlugin({ id: 'bad-runner', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(result.ok, false);
    assert.equal(getPluginProcess('bad-runner'), undefined);
  } finally {
    await cleanup(root);
  }
});

console.log(`\nplugin-runner: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
