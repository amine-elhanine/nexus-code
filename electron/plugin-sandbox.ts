// Isolation for executable plugin entries.
//
// SECURITY MODEL (honest, documented):
// - Declarative plugins (skills/agents/commands/rules/hooks/ui-declarative)
//   run in-process: they are data, not code. Safe by construction.
// - Executable plugins (`entry` JS) are UNTRUSTED code. They MUST NOT be
//   required() directly into the privileged Electron main process.
// - This module runs entry code OUT-OF-PROCESS through the same NDJSON-RPC
//   plugin runner the lifecycle manager uses (plugin-process-host.ts): a
//   one-shot child process (Electron binary with ELECTRON_RUN_AS_NODE=1,
//   secret-scrubbed env) that only exposes the frozen `nexus` SDK surface
//   over the narrow activate/call-tool protocol, with a bounded activation
//   timeout and process-tree kill on failure. There is NO in-process
//   node:vm fallback — every standalone sandbox validation runs with the
//   same OS-process boundary as live plugins.
// - Installation still requires explicit user approval and source review;
//   the process boundary makes the trust prompt meaningful instead of
//   decorative.

import { promises as fs } from "node:fs";
import path from "node:path";
import { startPluginProcess, stopPluginProcess, resolvePluginEntry } from "./plugin-process-host.js";

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

let oneShotCounter = 0;

function looksLikePathEscape(resolved: string, root: string): boolean {
  return !resolved.startsWith(root + path.sep) && resolved !== root;
}

/**
 * Load + execute a plugin entry file in a one-shot out-of-process runner.
 * Returns the recorded SDK calls (tools/commands/subscriptions/context
 * providers declared by the entry) for the lifecycle manager to validate and
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
  try {
    resolvePluginEntry(root, entry);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { ok: false, calls: [], logs: [], error: "entry is not a file" };
    if (stat.size > MAX_ENTRY_BYTES) {
      return { ok: false, calls: [], logs: [], error: `entry exceeds ${MAX_ENTRY_BYTES} bytes` };
    }
  } catch (error) {
    return { ok: false, calls: [], logs: [], error: error instanceof Error ? error.message : String(error) };
  }

  const oneShotId = `sandbox-${process.pid}-${Date.now()}-${oneShotCounter++}`;
  try {
    const { process: proc, activation } = await startPluginProcess(oneShotId, root, entry, {
      activationTimeoutMs: timeoutMs,
    });
    try {
      const calls: Array<{ method: string; args: unknown }> = [
        ...activation.tools.map((def) => ({ method: "registerTool", args: def })),
        ...activation.commands.map((def) => ({ method: "registerCommand", args: def })),
        ...(activation.contextProviders || []).map((def) => ({ method: "registerContextProvider", args: def })),
        ...activation.subscriptions.map((sub) => ({ method: "on", args: { event: sub.event } })),
      ];
      return { ok: true, calls, logs: (activation.logs || []).map((l) => String(l).slice(0, 2_000)) };
    } finally {
      await stopPluginProcess(oneShotId).catch(() => proc.kill());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timed out|timeout/i.test(message);
    return { ok: false, calls: [], logs: [], error: message.slice(0, 2_000), timedOut };
  }
}
