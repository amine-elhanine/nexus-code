// Hooks API tests: config parsing, hook dispatch (stdin JSON + exit codes),
// and the deny-capable tool:before middleware. Imports from dist-electron —
// run `npm run build:electron` first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { parseHooksConfig, discoverHooks, dispatchHook, dispatchHooks, createHooksMiddleware } from '../dist-electron/hooks-service.js';

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

await test('parseHooksConfig: valid entries kept, malformed configs tolerated', () => {
  const hooks = parseHooksConfig(JSON.stringify({
    hooks: [
      { event: 'tool:before', command: 'node guard.js', timeoutSeconds: 5 },
      { event: 'bogus-event', command: 'node x.js' },
      { event: 'run:end', command: '' },
      'not-an-object',
    ],
  }));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].event, 'tool:before');
  assert.equal(hooks[0].command, 'node guard.js');
  assert.equal(hooks[0].timeoutSeconds, 5);

  assert.deepEqual(parseHooksConfig('not json at all'), [], 'malformed JSON yields no hooks');
  assert.deepEqual(parseHooksConfig(''), []);
  // top-level array form also accepted
  assert.equal(parseHooksConfig('[{"event":"run:start","command":"a"}]').length, 1);
});

await test('discoverHooks reads .nexus/hooks.json from the project', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-hooks-'));
  try {
    assert.deepEqual(await discoverHooks(tempDir), [], 'missing file → no hooks');
    await fs.mkdir(path.join(tempDir, '.nexus'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.nexus', 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'verify:fail', command: 'node notify.js' }] }),
      'utf8'
    );
    const hooks = await discoverHooks(tempDir);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].event, 'verify:fail');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('dispatchHook pipes JSON on stdin and reports exit codes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-hookrun-'));
  try {
    const scriptPath = path.join(tempDir, 'echo-hook.js');
    await fs.writeFile(
      scriptPath,
      'let raw=""; process.stdin.on("data", (c) => raw += c); process.stdin.on("end", () => {\n' +
      '  const payload = JSON.parse(raw);\n' +
      '  if (payload.event !== "tool:before" || payload.tool !== "read_file") process.exit(3);\n' +
      '  process.stderr.write("checked " + payload.tool);\n' +
      '});',
      'utf8'
    );
    const hook = { event: 'tool:before', command: `node "${scriptPath}"` };

    const ok = await dispatchHook(tempDir, hook, { tool: 'read_file', args: {} });
    assert.ok(ok.ok, `passing payload exits 0, got: ${JSON.stringify(ok)}`);
    assert.ok(ok.output.includes('checked read_file'), `stderr captured, got: ${ok.output}`);

    const denied = await dispatchHook(tempDir, hook, { tool: 'write_file', args: {} });
    assert.ok(!denied.ok, 'mismatched payload exits 3 → not ok');
    assert.equal(denied.exitCode, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('dispatchHooks returns the last matching outcome and skips other events', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-hookfan-'));
  try {
    const scriptPath = path.join(tempDir, 'deny.js');
    await fs.writeFile(scriptPath, 'process.exit(1);', 'utf8');
    const hooks = [
      { event: 'tool:before', command: `node "${scriptPath}"` },
      { event: 'run:end', command: `node "${scriptPath}"` },
    ];
    const outcome = await dispatchHooks(tempDir, hooks, 'tool:before', { tool: 'x' });
    assert.ok(outcome && !outcome.ok, 'tool:before hook denial surfaces');
    assert.equal(outcome.exitCode, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('hooks middleware denies tool calls on hook failure via synthetic ToolMessage', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-hookmw-'));
  try {
    const denyPath = path.join(tempDir, 'deny.js');
    await fs.writeFile(denyPath, 'process.stderr.write("no writes allowed"); process.exit(1);', 'utf8');
    const middleware = createHooksMiddleware({
      projectRoot: tempDir,
      hooks: [{ event: 'tool:before', command: `node "${denyPath}"` }],
    });
    assert.ok(middleware, 'middleware exists when tool:before hooks are configured');

    let handlerRan = false;
    const result = await middleware.wrapToolCall(
      { tool: { name: 'write_file' }, toolCall: { id: 'call_1', args: { file_path: 'x.ts' } } },
      async () => {
        handlerRan = true;
        return new ToolMessage({ tool_call_id: 'call_1', name: 'write_file', content: 'written' });
      }
    );
    assert.ok(!handlerRan, 'denied call never reaches the real handler');
    assert.ok(result instanceof ToolMessage);
    assert.equal(result.status, 'error');
    assert.match(String(result.content), /HOOK DENIED/);
    assert.match(String(result.content), /no writes allowed/);

    // Passing hook: the real handler runs and its result is returned.
    const allowPath = path.join(tempDir, 'allow.js');
    await fs.writeFile(allowPath, 'process.exit(0);', 'utf8');
    const allowing = createHooksMiddleware({
      projectRoot: tempDir,
      hooks: [{ event: 'tool:before', command: `node "${allowPath}"` }],
    });
    const passed = await allowing.wrapToolCall(
      { tool: { name: 'write_file' }, toolCall: { id: 'call_2', args: {} } },
      async () => 'ok-result'
    );
    assert.equal(passed, 'ok-result');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('middleware returns null when no tool hooks are configured', () => {
  const middleware = createHooksMiddleware({ projectRoot: '.', hooks: [{ event: 'run:end', command: 'node -v' }] });
  assert.equal(middleware, null, 'run lifecycle hooks do not need the middleware');
});
