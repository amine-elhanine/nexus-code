// Central capability registry: tools, commands, providers, UI contributions.
// Agent runtime consumes capabilities through here instead of scattered
// hardcoded lists. Built-in and plugin contributions share the invocation
// pipeline shape, but privileged internals stay protected: registration is
// metadata + validated handlers, and execution always passes the permission
// + approval boundary in tool-executor.ts.
//
// Guarantees:
// - Namespaced unique ids (`pluginId:name` or `builtin:name`).
// - Duplicate registration is rejected (never silent overwrite).
// - Mode restrictions enforced at query time.
// - Unregister removes everything owned by a plugin (no stale entries).
// - Diagnostics for marketplace/management UI.

import type { PluginMode, PluginPermission } from "./plugin-manifest.js";

export type CapabilityKind = "tool" | "command" | "provider" | "ui" | "service";

export type CapabilityRecord<T = unknown> = {
  /** Fully qualified id, e.g. "builtin:web_search" or "my-plugin:greet". */
  id: string;
  kind: CapabilityKind;
  /** Owning plugin id, or "builtin". */
  owner: string;
  name: string;
  description: string;
  /** [] / omitted = all modes. */
  modes: PluginMode[];
  permissions: PluginPermission[];
  /** Opaque capability payload (schema, handler refs, metadata). */
  data: T;
  registeredAt: string;
};

export type RegistrationError =
  | { code: "duplicate"; message: string }
  | { code: "invalid-id"; message: string }
  | { code: "invalid-mode"; message: string }
  | { code: "invalid-permission"; message: string };

const VALID_ID = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;
const VALID_MODES: readonly string[] = ["home", "code", "notebook"];

const records = new Map<string, CapabilityRecord>();

function normalizeId(owner: string, name: string): string {
  return `${owner}:${name}`;
}

export function qualifyingId(owner: string, name: string): string {
  return normalizeId(owner, name);
}

export function registerCapability<T>(input: {
  owner: string;
  name: string;
  kind: CapabilityKind;
  description: string;
  modes?: PluginMode[];
  permissions?: PluginPermission[];
  data?: T;
}): { ok: true; id: string } | { ok: false; error: RegistrationError } {
  const owner = String(input.owner || "").trim();
  const name = String(input.name || "").trim();
  if (!owner || !name) {
    return { ok: false, error: { code: "invalid-id", message: "owner and name must not be empty" } };
  }
  const id = normalizeId(owner, name);
  if (!VALID_ID.test(id)) {
    return { ok: false, error: { code: "invalid-id", message: `invalid capability id "${id}" (expected owner:name with [a-z0-9._-])` } };
  }
  if (records.has(id)) {
    const existing = records.get(id);
    return { ok: false, error: { code: "duplicate", message: `capability "${id}" already registered by "${existing?.owner}"` } };
  }
  const modes = input.modes ?? [];
  for (const mode of modes) {
    if (!VALID_MODES.includes(mode)) {
      // NEVER broaden on invalid input: reject instead of falling back to all.
      return { ok: false, error: { code: "invalid-mode", message: `unknown mode "${mode}" for capability "${id}"` } };
    }
  }
  const record: CapabilityRecord = {
    id,
    kind: input.kind,
    owner,
    name,
    description: String(input.description || "").slice(0, 500),
    modes: [...new Set(modes)],
    permissions: [...new Set(input.permissions ?? [])],
    data: input.data,
    registeredAt: new Date().toISOString(),
  };
  records.set(id, record);
  return { ok: true, id };
}

export function unregisterCapability(id: string): boolean {
  return records.delete(id);
}

/** Remove everything owned by `owner`. Returns removed ids. */
export function unregisterOwnerCapabilities(owner: string): string[] {
  const removed: string[] = [];
  for (const [id, record] of records) {
    if (record.owner === owner) {
      records.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

export function getCapability(id: string): CapabilityRecord | undefined {
  return records.get(id);
}

export function capabilityAppliesToMode(record: Pick<CapabilityRecord, "modes">, mode: PluginMode): boolean {
  if (!record.modes || record.modes.length === 0) return true;
  return (record.modes as readonly string[]).includes(mode);
}

export function listCapabilities(filter?: { kind?: CapabilityKind; mode?: PluginMode; owner?: string }): CapabilityRecord[] {
  let all = [...records.values()];
  if (filter?.kind) all = all.filter((r) => r.kind === filter.kind);
  if (filter?.owner) all = all.filter((r) => r.owner === filter.owner);
  if (filter?.mode) all = all.filter((r) => capabilityAppliesToMode(r, filter.mode!));
  return all.sort((a, b) => a.id.localeCompare(b.id));
}

export function capabilityDiagnostics(): { total: number; byKind: Record<string, number>; byOwner: Record<string, number> } {
  const byKind: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  for (const record of records.values()) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    byOwner[record.owner] = (byOwner[record.owner] ?? 0) + 1;
  }
  return { total: records.size, byKind, byOwner };
}

/** Test/maintenance helper. */
export function clearAllCapabilities(): void {
  records.clear();
}
