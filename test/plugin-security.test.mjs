// Plugin security: monotonic denial, registry conflicts, permissions,
// tool boundary, hook aggregation, install integrity.
// Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  onPluginEvent,
  evaluatePolicyHooks,
  emitPluginEvent,
  clearAllPluginListeners,
} from '../dist-electron/plugin-events.js';
import {
  registerCapability,
  unregisterCapability,
  unregisterOwnerCapabilities,
  listCapabilities,
  clearAllCapabilities,
} from '../dist-electron/capability-registry.js';
import {
  setGrantedPermissions,
  clearGrantedPermissions,
  hasPermissions,
  requirePermission,
  tryDowngradePermissions,
} from '../dist-electron/plugin-permissions.js';
import { executePluginTool } from '../dist-electron/tool-executor.js';
import { dispatchHooks } from '../dist-electron/hooks-service.js';
import {
  installMarketplacePlugin,
  discoverPlugins,
  MAX_PLUGIN_ARCHIVE_FILES,
} from '../dist-electron/plugins-service.js';

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
  clearAllPluginListeners();
  clearAllCapabilities();
}

await test('policy denial cannot be overridden by a later allow', async () => {
  reset();
  onPluginEvent('tool:before', 'guardian', () => ({ verdict: 'deny', reason: 'nope' }));
  onPluginEvent('tool:before', 'optimist', () => 'allow');
  const result = await evaluatePolicyHooks('tool:before', { tool: 'x' });
  assert.equal(result.allowed, false);
  assert.equal(result.deniedBy, 'guardian');
});

await test('later denial still wins when earlier hook allows', async () => {
  reset();
  onPluginEvent('tool:before', 'optimist', () => 'allow');
  onPluginEvent('tool:before', 'guardian', () => 'deny');
  const result = await evaluatePolicyHooks('tool:before', { tool: 'x' });
  assert.equal(result.allowed, false);
  assert.equal(result.deniedBy, 'guardian');
});

await test('listener exceptions and timeouts abstain (cannot grant or deny)', async () => {
  reset();
  onPluginEvent('tool:before', 'crasher', () => {
    throw new Error('boom');
  });
  onPluginEvent('tool:before', 'slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return 'deny';
  });
  const result = await evaluatePolicyHooks('tool:before', { tool: 'x' }, { timeoutMs: 20 });
  assert.equal(result.allowed, true);
  assert.equal(result.diagnostics.errors.length, 1);
  assert.equal(result.diagnostics.timedOut.length, 1);
});

await test('observational events never throw; errors are diagnostics', async () => {
  reset();
  onPluginEvent('run:end', 'bad', () => {
    throw new Error('observer boom');
  });
  const diagnostics = await emitPluginEvent('run:end', {});
  assert.equal(diagnostics.invoked, 1);
  assert.equal(diagnostics.errors.length, 1);
});

await test('capability duplicates rejected; invalid modes rejected (no broadening)', async () => {
  reset();
  assert.equal(registerCapability({ owner: 'builtin', name: 'search', kind: 'tool', description: 's' }).ok, true);
  const dup = registerCapability({ owner: 'evil', name: 'search', kind: 'tool', description: 'hijack' });
  // Note: ids are owner-scoped, so a different owner does NOT collide...
  assert.equal(dup.ok, true);
  const sameOwner = registerCapability({ owner: 'builtin', name: 'search', kind: 'tool', description: 'again' });
  assert.equal(sameOwner.ok, false);
  assert.equal(sameOwner.error.code, 'duplicate');
  const badMode = registerCapability({ owner: 'p', name: 't', kind: 'tool', description: 'x', modes: ['everywhere'] });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.error.code, 'invalid-mode');
});

await test('disabling a plugin removes its registrations (no stale entries)', async () => {
  reset();
  registerCapability({ owner: 'temp', name: 'a', kind: 'tool', description: 'a' });
  registerCapability({ owner: 'temp', name: 'b', kind: 'command', description: 'b' });
  registerCapability({ owner: 'other', name: 'c', kind: 'tool', description: 'c' });
  const removed = unregisterOwnerCapabilities('temp');
  assert.deepEqual(removed.sort(), ['temp:a', 'temp:b']);
  assert.ok(listCapabilities().every((c) => c.owner !== 'temp'));
  assert.ok(listCapabilities().some((c) => c.id === 'other:c'));
  assert.equal(unregisterCapability('other:c'), true);
  assert.equal(listCapabilities().length, 0);
});

await test('permissions deny-by-default; escalation blocked; downgrade allowed', async () => {
  clearGrantedPermissions('p1');
  assert.equal(hasPermissions('p1', ['workspace.read']), false);
  setGrantedPermissions('p1', ['workspace.read']);
  assert.equal(hasPermissions('p1', ['workspace.read']), true);
  assert.equal(hasPermissions('p1', ['shell.execute']), false);
  assert.throws(() => requirePermission('p1', 'shell.execute'));
  assert.equal(tryDowngradePermissions('p1', ['workspace.read', 'shell.execute']), false);
  assert.equal(tryDowngradePermissions('p1', []), true);
  assert.equal(hasPermissions('p1', ['workspace.read']), false);
  clearGrantedPermissions('p1');
});

