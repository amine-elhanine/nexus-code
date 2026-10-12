// Least-privilege permission model for executable plugins.
//
// The host enforces permissions independently of plugin claims: a plugin
// declares `permissions` in its manifest, the user approves them at
// enable/install time, and every privileged operation checks
// `requirePermission()` before running. A plugin can NEVER grant itself
// more at runtime — grants only shrink (downgrade) after approval.

import { KNOWN_PERMISSIONS, type PluginPermission } from "./plugin-manifest.js";

export type PermissionGrant = {
  pluginId: string;
  granted: PluginPermission[];
  grantedAt: string;
};

const grants = new Map<string, Set<PluginPermission>>();

export function knownPermissions(): readonly PluginPermission[] {
  return KNOWN_PERMISSIONS;
}

export function isKnownPermission(value: string): value is PluginPermission {
  return (KNOWN_PERMISSIONS as readonly string[]).includes(value);
}

/** Record the exact set the user approved. Replaces any previous grant. */
export function setGrantedPermissions(pluginId: string, permissions: PluginPermission[]): void {
  grants.set(pluginId, new Set(permissions.filter(isKnownPermission)));
}

/** Remove all grants (uninstall / reset). */
export function clearGrantedPermissions(pluginId: string): void {
  grants.delete(pluginId);
}

export function getGrantedPermissions(pluginId: string): PluginPermission[] {
  return [...(grants.get(pluginId) ?? [])];
}

/** True only if EVERY requested permission was granted. Deny-by-default:
 *  unknown plugin or empty grant => false for any non-empty request. */
export function hasPermissions(pluginId: string, required: readonly PluginPermission[]): boolean {
  if (required.length === 0) return true;
  const granted = grants.get(pluginId);
  if (!granted) return false;
  return required.every((p) => granted.has(p));
}

/** Throws when the plugin lacks a permission. Call at every privileged
 *  boundary (tool execution, fs/shell/network, provider registration). */
export function requirePermission(pluginId: string, permission: PluginPermission): void {
  if (!hasPermissions(pluginId, [permission])) {
    throw new Error(`Plugin "${pluginId}" lacks required permission "${permission}".`);
  }
}

/** Downgrade-only update: new set must be a subset of the approved set.
 *  Returns false (and changes nothing) when escalation is attempted. */
export function tryDowngradePermissions(pluginId: string, next: PluginPermission[]): boolean {
  const current = grants.get(pluginId);
  if (!current) return false;
  if (!next.every((p) => current.has(p))) return false;
  grants.set(pluginId, new Set(next));
  return true;
}

/** Permissions that trigger an explicit user prompt (high impact). */
const SENSITIVE: readonly PluginPermission[] = [
  "fs.write",
  "workspace.write",
  "shell.execute",
  "network.fetch",
  "background.execute",
  "providers.register",
];

export function sensitivePermissions(requested: readonly PluginPermission[]): PluginPermission[] {
  return requested.filter((p) => (SENSITIVE as readonly string[]).includes(p));
}

/** Human-readable summary for the install/enable prompt. */
export function describePermissions(requested: readonly PluginPermission[]): string {
  if (requested.length === 0) return "No special permissions (declarative content only).";
  return requested.map((p) => `- ${p}`).join("\n");
}
