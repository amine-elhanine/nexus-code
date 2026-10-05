// Headless CLI + approval-policy tests. Runs the real CLI as a subprocess for
// the config-error paths (no network needed) and unit-tests the headless
// approval policy. Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { requestCommandApproval, setApprovalNotifier } from '../dist-electron/approval-service.js';

const execFileAsync = promisify(execFile);
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

await test('headless approval policy: deny without notifier, NEXUS_APPROVAL=allow opts in', async () => {
  setApprovalNotifier(null);
  const saved = process.env.NEXUS_APPROVAL;
  try {
    delete process.env.NEXUS_APPROVAL;
    assert.equal(await requestCommandApproval({ command: 'npm install', cwd: '.', reason: 'test' }), 'deny');
    process.env.NEXUS_APPROVAL = 'allow';
    assert.equal(await requestCommandApproval({ command: 'npm install', cwd: '.', reason: 'test' }), 'session');
  } finally {
    if (saved === undefined) delete process.env.NEXUS_APPROVAL;
    else process.env.NEXUS_APPROVAL = saved;
  }
});

await test('CLI: missing --request exits 3 with usage on stderr', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, ['scripts/agent-cli.mjs', '--project', '.'], { timeout: 30000 }),
    (error) => {
      assert.equal(error.code, 3);
      assert.match(String(error.stderr), /Usage:/);
      return true;
    }
  );
});

await test('CLI: unknown --provider exits 3 without touching the network', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, ['scripts/agent-cli.mjs', '--project', '.', '--request', 'noop', '--provider', 'definitely-not-a-provider'], { timeout: 60000 }),
    (error) => {
      assert.equal(error.code, 3);
      assert.match(String(error.stderr), /No configured provider matches/);
      return true;
    }
  );
});

if (failed > 0) process.exitCode = 1;
