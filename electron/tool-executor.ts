// Centralized tool execution boundary for plugin-registered tools.
//
// Every plugin tool invocation passes through here:
//   validate args (zod) → check mode → check permissions → policy hooks
//   (monotonic deny) → approval (when required) → timeout/cancellation →
//   execute → redact + record result.
//
// Built-in agent tools keep their existing LangChain path for now; new SDK
// tools MUST use this boundary so plugins cannot bypass security checks.

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { evaluatePolicyHooks } from "./plugin-events.js";
import { hasPermissions, getGrantedPermissions, type PermissionGrant } from "./plugin-permissions.js";
import { getCapability, listCapabilities, capabilityAppliesToMode } from "./capability-registry.js";
import type { PluginMode, PluginPermission } from "./plugin-manifest.js";

export type PluginToolDefinition = {
  name: string;
  description: string;
  /** Zod schema for arguments (strict validation). */
  schema: z.ZodTypeAny;
  modes?: PluginMode[];
  permissions?: PluginPermission[];
  /** When true, execution requires explicit user approval each call. */
  requiresApproval?: boolean;
  timeoutMs?: number;
  handler: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
};

export type ToolExecutionContext = {
  pluginId: string;
  mode: PluginMode;
  signal?: AbortSignal;
  /** Host-provided approval callback (UI). Null => deny when approval needed. */
  requestApproval?: (summary: string) => Promise<boolean>;
};

export type ToolExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code: "validation" | "mode" | "permission" | "policy" | "approval" | "timeout" | "cancelled" | "execution" };

