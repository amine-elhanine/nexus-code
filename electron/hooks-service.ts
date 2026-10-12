// OpenCode/ZCode-style lifecycle hooks. A hook is a shell command that
// receives the event payload as JSON on stdin; the `tool:before` event can
// DENY a tool call by exiting non-zero (stderr becomes the denial reason).
// Config lives in <project>/.nexus/hooks.json plus a global enable toggle in
// nexus-state.json (SkillsConfig pattern). Hook failures never break a run —
// dispatch errors are reported through the activity feed only.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { scrubSecretEnv } from "./child-env.js";
import { pluginHookFilesWithModes, type PluginMode } from "./plugins-service.js";
import { evaluatePolicyHooks, emitPluginEvent, listenerCount } from "./plugin-events.js";
import { listCapabilities } from "./capability-registry.js";

export type HookEventName = "run:start" | "run:end" | "tool:before" | "tool:after" | "verify:fail";

export type HookConfig = {
  event: HookEventName;
  command: string;
  /** Kill the hook after this long (default 15s). */
  timeoutSeconds?: number;
};

const HOOK_EVENTS: HookEventName[] = ["run:start", "run:end", "tool:before", "tool:after", "verify:fail"];
const DEFAULT_HOOK_TIMEOUT_MS = 15_000;
const HOOK_OUTPUT_CAP = 4_000;

const HOOKS_FILE = path.join(".nexus", "hooks.json");

/** Parses a hooks.json content string. Tolerant: malformed JSON or unknown
 *  events are skipped, never thrown — a broken config must not break runs. */
export function parseHooksConfig(content: string): HookConfig[] {
  if (!content.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.hooks) ? (raw as any).hooks : [];
  const hooks: HookConfig[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const event = String((entry as any).event || "").trim() as HookEventName;
    const command = String((entry as any).command || "").trim();
    if (!HOOK_EVENTS.includes(event) || !command) continue;
    const timeoutSeconds = Number((entry as any).timeoutSeconds);
    hooks.push({
      event,
      command,
      timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 120 ? timeoutSeconds : undefined,
    });
  }
  return hooks.slice(0, 20);
}

/** Reads <projectRoot>/.nexus/hooks.json plus plugin hooks. Missing/malformed → no hooks.
 * When `mode` is given, plugin hooks whose manifest `modes` excludes it are
 * skipped — project hooks.json always applies. */
export async function discoverHooks(projectRoot: string, mode?: PluginMode): Promise<HookConfig[]> {
  const files = [path.join(path.resolve(projectRoot), HOOKS_FILE)];
  for (const entry of await pluginHookFilesWithModes(projectRoot).catch(() => [] as Array<{ file: string; modes: PluginMode[] }>)) {
    if (mode && entry.modes.length && !entry.modes.includes(mode)) continue;
    files.push(entry.file);
  }
  const hooks: HookConfig[] = [];
  for (const file of files) {
    try {
      hooks.push(...parseHooksConfig(await readFile(file, "utf8")));
    } catch { /* missing or malformed file contributes nothing */ }
  }
  return hooks;
}

export type HookOutcome = { ok: boolean; exitCode: number | null; output: string; timedOut: boolean };

/** Runs one hook command with the event payload on stdin. Uses the same
 *  shell conventions and env scrubbing as agent-run commands. */
export async function dispatchHook(projectRoot: string, hook: HookConfig, payload: Record<string, unknown>): Promise<HookOutcome> {
  const input = JSON.stringify({ ...payload, event: hook.event });
  const timeoutMs = (hook.timeoutSeconds ?? 15) * 1000;
  const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", hook.command] : ["-c", hook.command];

  return new Promise<HookOutcome>((resolve) => {
    let child;
    try {
      child = spawn(shell, args, {
        cwd: path.resolve(projectRoot),
        env: { ...scrubSecretEnv(), NEXUS_HOOK: hook.event },
        windowsHide: true,
        windowsVerbatimArguments: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, output: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }

    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (output.length < HOOK_OUTPUT_CAP) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* already gone */ }
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      const trimmed = output.trim();
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        output: trimmed.length > HOOK_OUTPUT_CAP ? `${trimmed.slice(0, HOOK_OUTPUT_CAP)}…` : trimmed,
        timedOut,
      });
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: error.message, timedOut: false });
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => { /* hook may not read stdin */ });
    child.stdin.end(input);
  });
}

