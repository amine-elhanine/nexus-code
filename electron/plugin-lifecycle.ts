// Predictable plugin lifecycle for executable (SDK) plugins.
//
//   Discover → Validate → Resolve deps → Verify compat → Permissions →
//   Approval → Initialize (sandboxed) → Register → Enable → Execute →
//   Disable → Unregister → Dispose
//
// Declarative bundles (skills/agents/commands/rules/hooks.json) keep their
// existing filesystem-discovery path in plugins-service.ts — this manager
// handles the NEW executable surface (manifest v2 + entry) and tracks state
// so disable/uninstall ALWAYS cleans up (tools, commands, providers,
// listeners, permissions, UI contributions).
//
// State is in-memory + persisted enable/disable flags via the caller (store).
// Registration is reversible and deterministic; failures never leave stale
// capabilities behind.

import { z } from "zod";
import {
  validatePluginManifest,
  isAppVersionCompatible,
  manifestAppliesToMode,
  type ValidatedPluginManifest,
  type PluginMode,
  type PluginPermission,
} from "./plugin-manifest.js";
import { registerCapability, unregisterOwnerCapabilities, listCapabilities } from "./capability-registry.js";
import { setGrantedPermissions, clearGrantedPermissions, getGrantedPermissions } from "./plugin-permissions.js";
import { onPluginEvent, removePluginListeners, emitPluginEvent } from "./plugin-events.js";
import { registerProvider, unregisterOwnerProviders } from "./provider-registry.js";
import { startPluginProcess, stopPluginProcess, stopAllPluginProcesses, getPluginProcess } from "./plugin-process-host.js";
import type { PluginToolDefinition } from "./tool-executor.js";

export type PluginStatus =
  | "discovered"
  | "validated"
  | "disabled"
  | "enabled"
  | "failed";

export type ManagedPlugin = {
  id: string;
  dir: string;
  manifest: ValidatedPluginManifest;
  status: PluginStatus;
  error?: string;
  capabilities: string[];
  enabledAt?: string;
};

const managed = new Map<string, ManagedPlugin>();
const enabledFlags = new Map<string, boolean>(); // persisted by caller when available

const toolDefSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  description: z.string().trim().min(1).max(500),
  modes: z.array(z.enum(["home", "code", "notebook"])).max(3).optional(),
  permissions: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
  requiresApproval: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

const commandDefSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  description: z.string().trim().min(1).max(500),
  modes: z.array(z.enum(["home", "code", "notebook"])).max(3).optional(),
});

const contextProviderDefSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  description: z.string().trim().max(500).optional(),
  modes: z.array(z.enum(["home", "code", "notebook"])).max(3).optional(),
  hasHandler: z.boolean().optional(),
});

function pluginIdFrom(manifest: ValidatedPluginManifest): string {
  return manifest.id.toLowerCase();
}

export function getManagedPlugin(id: string): ManagedPlugin | undefined {
  return managed.get(id.toLowerCase());
}

