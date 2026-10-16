// Isolation for executable plugin entries.
//
// SECURITY MODEL (honest, documented):
// - Declarative plugins (skills/agents/commands/rules/hooks/ui-declarative)
//   run in-process: they are data, not code. Safe by construction.
// - Executable plugins (`entry` JS) are UNTRUSTED code. They MUST NOT be
//   required() directly into the privileged Electron main process.
// - This module runs entry code in a `node:vm` context with:
//     * no `require`, no `process`, no `Electron`, no Node globals,
//     * only a frozen `nexus` SDK object (registerTool/registerCommand/on),
//     * a bounded timeout (default 5s for activation),
//     * stdout-free, network-free activation.
// - vm-context isolation is NOT a full sandbox (no OS boundary). It raises
//   the bar against accidental privileged access and makes the trust prompt
//   meaningful, but installation still requires explicit user approval and
//   source review. High-risk deployments should run executable plugins in a
//   separate process (see PLUGIN_ISOLATION_NOTES in docs); that migration can
//   reuse this SDK surface without changing plugins.

import vm from "node:vm";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SandboxSdk = {
  registerTool: (def: unknown) => void;
  registerCommand: (def: unknown) => void;
  registerContextProvider: (def: unknown, handler?: unknown) => void;
  on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  log: (message: string) => void;
};

export type SandboxResult = {
  ok: boolean;
  calls: Array<{ method: string; args: unknown }>;
  logs: string[];
  error?: string;
  timedOut?: boolean;
};

const MAX_ENTRY_BYTES = 256 * 1024; // 256KB cap on entry source
const DEFAULT_TIMEOUT_MS = 5_000;

function looksLikePathEscape(resolved: string, root: string): boolean {
  return !resolved.startsWith(root + path.sep) && resolved !== root;
}

/**
 * Load + execute a plugin entry file inside a vm context. The entry may call
 * `nexus.registerTool/registerCommand/on` (CommonJS: `module.exports = ...`
 * or ESM-ish default export is NOT executed beyond top-level calls).
 * Returns the recorded SDK calls for the lifecycle manager to validate and
 * register through the normal capability registry (never direct).
 */
export async function runPluginEntrySandbox(options: {
  pluginDir: string;
  entry: string;
  timeoutMs?: number;
}): Promise<SandboxResult> {
  const { pluginDir, entry } = options;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 30_000);
  const root = path.resolve(pluginDir);
  const resolved = path.resolve(root, entry.replace(/\\/g, "/"));
  if (looksLikePathEscape(resolved, root)) {
    return { ok: false, calls: [], logs: [], error: "entry escapes plugin directory" };
  }
  let source: string;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { ok: false, calls: [], logs: [], error: "entry is not a file" };
    if (stat.size > MAX_ENTRY_BYTES) {
      return { ok: false, calls: [], logs: [], error: `entry exceeds ${MAX_ENTRY_BYTES} bytes` };
    }
    source = await fs.readFile(resolved, "utf8");
  } catch (error) {
    return { ok: false, calls: [], logs: [], error: error instanceof Error ? error.message : String(error) };
  }

  const calls: Array<{ method: string; args: unknown }> = [];
  const logs: string[] = [];
  const sdk: SandboxSdk = {
    registerTool: (def: unknown) => {
      calls.push({ method: "registerTool", args: def });
    },
    registerCommand: (def: unknown) => {
      calls.push({ method: "registerCommand", args: def });
    },
    registerContextProvider: (def: unknown, handler?: unknown) => {
      calls.push({ method: "registerContextProvider", args: { def, handler } });
    },
    on: (event: string, _handler: (...args: unknown[]) => unknown) => {
      // Handlers are functions that cannot cross the vm boundary safely.
      // Record the subscription; the host wires a message-port later.
      // For v1, executable event subscriptions via entry are recorded but
      // only `tool:before`/`tool:after` declarative hooks execute (see docs).
      calls.push({ method: "on", args: { event } });
    },
    log: (message: string) => {
      logs.push(String(message).slice(0, 2_000));
    },
  };

  const sandbox: Record<string, unknown> = {
    nexus: Object.freeze({ ...sdk }),
    console: Object.freeze({ log: (...args: unknown[]) => logs.push(args.map(String).join(" ").slice(0, 2_000)) }),
    module: { exports: {} },
    exports: {},
  };
  // Intentionally NO: require, process, globalThis pollution, fetch, setInterval
  // beyond the minimum. Timers are allowed but bounded by the vm timeout.
  const context = vm.createContext(sandbox, { name: "nexus-plugin-sandbox" });
  const wrapped = `"use strict";\n${source}\n//# sourceURL=nexus-plugin-entry.js`;
  try {
    const script = new vm.Script(wrapped, { filename: "nexus-plugin-entry.js" });
    script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
    return { ok: true, calls, logs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timed out/i.test(message);
    return { ok: false, calls, logs, error: message.slice(0, 2_000), timedOut };
  }
}
