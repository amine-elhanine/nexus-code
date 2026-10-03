import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FilesystemBackend } from "deepagents";
import { isDeniedCommand, classifyCommand } from "./permissions.js";
import type { CommandPolicy } from "./permissions.js";
import { requestCommandApproval } from "./approval-service.js";
import { scrubSecretEnv } from "./child-env.js";
import type { ProjectRecord } from "./store.js";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 180;

async function readCommandPolicy(projectRoot: string): Promise<CommandPolicy> {
  const candidates = [path.join(projectRoot, ".nexus", "permissions.json")];
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    if (packageJson?.nexus?.permissions) return packageJson.nexus.permissions;
  } catch { /* optional config */ }
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* optional config */ }
  }
  return {};
}

function approvalKey(command: string): string {
  if (/\bgit\s+push\b/i.test(command)) return "git-push";
  if (/\bgit\s+(reset|clean|rebase)\b/i.test(command)) return "git-history";
  if (/\b(?:npm|pnpm|yarn|pip|pip3|cargo|poetry|uv)\s+(?:install|add|remove|uninstall)\b/i.test(command)) return "dependency-change";
  if (/\bgo\s+get\b/i.test(command)) return "dependency-change";
  if (/\bmvn\s+(?:dependency|install)\b/i.test(command)) return "dependency-change";
  if (/\bdotnet\s+(?:add|remove|restore)\b/i.test(command)) return "dependency-change";
  if (/\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b|\b(?:Invoke-WebRequest|iwr|irm)\b/i.test(command)) return "download-execute";
  return "command-change";
}

export class RunCancelledError extends Error {
  constructor(message = "Agent run cancelled by user") {
    super(message);
    this.name = "RunCancelledError";
  }
}

// Cancellation is scoped per run (keyed by session id). The old process-global
// flag meant cancelling session A killed session B's run too — and starting a
// new run cleared a pending cancel for another session. Each run now owns its
// flag, AbortController, plus its child processes; cancelling one run never touches the others.
type RunState = { cancelled: boolean; children: Set<ChildProcess>; abortController: AbortController };
const DEFAULT_RUN_ID = "global";
const runStates = new Map<string, RunState>();

function stateFor(runId: string = DEFAULT_RUN_ID): RunState {
  let state = runStates.get(runId);
  if (!state) {
    state = { cancelled: false, children: new Set(), abortController: new AbortController() };
    runStates.set(runId, state);
  }
  return state;
}

function killChildren(state: RunState) {
  for (const child of state.children) {
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch { /* child already exited */ }
  }
  state.children.clear();
}

export function beginCommandRun(runId: string = DEFAULT_RUN_ID) {
  // Fresh state and abort controller for THIS run only — never touches other runs.
  const abortController = new AbortController();
  runStates.set(runId, { cancelled: false, children: new Set(), abortController });
  return abortController;
}

export function getRunAbortSignal(runId: string = DEFAULT_RUN_ID): AbortSignal | undefined {
  return runStates.get(runId)?.abortController.signal;
}

export function isCommandRunCancelled(runId: string = DEFAULT_RUN_ID) {
  const state = runStates.get(runId);
  return state?.cancelled || state?.abortController.signal.aborted || false;
}

export function cancelCommandRun(runId?: string) {
  // No id → cancel everything (fallback for stray callers); with an id only
  // that run's flag is set and only its process trees are killed.
  const targets = runId ? [runId] : [...runStates.keys()];
  for (const id of targets) {
    const state = runStates.get(id);
    if (!state) continue;
    state.cancelled = true;
    try {
      state.abortController.abort();
    } catch { /* ignore */ }
    killChildren(state);
  }
}
export function endCommandRun(runId: string = DEFAULT_RUN_ID) { runStates.delete(runId); }

function runProcess(shell: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }, state: RunState) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    // windowsVerbatimArguments is required on Windows: Node would otherwise
    // backslash-escape the quotes inside the command string, and cmd.exe
    // (invoked verbatim below as /d /s /c "<command>") misparses the result —
    // `node -e "console.log(1)"` silently produces no output.
    const child = execFile(shell, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
    }, (error, stdout, stderr) => {
      state.children.delete(child);
      if (error) { (error as any).stdout = stdout; (error as any).stderr = stderr; reject(error); }
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (child.pid) state.children.add(child);
  });
}

export type CommandResult = { output: string; exitCode: number; truncated: boolean; approvalDenied?: boolean };

// Opencode parity: agent tool outputs must never flood context. A bare
// `npm run check` or recursive listing can be megabytes — cap what returns
// to the model (head + tail) so one command cannot blow up the run.
export const MODEL_OUTPUT_CAP = 8000;

export function cleanTerminalOutput(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.replace(/\r\n/g, "\n");
  // Collapse carriage returns that overwrite current line (spinners/progress)
  cleaned = cleaned.replace(/[^\n\r]*\r/g, "");
  // Some verbose build tools print their full environment. Keep that noise
  // and credential-like assignments out of model context.
  cleaned = cleaned
    .split("\n")
    .filter((line) => !/^\s*[A-Z][A-Z0-9_]*(?:\s*:\s*|=\s*)['"]?(?:[A-Za-z]:\\|https?:\/\/|\\\\|[A-Za-z0-9_./-]{12,})/.test(line))
    .map((line) => line.replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^,\s}\]]+/ig, "$1[REDACTED]"))
    .join("\n");
  // Collapse runs of 3+ blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

export function capModelOutput(output: string): { output: string; truncated: boolean } {
  const cleaned = cleanTerminalOutput(output);
  if (!cleaned || cleaned.length <= MODEL_OUTPUT_CAP) return { output: cleaned, truncated: false };
  const head = cleaned.slice(0, 6000);
  const tail = cleaned.slice(-2000);
  return {
    output: `${head}\n\n…[output truncated: ${cleaned.length} chars total, showing first 6000 + last 2000]…\n\n${tail}`,
    truncated: true,
  };
}

