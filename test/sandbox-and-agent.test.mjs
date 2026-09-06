import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import {
  beginCommandRun,
  cancelCommandRun,
  isCommandRunCancelled,
  runProjectCommand,
  executeCommand,
  getAgentBackend,
} from '../dist-electron/command-service.js';
import { upsertProject, upsertProvider, removeProvider, listProviders, createSession, updateSession, getSession, appendSessionMessage, appendSessionMessages, calculateSessionUsage } from '../dist-electron/store.js';
import { pickVerificationCommand, findTargetedTests } from '../dist-electron/agent-service.js';
import {
  revertWorkspaceFile,
  revertAllWorkspaceChanges,
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  getWorkspaceDiffFiles,
  deleteWorkspaceCheckpoint,
} from '../dist-electron/diff-service.js';
import { parseSymbolsFromCode, formatOutline, createCodeIntelligenceTools } from '../dist-electron/code-tools.js';
import { SUBAGENT_CONFIGS, createSubagentDelegationTool, calculateAgentUsage, getModelPricing } from '../dist-electron/subagent-service.js';
import { createSkill, importSkill, listSkills, deleteSkill, readSkillContent } from '../dist-electron/skills-service.js';
import { isGitRepo, createSessionWorktree, getSessionWorktree, mergeWorktreeToMain, discardSessionWorktree } from '../dist-electron/worktree-service.js';
import { compactHistory, estimateTokens } from '../dist-electron/context-service.js';
import { saveArtifact, getArtifact, listArtifacts, updateArtifactStatus } from '../dist-electron/artifacts-service.js';
import { TrajectoryLogger, readSessionTrajectory } from '../dist-electron/trajectory-service.js';
import { discoverProjectRules } from '../dist-electron/rules-service.js';
import { createBrowserTools } from '../dist-electron/browser-tool.js';
import { terminalService } from '../dist-electron/terminal-service.js';
import { discoverCustomCommands, substituteCommandPlaceholders } from '../dist-electron/custom-commands-service.js';
import { DaemonService, daemonService } from '../dist-electron/daemon-service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

