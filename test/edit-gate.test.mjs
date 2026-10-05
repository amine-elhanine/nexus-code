// Edit-approval gate tests: backend write/edit/delete gating in getAgentBackend
// and the apply_patch beforeEdit hook. Imports from dist-electron — build first.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentBackend } from '../dist-electron/command-service.js';
import { setApprovalNotifier } from '../dist-electron/approval-service.js';
import { createEditTools } from '../dist-electron/edit-tools.js';

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

function projectRecord(root) {
  return { id: 'gate-test', name: 'gate-test', root, createdAt: '', updatedAt: '', memory: '', sessions: [] };
}

await test('getAgentBackend auto policy: writes proceed with no approval prompt', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-gate-auto-'));
  try {
    setApprovalNotifier(null);
    const saved = process.env.NEXUS_APPROVAL;
    delete process.env.NEXUS_APPROVAL;
    try {
      const { backend } = await getAgentBackend(projectRecord(tempDir), { runId: 'gate-auto' });
      await backend.write('auto.txt', 'written directly');
      assert.equal(await fs.readFile(path.join(tempDir, 'auto.txt'), 'utf8'), 'written directly');
    } finally {
      if (saved === undefined) delete process.env.NEXUS_APPROVAL;
      else process.env.NEXUS_APPROVAL = saved;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('getAgentBackend ask policy: denial blocks the write; NEXUS_APPROVAL=allow passes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-gate-ask-'));
  try {
    setApprovalNotifier(null);
    const saved = process.env.NEXUS_APPROVAL;
    try {
      delete process.env.NEXUS_APPROVAL;
      const { backend } = await getAgentBackend(projectRecord(tempDir), { runId: 'gate-ask', editPolicy: 'ask' });
      await assert.rejects(
        () => backend.write('blocked.txt', 'nope'),
        /Edit denied by the user/
      );
      assert.equal(await fs.stat(path.join(tempDir, 'blocked.txt')).then(() => true).catch(() => false), false);

      process.env.NEXUS_APPROVAL = 'allow';
      await backend.write('allowed.txt', 'approved');
      assert.equal(await fs.readFile(path.join(tempDir, 'allowed.txt'), 'utf8'), 'approved');
    } finally {
      if (saved === undefined) delete process.env.NEXUS_APPROVAL;
      else process.env.NEXUS_APPROVAL = saved;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await test('apply_patch beforeEdit gate: denial text returned, file untouched; null allows', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-gate-patch-'));
  try {
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'const a = 1;\n', 'utf8');
    const patchText = '*** Update File: app.ts\nconst a = 2;\n';

    const gated = createEditTools(tempDir, {
      beforeEdit: async () => 'Edit denied by the user: apply_patch on app.ts was not approved.',
    });
    const patchTool = gated.find((t) => t.name === 'apply_patch');
    assert.ok(patchTool);
    const denial = await patchTool.invoke({ patchText });
    assert.match(String(denial), /Edit denied by the user/);
    assert.equal(await fs.readFile(path.join(tempDir, 'app.ts'), 'utf8'), 'const a = 1;\n', 'file unchanged after denial');

    const open = createEditTools(tempDir, { beforeEdit: async () => null });
    const openTool = open.find((t) => t.name === 'apply_patch');
    await openTool.invoke({ patchText });
    assert.equal(await fs.readFile(path.join(tempDir, 'app.ts'), 'utf8'), 'const a = 2;\n', 'patch applied when the gate passes');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

if (failed > 0) process.exitCode = 1;