export function listManagedPlugins(): ManagedPlugin[] {
  return [...managed.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function isPluginEnabled(id: string): boolean {
  return enabledFlags.get(id.toLowerCase()) ?? false;
}

export function setPluginEnabledFlag(id: string, enabled: boolean): void {
  enabledFlags.set(id.toLowerCase(), enabled);
}

/** Validate raw manifest JSON without touching the filesystem. */
export function validateManifestOnly(raw: unknown): ReturnType<typeof validatePluginManifest> {
  return validatePluginManifest(raw);
}

/**
 * Discover step: read + strictly validate manifest.json in `dir`.
 * Returns the managed record in `discovered` state (or `failed`).
 * Does NOT execute code or register capabilities.
 */
export async function discoverExecutablePlugin(
  dir: string,
  readFile: (file: string) => Promise<string> = defaultReadFile
): Promise<ManagedPlugin> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(`${dir}/manifest.json`));
  } catch (error) {
    const failed: ManagedPlugin = {
      id: dir.split(/[/\\]/).pop()?.toLowerCase() ?? dir,
      dir,
      manifest: undefined as never,
      status: "failed",
      error: `manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
      capabilities: [],
    };
    managed.set(failed.id, failed);
    return failed;
  }
  const validated = validatePluginManifest(raw);
  if (!validated.ok) {
    const fallbackId = typeof (raw as { id?: unknown }).id === "string" && ((raw as { id: string }).id.trim())
      ? (raw as { id: string }).id.trim().toLowerCase()
      : dir.split(/[/\\]/).pop()?.toLowerCase() ?? dir;
    const failed: ManagedPlugin = {
      id: fallbackId,
      dir,
      manifest: undefined as never,
      status: "failed",
      error: validated.errors.map((e) => `${e.field || "manifest"}: ${e.message}`).join("; "),
      capabilities: [],
    };
    managed.set(failed.id, failed);
    return failed;
  }
  const id = pluginIdFrom(validated.manifest);
  // Duplicate detection: same id from a different dir is a conflict.
  const existing = managed.get(id);
  if (existing && existing.dir !== dir) {
    const failed: ManagedPlugin = {
      id,
      dir,
      manifest: validated.manifest,
      status: "failed",
      error: `duplicate plugin id "${id}" already managed from ${existing.dir}`,
      capabilities: [],
    };
    return failed;
  }
  const record: ManagedPlugin = { id, dir, manifest: validated.manifest, status: "discovered", capabilities: [] };
  managed.set(id, record);
  return record;
}

/**
 * Enable step (requires prior user approval of permissions — the caller shows
 * the prompt and passes `approvedPermissions`, which must COVER the manifest
 * request; fewer is allowed only as an explicit downgrade the plugin accepts).
 *
 * - verifies app/API compat + dependencies present,
 * - sandboxes the entry (when present) and registers declared tools/commands,
 * - registers providers/services/ui as metadata (execution stays gated),
 * - sets grants + enabled flag.
 * On ANY failure, all partial registrations are rolled back.
 */
export async function enablePlugin(options: {
  id: string;
  appVersion: string;
  approvedPermissions: PluginPermission[];
  availablePluginIds?: string[];
  approvalForSensitiveTools?: boolean;
}): Promise<{ ok: true; plugin: ManagedPlugin } | { ok: false; error: string }> {
  const { id, appVersion, approvedPermissions } = options;
  const record = managed.get(id.toLowerCase());
  if (!record || !record.manifest) {
    return { ok: false, error: `plugin "${id}" is not discovered (validate manifest first)` };
  }
  const manifest = record.manifest;
  const rollback: Array<() => void> = [];
  try {
    // Compat.
    if (!isAppVersionCompatible(manifest.minAppVersion, appVersion)) {
      throw new Error(`requires app >= ${manifest.minAppVersion} (running ${appVersion})`);
    }
    // Deps.
    const available = new Set((options.availablePluginIds ?? [...managed.keys()]).map((s) => s.toLowerCase()));
    for (const dep of Object.keys(manifest.dependencies)) {
      if (!available.has(dep.toLowerCase())) throw new Error(`missing dependency "${dep}"`);
    }
    // Permissions must cover the manifest request (downgrade allowed only if
    // the plugin needs nothing more — executable tools re-check at call time).
    const missing = manifest.permissions.filter((p) => !approvedPermissions.includes(p));
    if (missing.length > 0) {
      throw new Error(`permissions not approved: ${missing.join(", ")}`);
    }
    setGrantedPermissions(record.id, approvedPermissions);
    rollback.push(() => clearGrantedPermissions(record.id));

    // Initialize the entry out-of-process (when present). The main process
    // NEVER require()s plugin code: activation + tool calls run in
    // plugin-runner.cjs, reached only through narrow NDJSON-RPC.
    if (manifest.entry) {
      const { process: proc, activation } = await startPluginProcess(record.id, record.dir, manifest.entry).catch(
        (error: unknown) => {
          throw new Error(`entry failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      );
      void proc;
      rollback.push(() => {
        void stopPluginProcess(record.id).catch(() => undefined);
      });
      for (const tool of activation.tools) {
        const parsed = toolDefSchema.safeParse({
          name: tool.name,
          description: tool.description,
          modes: tool.modes,
          permissions: tool.permissions,
          requiresApproval: tool.requiresApproval,
          timeoutMs: tool.timeoutMs,
        });
        if (!parsed.success) {
          throw new Error(`invalid registerTool: ${parsed.error.issues[0]?.message ?? "schema error"}`);
        }
        const def = parsed.data;
        // Plugin tool permissions must be a subset of approved grants.
        const toolPerms = (def.permissions ?? []).filter((p): p is PluginPermission => true) as PluginPermission[];
        const unknownPerm = toolPerms.find((p) => !approvedPermissions.includes(p));
        if (unknownPerm) throw new Error(`tool "${def.name}" requests unapproved permission "${unknownPerm}"`);
        const hasHandler = tool.hasHandler === true;
        const toolTimeout = def.timeoutMs;
        const registered = registerCapability<Partial<PluginToolDefinition>>({
          owner: record.id,
          name: def.name,
          kind: "tool",
          description: def.description,
          modes: (def.modes ?? manifest.modes ?? []) as PluginMode[],
          permissions: toolPerms,
          data: {
            name: def.name,
            description: def.description,
            // Runner entries declare no arg schema in v1: accept any plain
            // object; the handler validates its own inputs. The executor
            // still rejects non-object args (see tool-executor fallback).
            schema: z.object({}).passthrough() as never,
            modes: (def.modes ?? manifest.modes ?? []) as PluginMode[],
            permissions: toolPerms,
            requiresApproval: def.requiresApproval ?? true,
            timeoutMs: toolTimeout,
            handler: hasHandler
              ? async (args: Record<string, unknown>, context: { mode: string; signal?: AbortSignal }) => {
                  const live = getPluginProcess(record.id);
                  if (!live) throw new Error(`Plugin "${record.id}" is not running.`);
                  return live.callTool(def.name, args, context.mode, toolTimeout) as Promise<unknown>;
                }
              : async () => {
                  throw new Error(`Tool "${def.name}" from "${record.id}" declares no executable handler.`);
                },
          } as Partial<PluginToolDefinition> as never,
        });
        if (!registered.ok) throw new Error(registered.error.message);
        rollback.push(() => unregisterOwnerCapabilities(record.id));
      }
      for (const command of activation.commands) {
        const parsed = commandDefSchema.safeParse(command);
        if (!parsed.success) {
          throw new Error(`invalid registerCommand: ${parsed.error.issues[0]?.message ?? "schema error"}`);
        }
        const def = parsed.data;
        const registered = registerCapability({
          owner: record.id,
          name: def.name,
          kind: "command",
          description: def.description,
          modes: (def.modes ?? manifest.modes ?? []) as PluginMode[],
          data: { ...def },
        });
        if (!registered.ok) throw new Error(registered.error.message);
      }
      for (const sub of activation.subscriptions) {
        const eventName = String(sub?.event ?? "").trim();
        if (!eventName) continue;
        registerCapability({
          owner: record.id,
          name: `event-${eventName}`,
          kind: "service",
          description: `Event subscription: ${eventName}`,
          modes: (manifest.modes ?? []) as PluginMode[],
          data: sub,
        });
        // Live cross-process event integration: wire out-of-process runner to plugin event bus
        const unreg = onPluginEvent(eventName as any, record.id, async (payload) => {
          const live = getPluginProcess(record.id);
          if (!live || !live.alive) return { verdict: "abstain" as const };
          try {
            const res = await live.callEvent(eventName, payload as Record<string, unknown>, 5000);
            const verdict = res.verdict === "deny" ? "deny" : res.verdict === "allow" ? "allow" : "abstain";
            return { verdict, reason: res.reason };
          } catch {
            return { verdict: "abstain" as const };
          }
        });
        rollback.push(unreg);
      }
      for (const cp of activation.contextProviders ?? []) {
        const parsed = contextProviderDefSchema.safeParse(cp);
        if (!parsed.success) {
          throw new Error(`invalid registerContextProvider: ${parsed.error.issues[0]?.message ?? "schema error"}`);
        }
        const def = parsed.data;
        const registered = registerCapability({
          owner: record.id,
          name: `context-provider-${def.name}`,
          kind: "service",
          description: def.description || `Context provider: ${def.name}`,
          modes: (def.modes ?? manifest.modes ?? []) as PluginMode[],
          data: { type: "context-provider", ...def },
        });
        if (!registered.ok) throw new Error(registered.error.message);
      }
    }

    // Declarative executable metadata (providers/services/ui) — always gated.
    if (manifest.capabilities.includes("providers" as never)) {
      registerCapability({
        owner: record.id,
        name: "providers",
        kind: "provider",
        description: `Provider contributions from ${record.id}`,
        modes: (manifest.modes ?? []) as PluginMode[],
        permissions: ["providers.register" as PluginPermission],
        data: { note: "use provider-registry.registerProvider with approved permission" },
      });
    }
    for (const ui of manifest.ui) {
      const registered = registerCapability({
        owner: record.id,
        name: `ui-${ui.slot}-${ui.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        kind: "ui",
        description: ui.title,
        modes: (manifest.modes ?? []) as PluginMode[],
        permissions: ["ui.contribute" as PluginPermission],
        data: ui,
      });
      if (!registered.ok) throw new Error(registered.error.message);
    }

    record.status = "enabled";
    record.enabledAt = new Date().toISOString();
    record.capabilities = listCapabilities({ owner: record.id }).map((c) => c.id);
    record.error = undefined;
    setPluginEnabledFlag(record.id, true);
    await emitPluginEvent("plugin:activated", { pluginId: record.id }).catch(() => undefined);
    return { ok: true, plugin: record };
  } catch (error) {
    // Deterministic rollback: kill the child process + remove everything
    // this enable added. No orphaned processes, no stale registrations.
    await stopPluginProcess(record.id).catch(() => undefined);
    unregisterOwnerCapabilities(record.id);
    unregisterOwnerProviders(record.id);
    removePluginListeners(record.id);
    clearGrantedPermissions(record.id);
    for (const undo of rollback.reverse()) {
      try {
        undo();
      } catch { /* best effort */ }
    }
    unregisterOwnerCapabilities(record.id);
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.capabilities = [];
    setPluginEnabledFlag(record.id, false);
    return { ok: false, error: record.error };
  }
}

/** Disable: stop the runner process, unregister contributions, listeners,
 *  providers; grant record cleared; flag off. Deterministic cleanup — no
 *  stale registrations and no orphaned child processes. */
export async function disablePlugin(id: string): Promise<{ ok: boolean; removed: string[] }> {
  const record = managed.get(id.toLowerCase());
  const removed: string[] = [];
  await stopPluginProcess(id.toLowerCase()).catch(() => undefined);
  removed.push(...unregisterOwnerCapabilities(id.toLowerCase()));
  removed.push(...unregisterOwnerProviders(id.toLowerCase()));
  const listeners = removePluginListeners(id.toLowerCase());
  void listeners;
  clearGrantedPermissions(id.toLowerCase());
  setPluginEnabledFlag(id.toLowerCase(), false);
  if (record) {
    record.status = "disabled";
    record.capabilities = [];
    record.error = undefined;
    await emitPluginEvent("plugin:deactivated", { pluginId: record.id }).catch(() => undefined);
  }
  // Remove the no-op provider-metadata capability too if present.
  return { ok: true, removed };
}

/** Full removal from the manager (after uninstall deletes files). */
export async function disposePlugin(id: string): Promise<void> {
  await disablePlugin(id);
  managed.delete(id.toLowerCase());
}

/** Mode-scoped query helper for the agent runtime. */
export function pluginAppliesToModeStrict(manifest: ValidatedPluginManifest, mode: PluginMode): boolean {
  return manifestAppliesToMode(manifest, mode);
}

/** Test helper: reset manager state. Stops any running plugin processes. */
export function clearManagedPlugins(): void {
  managed.clear();
  enabledFlags.clear();
  // Fire-and-forget: tests that need the kill completed await
  // stopAllPluginProcesses() from plugin-process-host.js explicitly.
  void stopAllPluginProcesses().catch(() => undefined);
}

async function defaultReadFile(file: string): Promise<string> {
  const { promises: fs } = await import("node:fs");
  // `dir/manifest.json` joined by caller with forward slash; normalize here.
  return fs.readFile(file.replace(/[/\\]+/g, "/").replace(/^\.\//, ""), "utf8").catch(async () => {
    // Fall back to path resolution for absolute dirs.
    const path = await import("node:path");
    return fs.readFile(path.resolve(file), "utf8");
  });
}

// Re-export so agent wiring can subscribe without importing internals.
export { onPluginEvent };

/**
 * Queries enabled out-of-process plugins for dynamic prompt context (Pi-style context injection).
 * Safe, isolated, and bounded by timeout so plugins never hang the agent loop.
 */
export async function collectDynamicPluginContext(context: {
  mode: PluginMode;
  projectRoot?: string;
}): Promise<string> {
  const sections: string[] = [];
  const caps = listCapabilities({ kind: "service", mode: context.mode });
  const contextCaps = caps.filter((c) => (c.data as Record<string, unknown> | undefined)?.type === "context-provider");

  for (const cap of contextCaps) {
    const pluginId = cap.owner;
    const cpData = cap.data as { name: string };
    const live = getPluginProcess(pluginId);
    if (!live || !live.alive) continue;
    try {
      const text = await live.callContextProvider(cpData.name, context, 3000);
      if (text && text.trim()) {
        sections.push(`### Plugin Context (${pluginId}/${cpData.name}):\n${text.trim()}`);
      }
    } catch {
      // Best effort: context providers never fail or block agent runs
    }
  }
  return sections.join("\n\n");
}
