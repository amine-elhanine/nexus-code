#!/usr/bin/env node
// Offline Notebook retrieval and grounding evaluation. The injected generator
// deliberately avoids model calls so failures isolate retrieval/gating/citation
// behavior rather than provider variance.
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEvalRepeatCount } from './eval-runner-utils.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    case: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'without-assets': { type: 'string', default: '' },
    repeat: { type: 'string' },
  },
});
let repeatCount;
try {
  repeatCount = parseEvalRepeatCount(values.repeat);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const { parseDisabledPromptAssets } = await import('../dist-electron/prompt-assets.js');
let disabledPromptAssets;
try {
  disabledPromptAssets = parseDisabledPromptAssets(values['without-assets']);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
if (!values.live && disabledPromptAssets.length) {
  process.stderr.write('--without-assets requires --live; the offline generator does not exercise prompt assets.\n');
  process.exit(2);
}
if (values.live && disabledPromptAssets.some((asset) => asset !== 'skills')) {
  process.stderr.write('Notebook evaluation supports only --without-assets skills; Notebook has no repository rules, slash commands, or subagent tool.\n');
  process.exit(2);
}
const allCases = JSON.parse(await fs.readFile(path.join(repoRoot, 'evals', 'notebook.cases.json'), 'utf8'));
const cases = values.case ? allCases.filter((item) => item.id === values.case) : allCases;
if (!cases.length) {
  process.stderr.write(`Unknown case "${values.case}". Available: ${allCases.map((item) => item.id).join(', ')}\n`);
  process.exit(2);
}
let liveProvider = null;
let liveModel = null;
if (values.live) {
  const store = await import('../dist-electron/store.js');
  const providers = await store.listProviders().catch(() => []);
  liveProvider = values.provider
    ? providers.find((item) => item.id === values.provider)
    : providers.find((item) => item.enabled !== false && !item.keyNeedsReentry && (item.apiKey || item.provider === 'ollama' || item.provider === 'custom'));
  if (!liveProvider || liveProvider.enabled === false || liveProvider.keyNeedsReentry) {
    process.stderr.write(values.provider ? 'Selected provider is missing, disabled, or needs its key re-entered.\n' : 'No enabled provider with a usable key is configured.\n');
    process.exit(2);
  }
  liveModel = values.model || liveProvider.models?.[0];
  if (!liveModel) {
    process.stderr.write('No model selected; pass --model or add a model to the provider.\n');
    process.exit(2);
  }
  if (liveProvider.provider === 'custom' && !liveProvider.baseUrl) {
    process.stderr.write('The selected custom provider needs a base URL.\n');
    process.exit(2);
  }
}
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-notebook-eval-'));
const originCwd = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const report = {
  startedAt: new Date().toISOString(),
  mode: values.live ? 'live-agent' : 'offline-deterministic',
  providerId: liveProvider?.id ?? null,
  providerLabel: liveProvider?.label ?? null,
  model: liveModel,
  disabledPromptAssets,
  repeatCount,
  cases: [],
};
let passed = true;
let evaluatedCaseCount = 0;
let skippedCaseCount = 0;

try {
  process.chdir(runRoot);
  const store = await import('../dist-electron/notebook-store.js');
  const jobs = await import('../dist-electron/notebook-jobs.js');
  const rag = await import('../dist-electron/notebook-rag.js');

  for (const benchmark of cases) for (let iteration = 1; iteration <= repeatCount; iteration++) {
    if (benchmark.requiresLive && !values.live) {
      skippedCaseCount++;
      report.cases.push({ id: benchmark.id, iteration, status: 'skipped', passed: null, reason: 'This case requires a live model call.' });
      process.stdout.write(`SKIP ${benchmark.id} (${iteration}/${repeatCount}) · requires --live\n`);
      continue;
    }
    evaluatedCaseCount++;
    const caseStartedAt = Date.now();
    const notebook = await store.createNotebook(`Evaluation ${benchmark.id}`);
    for (const [filename, body] of Object.entries(benchmark.documents)) {
      const source = await store.importSourceBuffer(notebook.id, filename, Buffer.from(body, 'utf8'));
      await jobs.runIngestJob(notebook.id, source.id);
    }

    const toolEvents = [];
    const ragOptions = values.live
      ? {
          chatProviderId: liveProvider.id,
          chatModel: liveModel,
          disabledPromptAssets,
          onTool: (name) => toolEvents.push(name),
        }
      : {
          generate: async (_system, user) => {
            const references = [...user.matchAll(/\[S(\d+)\]\s+([^\n]+)/g)];
            return benchmark.citationClaims.map((claim) => {
              const reference = references.find((match) => match[2].toLowerCase().includes(claim.sourceName.toLowerCase()));
              return `${claim.text} [S${reference?.[1] || '99'}].`;
            }).join(' ');
          },
        };
    const result = await rag.answerNotebookQuestion(notebook.id, benchmark.question, [], ragOptions);
    const sourceNames = result.sources.map((source) => source.sourceName);
    const missingSources = benchmark.expectedSources.filter((name) => !sourceNames.includes(name));
    const sourceExpectationPassed = missingSources.length === 0 && sourceNames.length >= benchmark.expectedSources.length;
    const factCoverage = benchmark.citationClaims.map((claim) => {
      const requiredTerms = claim.requiredTerms || [claim.text];
      const sentence = result.answer.split(/(?<=[.!?])\s+/).find((part) => requiredTerms.every((term) => {
        const alternatives = Array.isArray(term) ? term : [term];
        return alternatives.some((phrase) => part.toLowerCase().includes(phrase.toLowerCase()));
      })) || '';
      const source = result.sources.find((item) => item.sourceName === claim.sourceName);
      const passedClaim = Boolean(sentence && source && sentence.includes(`[S${source.index}]`));
      return { claim: claim.text, requiredTerms, expectedSource: claim.sourceName, citation: source ? `S${source.index}` : null, passed: passedClaim };
    });
    const factCoveragePassed = factCoverage.every((claim) => claim.passed);
    const forbiddenTerms = benchmark.forbiddenTerms || [];
    const forbiddenMatches = forbiddenTerms.filter((term) => result.answer.toLowerCase().includes(term.toLowerCase()));
    const forbiddenTermsPassed = forbiddenMatches.length === 0;
    const answerLooksLikeRefusal = /\b(?:not covered|not mentioned|do not contain|don't contain|cannot answer|can't answer|unable to answer|could not find|couldn't find|doesn't appear to be covered|does not appear to be covered|only answer from the uploaded files|not in the (?:provided|uploaded) documents)\b/i.test(result.answer);
    const actualRefusal = Boolean(result.metadata.refused || answerLooksLikeRefusal);
    const refusalPassed = actualRefusal === benchmark.expectedRefusal;
    const verdictPassed = benchmark.expectedVerdict === null || result.evaluation?.verdict === benchmark.expectedVerdict;
    const passedCase = sourceExpectationPassed && factCoveragePassed && forbiddenTermsPassed && refusalPassed && verdictPassed;
    passed &&= passedCase;
    report.cases.push({
      id: benchmark.id,
      iteration,
      passed: passedCase,
      durationMs: Date.now() - caseStartedAt,
      question: benchmark.question,
      expectedSources: benchmark.expectedSources,
      actualSources: sourceNames,
      missingSources,
      factCoverage,
      factCoveragePassed,
      forbiddenTerms,
      forbiddenMatches,
      forbiddenTermsPassed,
      expectedRefusal: benchmark.expectedRefusal,
      actualRefusal,
      refusalTextDetected: answerLooksLikeRefusal,
      expectedVerdict: benchmark.expectedVerdict,
      actualVerdict: result.evaluation?.verdict ?? null,
      citationCoverage: result.evaluation?.citationCoverage ?? null,
      routing: result.metadata.routing,
      topScore: result.metadata.topScore,
      fallbackModel: result.metadata.fallbackModel,
      steps: (result.steps || []).map((step) => step.name),
      toolEvents,
      answer: result.answer,
    });
    process.stdout.write(`${passedCase ? 'PASS' : 'FAIL'} ${benchmark.id} (${iteration}/${repeatCount}) · sources=${sourceNames.length} · refused=${result.metadata.refused} · groundedness=${result.evaluation?.verdict || 'n/a'}\n`);
  }
  if (evaluatedCaseCount === 0) {
    passed = false;
    report.error = 'No cases were evaluated; the selected case requires --live.';
    process.stderr.write(`${report.error}\n`);
  }
} catch (error) {
  passed = false;
  let message = error instanceof Error ? error.message : String(error);
  if (liveProvider?.apiKey) message = message.replaceAll(liveProvider.apiKey, '[REDACTED]');
  report.error = message;
  process.stderr.write(`Notebook evaluation failed: ${message}\n`);
} finally {
  process.chdir(originCwd);
  report.finishedAt = new Date().toISOString();
  report.passed = passed;
  report.complete = skippedCaseCount === 0 && evaluatedCaseCount > 0;
  report.status = !passed ? 'failed' : report.complete ? 'passed' : 'partial';
  report.evaluatedCaseCount = evaluatedCaseCount;
  report.skippedCaseCount = skippedCaseCount;
  report.summary = {
    expectedRuns: cases.length * repeatCount,
    totalRuns: evaluatedCaseCount,
    passedRuns: report.cases.filter((item) => item.status !== 'skipped' && item.passed).length,
    skippedRuns: skippedCaseCount,
    passRate: evaluatedCaseCount ? report.cases.filter((item) => item.status !== 'skipped' && item.passed).length / evaluatedCaseCount : 0,
  };
  const outputDir = path.join(repoRoot, '.nexus', 'evals');
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `notebook-${stamp}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rm(runRoot, { recursive: true, force: true });
  if (report.status === 'partial') {
    process.stdout.write(`PARTIAL evaluation: ${evaluatedCaseCount}/${cases.length * repeatCount} runs evaluated; ${skippedCaseCount} skipped.\n`);
  }
  process.stdout.write(`Report: ${path.relative(repoRoot, reportPath)}\n`);
}

if (!passed) process.exitCode = 1;
