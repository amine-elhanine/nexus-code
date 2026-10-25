import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLimitedProcess } from '../scripts/eval-runner-utils.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_FILES = ['evals/cases.json', 'evals/notebook.cases.json'];

async function loadCorpus(file) {
  const parsed = JSON.parse(await fs.readFile(path.join(repoRoot, file), 'utf8'));
  return { file, parsed };
}

test('agent eval corpus has unique, well-formed, checker-backed cases with safe fixture paths', async (t) => {
  const { parsed: cases } = await loadCorpus('evals/cases.json');
  assert.ok(Array.isArray(cases) && cases.length >= 50, `corpus should hold at least 50 representative tasks, found ${cases.length}`);
  const ids = cases.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids must be unique');

  for (const item of cases) {
    // Schema invariants every case curl must satisfy.
    assert.equal(typeof item.id, 'string', `${item.id}: id`);
    assert.equal(typeof item.title, 'string', `${item.id}: title`);
    assert.equal(typeof item.request, 'string', `${item.id}: request`);
    assert.ok(item.request.trim().length > 20, `${item.id}: request is substantive`);
    assert.ok(item.files && typeof item.files === 'object', `${item.id}: files object`);
    const checker = item.files['eval.test.mjs'];
    assert.equal(typeof checker, 'string', `${item.id}: independent eval.test.mjs checker required`);
    assert.match(checker, /^import test from 'node:test';/m, `${item.id}: checker uses node:test`);
    assert.doesNotMatch(checker, /process\.(exit|env)/, `${item.id}: checker must not short-circuit or read env`);
    // Request hygiene: the model must be told the checker is off-limits.
    if (!item.requireCommandExpansion && !item.requireSubagentDelegation && !item.requireSkillRead && !item.requireProjectRules) {
      assert.match(item.request, /Do not modify eval\.test\.mjs/, `${item.id}: request must guard the checker`);
    }
    // Fixture path containment (mirrors the runner's assertSafeRelativePath).
    for (const key of Object.keys(item.files)) {
      assert.equal(typeof item.files[key], 'string', `${item.id}: ${key} content`);
      assert.ok(!path.isAbsolute(key), `${item.id}: ${key} must be relative`);
      assert.ok(!key.split(/[\\/]/).includes('..'), `${item.id}: ${key} must not traverse`);
      assert.ok(key !== 'eval.test.mjs' || key === 'eval.test.mjs', `${item.id}: key shape`);
    }
    // taskKind: general only on Home-style cases; unknown kinds are ignored by the runner.
    if (item.taskKind !== undefined) assert.equal(item.taskKind, 'general', `${item.id}: taskKind must be code or general`);
    // Asset flags come only in boolean form.
    for (const flag of ['requireCommandExpansion', 'requireSubagentDelegation', 'requireSkillRead', 'requireProjectRules']) {
      if (item[flag] !== undefined) assert.equal(item[flag], true, `${item.id}: ${flag} must be true or absent`);
    }
  }

  // Notebook corpus: same uniqueness + safe-docs schema.
  const { parsed: notebookCases } = await loadCorpus('evals/notebook.cases.json');
  const notebookIds = notebookCases.map((item) => item.id);
  assert.equal(new Set(notebookIds).size, notebookIds.length, 'notebook case ids must be unique');
  for (const item of notebookCases) {
    assert.equal(typeof item.id, 'string', `${item.id}: id`);
    assert.equal(typeof item.question, 'string', `${item.id}: question`);
    assert.ok(item.documents && Object.keys(item.documents).length >= 1, `${item.id}: documents`);
    for (const [name, content] of Object.entries(item.documents)) {
      assert.ok(!name.split(/[\\/]/).includes('..') && !path.isAbsolute(name), `${item.id}: document name ${name}`);
      assert.equal(typeof content, 'string', `${item.id}: ${name}`);
    }
    for (const claim of item.citationClaims ?? []) {
      assert.ok(item.documents[claim.sourceName], `${item.id}: claim source ${claim.sourceName} exists`);
    }
  }
  void CORPUS_FILES;
});

// Every checker must FAIL on the pristine fixture: if a checker passed the
// untouched stub, the case proves nothing (a do-nothing agent passes it).
// Load-shaped errors (SyntaxError, missing modules) also disqualify the case —
// the checker must fail through real assertions, not broken code.
// Nested `node --test` children silently skip execution when they inherit the
// parent test runner's NODE_TEST_CONTEXT (they think they are reporting to a
// parent and exit 0 immediately). Strip it so the checker actually runs.
const cleanSpawnEnv = { ...process.env };
delete cleanSpawnEnv.NODE_TEST_CONTEXT;
delete cleanSpawnEnv.NODE_RUN_CHILD_PROCESS_ENV;
delete cleanSpawnEnv.NODE_RUN_EXEC_ARGV;

async function pristineCheckerFails(item, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `nexus-eval-corpus-${item.id}-`));
  try {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    for (const [relative, content] of Object.entries(item.files)) {
      const target = path.resolve(workspace, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    // TAP reporter keeps the evidence deterministic: a real executed-and-failed
    // checker always contains `not ok`; a skipped/hidden run would exit 0 with
    // no markers at all.
    const pristine = await run(process.execPath, ['--test', '--test-reporter', 'tap', 'eval.test.mjs'], { cwd: workspace, env: cleanSpawnEnv }, { timeoutMs: 60_000 });
    if (process.env.NEXUS_CORPUS_DEBUG) process.stderr.write(`DEBUG ${item.id}: code=${pristine.code} timedOut=${pristine.timedOut} dir=${await fs.readdir(workspace)}\n`);
    assert.ok(!pristine.timedOut, `${item.id}: pristine checker timed out`);
    assert.notEqual(pristine.code, 0, `${item.id}: checker PASSED the untouched fixture — it discriminates nothing`);
    assert.match(`${pristine.stdout}\n${pristine.stderr}`, /not ok/, `${item.id}: pristine run shows no executed failing test (skipped or swallowed?)`);
    const loadFailure = /(SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_ESM|ERR_UNKNOWN_FILE_EXTENSION)/i.test(pristine.stderr);
    assert.equal(loadFailure, false, `${item.id}: pristine failure looks like a broken checker, not assertions — inspect stderr: ${pristine.stderr.slice(0, 300)}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('every corpus checkers fails the pristine fixture (discriminative) and loads cleanly', async (t) => {
  const { parsed: cases } = await loadCorpus('evals/cases.json');
  const concurrency = 8;
  const failures = [];
  for (let index = 0; index < cases.length; index += concurrency) {
    const batch = cases.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map((item) => pristineCheckerFails(item, runLimitedProcess)));
    for (const [offset, result] of results.entries()) {
      if (result.status === 'rejected') failures.push({ id: batch[offset].id, reason: result.reason });
    }
  }
  if (failures.length) {
    const details = failures.map(({ id, reason }) => `\n  ${id}: ${String(reason?.message ?? reason).slice(0, 300)}`).join('');
    assert.fail(`${failures.length}/${cases.length} corpus cases are not discriminative or are malformed:${details}`);
  }
});