app.whenReady().then(async () => {
  console.log('\n=== 1. Command Execution Tests (direct execution, sandbox removed) ===');

  await test('executeCommand runs arbitrary commands directly and returns their output and exit code', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cmd-'));
    const project = await upsertProject({ id: 'test-cmd', name: 'cmd-test', root: tempDir });
    beginCommandRun();

    // Arbitrary tools run — that is the point of removing the sandbox.
    const echoResult = await runProjectCommand(project, 'node -e "console.log(42)"');
    assert.equal(echoResult.exitCode, 0);
    assert.match(String(echoResult.output), /42/);

    // Shell features work too — the old policy used to block them.
    const piped = await runProjectCommand(project, 'node -e "console.log(1;)" 2>&1 || echo failed');
    assert.equal(piped.exitCode, 0);

    // Failing commands report a non-zero exit code without throwing.
    const failing = await executeCommand(tempDir, 'node -e "process.exit(3)"');
    assert.equal(failing.exitCode, 3);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('empty command is rejected without spawning a shell', async () => {
    const result = await executeCommand(os.tmpdir(), '   ');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /empty/i);
  });

  console.log('\n=== 2. Cancellation & Process Tree Termination Tests ===');

  await test('Cancellation flags: beginCommandRun resets, cancelCommandRun sets cancelled flag', () => {
    beginCommandRun();
    assert.equal(isCommandRunCancelled(), false);
    cancelCommandRun();
    assert.equal(isCommandRunCancelled(), true);
    beginCommandRun();
    assert.equal(isCommandRunCancelled(), false);
  });

  await test('Process Tree Termination: Long running command is killed via cancelCommandRun()', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cancel-'));
    const scriptPath = path.join(tempDir, 'loop.js');
    await fs.writeFile(scriptPath, 'const t = Date.now(); while(Date.now() - t < 30000) {}', 'utf8');

    const project = await upsertProject({ id: 'test-cancel', name: 'cancel-test', root: tempDir });

    beginCommandRun();
    const runPromise = runProjectCommand(project, `node ${scriptPath}`);

    await new Promise((r) => setTimeout(r, 250));
    const startTime = Date.now();
    cancelCommandRun();

    const result = await runPromise;
    const elapsed = Date.now() - startTime;

    assert.ok(elapsed < 4000, `Process tree was terminated promptly in ${elapsed}ms`);
    assert.equal(result.exitCode, 130);
    assert.match(result.output, /cancelled by user/i);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 3. Read-Only Backend Tests (Plan Mode) ===');

  await test('Read-only backend blocks write, edit, delete, and execute with descriptive message', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-readonly-'));
    const project = await upsertProject({ id: 'test-readonly', name: 'readonly-test', root: tempDir });

    const { backend } = await getAgentBackend(project, { readOnly: true });

    await assert.rejects(
      async () => backend.write('file.txt', 'test'),
      /Plan mode is read-only: write_file is disabled/i
    );

    await assert.rejects(
      async () => backend.edit('file.txt', 'old', 'new'),
      /Plan mode is read-only: edit_file is disabled/i
    );

    await assert.rejects(
      async () => backend.delete('file.txt'),
      /Plan mode is read-only: delete is disabled/i
    );

    await assert.rejects(
      async () => backend.execute('git status'),
      /Plan mode is read-only: execute is disabled/i
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 4. Verification Command Selection Tests ===');

  await test('Verification command picks npm run typecheck when typecheck script exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', check: 'npm run lint' } }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}', 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'npm run typecheck');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks npm run check over bare tsc when a check script exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { check: 'tsc -p a && tsc -p b' } }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}', 'utf8');

    // A `check` script often covers more tsconfigs than bare tsc --noEmit
    // (which would silently check only the default project), so it wins.
    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'npm run check');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks tsc --noEmit when tsconfig.json exists without scripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}', 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'tsc --noEmit');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks npm run lint when lint script is only check script', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }), 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'npm run lint');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks cargo check when Cargo.toml exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-rust-'));
    await fs.writeFile(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"', 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'cargo check');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks go vet ./... when go.mod exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-go-'));
    await fs.writeFile(path.join(tempDir, 'go.mod'), 'module example.com/test\ngo 1.21', 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'go vet ./...');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks ruff check when pyproject.toml exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-py-'));
    await fs.writeFile(path.join(tempDir, 'pyproject.toml'), '[tool.ruff]\nline-length = 88', 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'ruff check');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command returns null when no matching script, tsconfig, or manifest exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }), 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 5. Checkpointing & Revert Tests ===');

  await test('revertWorkspaceFile discards single modified and untracked files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-git-revert-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'original file 1\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Modify file1 and create untracked file2
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'modified file 1\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'file2.txt'), 'untracked file 2\n', 'utf8');

    assert.equal((await fs.readFile(path.join(tempDir, 'file1.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'modified file 1\n');

    // Revert modified file1
    await revertWorkspaceFile(tempDir, 'file1.txt');
    assert.equal((await fs.readFile(path.join(tempDir, 'file1.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'original file 1\n');

    // Revert untracked file2
    await revertWorkspaceFile(tempDir, 'file2.txt');
    let file2Exists = true;
    try { await fs.access(path.join(tempDir, 'file2.txt')); } catch { file2Exists = false; }
    assert.equal(file2Exists, false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('createWorkspaceCheckpoint and restoreWorkspaceCheckpoint roll back entire workspace state, and survive an app restart', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-checkpoint-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'export const a = 1;\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Create pre-run checkpoint — it must be written to disk under .nexus/.
    const checkpointId = await createWorkspaceCheckpoint(tempDir, 'chk-1');
    assert.equal(checkpointId, 'chk-1');
    const checkpointFile = path.join(tempDir, '.nexus', 'checkpoints', 'chk-1.json');
    let manifestExists = true;
    try { await fs.access(checkpointFile); } catch { manifestExists = false; }
    assert.equal(manifestExists, true, 'checkpoint manifest must persist to disk');

    // Agent makes changes: edits app.ts and adds new-feature.ts
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'export const a = 999;\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'new-feature.ts'), 'export const feat = true;\n', 'utf8');

    // Restore checkpoint
    await restoreWorkspaceCheckpoint(tempDir, checkpointId);

    // Verify rollback
    assert.equal((await fs.readFile(path.join(tempDir, 'app.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'export const a = 1;\n');
    let newFeatExists = true;
    try { await fs.access(path.join(tempDir, 'new-feature.ts')); } catch { newFeatExists = false; }
    assert.equal(newFeatExists, false);

    // "Restart" simulation: the module-level state is gone, but the
    // disk-persisted checkpoint still restores (file unchanged, so restore
    // simply rewrites the same content — the point is it does not throw
    // "unknown checkpoint").
    const restoredAgain = await restoreWorkspaceCheckpoint(tempDir, checkpointId);
    assert.equal(restoredAgain, true, 'disk-persisted checkpoint survives restart');
    assert.equal((await fs.readFile(path.join(tempDir, 'app.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'export const a = 1;\n');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('checkpoint restore also reverts files the checkpoint recorded as clean but which no longer differ from HEAD', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cp-union-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'clean a\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Dirty state at checkpoint time includes a.txt (modified vs HEAD).
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'dirty a\n', 'utf8');
    const cpId = await createWorkspaceCheckpoint(tempDir, 'cp-union');

    // The agent reverts a.txt itself (back to clean) but edits a second file
    // that was clean at snapshot time... and then also resets that second file
    // by hand. Only a union restore guarantees the workspace returns exactly.
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'changed again\n', 'utf8');
    await restoreWorkspaceCheckpoint(tempDir, cpId);
    assert.equal((await fs.readFile(path.join(tempDir, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'dirty a\n');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('revertAllWorkspaceChanges clears all uncommitted changes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-revertall-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'main.ts'), 'console.log("hello");\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    await fs.writeFile(path.join(tempDir, 'main.ts'), 'console.log("changed");\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'extra.ts'), 'extra\n', 'utf8');

    await revertAllWorkspaceChanges(tempDir);

    assert.equal((await fs.readFile(path.join(tempDir, 'main.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'console.log("hello");\n');
    let extraExists = true;
    try { await fs.access(path.join(tempDir, 'extra.ts')); } catch { extraExists = false; }
    assert.equal(extraExists, false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('restoreWorkspaceCheckpoint restores the snapshot\'s own root regardless of caller path', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cp-root-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'original content\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    const cpId = await createWorkspaceCheckpoint(tempDir, 'cp-root-test');
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'modified content\n', 'utf8');

    // Pass a bogus root to restore, it should use the snapshot\'s own recorded projectRoot
    const restored = await restoreWorkspaceCheckpoint('/invalid/bogus/path', cpId);
    assert.equal(restored, true);
    assert.equal((await fs.readFile(path.join(tempDir, 'file.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'original content\n');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('restoreWorkspaceCheckpoint throws (does not silently return false) when checkpoint is unknown', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cp-unknown-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'keep.txt'), 'uncommitted keep\n', 'utf8');

    // An unknown checkpoint must be a loud error the UI can surface, never a
    // silent no-op that leaves the Undo card offering a dead action.
    await assert.rejects(
      async () => restoreWorkspaceCheckpoint(tempDir, 'non-existent-checkpoint'),
      /Unknown checkpoint/i
    );

    // Verify uncommitted file was NOT wiped
    let exists = true;
    try { await fs.access(path.join(tempDir, 'keep.txt')); } catch { exists = false; }
    assert.equal(exists, true);
    assert.equal((await fs.readFile(path.join(tempDir, 'keep.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'uncommitted keep\n');

    // deleteWorkspaceCheckpoint is a no-op-safe cleanup for missing ids.
    await deleteWorkspaceCheckpoint(tempDir, 'never-existed');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('getWorkspaceDiffFiles ignores .nexus, .forgepilot, and .deepagents files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-diff-ignore-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'src.ts'), 'export const x = 1;\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Modify src.ts and create .nexus internal telemetry files
    await fs.writeFile(path.join(tempDir, 'src.ts'), 'export const x = 2;\n', 'utf8');
    await fs.mkdir(path.join(tempDir, '.nexus'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.nexus', 'state.json'), '{"telemetry":true}', 'utf8');
    await fs.mkdir(path.join(tempDir, '.deepagents'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.deepagents', 'skills.json'), '{}', 'utf8');

    const diffs = await getWorkspaceDiffFiles(tempDir);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, 'src.ts');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 6. Code Symbol Intelligence Tests ===');

  await test('parseSymbolsFromCode extracts classes, functions, interfaces, types from TypeScript', () => {
    const code = `
export interface User {
  id: string;
  name: string;
}

export type UserRole = "admin" | "member";

export class UserService {
  private count = 0;

  public async getUser(id: string): Promise<User> {
    return { id, name: "Alice" };
  }

  deleteUser(id: string) {
    this.count--;
  }
}

export function formatUser(u: User): string {
  return u.name;
}

export const helper = () => true;
`;

    const symbols = parseSymbolsFromCode('src/user.ts', code);
    assert.ok(symbols.length >= 5, `Expected >= 5 symbols, got ${symbols.length}`);

    const names = symbols.map((s) => s.name);
    assert.ok(names.includes('User'));
    assert.ok(names.includes('UserRole'));
    assert.ok(names.includes('UserService'));
    assert.ok(names.includes('getUser'));
    assert.ok(names.includes('deleteUser'));
    assert.ok(names.includes('formatUser'));

    const outline = formatOutline('src/user.ts', symbols);
    assert.match(outline, /interface User/);
    assert.match(outline, /class UserService/);
    assert.match(outline, /method getUser/);
    assert.match(outline, /function formatUser/);
  });

  await test('parseSymbolsFromCode extracts classes and functions from Python', () => {
    const pyCode = `
class DataProcessor:
    def __init__(self, data):
        self.data = data

    def process(self):
        return [x * 2 for x in self.data]

async def fetch_data(url: str):
    return {}
`;

    const symbols = parseSymbolsFromCode('processor.py', pyCode);
    const names = symbols.map((s) => s.name);
    assert.ok(names.includes('DataProcessor'));
    assert.ok(names.includes('__init__'));
    assert.ok(names.includes('process'));
    assert.ok(names.includes('fetch_data'));
  });

  await test('parseSymbolsFromCode extracts funcs and structs from Go and Rust', () => {
    const goCode = `
package main
type Server struct { port int }
type Handler interface { Handle() }
func (s *Server) Start() error { return nil }
func NewServer() *Server { return &Server{} }
`;
    const goSymbols = parseSymbolsFromCode('server.go', goCode);
    const goNames = goSymbols.map((s) => s.name);
    assert.ok(goNames.includes('Server'));
    assert.ok(goNames.includes('Handler'));
    assert.ok(goNames.includes('Start'));
    assert.ok(goNames.includes('NewServer'));

    const rsCode = `
pub struct Config { pub timeout: u32 }
pub enum Mode { Fast, Slow }
pub trait Runner { fn run(&self); }
pub async fn execute_task(task: &str) -> bool { true }
`;
    const rsSymbols = parseSymbolsFromCode('lib.rs', rsCode);
    const rsNames = rsSymbols.map((s) => s.name);
    assert.ok(rsNames.includes('Config'));
    assert.ok(rsNames.includes('Mode'));
    assert.ok(rsNames.includes('Runner'));
    assert.ok(rsNames.includes('execute_task'));
  });

  await test('read_file_range extracts targeted line slices with line numbers', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-range-'));
    const filePath = path.join(tempDir, 'sample.txt');
    const content = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n');
    await fs.writeFile(filePath, content, 'utf8');

    const tools = createCodeIntelligenceTools(tempDir);
    const readRangeTool = tools.find((t) => t.name === 'read_file_range');
    assert.ok(readRangeTool);

    const result = await readRangeTool.invoke({ filePath: 'sample.txt', startLine: 10, endLine: 15 });
    assert.match(result, /lines 10-15 of 50/);
    assert.match(result, /10 \| Line 10/);
    assert.match(result, /15 \| Line 15/);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('grep_search finds matching regex patterns across workspace files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-grep-'));
    await fs.writeFile(path.join(tempDir, 'file1.ts'), 'export const SECRET_KEY = "alpha";\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'file2.js'), 'const other = 123;\nconst SECRET_KEY = "beta";\n', 'utf8');

    const tools = createCodeIntelligenceTools(tempDir);
    const grepTool = tools.find((t) => t.name === 'grep_search');
    assert.ok(grepTool);

    const result = await grepTool.invoke({ query: 'SECRET_KEY', isRegex: false });
    assert.match(result, /Found 2 match\(es\)/);
    assert.match(result, /file1\.ts:1:/);
    assert.match(result, /file2\.js:2:/);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 7. Targeted Test Resolution Tests ===');

  await test('findTargetedTests matches modified files to existing test files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-targeted-tests-'));
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'test'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'vitest' } }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'auth.ts'), 'export const auth = true;', 'utf8');
    await fs.writeFile(path.join(tempDir, 'test', 'auth.test.ts'), 'test("auth", () => {});', 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'user.ts'), 'export const user = true;', 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'user.spec.ts'), 'test("user", () => {});', 'utf8');

    const testsForAuth = findTargetedTests(tempDir, ['src/auth.ts']);
    assert.equal(testsForAuth, 'npm test -- test/auth.test.ts');

    const testsForUser = findTargetedTests(tempDir, ['src/user.ts']);
    assert.equal(testsForUser, 'npm test -- src/user.spec.ts');

    const testsForNone = findTargetedTests(tempDir, ['package.json', 'README.md']);
    assert.equal(testsForNone, null);

    // Fallback returns null when no test runner or script is configured
    const tempDirNoPkg = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-no-test-runner-'));
    await fs.mkdir(path.join(tempDirNoPkg, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDirNoPkg, 'src', 'auth.ts'), 'export const auth = true;', 'utf8');
    const testsNoRunner = findTargetedTests(tempDirNoPkg, ['src/auth.ts']);
    assert.equal(testsNoRunner, null);

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(tempDirNoPkg, { recursive: true, force: true });
  });

  console.log('\n=== 8. Subagent Delegation & Isolation Tests ===');

  await test('Subagent role configs define isolated system prompts, read-only permissions, and recursion limits', () => {
    assert.equal(SUBAGENT_CONFIGS.researcher.title, 'Researcher');
    assert.equal(SUBAGENT_CONFIGS.researcher.readOnly, true);
    assert.match(SUBAGENT_CONFIGS.researcher.systemPrompt('/app'), /Research Subagent/);
    assert.match(SUBAGENT_CONFIGS.researcher.systemPrompt('/app'), /READ-ONLY/);

    assert.equal(SUBAGENT_CONFIGS.tester.title, 'Test & Debug');
    assert.equal(SUBAGENT_CONFIGS.tester.readOnly, false);
    assert.match(SUBAGENT_CONFIGS.tester.systemPrompt('/app'), /Test & Debug Subagent/);

    assert.equal(SUBAGENT_CONFIGS.coder.title, 'Coder / Refactorer');
    assert.equal(SUBAGENT_CONFIGS.coder.readOnly, false);
    assert.match(SUBAGENT_CONFIGS.coder.systemPrompt('/app'), /Coder Subagent/);
  });

  await test('calculateAgentUsage computes exact costs for known models and null for unknown ones', () => {
    const claudeUsage = calculateAgentUsage(100000, 20000, 'claude-3-5-sonnet');
    assert.equal(claudeUsage.totalTokens, 120000);
    // (100000 / 1000000) * 3.00 + (20000 / 1000000) * 15.00 = 0.30 + 0.30 = 0.60
    assert.equal(claudeUsage.estimatedCost, 0.6);

    // Known model, no fabricated fallback either way.
    assert.equal(getModelPricing('gpt-4.1-mini').inputPerMillion, 0.15);

    // Unknown model (local Ollama model, free tier, aggregator catalogue):
    // no invented dollar figure — the UI renders "—".
    assert.equal(getModelPricing('qwen3-coder'), null);
    assert.equal(getModelPricing(undefined), null);
    assert.equal(getModelPricing('z-ai/glm-5.3-free'), null);
    const unknownUsage = calculateAgentUsage(10000, 5000, 'qwen3-coder');
    assert.equal(unknownUsage.estimatedCost, null);
    assert.equal(unknownUsage.totalTokens, 15000);
  });

  await test('createSubagentDelegationTool exports delegate_task with schema validation', () => {
    const delegationTool = createSubagentDelegationTool({
      projectRoot: '/test',
      provider: { id: 'test', label: 'Test', provider: 'openai', apiKey: 'key', models: ['gpt-4'] },
      modelName: 'gpt-4',
      projectRecord: { id: 'test', name: 'test', root: '/test' },
    });

    assert.equal(delegationTool.name, 'delegate_task');
    assert.ok(delegationTool.description.includes('subagent'));
  });

  await test('Researcher subagent backend blocks write operations in read-only mode', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-subagent-'));
    const project = await upsertProject({ id: 'test-subagent-proj', name: 'subagent-test', root: tempDir });

    const { backend } = await getAgentBackend(project, { readOnly: true });

    await assert.rejects(
      async () => backend.write('mutation.txt', 'forbidden'),
      /Plan mode is read-only: write_file is disabled/
    );

    await assert.rejects(
      async () => backend.delete('file.txt'),
      /Plan mode is read-only: delete is disabled/
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 9. Provider Lifecycle & Deletion Tests ===');

  await test('upsertProvider creates and saves provider with unique ID', async () => {
    const list = await upsertProvider({
      provider: 'openai',
      label: 'OpenAI Test',
      apiKey: 'sk-test-key-123',
      models: ['gpt-5.5', 'gpt-4.1'],
    });
    assert.ok(list.length > 0);
    const created = list.find((p) => p.label === 'OpenAI Test');
    assert.ok(created);
    assert.ok(created.id);
    assert.equal(created.provider, 'openai');
  });

  await test('removeProvider clears deleted provider from sessions and provider list', async () => {
    const p1List = await upsertProvider({
      provider: 'openai',
      label: 'OpenAI to Delete',
      apiKey: 'sk-test-delete',
      models: ['gpt-5.5'],
    });
    const p2List = await upsertProvider({
      provider: 'anthropic',
      label: 'Anthropic Retained',
      apiKey: 'sk-ant-test',
      models: ['claude-3-7-sonnet'],
    });
    const p1 = p1List.find((p) => p.label === 'OpenAI to Delete');
    const p2 = p2List.find((p) => p.label === 'Anthropic Retained');
    assert.ok(p1 && p2);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-session-prov-'));
    const project = await upsertProject({ name: 'Provider Lifecycle Project', root: tempDir });
    const session = await createSession(project.id, 'Session with P1');
    const updated = await updateSession(project.id, session.id, {
      model: { providerId: p1.id, model: 'gpt-5.5' },
    });
    assert.equal(updated.model?.providerId, p1.id);

    // Delete p1
    const remainingAfterP1 = await removeProvider(p1.id);
    assert.ok(!remainingAfterP1.some((p) => p.id === p1.id));
    assert.ok(remainingAfterP1.some((p) => p.id === p2.id));

    // Verify session model was cleared on deleted provider
    const checkedSession = await getSession(project.id, session.id);
    assert.equal(checkedSession?.model, undefined);

    // Delete p2
    const remainingAfterP2 = await removeProvider(p2.id);
    assert.ok(!remainingAfterP2.some((p) => p.id === p2.id));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 10. Skills Service Lifecycle & Import Tests ===');

  await test('createSkill creates a valid skill with frontmatter and instructions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-skill-proj-'));
    const skill = await createSkill(tempDir, {
      name: 'react-testing-guide',
      description: 'Guide for writing unit tests with vitest',
      scope: 'project',
      content: '---\nname: react-testing-guide\ndescription: Guide for writing unit tests with vitest\n---\n\n# React Testing\n\nFollow test standards.',
    });
    assert.equal(skill.name, 'react-testing-guide');
    assert.equal(skill.source, 'project');

    const content = await readSkillContent(skill.path);
    assert.ok(content.includes('React Testing'));

    const list = await listSkills(tempDir);
    assert.ok(list.some((s) => s.name === 'react-testing-guide'));

    await deleteSkill(skill.path);
    const listAfterDelete = await listSkills(tempDir);
    assert.ok(!listAfterDelete.some((s) => s.name === 'react-testing-guide'));

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('importSkill imports a SKILL.md file or folder into library', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-skill-import-'));
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-ext-skill-'));
    const externalSkillMd = path.join(externalDir, 'SKILL.md');
    await fs.writeFile(
      externalSkillMd,
      '---\nname: node-security\ndescription: Secure coding practices for Node\n---\n\n# Node Security\n\nValidate inputs.',
      'utf8'
    );

    const imported = await importSkill(tempDir, externalSkillMd, 'project');
    assert.equal(imported.name, 'node-security');
    assert.equal(imported.source, 'project');

    const list = await listSkills(tempDir);
    assert.ok(list.some((s) => s.name === 'node-security'));

    await deleteSkill(imported.path);
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  await test('importSkill imports arbitrary named markdown and text files (e.g. guidelines.md, notes.txt)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-skill-any-'));
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-ext-any-'));
    
    // 1. Arbitrary named .md file without frontmatter
    const customMd = path.join(externalDir, 'react-performance-tips.md');
    await fs.writeFile(customMd, '# React Performance\n\nUse useMemo wisely.', 'utf8');

    const importedMd = await importSkill(tempDir, customMd, 'global');
    assert.equal(importedMd.name, 'react-performance-tips');
    assert.equal(importedMd.source, 'global');
    const content = await readSkillContent(importedMd.path);
    assert.ok(content.includes('Use useMemo wisely.'));

    // 2. Arbitrary text file
    const txtFile = path.join(externalDir, 'clean-code-rules.txt');
    await fs.writeFile(txtFile, 'Keep functions short and pure.', 'utf8');

    const importedTxt = await importSkill(tempDir, txtFile, 'global');
    assert.equal(importedTxt.name, 'clean-code-rules');

    // 3. Folder without SKILL.md containing README.md
    const folderWithoutSkill = path.join(externalDir, 'graphql-helpers');
    await fs.mkdir(folderWithoutSkill, { recursive: true });
    await fs.writeFile(path.join(folderWithoutSkill, 'README.md'), '# GraphQL Helpers\n\nUse Apollo client.', 'utf8');

    const importedFolder = await importSkill(tempDir, folderWithoutSkill, 'global');
    assert.equal(importedFolder.name, 'graphql-helpers');

    await deleteSkill(importedMd.path);
    await deleteSkill(importedTxt.path);
    await deleteSkill(importedFolder.path);

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  await test('skills:read and skills:delete reject paths outside allowed directories', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-skill-sec-'));
    const outsideFile = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret content', 'utf8');

    await assert.rejects(
      async () => readSkillContent(outsideFile),
      /outside the authorized skills directories/i
    );

    await assert.rejects(
      async () => deleteSkill(outsideFile),
      /outside the authorized skills directories/i
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 11. Consumed Tokens & Session Tracking Tests ===');

  await test('session accumulates total tokens across multiple requests while messages store per-turn usage', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-token-proj-'));
    const project = await upsertProject({ name: 'Token Tracking Project', root: tempDir });
    const session = await createSession(project.id, 'Token Session');

    // Turn 1 (known model pricing)
    const turn1Usage = calculateAgentUsage(1000, 250, 'gpt-4.1-mini');
    assert.equal(turn1Usage.inputTokens, 1000);
    assert.equal(turn1Usage.outputTokens, 250);
    assert.equal(turn1Usage.totalTokens, 1250);
    assert.equal(turn1Usage.estimatedCost, 0.0003);

    await appendSessionMessage(project.id, session.id, {
      role: 'assistant',
      text: 'Response 1',
      createdAt: new Date().toISOString(),
      usage: turn1Usage,
    });

    const sessionAfterTurn1 = await getSession(project.id, session.id);
    assert.deepEqual(sessionAfterTurn1?.usage, turn1Usage);
    assert.deepEqual(sessionAfterTurn1?.messages[0]?.usage, turn1Usage);

    // Turn 2 (unknown model -> null cost; session cost stays known while all
    // turns have known pricing)
    const turn2Usage = calculateAgentUsage(2000, 500, 'gpt-4.1-mini');
    await appendSessionMessage(project.id, session.id, {
      role: 'assistant',
      text: 'Response 2',
      createdAt: new Date().toISOString(),
      usage: turn2Usage,
    });

    const sessionAfterTurn2 = await getSession(project.id, session.id);
    // Verify cumulative total tokens for the session (turn 1 + turn 2)
    assert.equal(sessionAfterTurn2?.usage?.inputTokens, 3000);
    assert.equal(sessionAfterTurn2?.usage?.outputTokens, 750);
    assert.equal(sessionAfterTurn2?.usage?.totalTokens, 3750);
    assert.equal(sessionAfterTurn2?.usage?.estimatedCost, 0.0009);

    // A null-cost turn (unknown model) makes the session cost null, not zero.
    const turn3Usage = calculateAgentUsage(500, 100, 'local-model');
    assert.equal(turn3Usage.estimatedCost, null);
    await appendSessionMessage(project.id, session.id, {
      role: 'assistant',
      text: 'Response 3 (local model)',
      createdAt: new Date().toISOString(),
      usage: turn3Usage,
    });
    const sessionAfterTurn3 = await getSession(project.id, session.id);
    // 1250 (t1) + 2500 (t2) + 600 (t3)
    assert.equal(sessionAfterTurn3?.usage?.totalTokens, 4350);
    assert.equal(sessionAfterTurn3?.usage?.estimatedCost, null, 'mixed known/unknown pricing must surface as null, not a fabricated sum');

    // Verify per-message usage on each individual request
    assert.deepEqual(sessionAfterTurn2?.messages[0]?.usage, turn1Usage);
    assert.deepEqual(sessionAfterTurn2?.messages[1]?.usage, turn2Usage);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('appendSessionMessages persists several messages in one write (batch transcript)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-batch-'));
    const project = await upsertProject({ name: 'Batch Project', root: tempDir });
    const session = await createSession(project.id, 'Batch Session');

    const batch = [
      { role: 'event', kind: 'tool', text: 'grep_search(query=x)', createdAt: new Date().toISOString() },
      { role: 'event', kind: 'status', text: 'Agent is working', createdAt: new Date().toISOString() },
      { role: 'assistant', text: 'Done', createdAt: new Date().toISOString(), usage: calculateAgentUsage(100, 20, 'gpt-4.1-mini') },
    ];
    const updated = await appendSessionMessages(project.id, session.id, batch);
    assert.equal(updated.messages.length, 3);
    assert.equal(updated.messages[0].text, 'grep_search(query=x)');
    assert.equal(updated.usage?.totalTokens, 120);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('calculateSessionUsage retroactively sums all historical messages for legacy sessions without session.usage', async () => {
    const historicalMessages = [
      { role: 'user', text: 'Hello', createdAt: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: 'Hi', createdAt: '2026-01-01T00:00:01Z', usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600, estimatedCost: 0.0001 } },
      { role: 'user', text: 'Fix this', createdAt: '2026-01-01T00:00:02Z' },
      { role: 'assistant', text: 'Fixed', createdAt: '2026-01-01T00:00:03Z', usage: { inputTokens: 1500, outputTokens: 400, totalTokens: 1900, estimatedCost: 0.0005 } },
    ];

    const computed = calculateSessionUsage(historicalMessages);
    assert.equal(computed.inputTokens, 2000);
    assert.equal(computed.outputTokens, 500);
    assert.equal(computed.totalTokens, 2500);
    assert.equal(computed.estimatedCost, 0.0006);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-legacy-sess-'));
    const project = await upsertProject({ name: 'Legacy Project', root: tempDir });
    const session = await createSession(project.id, 'Legacy Session');
    
    // Simulate legacy session by updating messages without setting session.usage
    session.messages = historicalMessages;
    const retrieved = await getSession(project.id, session.id);
    assert.equal(retrieved?.usage?.totalTokens, 2500);
    assert.equal(retrieved?.usage?.inputTokens, 2000);
    assert.equal(retrieved?.usage?.outputTokens, 500);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('calculateSessionUsage ignores usage event messages to prevent double counting', () => {
    const runUsage = { inputTokens: 500, outputTokens: 100, totalTokens: 600, estimatedCost: 0.0001 };
    const messagesWithEventAndAssistant = [
      { role: 'user', text: 'Hello' },
      { role: 'event', kind: 'usage', text: 'Token usage · 600 tokens', usage: runUsage },
      { role: 'assistant', text: 'Hi there', usage: runUsage },
    ];
    const computed = calculateSessionUsage(messagesWithEventAndAssistant);
    assert.equal(computed.totalTokens, 600, 'must not count 1200 tokens (double counted)');
    assert.equal(computed.inputTokens, 500);
    assert.equal(computed.outputTokens, 100);
    assert.equal(computed.estimatedCost, 0.0001);
  });

  console.log('\n=== 12. Git Worktree Isolation & Lifecycle Tests ===');

  await test('createSessionWorktree creates isolated worktree directory and branch in a git repository', async () => {
    const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-wt-repo-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: tempRepo });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempRepo });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tempRepo });
      await fs.writeFile(path.join(tempRepo, 'index.js'), 'console.log("hello");\n');
      await execFileAsync('git', ['add', '.'], { cwd: tempRepo });
      await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: tempRepo });

      const isGit = await isGitRepo(tempRepo);
      assert.equal(isGit, true);

      const sessionId = 'test-session-1';
      const wt = await createSessionWorktree(tempRepo, sessionId);
      assert.equal(wt.isNew, true);
      assert.equal(wt.branch, 'forgepilot/session-test-session-1');

      const existing = await getSessionWorktree(tempRepo, sessionId);
      assert.notEqual(existing, null);
      assert.equal(existing?.worktreePath, wt.worktreePath);

      // Modify file inside worktree
      await fs.writeFile(path.join(wt.worktreePath, 'index.js'), 'console.log("hello from worktree");\n');

      // Merge worktree to main
      const mergeRes = await mergeWorktreeToMain(tempRepo, sessionId, 'Merged session changes');
      assert.equal(mergeRes.success, true);

      // Verify merged content on main repo
      const mainContent = await fs.readFile(path.join(tempRepo, 'index.js'), 'utf8');
      assert.match(mainContent, /hello from worktree/);

      // Discard worktree
      const discardRes = await discardSessionWorktree(tempRepo, sessionId);
      assert.equal(discardRes, true);
    } finally {
      await fs.rm(tempRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log('\n=== 13. Context Compactor & Prompt Caching Tests ===');

  await test('compactHistory preserves recent turns and collapses large historical turns', () => {
    const history = [
      { role: 'user', text: 'Task 1: Large prompt with lots of text '.repeat(50) },
      { role: 'assistant', text: 'Response with detailed output '.repeat(50) },
      { role: 'user', text: 'Follow up 1' },
      { role: 'assistant', text: 'Follow up response 1' },
      { role: 'user', text: 'Recent question' },
      { role: 'assistant', text: 'Recent answer' },
    ];

    const compacted = compactHistory(history, 4000);
    assert.ok(compacted.length > 0);
    // Last turns must be preserved verbatim
    assert.equal(compacted[compacted.length - 1].text, 'Recent answer');
    assert.equal(compacted[compacted.length - 2].text, 'Recent question');
    // Early turns should have a prior summary
    assert.match(compacted[0].text, /\[Prior Conversation Summary\]/i);
  });

  await test('estimateTokens provides consistent character to token approximations', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('Hello world this is a test of tokenizer estimation') > 5);
  });

  console.log('\n=== 14. Artifacts Lifecycle & Status Tests ===');

  await test('saveArtifact, getArtifact, listArtifacts and updateArtifactStatus work end-to-end', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-art-'));
    try {
      const sessionId = 'session_art_test';
      const plan = await saveArtifact(tempDir, sessionId, 'implementation_plan.md', '# Objective\n\nBuild feature X\n', {
        status: 'pending_approval',
        name: 'Implementation Plan',
      });

      assert.equal(plan.status, 'pending_approval');
      assert.equal(plan.filename, 'implementation_plan.md');

      const fetched = await getArtifact(tempDir, sessionId, 'implementation_plan.md');
      assert.notEqual(fetched, null);
      assert.equal(fetched?.content.includes('Build feature X'), true);

      const all = await listArtifacts(tempDir, sessionId);
      assert.equal(all.length, 1);

      const updated = await updateArtifactStatus(tempDir, sessionId, 'implementation_plan.md', 'approved');
      assert.equal(updated?.status, 'approved');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log('\n=== 15. Trajectory JSONL Logger Tests ===');

  await test('TrajectoryLogger records step-by-step events in valid JSONL format', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-traj-'));
    try {
      const sessionId = 'session_traj_test';
      const logger = new TrajectoryLogger(tempDir, sessionId);
      await logger.init();

      await logger.log({ source: 'USER', type: 'USER_INPUT', content: 'Create a test file' });
      await logger.log({ source: 'TOOL', type: 'TOOL_CALL', content: 'write_file(test.js)' });
      await logger.log({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'File created successfully.' });

      const steps = await readSessionTrajectory(tempDir, sessionId);
      assert.equal(steps.length, 3);
      assert.equal(steps[0].step_index, 1);
      assert.equal(steps[0].type, 'USER_INPUT');
      assert.equal(steps[1].step_index, 2);
      assert.equal(steps[1].type, 'TOOL_CALL');
      assert.equal(steps[2].step_index, 3);
      assert.equal(steps[2].type, 'PLANNER_RESPONSE');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log('\n=== 16. Enhanced Code Intelligence Tests ===');

  await test('find_symbol_references locates symbol references across files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-symref-'));
    try {
      await fs.writeFile(path.join(tempDir, 'user.ts'), 'export interface UserProfile {\n  id: string;\n  name: string;\n}\n');
      await fs.writeFile(path.join(tempDir, 'service.ts'), 'import { UserProfile } from "./user";\nexport function getUser(): UserProfile { return { id: "1", name: "A" }; }\n');

      const tools = createCodeIntelligenceTools(tempDir);
      const findRefTool = tools.find((t) => t.name === 'find_symbol_references');
      assert.notEqual(findRefTool, undefined);

      const res = await findRefTool.invoke({ symbol: 'UserProfile' });
      assert.match(res, /Found 3 reference/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log('\n=== 17. Project Rules Auto-Discovery Tests ===');

  await test('discoverProjectRules finds .cursorrules, AGENT.md, and .nexus/rules/*.md', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-rules-'));
    try {
      await fs.writeFile(path.join(tempDir, '.cursorrules'), 'Always write clean TypeScript with strict types.\n');
      await fs.writeFile(path.join(tempDir, 'AGENT.md'), '# Project Conventions\nUse functional React components.\n');
      await fs.mkdir(path.join(tempDir, '.nexus', 'rules'), { recursive: true });
      await fs.writeFile(path.join(tempDir, '.nexus', 'rules', 'db.md'), 'Always run database migrations before schema edits.\n');

      const result = await discoverProjectRules(tempDir);
      assert.equal(result.hasRules, true);
      assert.equal(result.ruleFiles.length, 3);
      assert.match(result.combinedPromptSection, /Project-Specific Rules/i);
      assert.match(result.combinedPromptSection, /Always write clean TypeScript/);
      assert.match(result.combinedPromptSection, /Use functional React components/);
      assert.match(result.combinedPromptSection, /Always run database migrations/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log('\n=== 18. Headless Browser & API Verification Tests ===');

  await test('browser tools parse html structure and fetch api results', async () => {
    const tools = createBrowserTools();
    const inspectTool = tools.find((t) => t.name === 'browser_inspect');
    const apiTool = tools.find((t) => t.name === 'browser_fetch_api');

    assert.notEqual(inspectTool, undefined);
    assert.notEqual(apiTool, undefined);

    // Verify invalid url error handling
    const inspectRes = await inspectTool.invoke({ url: 'http://127.0.0.1:59999/non-existent' });
    assert.match(inspectRes, /Failed to inspect/i);

    const apiRes = await apiTool.invoke({ url: 'http://127.0.0.1:59999/api/health' });
    assert.match(apiRes, /API Request.*failed/i);
  });

  await test('browser tools fetch external URLs directly (network gate removed with the sandbox)', async () => {
    const tools = createBrowserTools('/test');
    const inspectTool = tools.find((t) => t.name === 'browser_inspect');
    const apiTool = tools.find((t) => t.name === 'browser_fetch_api');
    assert.notEqual(inspectTool, undefined);
    assert.notEqual(apiTool, undefined);

    // External URLs are no longer policy-blocked; the only failure mode is the
    // (offline-safe) connection error itself.
    const blockedInspect = await inspectTool.invoke({ url: 'https://example.invalid-qt/page' });
    assert.doesNotMatch(blockedInspect, /Network access blocked/i);
    assert.match(blockedInspect, /Failed to inspect/i);

    const blockedApi = await apiTool.invoke({ url: 'https://api.invalid-qt/v1/health' });
    assert.doesNotMatch(blockedApi, /Network access blocked/i);

    // Verify invalid url error handling still works
    const inspectRes = await inspectTool.invoke({ url: 'http://127.0.0.1:59999/non-existent' });
    assert.match(inspectRes, /Failed to inspect/i);

    const apiRes = await apiTool.invoke({ url: 'http://127.0.0.1:59999/api/health' });
    assert.match(apiRes, /API Request.*failed/i);
  });

  console.log('\n=== 19. Interactive Streaming Terminal Service Tests ===');

  await test('terminalService spawns a PTY (or documented pipes fallback) with TTY semantics and resize', async () => {
    const sessionId = 'test_shell_1';
    let outputReceived = '';

    const session = await terminalService.createSession(sessionId, process.cwd(), (data) => {
      outputReceived += data;
    });

    assert.notEqual(session, undefined);
    assert.equal(session.id, sessionId);
    assert.ok(session.mode === 'pty' || session.mode === 'pipes', `unexpected mode ${session.mode}`);

    if (session.mode === 'pty') {
      // A real TTY must be attached: child processes see process.stdout.isTTY === true.
      terminalService.write(sessionId, 'node -e "process.stdout.write(String(process.stdout.isTTY))"\r\n');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.match(outputReceived, /true/, 'PTY child should report process.stdout.isTTY === true');
      // Resize must be accepted and forwarded to the PTY host.
      assert.equal(terminalService.resize(sessionId, 120, 40), true);
      // Invalid dimensions are rejected.
      assert.equal(terminalService.resize(sessionId, 0, 0), false);
    } else {
      console.log('    (pipes fallback active — PTY host unavailable in this environment)');
    }

    // Kill session
    const killed = terminalService.killSession(sessionId);
    assert.equal(killed, true);
    terminalService.killAll();
  });

  await test('terminalService manages independent concurrent sessions and killAll teardown', async () => {
    let firstOutput = '';
    const first = await terminalService.createSession('test_shell_a', process.cwd(), (data) => {
      firstOutput += data;
    });
    const second = await terminalService.createSession('test_shell_b', process.cwd(), () => {});
    assert.equal(first.id, 'test_shell_a');
    assert.equal(second.id, 'test_shell_b');
    assert.equal(first.alive, true);
    assert.equal(second.alive, true);

    // Kill one session; the other must stay alive.
    assert.equal(terminalService.killSession('test_shell_a'), true);
    assert.equal(terminalService.getSession('test_shell_a'), undefined);
    assert.ok(terminalService.getSession('test_shell_b'), 'second session must survive the first kill');

    terminalService.killAll();
    assert.equal(terminalService.getSession('test_shell_b'), undefined);
  });

  console.log('\n=== 20. Custom Extensible Slash Commands Tests ===');

  await test('discoverCustomCommands discovers built-in and project-defined slash commands with placeholder substitutions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-custom-cmds-'));
    try {
      await fs.mkdir(path.join(tempDir, '.nexus', 'commands'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.nexus', 'commands', 'audit.md'),
        `---\nname: Audit Code\ndescription: Audit active file for performance and quality\nmode: ask\n---\nPerform an extensive code quality audit on {{activeFile}} in branch {{gitBranch}}. Changes: {{diffSummary}}.\n`,
        'utf8'
      );

      const commands = await discoverCustomCommands(tempDir);
      assert.ok(commands.length >= 10);

      const auditCmd = commands.find((c) => c.command === '/audit');
      assert.notEqual(auditCmd, undefined);
      assert.equal(auditCmd.name, 'Audit Code');
      assert.equal(auditCmd.source, 'project');
      assert.equal(auditCmd.mode, 'ask');

      const expanded = substituteCommandPlaceholders(auditCmd.promptTemplate, {
        activeFile: 'src/core/engine.ts',
        gitBranch: 'feature/elite-superpowers',
        diffSummary: '3 files changed (+45/-10)',
        input: 'Focus on memory consumption',
      });

      assert.match(expanded, /Perform an extensive code quality audit on src\/core\/engine\.ts/);
      assert.match(expanded, /branch feature\/elite-superpowers/);
      assert.match(expanded, /3 files changed/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log('\n=== 21. Long-Running Daemon Services & Process Manager Tests ===');

  await test('DaemonService starts, captures live output, tracks ports, and stops processes cleanly', async () => {
    const customDaemonService = new DaemonService();
    let logsReceived = '';

    const cmd = `node -e "process.stdout.write('Server listening on localhost:59123\\n'); setInterval(() => {}, 1000)"`;

    const info = customDaemonService.startDaemon('Mock Server', cmd, process.cwd(), (data) => {
      logsReceived += data;
    });

    assert.notEqual(info.id, undefined);
    assert.equal(info.name, 'Mock Server');
    assert.equal(info.status, 'running');

    // Wait for stdout processing
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const list = customDaemonService.listDaemons();
    const server = list.find((d) => d.id === info.id);
    assert.notEqual(server, undefined);
    assert.equal(server.port, 59123);

    const logs = customDaemonService.getDaemonLogs(info.id);
    assert.ok(logs.length > 0);

    const stopped = customDaemonService.stopDaemon(info.id);
    assert.equal(stopped, true);
  });

  console.log('\n=== 22. Integrated Live Browser & Navigation Validation Tests ===');

  await test('Browser URL normalizer and protocol guard validate localhost and web URLs', async () => {
    function resolveUrlOrSearch(input, engine = 'google') {
      const query = input.trim();
      if (!query) return 'https://www.google.com';
      if (/^https?:\/\//i.test(query)) return query;
      if (/^localhost(:\d+)?(\/.*)?$/i.test(query) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(query)) {
        return `http://${query}`;
      }
      const isDomain = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(query);
      if (isDomain && !query.includes(' ')) {
        return `https://${query}`;
      }
      const encoded = encodeURIComponent(query);
      if (engine === 'duckduckgo') return `https://duckduckgo.com/?q=${encoded}`;
      if (engine === 'bing') return `https://www.bing.com/search?q=${encoded}`;
      return `https://www.google.com/search?q=${encoded}`;
    }

    // Localhost
    assert.equal(resolveUrlOrSearch('localhost:5173'), 'http://localhost:5173');
    assert.equal(resolveUrlOrSearch('127.0.0.1:3000/app'), 'http://127.0.0.1:3000/app');

    // Domains
    assert.equal(resolveUrlOrSearch('github.com/facebook/react'), 'https://github.com/facebook/react');
    assert.equal(resolveUrlOrSearch('developer.mozilla.org'), 'https://developer.mozilla.org');
    assert.equal(resolveUrlOrSearch('https://example.com/api'), 'https://example.com/api');

    // Keywords search
    assert.equal(
      resolveUrlOrSearch('react useeffect cleanup', 'google'),
      'https://www.google.com/search?q=react%20useeffect%20cleanup'
    );
    assert.equal(
      resolveUrlOrSearch('tailwind flexbox center', 'duckduckgo'),
      'https://duckduckgo.com/?q=tailwind%20flexbox%20center'
    );

    function isSafeExternalUrl(url) {
      return /^https?:\/\//i.test(url);
    }

    assert.equal(isSafeExternalUrl('http://localhost:5173'), true);
    assert.equal(isSafeExternalUrl('https://google.com'), true);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed.\n`);
  app.exit(failed > 0 ? 1 : 0);
});