function redactSecrets(value: unknown): unknown {
  // Best-effort: never echo long hex/base64 tokens into logs/results.
  try {
    const text = JSON.stringify(value);
    if (!text) return value;
    const redacted = text.replace(/(sk-[a-zA-Z0-9-_]{8,})/g, "sk-****").replace(/("api[_-]?key"\s*:\s*")[^"]+(")/gi, "$1****$2");
    return JSON.parse(redacted);
  } catch {
    return value;
  }
}

export async function executePluginTool(
  pluginId: string,
  toolName: string,
  rawArgs: unknown,
  context: ToolExecutionContext,
  grants: Pick<PermissionGrant, "granted"> | { granted: PluginPermission[] } = { granted: [] }
): Promise<ToolExecutionResult> {
  const id = `${pluginId}:${toolName}`;
  const record = getCapability(id);
  if (!record || record.kind !== "tool") {
    return { ok: false, error: `Unknown tool "${id}".`, code: "validation" };
  }
  const def = record.data as PluginToolDefinition;

  if (context.signal?.aborted) {
    return { ok: false, error: "Tool execution cancelled.", code: "cancelled" };
  }

  // Mode gate (deny-by-default on mismatch; invalid modes were rejected at registration).
  if (!capabilityAppliesToMode({ modes: def.modes ?? record.modes ?? [] }, context.mode)) {
    return { ok: false, error: `Tool "${id}" is not available in "${context.mode}" mode.`, code: "mode" };
  }

  // Permission gate (host-enforced, deny-by-default).
  const required = [...new Set([...(record.permissions ?? []), ...(def.permissions ?? [])])] as PluginPermission[];
  const grantedSet = new Set(grants.granted ?? []);
  if (!required.every((p) => grantedSet.has(p)) || !hasPermissions(pluginId, required)) {
    return { ok: false, error: `Plugin "${pluginId}" lacks permission for tool "${toolName}" (needs: ${required.join(", ") || "none"}).`, code: "permission" };
  }

  // Arg validation (strict when the tool declares a schema; runner-registered
  // tools accept any plain object and validate inside their own process).
  let args: Record<string, unknown>;
  try {
    if (def.schema && typeof (def.schema as { parseAsync?: unknown }).parseAsync === "function") {
      const parsed = await def.schema.parseAsync(rawArgs ?? {});
      args = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else if (rawArgs === undefined || rawArgs === null) {
      args = {};
    } else {
      return { ok: false, error: `Invalid arguments for "${id}": expected an object.`, code: "validation" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid arguments for "${id}": ${message.slice(0, 500)}`, code: "validation" };
  }

  // Policy hooks (monotonic deny wins).
  try {
    const policy = await evaluatePolicyHooks("tool:before", { tool: id, args, pluginId, mode: context.mode }, { timeoutMs: 5_000 });
    if (!policy.allowed) {
      return { ok: false, error: policy.reason || `Tool "${id}" blocked by policy.`, code: "policy" };
    }
  } catch (error) {
    return { ok: false, error: `Policy check failed for "${id}".`, code: "policy" };
  }

  // Approval for sensitive tools.
  if (def.requiresApproval) {
    if (!context.requestApproval) {
      return { ok: false, error: `Tool "${id}" requires approval, but no approval channel is available. Denied by default.`, code: "approval" };
    }
    const approved = await context.requestApproval(`${pluginId}:${toolName}`).catch(() => false);
    if (!approved) {
      return { ok: false, error: `Tool "${id}" denied by user.`, code: "approval" };
    }
  }

  // Execute with timeout + cancellation.
  const timeoutMs = Math.min(Math.max(def.timeoutMs ?? 30_000, 1_000), 120_000);
  try {
    const result = await runWithTimeout(
      def.handler(args, context),
      timeoutMs,
      context.signal
    );
    return { ok: true, result: redactSecrets(result) };
  } catch (error) {
    if (context.signal?.aborted) return { ok: false, error: "Tool execution cancelled.", code: "cancelled" };
    if (error instanceof Error && error.message === "tool-timeout") {
      return { ok: false, error: `Tool "${id}" timed out after ${timeoutMs}ms.`, code: "timeout" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Tool "${id}" failed: ${message.slice(0, 1000)}`, code: "execution" };
  }
}

function runWithTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("tool-timeout")), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Adapts registered executable plugin tools into LangChain tools for the agent loop.
 * Honors mode restrictions, host-enforced permissions, approvals, and secret redaction.
 */
export function createPluginAgentTools(options: {
  mode: PluginMode;
  runId?: string;
  projectRoot?: string;
  signal?: AbortSignal;
  requestApproval?: (summary: string) => Promise<boolean>;
}): any[] {
  const records = listCapabilities({ kind: "tool", mode: options.mode });
  const agentTools: any[] = [];

  for (const record of records) {
    const pluginId = record.owner;
    const toolName = record.name;
    const def = record.data as Partial<PluginToolDefinition> | undefined;

    // Sanitize identifier to safe characters for LangChain / models [a-zA-Z0-9_]
    const safePluginId = pluginId.replace(/[^a-zA-Z0-9_]/g, "_");
    const safeToolName = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
    const langChainToolName = `plugin_${safePluginId}_${safeToolName}`;

    const description = `[Plugin: ${pluginId}] ${record.description || def?.description || toolName}`;
    const schema = (def?.schema && typeof def.schema === "object" && "parseAsync" in def.schema)
      ? def.schema
      : z.record(z.string(), z.unknown()).describe("JSON parameters for this plugin tool");

    const t = tool(
      async (args: Record<string, unknown>) => {
        const grants = getGrantedPermissions(pluginId);
        const context: ToolExecutionContext = {
          pluginId,
          mode: options.mode,
          signal: options.signal,
          requestApproval: options.requestApproval,
        };
        const result = await executePluginTool(pluginId, toolName, args ?? {}, context, { granted: grants });
        if (result.ok) {
          if (typeof result.result === "string") return result.result;
          try {
            return JSON.stringify(result.result, null, 2);
          } catch {
            return String(result.result);
          }
        }
        return `[Plugin Tool Error (${result.code})]: ${result.error}`;
      },
      {
        name: langChainToolName,
        description,
        schema: schema as any,
      }
    );
    agentTools.push(t);
  }

  return agentTools;
}
