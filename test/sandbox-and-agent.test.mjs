import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import {
  commandPolicy,
  isCommandAllowed,
  beginSandboxRun,
  cancelSandboxRun,
  isSandboxRunCancelled,
  runSandboxCommand,
  getSandboxAgentBackend,
} from '../dist-electron/sandbox-service.js';
import { upsertProject, upsertProvider, removeProvider, listProviders, createSession, updateSession, getSession, appendSessionMessage, calculateSessionUsage } from '../dist-electron/store.js';
import { pickVerificationCommand, findTargetedTests } from '../dist-electron/agent-service.js';
import {
  revertWorkspaceFile,
  revertAllWorkspaceChanges,
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from '../dist-electron/diff-service.js';
import { parseSymbolsFromCode, formatOutline, createCodeIntelligenceTools } from '../dist-electron/code-tools.js';
import { SUBAGENT_CONFIGS, createSubagentDelegationTool, calculateAgentUsage } from '../dist-electron/subagent-service.js';
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

const defaultConfig = {
  provider: 'local',
  enabled: true,
  requireApproval: false,
  allowNetwork: false,
  commandTimeoutSeconds: 120,
};

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
  console.log('\n=== 1. Sandbox Policy Tests (21 rules + network) ===');

  await test('Policy 1: Empty command is rejected', () => {
    assert.match(commandPolicy('', defaultConfig), /empty/i);
    assert.match(commandPolicy('   ', defaultConfig), /empty/i);
    assert.equal(isCommandAllowed('', defaultConfig), false);
  });

  await test('Policy 2: Semicolon chaining is rejected', () => {
    assert.match(commandPolicy('npm test ; ls', defaultConfig), /shell chaining/i);
    assert.equal(isCommandAllowed('npm test ; ls', defaultConfig), false);
  });

  await test('Policy 3: Ampersand chaining (&, &&) is rejected', () => {
    assert.match(commandPolicy('npm test && npm run build', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test &', defaultConfig), /shell chaining/i);
  });

  await test('Policy 4: Pipe (|) is rejected', () => {
    assert.match(commandPolicy('npm test | grep ok', defaultConfig), /shell chaining/i);
  });

  await test('Policy 5: Redirection (<, >) is rejected', () => {
    assert.match(commandPolicy('npm test > out.txt', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test < in.txt', defaultConfig), /shell chaining/i);
  });

  await test('Policy 6: Shell variable/substitution characters (^, %, !, `, $) are rejected', () => {
    assert.match(commandPolicy('npm test $VAR', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test %VAR%', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test !VAR!', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test `whoami`', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test ^', defaultConfig), /shell chaining/i);
  });

  await test('Policy 7: Newline characters are rejected', () => {
    assert.match(commandPolicy('npm test\nls', defaultConfig), /shell chaining/i);
    assert.match(commandPolicy('npm test\r\nls', defaultConfig), /shell chaining/i);
  });

  await test('Policy 8: Unmatched quotes are rejected', () => {
    assert.match(commandPolicy('node "unterminated', defaultConfig), /unmatched quotes/i);
    assert.match(commandPolicy("node 'unterminated", defaultConfig), /unmatched quotes/i);
  });

  await test('Policy 9: Unapproved shell interpreters (bash, sh, cmd, powershell) are rejected', () => {
    assert.match(commandPolicy('bash script.sh', defaultConfig), /not an approved/i);
    assert.match(commandPolicy('sh script.sh', defaultConfig), /not an approved/i);
    assert.match(commandPolicy('powershell -Command Get-Process', defaultConfig), /not an approved/i);
    assert.match(commandPolicy('cmd.exe /c dir', defaultConfig), /not an approved/i);
  });

  await test('Policy 10: Unapproved tools (curl, wget) are rejected', () => {
    assert.match(commandPolicy('curl https://example.com', defaultConfig), /not an approved/i);
    assert.match(commandPolicy('wget https://example.com', defaultConfig), /not an approved/i);
  });

  await test('Policy 11: Approved dev tools (npm, git, tsc, vite, eslint, bun, deno, cargo, go, ruff, mypy, uv, poetry, biome) are allowed', () => {
    assert.equal(commandPolicy('npm run check', defaultConfig), null);
    assert.equal(commandPolicy('git status', defaultConfig), null);
    assert.equal(commandPolicy('tsc --noEmit', defaultConfig), null);
    assert.equal(commandPolicy('vite build', defaultConfig), null);
    assert.equal(commandPolicy('eslint src/', defaultConfig), null);
    assert.equal(commandPolicy('cargo check', defaultConfig), null);
    assert.equal(commandPolicy('go vet ./...', defaultConfig), null);
    assert.equal(commandPolicy('bun test', defaultConfig), null);
    assert.equal(commandPolicy('deno test', defaultConfig), null);
    assert.equal(commandPolicy('ruff check', defaultConfig), null);
    assert.equal(commandPolicy('mypy src', defaultConfig), null);
    assert.equal(commandPolicy('biome check', defaultConfig), null);
  });

  await test('Policy 12: Node with valid script file is allowed', () => {
    assert.equal(commandPolicy('node dist/index.js', defaultConfig), null);
    assert.equal(commandPolicy('node script.mjs arg1 arg2', defaultConfig), null);
  });

  await test('Policy 13: Node -e / --eval is rejected', () => {
    assert.match(commandPolicy('node -e "console.log(1)"', defaultConfig), /outside the sandbox policy/i);
    assert.match(commandPolicy('node --eval "console.log(1)"', defaultConfig), /outside the sandbox policy/i);
  });

  await test('Policy 14: Node -p / --print is rejected', () => {
    assert.match(commandPolicy('node -p "process.env"', defaultConfig), /outside the sandbox policy/i);
    assert.match(commandPolicy('node --print "process.env"', defaultConfig), /outside the sandbox policy/i);
  });

  await test('Policy 15: Node -r / --require is rejected', () => {
    assert.match(commandPolicy('node -r hook.js script.js', defaultConfig), /outside the sandbox policy/i);
    assert.match(commandPolicy('node --require hook.js script.js', defaultConfig), /outside the sandbox policy/i);
  });

  await test('Policy 16: Node --import is rejected', () => {
    assert.match(commandPolicy('node --import hook.js script.js', defaultConfig), /outside the sandbox policy/i);
  });

  await test('Policy 17: Node --experimental-loader is rejected', () => {
    assert.match(commandPolicy('node --experimental-loader loader.js script.js', defaultConfig), /outside the sandbox policy/i);
  });

  await test('Policy 18: Manual node --permission flag is rejected (sandbox applies it)', () => {
    assert.match(commandPolicy('node --permission script.js', defaultConfig), /applies node --permission automatically/i);
  });

  await test('Policy 19: Python pytest is allowed', () => {
    assert.equal(commandPolicy('python -m pytest', defaultConfig), null);
    assert.equal(commandPolicy('python -m pytest tests/test_foo.py', defaultConfig), null);
  });

  await test('Policy 20: Python version flags are allowed', () => {
    assert.equal(commandPolicy('python --version', defaultConfig), null);
    assert.equal(commandPolicy('python -v', defaultConfig), null);
  });

  await test('Policy 21: Python arbitrary script execution is rejected', () => {
    assert.match(commandPolicy('python script.py', defaultConfig), /only available for pytest/i);
    assert.match(commandPolicy('python -c "import os"', defaultConfig), /only available for pytest/i);
  });

  await test('Policy 22: Network restriction blocks package install/add/update commands when allowNetwork=false', () => {
    assert.match(commandPolicy('npm install', { ...defaultConfig, allowNetwork: false }), /Network-dependent package operations/i);
    assert.match(commandPolicy('yarn add lodash', { ...defaultConfig, allowNetwork: false }), /Network-dependent package operations/i);
    assert.match(commandPolicy('pnpm update', { ...defaultConfig, allowNetwork: false }), /Network-dependent package operations/i);
    assert.equal(commandPolicy('npm install', { ...defaultConfig, allowNetwork: true }), null);
  });

  console.log('\n=== 2. Cancellation & Process Tree Termination Tests ===');

  await test('Cancellation flags: beginSandboxRun resets, cancelSandboxRun sets cancelled flag', () => {
    beginSandboxRun();
    assert.equal(isSandboxRunCancelled(), false);
    cancelSandboxRun();
    assert.equal(isSandboxRunCancelled(), true);
    beginSandboxRun();
    assert.equal(isSandboxRunCancelled(), false);
  });

  await test('Process Tree Termination: Long running command is killed via cancelSandboxRun()', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-cancel-'));
    const scriptPath = path.join(tempDir, 'loop.js');
    await fs.writeFile(scriptPath, 'const t = Date.now(); while(Date.now() - t < 30000) {}', 'utf8');

    const project = await upsertProject({ id: 'test-cancel', name: 'cancel-test', root: tempDir });
    const config = { ...defaultConfig, commandTimeoutSeconds: 60 };

    beginSandboxRun();
    const runPromise = runSandboxCommand(project, config, `node ${scriptPath}`);

    await new Promise((r) => setTimeout(r, 250));
    const startTime = Date.now();
    cancelSandboxRun();

    const result = await runPromise;
    const elapsed = Date.now() - startTime;

    assert.ok(elapsed < 4000, `Process tree was terminated promptly in ${elapsed}ms`);
    assert.equal(result.exitCode, 130);
    assert.match(result.output, /cancelled by user/i);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  console.log('\n=== 3. Read-Only Backend Tests (Plan Mode) ===');

  await test('Read-only backend blocks write, edit, delete, and execute with descriptive message', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-readonly-'));
    const project = await upsertProject({ id: 'test-readonly', name: 'readonly-test', root: tempDir });
    const config = { ...defaultConfig };

    const { backend } = await getSandboxAgentBackend(project, config, { readOnly: true });

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

  await test('Verification command picks tsc --noEmit when tsconfig.json exists without typecheck script', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { check: 'npm run test', lint: 'eslint .' } }), 'utf8');
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}', 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'tsc --noEmit');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await test('Verification command picks npm run check when check script exists without tsconfig or typecheck', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-verify-'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { check: 'node check.js', lint: 'eslint .' } }), 'utf8');

    const cmd = pickVerificationCommand(tempDir);
    assert.equal(cmd, 'npm run check');
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

  await test('createWorkspaceCheckpoint and restoreWorkspaceCheckpoint roll back entire workspace state', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-checkpoint-'));
    const { execSync } = await import('node:child_process');
    execSync('git init && git config user.name "Test" && git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'export const a = 1;\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    // Create pre-run checkpoint
    const checkpointId = await createWorkspaceCheckpoint(tempDir, 'chk-1');
    assert.equal(checkpointId, 'chk-1');

    // Agent makes changes: edits app.ts and adds new-feature.ts
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'export const a = 999;\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'new-feature.ts'), 'export const feat = true;\n', 'utf8');

    assert.equal((await fs.readFile(path.join(tempDir, 'app.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'export const a = 999;\n');

    // Restore checkpoint
    await restoreWorkspaceCheckpoint(tempDir, checkpointId);

    // Verify rollback
    assert.equal((await fs.readFile(path.join(tempDir, 'app.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'export const a = 1;\n');
    let newFeatExists = true;
    try { await fs.access(path.join(tempDir, 'new-feature.ts')); } catch { newFeatExists = false; }
    assert.equal(newFeatExists, false);

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

    await fs.writeFile(path.join(tempDir, 'src', 'auth.ts'), 'export const auth = true;', 'utf8');
    await fs.writeFile(path.join(tempDir, 'test', 'auth.test.ts'), 'test("auth", () => {});', 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'user.ts'), 'export const user = true;', 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'user.spec.ts'), 'test("user", () => {});', 'utf8');

    const testsForAuth = findTargetedTests(tempDir, ['src/auth.ts']);
    assert.ok(testsForAuth.includes('test/auth.test.ts') || testsForAuth.includes('test\\auth.test.ts'));

    const testsForUser = findTargetedTests(tempDir, ['src/user.ts']);
    assert.ok(testsForUser.includes('src/user.spec.ts') || testsForUser.includes('src\\user.spec.ts'));

    const testsForNone = findTargetedTests(tempDir, ['package.json', 'README.md']);
    assert.equal(testsForNone, null);

    await fs.rm(tempDir, { recursive: true, force: true });
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

  await test('calculateAgentUsage computes accurate token pricing ($0.15/1M input, $0.60/1M output)', () => {
    const usage = calculateAgentUsage(10000, 5000);
    assert.equal(usage.inputTokens, 10000);
    assert.equal(usage.outputTokens, 5000);
    assert.equal(usage.totalTokens, 15000);
    // (10000 * 0.00015 + 5000 * 0.0006) / 1000 = (1.5 + 3.0) / 1000 = 0.0045
    assert.equal(usage.estimatedCost, 0.0045);
  });

  await test('createSubagentDelegationTool exports delegate_task with schema validation', () => {
    const delegationTool = createSubagentDelegationTool({
      projectRoot: '/test',
      provider: { id: 'test', label: 'Test', provider: 'openai', apiKey: 'key', models: ['gpt-4'] },
      modelName: 'gpt-4',
      sandboxConfig: defaultConfig,
      projectRecord: { id: 'test', name: 'test', root: '/test' },
    });

    assert.equal(delegationTool.name, 'delegate_task');
    assert.ok(delegationTool.description.includes('subagent'));
  });

  await test('Researcher subagent backend blocks write operations in isolated sandbox', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-subagent-'));
    const project = await upsertProject({ id: 'test-subagent-proj', name: 'subagent-test', root: tempDir });

    const { backend } = await getSandboxAgentBackend(project, defaultConfig, { readOnly: true });

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

  console.log('\n=== 11. Consumed Tokens & Session Tracking Tests ===');

  await test('session accumulates total tokens across multiple requests while messages store per-turn usage', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-token-proj-'));
    const project = await upsertProject({ name: 'Token Tracking Project', root: tempDir });
    const session = await createSession(project.id, 'Token Session');

    // Turn 1
    const turn1Usage = calculateAgentUsage(1000, 250);
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

    // Turn 2
    const turn2Usage = calculateAgentUsage(2000, 500);
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

    // Verify per-message usage on each individual request
    assert.deepEqual(sessionAfterTurn2?.messages[0]?.usage, turn1Usage);
    assert.deepEqual(sessionAfterTurn2?.messages[1]?.usage, turn2Usage);

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

  console.log('\n=== 19. Interactive Streaming Terminal Service Tests ===');

  await test('terminalService manages interactive shell lifecycle and IO', async () => {
    const sessionId = 'test_shell_1';
    let outputReceived = '';

    const session = terminalService.createSession(sessionId, process.cwd(), (data) => {
      outputReceived += data;
    });

    assert.notEqual(session, undefined);
    assert.equal(session.id, sessionId);

    // Write command
    terminalService.write(sessionId, 'echo HELLO_NEXUS_PTY\r\n');

    // Wait for output
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.match(outputReceived, /HELLO_NEXUS_PTY/);

    // Kill session
    const killed = terminalService.killSession(sessionId);
    assert.equal(killed, true);
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






