// Host side of the out-of-process plugin runner.
//
// One child process per executable plugin. The child runs
// dist-electron/plugin-runner.cjs under plain Node semantics
// (ELECTRON_RUN_AS_NODE=1 when spawned from Electron, where process.execPath
// is the Electron binary). Narrow NDJSON-RPC only: activate / call-tool /
// shutdown. No shared memory, no module loading in the main process.
//
// Guarantees:
// - Activation + every tool call has a host-side timeout; expiry rejects the
//   pending call. A hung activation kills the process.
// - Crash/exit rejects all pending calls with a clear error; optional
//   bounded restart (default: no auto-restart — the lifecycle manager decides).
// - dispose() kills the process and removes all tracking (no orphans).
// - Entry path must resolve inside the plugin dir (traversal rejected).

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RunnerToolDef = {
  name: string;
  description: string;
  modes?: string[];
  permissions?: string[];
  requiresApproval?: boolean;
  timeoutMs?: number;
  hasHandler: boolean;
};

export type RunnerCommandDef = { name: string; description: string; modes?: string[] };

export type RunnerContextProviderDef = {
  name: string;
  description?: string;
  modes?: string[];
  hasHandler: boolean;
};

export type RunnerActivation = {
  tools: RunnerToolDef[];
  commands: RunnerCommandDef[];
  subscriptions: Array<{ event: string }>;
  contextProviders?: RunnerContextProviderDef[];
  logs: string[];
};

type PendingCall = {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export class PluginProcess {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = "";
  private exited = false;
  private exitError: Error | null = null;

  constructor(
    readonly pluginId: string,
    readonly pluginDir: string,
    private runnerPath: string
  ) {}

  get alive(): boolean {
    return this.child !== null && !this.exited && this.child.exitCode === null && this.child.signalCode === null;
  }

  spawn(): void {
    if (this.child && !this.exited) throw new Error(`runner for "${this.pluginId}" already running`);
    this.exited = false;
    this.exitError = null;
    this.buffer = "";
    const child = spawn(process.execPath, [this.runnerPath], {
      cwd: path.resolve(this.pluginDir),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.on("error", (error) => this.onExit(new Error(`runner spawn failed: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.onExit(new Error(`runner exited (code=${code ?? "?"} signal=${signal ?? "none"})`));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: { id?: unknown; ok?: unknown; result?: never; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // runner only speaks JSON; ignore stray lines defensively
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.result as never);
      else pending.reject(new Error(typeof message.error === "string" ? message.error : "runner call failed"));
    }
  }

  private onExit(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = error;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method} failed: ${error.message}`));
    }
    this.pending.clear();
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error(`${method} failed: runner is not running${this.exitError ? ` (${this.exitError.message})` : ""}`));
    }
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error(`${method} failed: runner stdin is closed`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
        method,
      });
      stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`${method} failed: ${error.message}`));
        }
      });
    });
  }

  /** Load the entry in the child. Kills the child when activation hangs. */
  async activate(entryAbs: string, timeoutMs = 5_000): Promise<RunnerActivation> {
    const bounded = Math.min(Math.max(timeoutMs, 1_000), 30_000);
    try {
      return await this.request<RunnerActivation>("activate", { entry: entryAbs, timeoutMs: bounded }, bounded + 2_000);
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  callTool(tool: string, args: Record<string, unknown>, mode: string, timeoutMs = 30_000): Promise<unknown> {
    const bounded = Math.min(Math.max(timeoutMs, 1_000), 120_000);
    return this.request<{ output: unknown }>("call-tool", { tool, args, mode, timeoutMs: bounded }, bounded + 2_000).then(
      (result) => result.output
    );
  }

  callEvent(event: string, payload: Record<string, unknown>, timeoutMs = 5_000): Promise<{ verdict: "allow" | "deny" | "abstain"; reason?: string }> {
    const bounded = Math.min(Math.max(timeoutMs, 500), 30_000);
    return this.request<{ verdict: "allow" | "deny" | "abstain"; reason?: string }>("call-event", { event, payload, timeoutMs: bounded }, bounded + 2_000);
  }

  callContextProvider(name: string, context: { mode: string; projectRoot?: string }, timeoutMs = 5_000): Promise<string> {
    const bounded = Math.min(Math.max(timeoutMs, 500), 30_000);
    return this.request<{ text: string }>("call-context-provider", { name, ...context, timeoutMs: bounded }, bounded + 2_000).then(
      (result) => result.text ?? ""
    );
  }

  async shutdown(timeoutMs = 3_000): Promise<void> {
    if (!this.child || this.exited) return;
    try {
      await this.request("shutdown", {}, timeoutMs);
    } catch {
      // Best effort — kill below covers it.
    }
    this.kill();
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    this.onExit(new Error("runner disposed"));
    try {
      child?.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const processes = new Map<string, PluginProcess>();

export function runnerScriptPath(): string {
  // dist-electron/plugin-runner.cjs in production; electron/ source in dev
  // when tests run before packaging. Prefer the compiled-side copy.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "plugin-runner.cjs"), path.resolve("dist-electron/plugin-runner.cjs")];
  // The spawn call will surface ENOENT clearly if neither exists.
  return candidates[0] as string;
}

/** Resolve + containment-check the entry inside the plugin dir. */
export function resolvePluginEntry(pluginDir: string, entry: string): string {
  const root = path.resolve(pluginDir);
  const normalized = entry.replace(/\\/g, "/");
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("entry escapes plugin directory");
  }
  return resolved;
}

/** Spawn + activate a plugin process. Caller owns disposal on failure. */
export async function startPluginProcess(
  pluginId: string,
  pluginDir: string,
  entry: string,
  options: { activationTimeoutMs?: number } = {}
): Promise<{ process: PluginProcess; activation: RunnerActivation }> {
  const id = pluginId.toLowerCase();
  if (processes.has(id)) throw new Error(`plugin "${pluginId}" already has a running process`);
  const entryAbs = resolvePluginEntry(pluginDir, entry);
  const proc = new PluginProcess(id, pluginDir, runnerScriptPath());
  processes.set(id, proc);
  try {
    proc.spawn();
    const activation = await proc.activate(entryAbs, options.activationTimeoutMs ?? 5_000);
    return { process: proc, activation };
  } catch (error) {
    processes.delete(id);
    try {
      proc.kill();
    } catch {
      // Ignore.
    }
    throw error;
  }
}

export function getPluginProcess(pluginId: string): PluginProcess | undefined {
  return processes.get(pluginId.toLowerCase());
}

/** Terminate + forget a plugin process. Safe to call when absent. */
export async function stopPluginProcess(pluginId: string): Promise<boolean> {
  const id = pluginId.toLowerCase();
  const proc = processes.get(id);
  if (!proc) return false;
  processes.delete(id);
  try {
    await proc.shutdown();
  } catch {
    try {
      proc.kill();
    } catch {
      // Ignore.
    }
  }
  return true;
}

/** Test/maintenance helper: stop everything. */
export async function stopAllPluginProcesses(): Promise<void> {
  const ids = [...processes.keys()];
  for (const id of ids) {
    await stopPluginProcess(id).catch(() => undefined);
  }
}
