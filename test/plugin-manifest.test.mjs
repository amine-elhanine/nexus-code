// Plugin manifest v2 validation (strict path). Imports from dist-electron.
import assert from 'node:assert/strict';
import {
  validatePluginManifest,
  validateEntryPath,
  parseVersion,
  compareVersions,
  isApiVersionCompatible,
  isAppVersionCompatible,
  manifestAppliesToMode,
} from '../dist-electron/plugin-manifest.js';

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

const base = {
  id: 'acme-tools',
  name: 'Acme Tools',
  version: '1.2.0',
  capabilities: ['skills'],
};

await test('valid declarative manifest passes; modes omitted = implicit all', async () => {
  const result = validatePluginManifest({ ...base });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.modesImplicit, true);
  assert.ok(manifestAppliesToMode(result.manifest, 'code'));
  assert.ok(manifestAppliesToMode(result.manifest, 'home'));
});

await test('explicit empty modes = unrestricted but explicit', async () => {
  const result = validatePluginManifest({ ...base, modes: [] });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.modesImplicit, false);
  assert.ok(manifestAppliesToMode(result.manifest, 'notebook'));
});

await test('unknown mode is REJECTED (never broadened to all)', async () => {
  const result = validatePluginManifest({ ...base, modes: ['code', 'bogus'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'modes' || e.field.startsWith('modes.')), `expected modes error, got ${JSON.stringify(result.errors)}`);
});

await test('unknown capability is rejected', async () => {
  const result = validatePluginManifest({ ...base, capabilities: ['teleport'] });
  assert.equal(result.ok, false);
});

await test('unknown permission is rejected', async () => {
  const result = validatePluginManifest({ ...base, capabilities: ['tools'], entry: './dist/index.js', permissions: ['mind.read'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'permissions' || e.field.startsWith('permissions.')));
});

await test('executable capability without entry is rejected', async () => {
  const result = validatePluginManifest({ ...base, capabilities: ['tools'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'entry'));
});

await test('entry without executable capability is rejected', async () => {
  const result = validatePluginManifest({ ...base, capabilities: ['skills'], entry: './dist/index.js' });
  assert.equal(result.ok, false);
});

await test('unsafe entry paths rejected', async () => {
  for (const bad of ['https://evil/x.js', '/abs/index.js', '../escape.js', './dist/../secret.js', 'C:/win.js', './dist/index.ts', '']) {
    assert.ok(validateEntryPath(bad) !== null, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(validateEntryPath('./dist/index.js'), null);
  assert.equal(validateEntryPath('dist/worker.cjs'), null);
});

await test('ui contributions require the ui capability', async () => {
  const result = validatePluginManifest({ ...base, capabilities: ['skills'], ui: [{ slot: 'settings', title: 'Prefs' }] });
  assert.equal(result.ok, false);
});

await test('unsupported apiVersion rejected; app version gate works', async () => {
  assert.equal(validatePluginManifest({ ...base, apiVersion: '99' }).ok, false);
  assert.equal(isApiVersionCompatible('1'), true);
  assert.equal(isApiVersionCompatible('2'), false);
  assert.equal(isAppVersionCompatible('0.4.0', '0.4.5'), true);
  assert.equal(isAppVersionCompatible('9.9.9', '0.4.5'), false);
  assert.equal(isAppVersionCompatible(undefined, '0.0.1'), true);
});

await test('semver compare handles major/minor/patch + prerelease', async () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0-alpha', '2.0.0'), -1);
  assert.equal(compareVersions('nope', '1.0.0'), null);
  assert.ok(parseVersion('1.0.0'));
  assert.equal(parseVersion('nope'), null);
});

await test('malformed manifests rejected (non-object, missing id/name)', async () => {
  assert.equal(validatePluginManifest(null).ok, false);
  assert.equal(validatePluginManifest([]).ok, false);
  assert.equal(validatePluginManifest({ name: 'x', capabilities: ['skills'] }).ok, false);
  assert.equal(validatePluginManifest({ id: 'x', capabilities: ['skills'] }).ok, false);
  assert.equal(validatePluginManifest({ id: 'BAD ID!!', name: 'x', capabilities: ['skills'] }).ok, false);
});

console.log(`\nplugin-manifest: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
