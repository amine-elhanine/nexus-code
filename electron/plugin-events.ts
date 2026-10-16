// Typed plugin event system: observational events vs policy hooks.
//
// - Observational events (run:start, run:end, tool:after, ...): listeners
//   observe; failures/timeouts never change the outcome, only diagnostics.
// - Policy hooks (tool:before): listeners vote allow/deny/abstain.
//   SECURITY RULE: denials are monotonic — once ANY hook denies, the call is
//   denied. A later allow can NEVER override an earlier denial. Exceptions
//   and timeouts are treated as abstain for observational events but as
//   DENY-safe behavior is configurable for policy hooks (default: abstain,
//   because fail-closed on every slow hook would break runs; the shell-hook
//   path in hooks-service.ts keeps its own fail-closed timeout=>deny rule).
//
// Ordering: registration order. Timeout per listener. Errors recorded.

export type ObservationalEvent =
  | "plugin:activated"
  | "plugin:deactivated"
  | "run:start"
  | "run:end"
  | "tool:after"
  | "task:completed"
  | "task:failed"
  | "config:changed";

export type PolicyEvent = "tool:before";

export type PluginEventName = ObservationalEvent | PolicyEvent;

export type PolicyVerdict = "allow" | "deny" | "abstain";

export type PolicyDecision = {
  verdict: PolicyVerdict;
  reason?: string;
};

export type EventListener<T = Record<string, unknown>> = (
  payload: T,
  context: { pluginId: string; signal: AbortSignal }
) => void | Promise<void | PolicyVerdict | PolicyDecision | { verdict?: PolicyVerdict; reason?: string }>;

type Registration = {
  pluginId: string;
  event: PluginEventName;
  listener: EventListener;
};

const listeners: Registration[] = [];

export function onPluginEvent(event: PluginEventName, pluginId: string, listener: EventListener): () => void {
  const reg: Registration = { pluginId, event, listener };
  listeners.push(reg);
  return () => {
    const index = listeners.indexOf(reg);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** Remove every listener owned by a plugin. Called on disable/uninstall.
 *  Returns the number removed (diagnostics). */
export function removePluginListeners(pluginId: string): number {
  let removed = 0;
  for (let i = listeners.length - 1; i >= 0; i--) {
    if (listeners[i]?.pluginId === pluginId) {
      listeners.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

export function listenerCount(event?: PluginEventName): number {
  return event ? listeners.filter((l) => l.event === event).length : listeners.length;
}

export type DispatchDiagnostics = {
  event: PluginEventName;
  invoked: number;
  deniedBy?: string;
  errors: Array<{ pluginId: string; message: string }>;
  timedOut: Array<{ pluginId: string }>;
};

function normalizeVerdict(value: unknown): PolicyDecision {
  if (value === "deny") return { verdict: "deny" };
  if (value === "allow") return { verdict: "allow" };
  if (value && typeof value === "object") {
    const verdict = (value as { verdict?: unknown }).verdict;
    const reason = (value as { reason?: unknown }).reason;
    if (verdict === "deny") return { verdict: "deny", reason: typeof reason === "string" ? reason : undefined };
    if (verdict === "allow") return { verdict: "allow", reason: typeof reason === "string" ? reason : undefined };
  }
  return { verdict: "abstain" };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error?: unknown }> {
  if (ms <= 0) {
    try {
      return { ok: true, value: await promise };
    } catch (error) {
      return { ok: false, timedOut: false, error };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    return { ok: false, timedOut, error };
  } finally {
    if (timer) clearTimeout(timer);
    void signal;
  }
}

/** Observational dispatch: all listeners run in order; failures never throw.
 *  Returns diagnostics only. */
export async function emitPluginEvent(
  event: ObservationalEvent,
  payload: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {}
): Promise<DispatchDiagnostics> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const matching = listeners.filter((l) => l.event === event);
  const diagnostics: DispatchDiagnostics = { event, invoked: 0, errors: [], timedOut: [] };
  for (const reg of matching) {
    const controller = new AbortController();
    diagnostics.invoked++;
    const result = await withTimeout(
      Promise.resolve().then(() => reg.listener(payload, { pluginId: reg.pluginId, signal: controller.signal })),
      timeoutMs
    );
    controller.abort();
    if (!result.ok) {
      if (result.timedOut) diagnostics.timedOut.push({ pluginId: reg.pluginId });
      else diagnostics.errors.push({ pluginId: reg.pluginId, message: result.error instanceof Error ? result.error.message : String(result.error) });
    }
  }
  return diagnostics;
}

/**
 * Policy dispatch for `tool:before`. Monotonic denial:
 * - every matching listener runs (in registration order) unless aborted,
 * - ANY deny wins; later allows cannot clear it,
 * - first denial's reason + owner are reported,
 * - listener exceptions/timeouts count as abstain (they cannot grant access).
 */
export async function evaluatePolicyHooks(
  event: PolicyEvent,
  payload: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {}
): Promise<{ allowed: boolean; deniedBy?: string; reason?: string; diagnostics: DispatchDiagnostics }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const matching = listeners.filter((l) => l.event === event);
  const diagnostics: DispatchDiagnostics = { event, invoked: 0, errors: [], timedOut: [] };
  let deniedBy: string | undefined;
  let reason: string | undefined;

  for (const reg of matching) {
    const controller = new AbortController();
    diagnostics.invoked++;
    const result = await withTimeout(
      Promise.resolve().then(() => reg.listener(payload, { pluginId: reg.pluginId, signal: controller.signal })),
      timeoutMs
    );
    controller.abort();
    if (!result.ok) {
      if (result.timedOut) diagnostics.timedOut.push({ pluginId: reg.pluginId });
      else diagnostics.errors.push({ pluginId: reg.pluginId, message: result.error instanceof Error ? result.error.message : String(result.error) });
      continue; // fail-open to abstain here; shell hooks stay fail-closed separately.
    }
    const decision = normalizeVerdict(result.value);
    if (decision.verdict === "deny" && !deniedBy) {
      deniedBy = reg.pluginId;
      reason = decision.reason || `Denied by plugin "${reg.pluginId}".`;
    }
  }

  if (deniedBy) {
    diagnostics.deniedBy = deniedBy;
    return { allowed: false, deniedBy, reason, diagnostics };
  }
  return { allowed: true, diagnostics };
}

/** Test/maintenance helper: clear all listeners. */
export function clearAllPluginListeners(): void {
  listeners.length = 0;
}
