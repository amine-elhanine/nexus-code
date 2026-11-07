import { execFile, spawn } from "node:child_process";
import { planCommandSandbox, sandboxArgvPrefix, sandboxEnvAdditions, type SandboxPlan } from "./os-sandbox.js";
import { getAppSettings } from "./store.js";
import type { ChildProcess } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeniedCommand, classifyCommand, isHttpMutationCommand, isWindowsDownloadCommand } from "./permissions.js";
import { stripProjectRoot, normalizeCommandPaths } from "./path-utils.js";
import type { CommandPolicy } from "./permissions.js";
import { requestCommandApproval } from "./approval-service.js";
import { scrubSecretEnv } from "./child-env.js";
import type { ProjectRecord } from "./store.js";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 180;

export async function readCommandPolicy(projectRoot: string): Promise<CommandPolicy> {
  return (await readCommandPolicyWithTrust(projectRoot)).policy;
}

// package.json policy is user-authored (committed, reviewable) — trusted to
// override the built-in ask gates. `.nexus/permissions.json` sits inside the
// workspace where the agent can write it, so its allow list is untrusted.
export async function readCommandPolicyWithTrust(projectRoot: string): Promise<{ policy: CommandPolicy; trustedAllow: boolean }> {
  const candidates = [path.join(projectRoot, ".nexus", "permissions.json")];
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    if (packageJson?.nexus?.permissions) return { policy: packageJson.nexus.permissions, trustedAllow: true };
  } catch { /* optional config */ }
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object") return { policy: parsed, trustedAllow: false };
    } catch { /* optional config */ }
  }
  return { policy: {}, trustedAllow: true };
}

function approvalKey(command: string): string {
  if (isHttpMutationCommand(command)) return "network-write";
  if (/\bgit\b[^|&;\n]*\bpush\b/i.test(command)) return "git-push";
  if (/\bgit\b[^|&;\n]*\b(?:reset|clean|rebase)\b/i.test(command)) return "git-history";
  if (/\b(?:npm|pnpm|yarn|pip|pip3|cargo|poetry|uv)\s+(?:i|ci|install|add|remove|uninstall|rm|un)\b/i.test(command)) return "dependency-change";
  if (/\bgo\s+get\b/i.test(command)) return "dependency-change";
  if (/\bmvn\s+(?:dependency|install)\b/i.test(command)) return "dependency-change";
  if (/\bdotnet\s+(?:add|remove|restore)\b/i.test(command)) return "dependency-change";
  if (/\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b|\b(?:Invoke-WebRequest|iwr|irm)\b/i.test(command) || isWindowsDownloadCommand(command)) return "download-execute";
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
export function endCommandRun(runId: string = DEFAULT_RUN_ID) {
  runStates.delete(runId);
  sessionShellState.delete(runId);
}

// Session-level shell state tracking (CWD and env persistence across execute tool calls)
const sessionShellState = new Map<string, { cwd: string }>();

export function getSessionShellCwd(runId?: string): string | undefined {
  if (!runId) return undefined;
  return sessionShellState.get(runId)?.cwd;
}

export function setSessionShellCwd(runId: string, cwd: string): void {
  sessionShellState.set(runId, { cwd });
}

export function clearSessionShellState(runId?: string): void {
  if (runId) sessionShellState.delete(runId);
  else sessionShellState.clear();
}

function runProcess(shell: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; onOutput?: (chunk: string) => void }, state: RunState) {
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
    const forwardOutput = (chunk: Buffer | string) => {
      try { options.onOutput?.(chunk.toString()); } catch { /* output observers must not break the command */ }
    };
    child.stdout?.on("data", forwardOutput);
    child.stderr?.on("data", forwardOutput);
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
  // Collapse carriage returns that overwrite current line (spinners/progress).
  // Equivalent to a `[^\n\r]*\r` global strip (drop everything up to and
  // including each CR, per newline-delimited line) but implemented as a
  // linear scan — the regex variant backtracks quadratically on megabyte
  // single-line outputs and can hang the renderer round-trip.
  cleaned = cleaned
    .split("\n")
    .map((line) => {
      const lastCr = line.lastIndexOf("\r");
      return lastCr === -1 ? line : line.slice(lastCr + 1);
    })
    .join("\n");
  // Some verbose build tools print their full environment. Keep that noise
  // and credential-like assignments out of model context.
  cleaned = cleaned
    .split("\n")
    .filter((line) => !/^\s*[A-Z][A-Z0-9_]*(?:\s*:\s*|=\s*)['"]?(?:[A-Za-z]:\\|https?:\/\/|\\\\|[A-Za-z0-9_./-]{12,})/.test(line))
    .map((line) => {
      // Credential-style headers ("Authorization: Bearer …", "Bearer jwt…")
      // must run BEFORE the key=value substitution, which would otherwise
      // consume "bearer" as the value and leave the token in the clear.
      let redacted = line.replace(/((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}/ig, "$1[REDACTED]");
      redacted = redacted.replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^,\s}\]]+/ig, "$1[REDACTED]");
      return redacted;
    })
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