/** Fans an event out to every hook registered for it, in order. Denials are
 *  only meaningful for tool:before; every other event ignores outcomes.
 *
 *  SECURITY: denials are monotonic — if ANY matching hook fails (non-zero
 *  exit, timeout, or spawn error), the aggregated outcome is a denial and a
 *  later successful hook can NEVER override it. Returns the FIRST denial
 *  (owner of the decision) so audit records point at the right hook. */
export async function dispatchHooks(projectRoot: string, hooks: HookConfig[], event: HookEventName, payload: Record<string, unknown>): Promise<HookOutcome | null> {
  const matching = hooks.filter((hook) => hook.event === event);
  let last: HookOutcome | null = null;
  let firstDenial: HookOutcome | null = null;
  for (const hook of matching) {
    const outcome = await dispatchHook(projectRoot, hook, payload).catch((error) => ({
      ok: false,
      exitCode: null,
      output: error instanceof Error ? error.message : String(error),
      timedOut: false,
    }));
    last = outcome;
    if (!outcome.ok && !firstDenial) firstDenial = outcome;
  }
  if ((event === "run:start" || event === "run:end" || event === "tool:after") && listenerCount(event) > 0) {
    await emitPluginEvent(event, { ...payload, projectRoot }).catch(() => undefined);
  }
  // Monotonic denial wins over later success.
  if (firstDenial) return firstDenial;
  return last;
}

/**
 * LangChain middleware running tool:before (deny-capable) and tool:after
 * hooks around every tool call (both declarative hooks.json shell hooks and
 * executable SDK plugin listeners). Returns null when there are no hooks or
 * plugin tool listeners so the run pays nothing.
 */
export function createHooksMiddleware(options: { projectRoot: string; hooks: HookConfig[]; runId?: string }) {
  const { projectRoot, hooks, runId } = options;
  const before = hooks.filter((hook) => hook.event === "tool:before");
  const after = hooks.filter((hook) => hook.event === "tool:after");
  const hasPluginToolListeners = listenerCount("tool:before") > 0 || listenerCount("tool:after") > 0;
  if (!before.length && !after.length && !hasPluginToolListeners) return null;

  return createMiddleware({
    name: "hooksMiddleware",
    wrapToolCall: async (request: any, handler: any) => {
      const toolName = String(request?.tool?.name ?? request?.toolCall?.name ?? "");
      const args = request?.toolCall?.args ?? {};
      const toolCallId = String(request?.toolCall?.id ?? "");
      const isPluginOwnedTool = toolName.startsWith("plugin_") || listCapabilities({ kind: "tool" }).some((c) => c.id === toolName || c.name === toolName);

      if (before.length) {
        const outcome = await dispatchHooks(projectRoot, before, "tool:before", { tool: toolName, args, runId });
        if (outcome && !outcome.ok) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            status: "error",
            content: `[HOOK DENIED] The tool call '${toolName}' was blocked by a project hook (exit ${outcome.exitCode ?? "timeout"}): ${outcome.output || "no output"}. Ask the user to review .nexus/hooks.json if this denial is wrong.`,
          });
        }
      }

      // Executable SDK plugin policy hooks for built-in/MCP tools (plugin-owned
      // tools already evaluate policy hooks inside executePluginTool).
      if (!isPluginOwnedTool && listenerCount("tool:before") > 0) {
        const policy = await evaluatePolicyHooks("tool:before", { tool: toolName, args, runId, projectRoot });
        if (!policy.allowed) {
          return new ToolMessage({
            tool_call_id: toolCallId,
            name: toolName,
            status: "error",
            content: `[HOOK DENIED] The tool call '${toolName}' was blocked by plugin '${policy.deniedBy ?? "unknown"}': ${policy.reason || "denied by policy hook"}.`,
          });
        }
      }

      const result = await handler(request);

      if (after.length) {
        await dispatchHooks(projectRoot, after, "tool:after", { tool: toolName, args, runId }).catch(() => undefined);
      } else if (!isPluginOwnedTool && listenerCount("tool:after") > 0) {
        await emitPluginEvent("tool:after", { tool: toolName, args, runId, projectRoot, ok: true }).catch(() => undefined);
      }
      return result;
    },
  });
}
