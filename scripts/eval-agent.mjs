#!/usr/bin/env node
// Small, repeatable end-to-end benchmark for Nexus Code and Home runs. Each case gets
// a fresh disposable workspace and an independent post-run objective check.
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentEvalCasePassed, agentEvalReadinessError, parseEvalRepeatCount, redactEvalOutput, resolveAgentEvalRuntime, restoreEvalChecker, runLimitedProcess, summarizeAgentEvalVariants } from './eval-runner-utils.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { parseDisabledPromptAssets } = await import('../dist-electron/prompt-assets.js');
const { values } = parseArgs({
  options: {
    case: { type: 'string', short: 'c' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'api-key': { type: 'string' },
    'base-url': { type: 'string' },
    'without-assets': { type: 'string' },
    'compare-assets': { type: 'string' },
    'timeout-ms': { type: 'string' },
    repeat: { type: 'string' },
  },
});
let disabledPromptAssets;
let compareAssets;
try {
  disabledPromptAssets = parseDisabledPromptAssets(values['without-assets']);
  compareAssets = values['compare-assets'] === undefined ? null : parseDisabledPromptAssets(values['compare-assets']);
  if (values['compare-assets'] !== undefined && !compareAssets.length) throw new Error('--compare-assets needs at least one asset name.');
  if (compareAssets && disabledPromptAssets.length) throw new Error('Use either --compare-assets or --without-assets, not both.');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const timeoutMs = values['timeout-ms'] === undefined ? 600_000 : Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
  process.stderr.write('--timeout-ms must be an integer from 1000 to 1800000.\n');
  process.exit(2);
}
let repeatCount;
try {
  repeatCount = parseEvalRepeatCount(values.repeat);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const secretsToRedact = [values['api-key'], process.env.NEXUS_API_KEY, process.env.OPENAI_API_KEY]
  .filter((secret) => typeof secret === 'string' && secret.length >= 6);
const providerStore = await import('../dist-electron/store.js');
const providerCatalog = await import('../dist-electron/providers.js');
const configuredProviders = await providerStore.listProviders().catch(() => []);
const explicitApiKey = values['api-key'] || process.env.NEXUS_API_KEY || process.env.OPENAI_API_KEY || '';
const runtime = resolveAgentEvalRuntime({
  providers: configuredProviders,
  providerSelection: values.provider,
  modelSelection: values.model,
  apiKey: explicitApiKey,
  env: process.env,
});
const selectedProvider = runtime.configuredProvider;
if (selectedProvider?.apiKey) secretsToRedact.push(selectedProvider.apiKey);

function parseResult(stdout) {
  for (const event of parseEvents(stdout).reverse()) {
    if (event.type === 'result') return event;
  }
  return null;
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event && typeof event.type === 'string') events.push(event);
    } catch { /* status lines are not JSONL results */ }
  }
  return events;
}

function assertSafeRelativePath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error(`Unsafe fixture path: ${relative}`);
  }
}

const cases = JSON.parse(await fs.readFile(path.join(repoRoot, 'evals', 'cases.json'), 'utf8'));
const selected = values.case ? cases.filter((item) => item.id === values.case) : cases;
if (!selected.length) {
  process.stderr.write(`Unknown case "${values.case}". Available: ${cases.map((item) => item.id).join(', ')}\n`);
  process.exit(2);
}

const providerEnvKey = runtime.providerKind ? providerCatalog.getProviderDefinition(runtime.providerKind).envKey : undefined;
const readinessError = agentEvalReadinessError({
  runtime,
  providerSelection: values.provider,
  apiKey: explicitApiKey,
  providerEnvKey,
  env: process.env,
  baseUrl: values['base-url'],
});
if (readinessError) {
  process.stderr.write(`Evaluation cannot start: ${readinessError}\n`);
  process.exit(2);
}

const variants = compareAssets
  ? [
      { name: 'baseline', disabledPromptAssets: [] },
      ...compareAssets.map((asset) => ({ name: `without-${asset}`, disabledPromptAssets: [asset] })),
    ]
  : [{ name: 'single', disabledPromptAssets }];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-eval-'));