function commandLeavesProjectRoot(projectRoot: string, command: string, baseDir?: string): boolean {
  const root = path.resolve(projectRoot).toLowerCase();
  const base = path.resolve(baseDir || projectRoot).toLowerCase();
  const matches = [...command.matchAll(/(?:^|[&|;])\s*(?:cd|pushd)\s+["']?([^"'&|;]+)/gi)];
  for (const match of matches) {
    const target = match[1].trim();
    if (!target) continue;
    // Shell-expandable forms (~, %VAR%, $VAR, `cd -`) resolve outside the
    // workspace at runtime — the lexical check cannot follow them, so refuse.
    if (target === "-" || /^~/.test(target) || /%[^%]+%/.test(target) || /\$\{?\w/.test(target)) return true;
    // Absolute AND relative targets both resolve against the active baseDir:
    const resolved = path.resolve(base, target).toLowerCase();
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

export async function executeCommand(projectRoot: string, command: string, options: { timeoutSeconds?: number; runId?: string; requireApproval?: boolean; policy?: CommandPolicy; policyTrusted?: boolean; onOutput?: (chunk: string) => void; extraEnv?: Record<string, string>; /** Full Access mode: run every non-denied command without the approval prompt. */ fullAccess?: boolean } = {}): Promise<CommandResult> {
  const state = stateFor(options.runId);
  if (state.cancelled || state.abortController.signal.aborted) {
    throw new RunCancelledError();
  }
  const trimmed = command.trim();
  if (!trimmed) return { output: "Command is empty.", exitCode: 1, truncated: false };
  const normalized = normalizeCommandPaths(trimmed, projectRoot);
  const activeCwd = (options.runId && sessionShellState.get(options.runId)?.cwd)
    ? sessionShellState.get(options.runId)!.cwd
    : path.resolve(projectRoot);

  if (commandLeavesProjectRoot(projectRoot, normalized, activeCwd)) {
    return { output: "Command blocked: do not cd outside the selected project workspace. Commands already run with the correct project cwd; use relative paths instead.", exitCode: 1, truncated: false };
  }
  const { policy, trustedAllow } = options.policy !== undefined
    ? { policy: options.policy, trustedAllow: options.policyTrusted !== false }
    : await readCommandPolicyWithTrust(projectRoot);
  const classifyOptions = { trustedAllow, fullAccess: options.fullAccess };
  if (isDeniedCommand(normalized) || classifyCommand(normalized, policy, classifyOptions) === "deny") return { output: "Command blocked by permission policy (destructive pattern).", exitCode: 1, truncated: false };
  if (options.requireApproval && !options.fullAccess && classifyCommand(normalized, policy, classifyOptions) === "ask") {
    const decision = await requestCommandApproval({ runId: options.runId, approvalKey: approvalKey(normalized), command: normalized, cwd: path.resolve(projectRoot), reason: "This command can change dependencies, Git history, remote state, execute downloaded code, or send data to a remote service." });
    if (state.cancelled || state.abortController.signal.aborted) throw new RunCancelledError();
    if (decision === "deny") return { output: "Command denied or approval timed out.", exitCode: 126, truncated: false, approvalDenied: true };
  }

  // Wrap command with working directory tracker sentinel so sticky cwd works across execute tool calls
  const sentinelTag = `__NEXUS_PWD_${Date.now()}__`;
  const wrappedCommand = process.platform === "win32"
    // Exit-code fidelity: the cwd report must not clobber ERRORLEVEL. `cd`
    // resets ERRORLEVEL to 0 on success (it would mask a failing command's
    // real exit code), and `echo` does not. So the cwd is reported by a
    // `for /f` child running `cd` instead of a direct `cd`, and the failure
    // branch ends with a bare `exit /b`, which exits with the preserved
    // ERRORLEVEL instead of the previous hardcoded 1.
    ? `${normalized} && (echo ${sentinelTag}& for /f "delims=" %i in ('cd') do @echo %i) || (echo ${sentinelTag}& for /f "delims=" %i in ('cd') do @echo %i & exit /b)`
    : `{ ${normalized}; }; __ex=$?; echo "${sentinelTag}"; pwd; exit $__ex`;

  const extractAndApplySentinel = (rawStdout: string): string => {
    const sentinelIdx = rawStdout.lastIndexOf(sentinelTag);
    if (sentinelIdx === -1) return rawStdout;
    const afterSentinel = rawStdout.slice(sentinelIdx + sentinelTag.length).trim();
    const cleaned = rawStdout.slice(0, sentinelIdx);
    if (afterSentinel) {
      const newCwdLine = afterSentinel.split(/\r?\n/)[0]?.trim();
      if (newCwdLine) {
        const resolvedNewCwd = path.resolve(activeCwd, newCwdLine);
        const resolvedRoot = path.resolve(projectRoot);
        const isWindows = process.platform === "win32";
        const rootCmp = isWindows ? resolvedRoot.toLowerCase() : resolvedRoot;
        const newCwdCmp = isWindows ? resolvedNewCwd.toLowerCase() : resolvedNewCwd;
        if (newCwdCmp === rootCmp || newCwdCmp.startsWith(rootCmp + path.sep)) {
          if (options.runId) {
            sessionShellState.set(options.runId, { cwd: resolvedNewCwd });
          }
        }
      }
    }
    return cleaned;
  };

  let sentinelSeenInStream = false;
  const filteredOnOutput = options.onOutput
    ? (chunk: string) => {
        if (sentinelSeenInStream) return;
        const idx = chunk.indexOf(sentinelTag);
        if (idx !== -1) {
          sentinelSeenInStream = true;
          const before = chunk.slice(0, idx);
          if (before) options.onOutput!(before);
          return;
        }
        options.onOutput!(chunk);
      }
    : undefined;

  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", wrappedCommand] : ["-c", wrappedCommand];

  // OS-level sandbox (Phase 4.1): opt-in via AppSettings.commandSandbox="auto".
  // macOS wraps the shell in sandbox-exec (writes scoped to workspace+temp,
  // ~/.ssh & ~/.gnupg denied); Linux uses bwrap when installed; Windows
  // degrades to TEMP/TMP env scoping. Never breaks a command: plan failures
  // leave the run unsandboxed with the policy layer still applying.
  let sandboxPlan: SandboxPlan = { kind: "none", reason: "sandbox disabled" };
  try {
    const appSettings = await getAppSettings();
    sandboxPlan = planCommandSandbox({ projectRoot: path.resolve(projectRoot), mode: appSettings.commandSandbox || "off" });
    if (sandboxPlan.kind !== "none") {
      await mkdir(path.join(path.resolve(projectRoot), ".nexus", "tmp"), { recursive: true });
    }
  } catch { /* sandbox is optional hardening */ }
  const sandboxPrefix = sandboxArgvPrefix(sandboxPlan);
  const sandboxEnv = sandboxEnvAdditions(sandboxPlan);
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
    // Caller-supplied additions are main-process-controlled values only
    // (never model-controlled) — e.g. passing a file path to a script without
    // shell/python string interpolation.
    ...(options.extraEnv || {}),
    CI: "true",
    DEBIAN_FRONTEND: "noninteractive",
    NONINTERACTIVE: "1",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    NODE_PATH: nodePath,
  };

  try {
    const result = await runProcess(sandboxPrefix.length ? sandboxPrefix[0] : shell, sandboxPrefix.length ? [...sandboxPrefix.slice(1), shell, ...args] : args, {
      cwd: activeCwd,
      env: { ...env, ...sandboxEnv },
      timeout: Math.max(10, options.timeoutSeconds || DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000,
      maxBuffer: 8_000_000,
      onOutput: filteredOnOutput,
    }, state);
    if (state.cancelled || state.abortController.signal.aborted) throw new RunCancelledError();

    const cleanStdout = extractAndApplySentinel(result.stdout);
    const capped = capModelOutput([cleanStdout, result.stderr].filter(Boolean).join("\n"));
    return { output: capped.output, exitCode: 0, truncated: capped.truncated };
  } catch (error: any) {
    if (error instanceof RunCancelledError || state.cancelled || state.abortController.signal.aborted) {
      throw new RunCancelledError();
    }
    const cleanStdout = extractAndApplySentinel(error?.stdout || "");
    const cleanErrMsg = error?.message ? String(error.message).replace(wrappedCommand, normalized) : "";
    const output = [cleanStdout, error?.stderr, cleanErrMsg].filter(Boolean).join("\n");
    const capped = capModelOutput(output);
    return { output: capped.output, exitCode: typeof error?.code === "number" ? error.code : 1, truncated: capped.truncated };
  }
}

function backendId(project: ProjectRecord) { return `workspace-${project.id}`; }
void backendId;

// The run-scoped workspace backend (read-only stubs, command approval policy,
// edit gates, legacy-dir guard, LSP diagnostics) now lives in agentcore/backend.
export { getAgentBackend } from "./agentcore/backend.js";

export async function runProjectCommand(project: ProjectRecord, command: string, runId?: string) {
  return executeCommand(project.root, command, { runId });
}
