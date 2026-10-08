import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { selectConfiguredProvider } from './provider-selection.mjs';

export function redactEvalOutput(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) text = text.replaceAll(secret, '[REDACTED]');
  }
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]');
}

export function agentEvalCasePassed({ agentTimedOut, checkerTimedOut, agentExitCode, verification, checkerIntact, checkerExitCode, requireCommandExpansion = false, commandsAssetDisabled = false, commandExpansionUsed = false, requireSubagentDelegation = false, agentsAssetDisabled = false, subagentDelegationUsed = false, requireSkillRead = false, skillsAssetDisabled = false, skillReadUsed = false, requireProjectRules = false, rulesAssetDisabled = false, projectRulesLoaded = false }) {
  const commandRequirementMet = !requireCommandExpansion || commandsAssetDisabled || commandExpansionUsed;
  const delegationRequirementMet = !requireSubagentDelegation || agentsAssetDisabled || subagentDelegationUsed;
  const skillRequirementMet = !requireSkillRead || skillsAssetDisabled || skillReadUsed;
  const rulesRequirementMet = !requireProjectRules || rulesAssetDisabled || projectRulesLoaded;
  return !agentTimedOut && !checkerTimedOut && agentExitCode === 0 && verification === 'passed' && checkerIntact && checkerExitCode === 0 && commandRequirementMet && delegationRequirementMet && skillRequirementMet && rulesRequirementMet;
}

export function parseEvalRepeatCount(value) {
  if (value === undefined) return 1;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw new Error('--repeat must be an integer from 1 to 10.');
  return count;
}

