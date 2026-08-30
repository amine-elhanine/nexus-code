import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { dialog } from "electron";
import { FilesystemBackend } from "deepagents";
import type { ProjectRecord, ProjectSandboxState, SandboxConfig } from "./store.js";
import { updateProjectSandbox } from "./store.js";

// Tools the sandbox may launch. Shells (bash, sh, cmd, powershell) are deliberately
// absent: commands are validated argument-by-argument, and an interpreter in the
// list would let a model bypass that validation with a single string.
const ALLOWED_TOOLS = new Set([
  "npm", "pnpm", "yarn", "node", "npx", "git", "tsc", "vite", "electron",
  "eslint", "prettier", "python", "pytest", "bun", "deno", "cargo", "go",
  "ruff", "mypy", "uv", "poetry", "biome",
]);

// Characters a shell would treat as syntax. Commands are executed through a shell
// only because Windows tool shims (.cmd) require it, so any occurrence of these
// characters is rejected outright rather than passed through as a literal argument.
const SHELL_SYNTAX = /[;&|<>^%!`$\r\n]/;

// Node flags that execute or load code the sandbox policy never approved.
const NODE_EXEC_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--experimental-loader"]);

// Only these environment variables reach a spawned command: everything else
// (API keys, NODE_OPTIONS, shell hooks, secrets of any kind) stays in the host.
const ENV_PASSTHROUGH = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "windir",
  "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ProgramData", "PROGRAMFILES",
  "ProgramFiles(x86)", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "OS", "LANG",
  "LC_ALL", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "ALLUSERSPROFILE",
];

const APPROVAL_REQUIRED = /^(npm|pnpm|yarn|npx|bun|deno|cargo|uv|poetry)\s+(install|add|remove|update|upgrade|publish|login)|^git\s+(commit|push|reset|checkout|switch|merge|rebase)|^python\s+-m\s+pip/i;

// Node's built-in permission model (no external sandbox required) restricts a
// spawned `node` script's filesystem access to the project root. Detected once.
let nodePermissionSupport: boolean | null = null;

// One agent run is active at a time (main.ts holds the lock). Cancelling a run
// rejects new commands, kills every tracked child process tree (taskkill /T on
// Windows, a built-in), and the agent loop unwinds at the next chunk or command.
const activeChildren = new Set<ChildProcess>();
let runCancelled = false;

export function beginSandboxRun() { runCancelled = false; }
export function isSandboxRunCancelled() { return runCancelled; }
export function cancelSandboxRun() {
  runCancelled = true;
  for (const child of activeChildren) {
    try {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill();
    } catch { /* child already exited */ }
  }
  activeChildren.clear();
}

function runProcess(shell: string, args: string[], options: { cwd: string; env?: Record<string, string>; timeout?: number; maxBuffer?: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(shell, args, { cwd: options.cwd, env: options.env, timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      activeChildren.delete(child);
      if (error) { (error as any).stdout = stdout; (error as any).stderr = stderr; reject(error); }
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (child.pid) activeChildren.add(child);
  });
}

function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && (command[index + 1] === '"' || command[index + 1] === "'")) { current += command[++index]; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === " " || char === "\t") {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  if (current) tokens.push(current);
  return tokens;
}

function quoteForShell(token: string) {
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

async function supportsNodePermission() {
  if (nodePermissionSupport !== null) return nodePermissionSupport;
  try {
    const { stdout } = await runProcess("node", ["--version"], { cwd: process.cwd(), timeout: 5000, maxBuffer: 64_000 });
    const major = Number(stdout.trim().replace(/^v/, "").split(".")[0]);
    nodePermissionSupport = Number.isFinite(major) && major >= 20;
  } catch {
    nodePermissionSupport = false;
  }
  return nodePermissionSupport;
}

async function applyNodePermissionSandbox(command: string, projectRoot: string) {
  if (!(await supportsNodePermission())) return command;
  const argv = tokenize(command);
  if (!argv || argv[0].toLowerCase() !== "node") return command;
  const root = path.resolve(projectRoot);
  const flags = ["--permission", `--allow-fs-read=${root}`, `--allow-fs-write=${root}`];
  return [argv[0], ...flags, ...argv.slice(1).map(quoteForShell)].join(" ");
}

function sandboxEnvironment() {
  const env: Record<string, string> = {
    CI: "true",
  };
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export function commandPolicy(command: string, config: SandboxConfig) {
  const trimmed = command.trim();
  if (!trimmed) return "Command is empty.";
  if (SHELL_SYNTAX.test(trimmed)) return "Command blocked: shell chaining, substitution and redirection characters are not allowed in the local sandbox.";
  const argv = tokenize(trimmed);
  if (!argv) return "Command blocked: unmatched quotes.";
  const tool = argv[0].toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
  if (!ALLOWED_TOOLS.has(tool)) return `Command blocked: "${argv[0]}" is not an approved development tool.`;
  if (tool === "node") {
    for (const flag of argv.slice(1)) {
      const normalized = flag.toLowerCase();
      if (NODE_EXEC_FLAGS.has(normalized)) return `Command blocked: node ${flag} executes code outside the sandbox policy.`;
      if (normalized === "--permission") return "Command blocked: the sandbox applies node --permission automatically.";
    }
  }
  if (tool === "python") {
    const rest = argv.slice(1).map((arg) => arg.toLowerCase());
    const pytestModule = rest[0] === "-m" && rest[1] === "pytest";
    const versionOnly = rest.every((arg) => ["--version", "-v", "-vv"].includes(arg));
    if (!pytestModule && !versionOnly) return "Command blocked: python is only available for pytest runs (`python -m pytest …`) in the local sandbox.";
  }
  if (!config.allowNetwork && /^(npm|pnpm|yarn|npx|bun|cargo|uv|poetry)(\s|$)/i.test(trimmed) && /(^|\s)(install|add|remove|update|upgrade|fetch|publish|login|download)(\s|$)/i.test(trimmed)) return "Network-dependent package operations are disabled by the local sandbox policy.";
  return null;
}

function commandTimeoutMs(config: SandboxConfig) {
  return Math.max(10, config.commandTimeoutSeconds || 120) * 1000;
}

function backendId(project: ProjectRecord) { return `local-workspace-${project.id}`; }
function sandboxState(): ProjectSandboxState { return { provider: "local", mode: "workspace-permissions", status: "ready", path: "selected-project-root" }; }

async function executeLocal(projectRoot: string, command: string, config: SandboxConfig, fromAgent = false) {
  if (runCancelled) return { output: "Run cancelled by user.", exitCode: 130, truncated: false };
  const violation = commandPolicy(command, config);
  if (violation) return { output: violation, exitCode: 126, truncated: false };
  const trimmed = command.trim();
  if (fromAgent && config.requireApproval && APPROVAL_REQUIRED.test(trimmed)) {
    const approval = await dialog.showMessageBox({ type: "question", title: "ForgePilot approval required", message: "Allow this command inside the local workspace sandbox?", detail: trimmed, buttons: ["Allow once", "Block"], defaultId: 1, cancelId: 1 });
    if (approval.response !== 0) return { output: "Command blocked by user approval.", exitCode: 126, truncated: false };
  }
  const runCommand = trimmed.toLowerCase().startsWith("node ") || trimmed.toLowerCase() === "node"
    ? await applyNodePermissionSandbox(trimmed, projectRoot)
    : trimmed;
  // The shell is only a launcher for pre-validated tool shims (npm.cmd on Windows);
  // every character the shell could interpret as syntax was rejected by commandPolicy.
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", runCommand] : ["-c", runCommand];
  try {
    const result = await runProcess(shell, args, { cwd: path.resolve(projectRoot), env: sandboxEnvironment(), timeout: commandTimeoutMs(config), maxBuffer: 8_000_000 });
    return { output: [result.stdout, result.stderr].filter(Boolean).join("\n"), exitCode: 0, truncated: false };
  } catch (error: any) {
    if (runCancelled) return { output: "Run cancelled by user.", exitCode: 130, truncated: false };
    let output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    if (/ERR_ACCESS_DENIED|permission model/i.test(output)) output += "\n(Note: node's built-in permission sandbox blocked an operation outside the project root.)";
    return { output, exitCode: typeof error?.code === "number" ? error.code : 1, truncated: false };
  }
}

export async function getSandboxStatus(project: ProjectRecord, config: SandboxConfig | null) {
  if (!config?.enabled) return { configured: false, status: "disabled", sandbox: project.sandbox || null };
  return { configured: true, status: "ready", sandbox: project.sandbox || sandboxState() };
}

export async function getSandboxAgentBackend(project: ProjectRecord, config: SandboxConfig, options: { readOnly?: boolean } = {}) {
  if (!config.enabled) throw new Error("Local sandbox execution is disabled.");
  const backend: any = new FilesystemBackend({ rootDir: path.resolve(project.root), virtualMode: true });
  backend.id = backendId(project);
  if (options.readOnly) {
    const refuse = (action: string) => async () => { throw new Error(`Plan mode is read-only: ${action} is disabled. Explore the repository and produce an implementation plan instead of changing files.`); };
    backend.write = refuse("write_file");
    backend.edit = refuse("edit_file");
    backend.delete = refuse("delete");
    backend.execute = refuse("execute");
  } else {
    backend.execute = (command: string) => executeLocal(project.root, command, config, true);
  }
  await updateProjectSandbox(project.id, sandboxState());
  return { backend, workspace: project.root };
}

export async function runSandboxCommand(project: ProjectRecord, config: SandboxConfig, command: string) {
  beginSandboxRun();
  const result = await executeLocal(project.root, command, config);
  await updateProjectSandbox(project.id, { ...sandboxState(), lastSyncAt: new Date().toISOString() });
  return result;
}

export async function syncSandboxToProject(_workspace: string, _projectRoot: string) { return true; }
export async function stopProjectSandbox(project: ProjectRecord, _config: SandboxConfig | null) { await updateProjectSandbox(project.id, { provider: "local", mode: "workspace-permissions", status: "stopped", path: "selected-project-root" }); }
export async function deleteProjectSandbox(project: ProjectRecord, _config: SandboxConfig | null) { await updateProjectSandbox(project.id, undefined); }

export function isCommandAllowed(command: string, config: SandboxConfig) { return !commandPolicy(command, config); }