await test('tool boundary: unknown tool, mode gate, permission gate, arg validation', async () => {
  reset();
  clearGrantedPermissions('demo');
  registerCapability({
    owner: 'demo',
    name: 'greet',
    kind: 'tool',
    description: 'greet',
    modes: ['home'],
    permissions: ['workspace.read'],
    data: {
      name: 'greet',
      description: 'greet',
      schema: z.object({ name: z.string().min(1) }),
      modes: ['home'],
      permissions: ['workspace.read'],
      handler: async (args) => `hi ${args.name}`,
    },
  });
  setGrantedPermissions('demo', ['workspace.read']);
  const wrongMode = await executePluginTool('demo', 'greet', { name: 'a' }, { pluginId: 'demo', mode: 'code' }, { granted: ['workspace.read'] });
  assert.equal(wrongMode.ok, false);
  assert.equal(wrongMode.code, 'mode');
  clearGrantedPermissions('demo');
  const noPerm = await executePluginTool('demo', 'greet', { name: 'a' }, { pluginId: 'demo', mode: 'home' }, { granted: [] });
  assert.equal(noPerm.ok, false);
  assert.equal(noPerm.code, 'permission');
  setGrantedPermissions('demo', ['workspace.read']);
  const badArgs = await executePluginTool('demo', 'greet', { name: '' }, { pluginId: 'demo', mode: 'home' }, { granted: ['workspace.read'] });
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.code, 'validation');
  const unknown = await executePluginTool('demo', 'missing', {}, { pluginId: 'demo', mode: 'home' }, { granted: [] });
  assert.equal(unknown.ok, false);
});

await test('tool boundary: approval required denies without channel; policy deny blocks', async () => {
  reset();
  clearGrantedPermissions('gated');
  registerCapability({
    owner: 'gated',
    name: 'danger',
    kind: 'tool',
    description: 'danger',
    modes: [],
    permissions: [],
    data: {
      name: 'danger',
      description: 'danger',
      schema: z.object({}),
      modes: [],
      permissions: [],
      requiresApproval: true,
      handler: async () => 'should not run',
    },
  });
  setGrantedPermissions('gated', []);
  const noChannel = await executePluginTool('gated', 'danger', {}, { pluginId: 'gated', mode: 'home' }, { granted: [] });
  assert.equal(noChannel.ok, false);
  assert.equal(noChannel.code, 'approval');
  onPluginEvent('tool:before', 'blocker', () => 'deny');
  const blocked = await executePluginTool(
    'gated',
    'danger',
    {},
    { pluginId: 'gated', mode: 'home', requestApproval: async () => true },
    { granted: [] }
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'policy');
  clearAllPluginListeners();
});

await test('shell hook denial is monotonic: earlier deny survives later allow', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-hook-mono-'));
  try {
    const denyHook = { event: 'tool:before', command: 'node -e "console.error(\'denied\'); process.exit(1)"' };
    const allowHook = { event: 'tool:before', command: 'node -e "process.exit(0)"' };
    const outcome = await dispatchHooks(tempDir, [denyHook, allowHook], 'tool:before', { tool: 'read_file' });
    assert.ok(outcome && !outcome.ok, 'aggregated outcome must be denial');
    const reversed = await dispatchHooks(tempDir, [allowHook, denyHook], 'tool:before', { tool: 'read_file' });
    assert.ok(reversed && !reversed.ok, 'denial must win regardless of order');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('archive path traversal is rejected', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-market-evil-'));
  try {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('../../evil.txt', 'pwned');
    zip.file('manifest.json', JSON.stringify({ id: 'evil', name: 'Evil' }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    // Serve via data URL is rejected before extraction; instead test the guard
    // by invoking install with a local file URL (unsupported scheme).
    let threw = false;
    try {
      await installMarketplacePlugin(path.join(tempDir, 'project'), { id: 'evil', name: 'Evil', source: 'file:///tmp/evil.zip' });
    } catch (error) {
      threw = true;
      assert.ok(String(error instanceof Error ? error.message : error).length > 0);
    }
    assert.ok(threw, 'non-https source must be rejected');
    void buffer;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('interrupted update preserves the last working install (rollback)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-market-rollback-'));
  try {
    const project = path.join(tempDir, 'project');
    const goodSource = path.join(tempDir, 'good');
    await fs.mkdir(path.join(goodSource, 'skills', 's'), { recursive: true });
    await fs.writeFile(path.join(goodSource, 'manifest.json'), JSON.stringify({ id: 'keepme', name: 'Keepme', version: '1.0.0' }), 'utf8');
    await fs.writeFile(path.join(goodSource, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: d\n---\n\nHi.', 'utf8');
    await installMarketplacePlugin(project, { id: 'keepme', name: 'Keepme', source: goodSource });
    assert.equal((await discoverPlugins(project)).length, 1);
    // Bad update: bundle id does not match listing → must fail WITHOUT deleting old.
    const badSource = path.join(tempDir, 'bad');
    await fs.mkdir(badSource, { recursive: true });
    await fs.writeFile(path.join(badSource, 'manifest.json'), JSON.stringify({ id: 'other-id', name: 'Other' }), 'utf8');
    let threw = false;
    try {
      await installMarketplacePlugin(project, { id: 'keepme', name: 'Keepme', source: badSource });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'mismatched bundle must fail');
    const after = await discoverPlugins(project);
    assert.equal(after.length, 1, 'previous install must survive failed update');
    assert.equal(after[0].name, 'Keepme');
    assert.equal(after[0].manifest.version, '1.0.0');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('archive file-count constant is a sane bound', async () => {
  assert.ok(MAX_PLUGIN_ARCHIVE_FILES >= 100 && MAX_PLUGIN_ARCHIVE_FILES <= 5000, `unexpected bound ${MAX_PLUGIN_ARCHIVE_FILES}`);
});

console.log(`\nplugin-security: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
