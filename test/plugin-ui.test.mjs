// Plugin UI contributions: manifest shape, file serving guards, calendar
// sample end-to-end (tool side). Renderer iframe mounting is covered by
// manual steps in docs (no DOM in unit tests).
// Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginManifest } from '../dist-electron/plugin-manifest.js';
import { readPluginUiHtml, validateUiRequest } from '../dist-electron/plugin-ui.js';
import {
  discoverExecutablePlugin,
  enablePlugin,
  disablePlugin,
  disposePlugin,
  clearManagedPlugins,
} from '../dist-electron/plugin-lifecycle.js';
import { executePluginTool } from '../dist-electron/tool-executor.js';
import { setGrantedPermissions, clearGrantedPermissions } from '../dist-electron/plugin-permissions.js';
import { clearAllCapabilities } from '../dist-electron/capability-registry.js';
import { stopAllPluginProcesses } from '../dist-electron/plugin-process-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const calendarDir = path.join(repoRoot, 'plugins', 'examples', 'calendar');

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

async function teardown(root) {
  await stopAllPluginProcesses().catch(() => undefined);
  clearManagedPlugins();
  clearAllCapabilities();
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

await test('calendar sample manifest validates on the strict v2 path', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(calendarDir, 'manifest.json'), 'utf8'));
  const result = validatePluginManifest(raw);
  assert.equal(result.ok, true, `expected valid, got ${JSON.stringify(result.errors)}`);
  assert.ok(result.manifest.capabilities.includes('tools'));
  assert.ok(result.manifest.capabilities.includes('ui'));
  assert.equal(result.manifest.ui.length, 1);
  assert.equal(result.manifest.ui[0].slot, 'modal');
});

await test('calendar UI file is served (exact manifest match)', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(calendarDir, 'manifest.json'), 'utf8'));
  const { manifest } = validatePluginManifest(raw);
  const doc = await readPluginUiHtml(calendarDir, manifest, './ui/calendar.html');
  assert.equal(doc.title, 'Calendar');
  assert.equal(doc.slot, 'modal');
  assert.ok(doc.html.includes('cal-grid'), 'expected calendar markup');
  assert.ok(doc.html.includes('nexusPlugin'), 'expected bridge usage docs in file');
});

await test('UI serving rejects undeclared entries, traversal, and bad types', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ui-'));
  try {
    const dir = path.join(tmp, 'plug');
    await fs.mkdir(path.join(dir, 'ui'), { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
      id: 'uix', name: 'Uix', version: '1.0.0', apiVersion: '1',
      capabilities: ['ui'], entry: './dist/index.js',
      ui: [{ slot: 'modal', title: 'Panel', entry: './ui/panel.html' }],
    }), 'utf8');
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist', 'index.js'), 'nexus.log("x");\n');
    await fs.writeFile(path.join(dir, 'ui', 'panel.html'), '<div>hi</div>', 'utf8');
    await fs.writeFile(path.join(dir, 'ui', 'evil.txt'), 'nope', 'utf8');
    await fs.writeFile(path.join(dir, 'ui', 'bad.html'), '<object data="x"></object>', 'utf8');
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const { manifest } = validatePluginManifest(raw);

    // Undeclared entry (even inside the dir) is never served.
    let threw = false;
    try {
      await readPluginUiHtml(dir, manifest, './ui/evil.txt');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'undeclared entry must be rejected');

    // Declared entry with a forbidden element is refused.
    const withBad = { ...manifest, ui: [{ slot: 'modal', title: 'Bad', entry: './ui/bad.html' }] };
    threw = false;
    try {
      await readPluginUiHtml(dir, withBad, './ui/bad.html');
    } catch (error) {
      threw = true;
      assert.ok(String(error.message).includes('forbidden'));
    }
    assert.ok(threw, 'forbidden elements must be refused');

    // Missing file is refused.
    const withMissing = { ...manifest, ui: [{ slot: 'modal', title: 'Missing', entry: './ui/gone.html' }] };
    threw = false;
    try {
      await readPluginUiHtml(dir, withMissing, './ui/gone.html');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'missing file must be refused');

    // Request shape validation.
    assert.equal(validateUiRequest(null).ok, false);
    assert.equal(validateUiRequest({ pluginId: '../evil', entry: './ui/panel.html' }).ok, false);
    assert.equal(validateUiRequest({ pluginId: 'uix', entry: './ui/panel.html' }).ok, true);
  } finally {
    await teardown(tmp);
  }
});

await test('calendar tools work end-to-end via the runner (seed + add)', async () => {
  clearManagedPlugins();
  clearAllCapabilities();
  await discoverExecutablePlugin(calendarDir);
  try {
    const enabled = await enablePlugin({ id: 'calendar', appVersion: '0.4.5', approvedPermissions: [] });
    assert.equal(enabled.ok, true, `enable failed: ${enabled.error}`);
    setGrantedPermissions('calendar', []);
    const listed = await executePluginTool('calendar', 'list_events', {}, { pluginId: 'calendar', mode: 'home' }, { granted: [] });
    assert.equal(listed.ok, true, `list failed: ${listed.error}`);
    assert.ok(Array.isArray(listed.result.events), 'expected events array');
    assert.ok(listed.result.events.length >= 2, 'expected seeded demo events');
    assert.ok(listed.result.events.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.title === 'string'));

    const added = await executePluginTool(
      'calendar', 'add_event', { date: '2030-01-02', title: 'Future review' },
      { pluginId: 'calendar', mode: 'home' }, { granted: [] }
    );
    assert.equal(added.ok, true, `add failed: ${added.error}`);
    assert.equal(added.result.event.date, '2030-01-02');

    const filtered = await executePluginTool(
      'calendar', 'list_events', { month: '2030-01' },
      { pluginId: 'calendar', mode: 'home' }, { granted: [] }
    );
    assert.equal(filtered.ok, true);
    assert.ok(filtered.result.events.some((e) => e.title === 'Future review'), 'month filter must find the new event');

    const badDate = await executePluginTool(
      'calendar', 'add_event', { date: 'tomorrow', title: 'x' },
      { pluginId: 'calendar', mode: 'home' }, { granted: [] }
    );
    assert.equal(badDate.ok, false, 'invalid date must fail inside the handler');
  } finally {
    await disablePlugin('calendar').catch(() => undefined);
    await disposePlugin('calendar').catch(() => undefined);
    clearGrantedPermissions('calendar');
    await stopAllPluginProcesses().catch(() => undefined);
    clearManagedPlugins();
    clearAllCapabilities();
  }
});

console.log(`\nplugin-ui: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
