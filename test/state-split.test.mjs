// State-split test runner: executes each scenario in a child process with a
// scratch APPDATA (the store caches state at module scope, and the real
// user's nexus-state.json must never be touched by tests).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function runScenario(scenario) {
  return new Promise((resolve, reject) => {
    fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-split-')).then((scratch) => {
      const child = spawn(process.execPath, [path.join(here, 'state-split-scenario.mjs')], {
        env: { ...process.env, SCENARIO: scenario, SCRATCH_APPDATA: scratch },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (code) => {
        fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
        if (code === 0 && out.includes(`OK ${scenario}`)) resolve(out);
        else reject(new Error(`scenario ${scenario} failed (exit ${code}):\n${out}\n${err}`));
      });
    });
  });
}

const scenarios = ['basic-split', 'cold-hydration', 'migration'];
for (const scenario of scenarios) {
  try {
    await runScenario(scenario);
    console.log(`  ✓ state split: ${scenario}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ state split: ${scenario}`);
    console.error(error);
    failed++;
  }
}
console.log(`Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
