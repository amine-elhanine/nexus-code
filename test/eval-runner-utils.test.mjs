import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { agentEvalCasePassed, agentEvalReadinessError, parseEvalRepeatCount, redactEvalOutput, resolveAgentEvalRuntime, restoreEvalChecker, runLimitedProcess, summarizeAgentEvalVariants } from '../scripts/eval-runner-utils.mjs';

test('agent evaluation requires a passed Nexus verification result', () => {
  const good = { agentTimedOut: false, checkerTimedOut: false, agentExitCode: 0, verification: 'passed', checkerIntact: true, checkerExitCode: 0 };
  assert.equal(agentEvalCasePassed(good), true);
  assert.equal(agentEvalCasePassed({ ...good, verification: 'none' }), false);
  assert.equal(agentEvalCasePassed({ ...good, verification: 'failed' }), false);
  assert.equal(agentEvalCasePassed({ ...good, checkerIntact: false }), false);
  assert.equal(agentEvalCasePassed({ ...good, requireCommandExpansion: true }), false);
  assert.equal(agentEvalCasePassed({ ...good, requireCommandExpansion: true, commandExpansionUsed: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireCommandExpansion: true, commandsAssetDisabled: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireSubagentDelegation: true }), false);
  assert.equal(agentEvalCasePassed({ ...good, requireSubagentDelegation: true, subagentDelegationUsed: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireSubagentDelegation: true, agentsAssetDisabled: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireSkillRead: true }), false);
  assert.equal(agentEvalCasePassed({ ...good, requireSkillRead: true, skillReadUsed: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireSkillRead: true, skillsAssetDisabled: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireProjectRules: true }), false);
  assert.equal(agentEvalCasePassed({ ...good, requireProjectRules: true, projectRulesLoaded: true }), true);
  assert.equal(agentEvalCasePassed({ ...good, requireProjectRules: true, rulesAssetDisabled: true }), true);
});

