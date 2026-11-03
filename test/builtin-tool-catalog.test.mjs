// Built-in tool catalog tests: registry registration, idempotency, plugin
// shadowing safety, and hook-classification (a registered builtin must still
// be treated as non-plugin-owned so middleware policy hooks keep evaluating).
// Imports from dist-electron — run `npm run build:electron` first.
import assert from 'node:assert/strict';
import { ensureBuiltinToolCatalog, getBuiltinToolRecord, builtinCatalogEntries } from '../dist-electron/agent/builtin-tool-catalog.js';
import { unregisterOwnerCapabilities, registerCapability, listCapabilities } from '../dist-electron/capability-registry.js';
import { createHooksMiddleware } from '../dist-electron/hooks-service.js';
import { onPluginEvent, clearAllPluginListeners } from '../dist-electron/plugin-events.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { console.log(`  ✔ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}`); console.error(e); failed++; });
}

await test('ensureBuiltinToolCatalog registers every catalog entry', () => {
  unregisterOwnerCapabilities('builtin');
  const ids = ensureBuiltinToolCatalog();
  assert.equal(ids.length, builtinCatalogEntries().length, 'all entries registered');
  for (const e of builtinCatalogEntries()) {
    assert.ok(getBuiltinToolRecord(e.name), `record present for ${e.name}`);
  }
});

await test('ensureBuiltinToolCatalog is idempotent (re-run does not throw or shrink)', () => {
  const before = getBuiltinToolRecord('web_search');
  const ids = ensureBuiltinToolCatalog();
  const after = getBuiltinToolRecord('web_search');
  assert.ok(after, 'record still present on re-run');
  assert.equal(after.name, before.name);
  assert.equal(ids.length, 0, 'no NEW registrations on a re-run (all duplicates)');
});

await test('builtin records keep metadata-only payloads and valid modes', () => {
  for (const e of builtinCatalogEntries()) {
    const record = getBuiltinToolRecord(e.name);
    assert.equal(record.owner, 'builtin');
    assert.equal(record.kind, 'tool');
    assert.ok(record.modes.length > 0 && record.modes.every((m) => ['home', 'code', 'notebook'].includes(m)), `valid modes for ${e.name}`);
  }
});

await test('plugin registrations are never evicted or shadowed by the catalog', () => {
  // Same tool name, different owner — must tolerate coexistence.
  const res = registerCapability({
    owner: 'some-plugin', name: 'web_search', kind: 'tool',
    description: 'plugin variant', modes: ['home'], permissions: [],
  });
  assert.ok(res.ok, 'plugin registration with same name succeeds (separate namespace)');
  ensureBuiltinToolCatalog();
  assert.equal(getBuiltinToolRecord('web_search').owner, 'builtin');
  const owners = listCapabilities({ kind: 'tool' }).filter((c) => c.name === 'web_search').map((c) => c.owner);
  assert.deepEqual(owners.sort(), ['builtin', 'some-plugin']);
  unregisterOwnerCapabilities('some-plugin');
});

await test('hooks middleware still runs policy hooks for a REGISTERED builtin tool', async () => {
  // web_search IS registered by the catalog; middleware must STILL route its
  // policy hook, because built-ins do not self-evaluate inside the executor.
  clearAllPluginListeners();
  const remove = onPluginEvent('tool:before', 'test-plugin', async () => ({ verdict: 'deny', reason: 'test-deny' }));
  try {
    const middleware = createHooksMiddleware({ projectRoot: '.', hooks: [] });
    assert.ok(middleware, 'middleware exists when a listener is registered');
    const request = { tool: { name: 'web_search' }, toolCall: { name: 'web_search', args: {}, id: 'tc1' } };
    const handled = await middleware.wrapToolCall(request, async (req) => ({ via: 'handler', req: req.toolCall.id }));
    assert.equal(handled.status, 'error', 'registered builtin tool is still policy-hook-denyable');
    assert.ok(String(handled.content).includes('[HOOK DENIED]'), 'denial message present');
  } finally {
    remove();
    clearAllPluginListeners();
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