function commandLeavesProjectRoot(projectRoot: string, command: string): boolean {
  const root = path.resolve(projectRoot).toLowerCase();
  const matches = [...command.matchAll(/(?:^|[&|])\s*(?:cd|pushd)\s+["']?([^"'&|]+)["']?/gi)];
  for (const match of matches) {
    const target = match[1].trim();
    if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(target)) continue;
    const resolved = path.resolve(target).toLowerCase();
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

export async function executeCommand(projectRoot: string, command: string, options: { timeoutSeconds?: number; runId?: string; requireApproval?: boolean } = {}): Promise<CommandResult> {
  const state = stateFor(options.runId);
  if (state.cancelled || state.abortController.signal.aborted) {
    throw new RunCancelledError();
  }
  const trimmed = command.trim();
  if (!trimmed) return { output: "Command is empty.", exitCode: 1, truncated: false };
  if (commandLeavesProjectRoot(projectRoot, trimmed)) {
    return { output: "Command blocked: do not cd outside the selected project workspace. Commands already run with the correct project cwd; use relative paths instead.", exitCode: 1, truncated: false };
  }
  const policy = await readCommandPolicy(projectRoot);
  if (isDeniedCommand(trimmed) || classifyCommand(trimmed, policy) === "deny") return { output: "Command blocked by permission policy (destructive pattern).", exitCode: 1, truncated: false };
  if (options.requireApproval && classifyCommand(trimmed, policy) === "ask") {
    const decision = await requestCommandApproval({ runId: options.runId, approvalKey: approvalKey(trimmed), command: trimmed, cwd: path.resolve(projectRoot), reason: "This command can change dependencies, Git history, remote state, or execute downloaded code." });
    if (state.cancelled || state.abortController.signal.aborted) throw new RunCancelledError();
    if (decision === "deny") return { output: "Command denied or approval timed out.", exitCode: 126, truncated: false, approvalDenied: true };
  }

  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", trimmed] : ["-c", trimmed];
  const appNodeModules = path.resolve(process.cwd(), "node_modules");
  const existingNodePath = process.env.NODE_PATH || "";
  const nodePath = [existingNodePath, appNodeModules].filter(Boolean).join(path.delimiter);
  // Agent-run commands inherit the user environment MINUS secret-shaped
  // variables — the same policy as the interactive terminal. A prompt-injected
  // or confused model must not be able to leak API keys by echoing the
  // environment; tools that legitimately need credentials should receive them
  // via the daemon allowlist mechanism or explicit configuration.
  const env = {
    ...scrubSecretEnv(),
    CI: "true",
    DEBIAN_FRONTEND: "noninteractive",
    NONINTERACTIVE: "1",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    NODE_PATH: nodePath,
  };

  try {
    const result = await runProcess(shell, args, {
      cwd: path.resolve(projectRoot),
      env,
      timeout: Math.max(10, options.timeoutSeconds || DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000,
      maxBuffer: 8_000_000,
    }, state);
    if (state.cancelled || state.abortController.signal.aborted) throw new RunCancelledError();
    const capped = capModelOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
    return { output: capped.output, exitCode: 0, truncated: capped.truncated };
  } catch (error: any) {
    if (error instanceof RunCancelledError || state.cancelled || state.abortController.signal.aborted) {
      throw new RunCancelledError();
    }
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    const capped = capModelOutput(output);
    return { output: capped.output, exitCode: typeof error?.code === "number" ? error.code : 1, truncated: capped.truncated };
  }
}

function backendId(project: ProjectRecord) { return `workspace-${project.id}`; }

export async function getAgentBackend(project: ProjectRecord, options: { readOnly?: boolean; runId?: string } = {}) {
  const backend: any = new FilesystemBackend({ rootDir: path.resolve(project.root), virtualMode: true });
  backend.id = backendId(project);
  // Cap listing/search fan-out: an uncapped `ls /` or `glob **/*` on a repo
  // with node_modules/dist returns thousands of entries into context and the
  // run looks busy while achieving nothing. Truncate with a hint instead.
  const capEntries = (result: any, kind: "files" | "matches", max: number, hint: string) => {
    const list = result?.[kind];
    if (!Array.isArray(list) || list.length <= max) return result;
    return { ...result, [kind]: [...list.slice(0, max)], truncated: true, notice: `${hint} (${list.length} total, showing first ${max})` };
  };
  for (const [method, kind, max, hint] of [
    ["ls", "files", 200, "Directory listing truncated — list a subdirectory or use glob/grep"],
    ["glob", "files", 200, "Glob matched too many files — narrow the pattern"],
    ["grep", "matches", 100, "Too many matches — narrow the pattern or scope to a subdirectory"],
  ] as const) {
    const original = backend[method]?.bind(backend);
    if (!original) continue;
    backend[method] = async (...args: any[]) => capEntries(await original(...args), kind, max, hint);
  }
  if (options.readOnly) {
    const refuse = (action: string) => async () => { throw new Error(`Plan mode is read-only: ${action} is disabled. Explore the repository and produce an implementation plan instead of changing files.`); };
    backend.write = refuse("write_file");
    backend.edit = refuse("edit_file");
    backend.delete = refuse("delete");
    backend.execute = refuse("execute");
  } else {
    backend.execute = (command: string) => executeCommand(project.root, command, { runId: options.runId, requireApproval: true });
  }
  return { backend, workspace: project.root };
}

export async function runProjectCommand(project: ProjectRecord, command: string, runId?: string) {
  return executeCommand(project.root, command, { runId });
}