test('evaluation repeat count defaults to one and rejects unsafe bounds', () => {
  assert.equal(parseEvalRepeatCount(undefined), 1);
  assert.equal(parseEvalRepeatCount('3'), 3);
  for (const value of ['0', '11', '1.5', 'NaN', '-2']) {
    assert.throws(() => parseEvalRepeatCount(value), /--repeat/);
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-eval-checker-'));
  const workspace = path.join(root, 'case');
  await fs.mkdir(workspace);
  t.after(async () => {
    const resolved = path.resolve(root);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(tempRoot), `refusing cleanup outside temp directory: ${resolved}`);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, workspace };
}

test('checker restore reports intact content and rewrites from the trusted copy', async (t) => {
  const { root, workspace } = await fixture(t);
  const trusted = 'import test from "node:test";\n';
  const checker = path.join(workspace, 'eval.test.mjs');
  await fs.writeFile(checker, trusted);
  assert.equal(await restoreEvalChecker({ runRoot: root, workspace, expectedContents: trusted }), true);
  await fs.writeFile(checker, 'tampered');
  assert.equal(await restoreEvalChecker({ runRoot: root, workspace, expectedContents: trusted }), false);
  assert.equal(await fs.readFile(checker, 'utf8'), trusted);
});

test('checker restore removes a symlink without overwriting its target', async (t) => {
  const { root, workspace } = await fixture(t);
  const trusted = 'trusted checker';
  const sentinel = path.join(root, 'outside.txt');
  const checker = path.join(workspace, 'eval.test.mjs');
  await fs.writeFile(sentinel, 'must remain unchanged');
  try {
    await fs.symlink(sentinel, checker, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`file symlinks unavailable: ${error.code}`);
    throw error;
  }
  assert.equal(await restoreEvalChecker({ runRoot: root, workspace, expectedContents: trusted }), false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must remain unchanged');
  assert.equal(await fs.readFile(checker, 'utf8'), trusted);
});

test('checker restore breaks a hard link before writing trusted content', async (t) => {
  const { root, workspace } = await fixture(t);
  const trusted = 'trusted checker';
  const sentinel = path.join(root, 'outside.txt');
  const checker = path.join(workspace, 'eval.test.mjs');
  await fs.writeFile(sentinel, 'outside data');
  try {
    await fs.link(sentinel, checker);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`hard links unavailable: ${error.code}`);
    throw error;
  }
  assert.equal(await restoreEvalChecker({ runRoot: root, workspace, expectedContents: trusted }), false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside data');
  assert.equal(await fs.readFile(checker, 'utf8'), trusted);
});

test('checker restore refuses a workspace symlink escape', async (t) => {
  const { root, workspace } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.rm(workspace, { recursive: true });
  try {
    await fs.symlink(outside, workspace, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`directory symlinks unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(restoreEvalChecker({ runRoot: root, workspace, expectedContents: 'trusted' }), /workspace was replaced/);
});

test('process runner terminates a child at its deadline', async () => {
  const result = await runLimitedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {}, { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('process runner bounds output while preserving the tail', async () => {
  const result = await runLimitedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(200)); process.stdout.write("FINAL")'], {}, { timeoutMs: 5_000, maxOutputChars: 32 });
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdout.endsWith('FINAL'));
});

test('evaluation output redacts explicit and bearer credentials', () => {
  assert.equal(redactEvalOutput('key=secret-value Bearer abcdefghijklmnop.qrstuvwxyz', ['secret-value']), 'key=[REDACTED] Bearer [REDACTED]');
});

test('runtime reporting mirrors CLI provider and model fallback order', () => {
  const providers = [
    { id: 'encrypted', label: 'Encrypted', provider: 'openai', apiKey: 'safeStorage:v1:cipher', models: ['ignored-model'] },
    { id: 'usable', label: 'Usable', provider: 'mistral', apiKey: 'plain-key', models: ['mistral-small'] },
  ];
  assert.deepEqual(resolveAgentEvalRuntime({ providers }), {
    providerId: 'usable', providerLabel: 'Usable', providerKind: 'mistral', model: 'mistral-small', configuredProvider: providers[1],
  });
  assert.equal(resolveAgentEvalRuntime({ providers, providerSelection: 'ENCRYPTED', modelSelection: 'custom-model', env: { NEXUS_MODEL: 'env-model' } }).model, 'custom-model');
  assert.equal(resolveAgentEvalRuntime({ providers, providerSelection: 'Usable', env: { NEXUS_MODEL: 'env-model' } }).model, 'env-model');
  const headless = resolveAgentEvalRuntime({ providers, apiKey: 'explicit-key', env: { NEXUS_PROVIDER_KIND: 'custom' } });
  assert.equal(headless.providerId, 'headless');
  assert.equal(headless.providerKind, 'custom');
  assert.equal(headless.model, 'gpt-4.1-mini');
});

test('evaluation preflight explains missing, unknown, and desktop-only credentials without exposing secrets', () => {
  const missing = resolveAgentEvalRuntime({ providers: [] });
  assert.match(agentEvalReadinessError({ runtime: missing }), /No usable API key\/provider/);

  const providers = [
    { id: 'encrypted', label: 'Encrypted', provider: 'openai', apiKey: 'safeStorage:v1:private-ciphertext', models: ['test-model'] },
    { id: 'local', label: 'Local', provider: 'ollama', apiKey: '', models: ['local-model'] },
  ];
  const encrypted = resolveAgentEvalRuntime({ providers, providerSelection: 'encrypted' });
  const encryptedError = agentEvalReadinessError({ runtime: encrypted, providerSelection: 'encrypted' });
  assert.match(encryptedError, /encrypted for the desktop app/);
  assert.doesNotMatch(encryptedError, /private-ciphertext/);
  assert.equal(agentEvalReadinessError({ runtime: encrypted, providerSelection: 'encrypted', apiKey: 'explicit-key' }), null);

  const unknown = resolveAgentEvalRuntime({ providers, providerSelection: 'missing' });
  assert.match(agentEvalReadinessError({ runtime: unknown, providerSelection: 'missing' }), /No configured provider matches/);
  const local = resolveAgentEvalRuntime({ providers, providerSelection: 'local' });
  assert.equal(agentEvalReadinessError({ runtime: local, providerSelection: 'local' }), null);
  const localDefault = resolveAgentEvalRuntime({ providers });
  assert.equal(localDefault.providerId, 'local', 'keyless Ollama should be auto-selected for headless runs');
  assert.equal(agentEvalReadinessError({ runtime: localDefault }), null);

  const customLocal = resolveAgentEvalRuntime({ providers: [
    { id: 'custom-no-url', label: 'Custom without URL', provider: 'custom', apiKey: '', models: ['model'] },
    { id: 'custom-local', label: 'Custom local', provider: 'custom', apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1', models: ['model'] },
  ] });
  assert.equal(customLocal.providerId, 'custom-local', 'keyless custom providers need an explicit endpoint before auto-selection');
  assert.equal(agentEvalReadinessError({ runtime: customLocal }), null);

  const emptyMistral = resolveAgentEvalRuntime({
    providers: [{ id: 'mistral', label: 'Mistral', provider: 'mistral', apiKey: '', models: ['mistral-small'] }],
    providerSelection: 'mistral',
  });
  assert.match(agentEvalReadinessError({ runtime: emptyMistral, providerSelection: 'mistral', providerEnvKey: 'MISTRAL_API_KEY' }), /no usable API key/);
  assert.equal(agentEvalReadinessError({ runtime: emptyMistral, providerSelection: 'mistral', providerEnvKey: 'MISTRAL_API_KEY', env: { MISTRAL_API_KEY: 'available-key' } }), null);

  const custom = resolveAgentEvalRuntime({
    providers: [{ id: 'custom', label: 'Custom', provider: 'custom', apiKey: '', models: ['local-model'] }],
    providerSelection: 'custom',
  });
  assert.match(agentEvalReadinessError({ runtime: custom, providerSelection: 'custom' }), /needs a base URL/);
  assert.equal(agentEvalReadinessError({ runtime: custom, providerSelection: 'custom', baseUrl: 'http://127.0.0.1:1234/v1' }), null);
});

test('paired eval summaries report asset ablation wins, losses, ties, and pass-rate delta', () => {
  const variants = [
    { name: 'baseline', disabledPromptAssets: [] },
    { name: 'without-skills', disabledPromptAssets: ['skills'] },
  ];
  const cases = [
    { variant: 'baseline', id: 'a', iteration: 1, passed: true, durationMs: 10, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCost: 0.003 } },
    { variant: 'baseline', id: 'b', iteration: 1, passed: true, durationMs: 20, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, estimatedCost: 0.005 } },
    { variant: 'baseline', id: 'c', iteration: 1, passed: false, durationMs: 30, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, estimatedCost: null } },
    { variant: 'without-skills', id: 'a', iteration: 1, passed: true, durationMs: 11, usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, estimatedCost: 0.004 } },
    { variant: 'without-skills', id: 'b', iteration: 1, passed: false, durationMs: 18, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCost: 0.002 } },
    { variant: 'without-skills', id: 'c', iteration: 1, passed: false, durationMs: 33, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, estimatedCost: null } },
    { variant: 'without-skills', id: 'unpaired', iteration: 1, passed: true, durationMs: 1, usage: { inputTokens: 50, outputTokens: 49, totalTokens: 99, estimatedCost: 0.01 } },
  ];
  const summary = summarizeAgentEvalVariants(cases, variants);
  assert.deepEqual(summary.variants.map(({ name, totalRuns, passedRuns }) => ({ name, totalRuns, passedRuns })), [
    { name: 'baseline', totalRuns: 3, passedRuns: 2 },
    { name: 'without-skills', totalRuns: 4, passedRuns: 2 },
  ]);
  assert.deepEqual(summary.pairedComparisons, [{
    baseline: 'baseline', ablation: 'without-skills', pairedRuns: 3,
    bothPass: 1, bothFail: 1, baselineOnlyPass: 1, ablationOnlyPass: 0,
    passRateDelta: -1 / 3,
    pairedTotalTokensDelta: -11,
    pairedEstimatedCostDelta: null,
  }]);
  assert.equal(summary.variants[0].meanDurationMs, 20);
  assert.equal(summary.variants[0].usageTotals.totalTokens, 51);
  assert.equal(summary.variants[0].usageTotals.estimatedCost, null, 'partial provider cost data must not look complete');
  assert.equal(summary.variants[0].usageSamples.estimatedCost, 2);
  assert.deepEqual(summarizeAgentEvalVariants([], [{ name: 'single', disabledPromptAssets: [] }]).pairedComparisons, []);
  const noPairs = summarizeAgentEvalVariants([{ variant: 'baseline', id: 'only-baseline', iteration: 1, passed: true }], variants);
  assert.equal(noPairs.pairedComparisons[0].pairedRuns, 0);
  assert.equal(noPairs.pairedComparisons[0].passRateDelta, null);
});