export function summarizeAgentEvalVariants(cases, variants) {
  const metric = (runs, field) => {
    const values = runs.map((item) => item.usage?.[field]).filter((value) => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const completeMetric = (runs, field) => runs.length && runs.every((item) => item.usage?.[field] !== null && item.usage?.[field] !== undefined && Number.isFinite(Number(item.usage[field])))
    ? metric(runs, field)
    : null;
  const sampleCount = (runs, field) => runs.filter((item) => item.usage?.[field] !== null && item.usage?.[field] !== undefined && Number.isFinite(Number(item.usage[field]))).length;
  const variantSummaries = variants.map((variant) => {
    const runs = cases.filter((item) => item.variant === variant.name);
    const passedRuns = runs.filter((item) => item.passed).length;
    const durations = runs.map((item) => Number(item.durationMs)).filter(Number.isFinite);
    return {
      name: variant.name,
      disabledPromptAssets: variant.disabledPromptAssets,
      totalRuns: runs.length,
      passedRuns,
      passRate: runs.length ? passedRuns / runs.length : 0,
      meanDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
      usageTotals: {
        inputTokens: completeMetric(runs, 'inputTokens'),
        outputTokens: completeMetric(runs, 'outputTokens'),
        totalTokens: completeMetric(runs, 'totalTokens'),
        estimatedCost: completeMetric(runs, 'estimatedCost'),
      },
      usageSamples: {
        inputTokens: sampleCount(runs, 'inputTokens'),
        outputTokens: sampleCount(runs, 'outputTokens'),
        totalTokens: sampleCount(runs, 'totalTokens'),
        estimatedCost: sampleCount(runs, 'estimatedCost'),
      },
    };
  });
  const baseline = new Map(cases.filter((item) => item.variant === 'baseline').map((item) => [`${item.id}\0${item.iteration}`, item]));
  const pairedComparisons = (variants.some((variant) => variant.name === 'baseline') ? variants.filter((variant) => variant.name !== 'baseline') : []).map((variant) => {
    const ablated = new Map(cases.filter((item) => item.variant === variant.name).map((item) => [`${item.id}\0${item.iteration}`, item]));
    let baselineOnlyPass = 0;
    let ablationOnlyPass = 0;
    let bothPass = 0;
    let bothFail = 0;
    let pairedRuns = 0;
    let baselinePassedRuns = 0;
    let ablationPassedRuns = 0;
    const pairedBaselineRuns = [];
    const pairedAblationRuns = [];
    for (const [key, baselineRun] of baseline) {
      const ablationRun = ablated.get(key);
      if (!ablationRun) continue;
      pairedRuns++;
      pairedBaselineRuns.push(baselineRun);
      pairedAblationRuns.push(ablationRun);
      if (baselineRun.passed) baselinePassedRuns++;
      if (ablationRun.passed) ablationPassedRuns++;
      if (baselineRun.passed && ablationRun.passed) bothPass++;
      else if (baselineRun.passed) baselineOnlyPass++;
      else if (ablationRun.passed) ablationOnlyPass++;
      else bothFail++;
    }
    return {
      baseline: 'baseline',
      ablation: variant.name,
      pairedRuns,
      bothPass,
      bothFail,
      baselineOnlyPass,
      ablationOnlyPass,
      passRateDelta: pairedRuns ? (ablationPassedRuns - baselinePassedRuns) / pairedRuns : null,
      pairedTotalTokensDelta: completeMetric(pairedAblationRuns, 'totalTokens') === null || completeMetric(pairedBaselineRuns, 'totalTokens') === null
        ? null
        : completeMetric(pairedAblationRuns, 'totalTokens') - completeMetric(pairedBaselineRuns, 'totalTokens'),
      pairedEstimatedCostDelta: completeMetric(pairedAblationRuns, 'estimatedCost') === null || completeMetric(pairedBaselineRuns, 'estimatedCost') === null
        ? null
        : completeMetric(pairedAblationRuns, 'estimatedCost') - completeMetric(pairedBaselineRuns, 'estimatedCost'),
    };
  });
  return { variants: variantSummaries, pairedComparisons };
}

/** Mirror the model/provider fallback order used by scripts/agent-cli.mjs so
 * benchmark reports identify the runtime configuration that actually runs. */
export function resolveAgentEvalRuntime({ providers = [], providerSelection, modelSelection, apiKey, env = {} }) {
  const configuredProvider = apiKey && !providerSelection ? null : selectConfiguredProvider(providers, providerSelection);
  const providerId = configuredProvider?.id ?? providerSelection ?? (apiKey ? 'headless' : null);
  const providerLabel = configuredProvider?.label ?? (providerId === 'headless' ? 'Headless' : null);
  const providerKind = configuredProvider?.provider ?? (providerSelection ? null : apiKey ? env.NEXUS_PROVIDER_KIND || 'openai' : null);
  const model = modelSelection || env.NEXUS_MODEL || configuredProvider?.models?.[0] || env.OPENAI_MODEL || (apiKey ? 'gpt-4.1-mini' : null);
  return { providerId, providerLabel, providerKind, model, configuredProvider };
}

/** Return a credential-free explanation when the CLI cannot start this eval. */
export function agentEvalReadinessError({ runtime, providerSelection, apiKey, providerEnvKey, env = {}, baseUrl }) {
  if (providerSelection && !runtime.configuredProvider) {
    return `No configured provider matches "${providerSelection}".`;
  }
  if (runtime.configuredProvider?.apiKey?.startsWith('safeStorage:v1:') && !apiKey) {
    return 'The selected provider key is encrypted for the desktop app and cannot be used by the headless evaluator. Pass --api-key or NEXUS_API_KEY.';
  }
  if (!runtime.configuredProvider && !apiKey) {
    return 'No usable API key/provider is available to the headless evaluator. Configure a plaintext provider key, pass --api-key, or set NEXUS_API_KEY / OPENAI_API_KEY.';
  }
  const provider = runtime.configuredProvider;
  if (provider?.provider === 'custom' && !(baseUrl || provider.baseUrl)) {
    return 'The selected custom provider needs a base URL. Configure it in the provider settings or pass --base-url.';
  }
  const localOrKeyless = provider?.provider === 'ollama' || provider?.provider === 'custom';
  if (provider && !localOrKeyless && !apiKey && !provider.apiKey && !(providerEnvKey && env[providerEnvKey])) {
    return `The selected provider has no usable API key. Add its key in Nexus, pass --api-key, or set ${providerEnvKey || 'the provider-specific environment variable'}.`;
  }
  return null;
}

export function runLimitedProcess(command, args, options, { timeoutMs = 600_000, maxOutputChars = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finished = false;
    let killHandle;
    const append = (current, part, stream) => {
      const joined = current + part;
      if (joined.length <= maxOutputChars) return joined;
      if (stream === 'stdout') stdoutTruncated = true;
      else stderrTruncated = true;
      return joined.slice(-maxOutputChars);
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      resolve({ stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, ...result });
    };
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killHandle = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout = append(stdout, part, 'stdout'); });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr = append(stderr, part, 'stderr'); });
    child.on('error', (error) => finish({ code: 1, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (code) => finish({ code: code ?? 1 }));
  });
}

/** Verify the fixture workspace still belongs to the disposable run root, then
 * restore a trusted checker without following a model-created symlink. */
export async function restoreEvalChecker({ runRoot, workspace, expectedContents }) {
  const rootStat = await fs.lstat(runRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Evaluation run root was replaced or is not a directory.');
  }
  const workspaceStat = await fs.lstat(workspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error('Evaluation workspace was replaced or is not a directory.');
  }
  const rootRealPath = await fs.realpath(runRoot);
  const workspaceRealPath = await fs.realpath(workspace);
  const relativeWorkspace = path.relative(rootRealPath, workspaceRealPath);
  if (!relativeWorkspace || relativeWorkspace === '..' || relativeWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorkspace)) {
    throw new Error('Evaluation workspace escaped its disposable run root.');
  }

  const checkerPath = path.join(workspace, 'eval.test.mjs');
  let actualContents = null;
  try {
    const checkerStat = await fs.lstat(checkerPath);
    if (checkerStat.isFile() && !checkerStat.isSymbolicLink()) {
      actualContents = await fs.readFile(checkerPath, 'utf8');
    }
  } catch { /* missing, replaced, or unreadable checkers are not intact */ }
  const intact = actualContents === expectedContents;

  // rm removes a symlink itself instead of following its destination. The
  // exclusive create refuses a replacement link racing this restore.
  await fs.rm(checkerPath, { recursive: true, force: true });
  await fs.writeFile(checkerPath, expectedContents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return intact;
}
