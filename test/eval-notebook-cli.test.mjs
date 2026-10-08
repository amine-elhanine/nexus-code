import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(repoRoot, "scripts", "eval-notebook.mjs");

function run(args) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: repoRoot, encoding: "utf8" });
}

test("offline Notebook evaluation rejects prompt-asset ablations", () => {
  const result = run(["--without-assets", "skills"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --live/);
});

test("Notebook live evaluation rejects assets the mode does not use", () => {
  const result = run(["--live", "--without-assets", "rules"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /supports only --without-assets skills/);
});

test("Notebook evaluation rejects unknown cases before creating a report or calling a provider", () => {
  const result = run(["--case", "does-not-exist"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown case/);
});

test("Notebook evaluation rejects invalid repeat counts before starting a run", () => {
  const result = run(["--repeat", "11"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--repeat must be an integer from 1 to 10/);
});

test("offline Notebook evaluation skips live-only injection case instead of passing it synthetically", () => {
  const result = run(["--case", "notebook-resists-source-injection"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SKIP notebook-resists-source-injection \(1\/1\) · requires --live/);
  assert.match(result.stderr, /No cases were evaluated/);
});

test("Notebook evaluation repeats a case and records aggregate pass rate", async () => {
  const result = run(["--case", "notebook-grounded-answer", "--repeat", "2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /notebook-grounded-answer \(1\/2\)/);
  assert.match(result.stdout, /notebook-grounded-answer \(2\/2\)/);
  const reportPath = result.stdout.match(/Report: (\.nexus[\\/]evals[\\/]notebook-[^\r\n]+\.json)/)?.[1];
  assert.ok(reportPath, "runner should print its result report path");
  const absoluteReportPath = path.resolve(repoRoot, reportPath);
  try {
    const report = JSON.parse(await fs.readFile(absoluteReportPath, "utf8"));
    assert.equal(report.repeatCount, 2);
    assert.equal(report.summary.totalRuns, 2);
    assert.equal(report.summary.expectedRuns, 2);
    assert.equal(report.summary.passedRuns, 2);
    assert.equal(report.summary.skippedRuns, 0);
    assert.equal(report.summary.passRate, 1);
    assert.equal(report.status, "passed");
    assert.equal(report.complete, true);
    assert.deepEqual(report.cases.map((item) => item.iteration), [1, 2]);
  } finally {
    await fs.rm(absoluteReportPath, { force: true });
  }
});

test("the offline full Notebook evaluation reports skipped live coverage as partial", async () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PARTIAL evaluation: 3\/4 runs evaluated; 1 skipped/);
  const reportPath = result.stdout.match(/Report: (\.nexus[\\/]evals[\\/]notebook-[^\r\n]+\.json)/)?.[1];
  assert.ok(reportPath, "runner should print its result report path");
  const absoluteReportPath = path.resolve(repoRoot, reportPath);
  try {
    const report = JSON.parse(await fs.readFile(absoluteReportPath, "utf8"));
    assert.equal(report.passed, true, "all evaluated offline cases passed");
    assert.equal(report.complete, false);
    assert.equal(report.status, "partial");
    assert.equal(report.summary.expectedRuns, 4);
    assert.equal(report.summary.totalRuns, 3);
    assert.equal(report.summary.skippedRuns, 1);
  } finally {
    await fs.rm(absoluteReportPath, { force: true });
  }
});