const report = {
  startedAt: new Date().toISOString(),
  providerId: runtime.providerId,
  providerLabel: runtime.providerLabel,
  providerKind: runtime.providerKind,
  model: runtime.model,
  timeoutMs,
  repeatCount,
  variants,
  cases: [],
};
let allPassed = true;

try {
  for (let iteration = 1; iteration <= repeatCount; iteration++) for (const benchmark of selected) {
    // Keep paired runs adjacent, and alternate which side runs first per repeat
    // to reduce confounding from provider load or time-based model drift.
    const orderedVariants = iteration % 2 === 1 ? variants : [...variants.slice(1), variants[0]];
    for (const variant of orderedVariants) {
      const disabledPromptAssets = variant.disabledPromptAssets;
      const workspace = path.join(runRoot, `${variant.name}-${benchmark.id}-${iteration}`);
      await fs.mkdir(workspace, { recursive: true });
      for (const [relative, content] of Object.entries(benchmark.files)) {
        assertSafeRelativePath(relative);
        const target = path.resolve(workspace, relative);
        if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error(`Fixture path escapes workspace: ${relative}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
      }

      const args = [path.join(repoRoot, 'scripts', 'agent-cli.mjs'), '--project', workspace, '--request', benchmark.request, '--mode', 'auto', '--task-kind', benchmark.taskKind || 'code'];
      if (disabledPromptAssets.length) args.push('--without-assets', disabledPromptAssets.join(','));
      for (const [flag, value] of [['--model', values.model], ['--provider', values.provider], ['--base-url', values['base-url']]]) {
        if (value) args.push(flag, value);
      }
      const startedAt = Date.now();
      const childEnv = { ...process.env };
      if (values['api-key']) childEnv.NEXUS_API_KEY = values['api-key'];
      const agent = await runLimitedProcess(process.execPath, args, { cwd: repoRoot, env: childEnv }, { timeoutMs });
      const durationMs = Date.now() - startedAt;
      const safeStdout = redactEvalOutput(agent.stdout, secretsToRedact);
      const safeStderr = redactEvalOutput(agent.stderr, secretsToRedact);
      const events = parseEvents(safeStdout);
      const result = parseResult(safeStdout);
      const expectedCheck = benchmark.files['eval.test.mjs'];
      if (typeof expectedCheck !== 'string') throw new Error(`Case ${benchmark.id} is missing its independent eval.test.mjs checker.`);
      const checkFixtureIntact = await restoreEvalChecker({ runRoot, workspace, expectedContents: expectedCheck });
      const check = await runLimitedProcess(process.execPath, ['--test', 'eval.test.mjs'], { cwd: workspace, env: process.env }, { timeoutMs });
      const commandExpansionUsed = events.some((event) => event.type === 'status' && /Expanded slash command\//.test(String(event.text)));
      const subagentDelegationUsed = events.some((event) => event.type === 'subagent');
      const skillReadUsed = events.some((event) => event.type === 'tool' && /^Skill loaded:/i.test(String(event.text)));
      const projectRulesLoaded = events.some((event) => event.type === 'status' && /Loaded \d+ project rule file/i.test(String(event.text)));
      const commandExpansionPassed = !benchmark.requireCommandExpansion || disabledPromptAssets.includes('commands') || commandExpansionUsed;
      const subagentDelegationPassed = !benchmark.requireSubagentDelegation || disabledPromptAssets.includes('agents') || subagentDelegationUsed;
      const skillReadPassed = !benchmark.requireSkillRead || disabledPromptAssets.includes('skills') || skillReadUsed;
      const projectRulesPassed = !benchmark.requireProjectRules || disabledPromptAssets.includes('rules') || projectRulesLoaded;
      const passed = agentEvalCasePassed({
        agentTimedOut: agent.timedOut,
        checkerTimedOut: check.timedOut,
        agentExitCode: agent.code,
        verification: result?.verification,
        checkerIntact: checkFixtureIntact,
        checkerExitCode: check.code,
        requireCommandExpansion: benchmark.requireCommandExpansion,
        commandsAssetDisabled: disabledPromptAssets.includes('commands'),
        commandExpansionUsed,
        requireSubagentDelegation: benchmark.requireSubagentDelegation,
        agentsAssetDisabled: disabledPromptAssets.includes('agents'),
        subagentDelegationUsed,
        requireSkillRead: benchmark.requireSkillRead,
        skillsAssetDisabled: disabledPromptAssets.includes('skills'),
        skillReadUsed,
        requireProjectRules: benchmark.requireProjectRules,
        rulesAssetDisabled: disabledPromptAssets.includes('rules'),
        projectRulesLoaded,
      });
      allPassed &&= Boolean(passed);
      report.cases.push({
        variant: variant.name,
        id: benchmark.id,
        iteration,
        title: benchmark.title,
        taskKind: benchmark.taskKind || 'code',
        disabledPromptAssets: result?.disabledPromptAssets ?? disabledPromptAssets,
        commandExpansionUsed,
        commandExpansionPassed,
        subagentDelegationPassed,
        skillReadPassed,
        projectRulesPassed,
        passed: Boolean(passed),
        durationMs,
        toolEventCount: events.filter((event) => event.type === 'tool').length,
        subagentEventCount: events.filter((event) => event.type === 'subagent').length,
        agentStartStatus: events.find((event) => event.type === 'status' && String(event.text).startsWith('Starting agent'))?.text ?? null,
        agentExitCode: agent.code,
        agentTimedOut: agent.timedOut,
        agentOutputTruncated: agent.stdoutTruncated || agent.stderrTruncated,
        verification: result?.verification ?? 'missing-result',
        usage: result?.usage ?? null,
        response: redactEvalOutput(result?.response ?? '', secretsToRedact),
        objectiveCheckExitCode: check.code,
        objectiveCheckTimedOut: check.timedOut,
        objectiveCheckOutputTruncated: check.stdoutTruncated || check.stderrTruncated,
        checkFixtureIntact,
        objectiveCheckOutput: redactEvalOutput(`${check.stdout}${check.stderr}`, secretsToRedact).slice(-8000),
        agentErrorOutput: safeStderr.slice(-4000),
      });
      process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${variant.name} · ${benchmark.id} (${iteration}/${repeatCount}) · agent=${result?.verification ?? 'no result'} · objective-check=${check.code}\n`);
    }
  }
} finally {
  report.finishedAt = new Date().toISOString();
  const comparison = summarizeAgentEvalVariants(report.cases, variants);
  report.summary = {
    totalRuns: report.cases.length,
    passedRuns: report.cases.filter((item) => item.passed).length,
    passRate: report.cases.length ? report.cases.filter((item) => item.passed).length / report.cases.length : 0,
    variants: comparison.variants,
    pairedComparisons: comparison.pairedComparisons,
  };
  report.passed = allPassed;
  const outputDir = path.join(repoRoot, '.nexus', 'evals');
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `${stamp}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rm(runRoot, { recursive: true, force: true });
  process.stdout.write(`Report: ${path.relative(repoRoot, reportPath)}\n`);
  for (const pair of comparison.pairedComparisons) {
    const passRateDelta = pair.passRateDelta === null ? 'n/a' : `${(pair.passRateDelta * 100).toFixed(1)}pp`;
    const tokenDelta = pair.pairedTotalTokensDelta === null ? 'n/a' : `${pair.pairedTotalTokensDelta > 0 ? '+' : ''}${pair.pairedTotalTokensDelta}`;
    const costDelta = pair.pairedEstimatedCostDelta === null ? 'n/a' : `${pair.pairedEstimatedCostDelta > 0 ? '+' : ''}${pair.pairedEstimatedCostDelta.toFixed(6)}`;
    process.stdout.write(`COMPARE ${pair.ablation} vs baseline · ${pair.pairedRuns} paired · baseline-only=${pair.baselineOnlyPass} · ablation-only=${pair.ablationOnlyPass} · both-pass=${pair.bothPass} · both-fail=${pair.bothFail} · pass-rate-delta=${passRateDelta} · token-delta=${tokenDelta} · cost-delta=${costDelta}\n`);
  }
}

if (!allPassed) process.exitCode = 1;
