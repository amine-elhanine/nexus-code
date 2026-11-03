// Plugin Marketplace + executable plugin capability IPC routes.
// Bundles are installed globally into userData/plugins so skills, rules,
// subagents, and commands are available across all modes. Payloads are
// validated here; the renderer is never trusted for permissions.

import { ipcMain, dialog, app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { getPluginRegistryConfig, savePluginRegistryConfig } from "../store.js";
import { discoverPlugins, globalPluginsDir, installMarketplacePlugin, listMarketplace, publishLocalPlugin, removeMarketplacePlugin, uninstallPluginAnywhere } from "../plugins-service.js";
import { validatePluginManifest } from "../plugin-manifest.js";
import { listCapabilities } from "../capability-registry.js";
import { getGrantedPermissions } from "../plugin-permissions.js";
import { discoverExecutablePlugin, enablePlugin, disablePlugin, listManagedPlugins, disposePlugin } from "../plugin-lifecycle.js";
import { readPluginUiHtml, validateUiRequest } from "../plugin-ui.js";
import { executePluginTool } from "../tool-executor.js";
import type { MainIpcContext } from "./context.js";

export function registerPluginRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("plugins:marketplace:list", () => listMarketplace(ctx.active().projectRoot || undefined));
  ipcMain.handle("plugins:installed:list", () => discoverPlugins(ctx.active().projectRoot || undefined));
  ipcMain.handle("plugins:registry:get", () => getPluginRegistryConfig());
  ipcMain.handle("plugins:registry:save", (_event, config) => savePluginRegistryConfig(config));
  ipcMain.handle("plugins:developer:pick-and-publish", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return publishLocalPlugin(result.filePaths[0]);
  });
  // Dev root folder: every subfolder with a manifest.json is listed
  // automatically (no per-plugin pick). Returns the folder or null.
  ipcMain.handle("plugins:devroot:pick", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("plugins:developer:remove", async (_event, id: string) => {
    await removeMarketplacePlugin(id);
    // Removing a dev entry must not orphan its installed bundle
    await uninstallPluginAnywhere(id, ctx.active().projectRoot || undefined).catch(() => undefined);
    ctx.window()?.webContents.send("skills:changed");
  });
  // Marketplace bundles install globally (userData/plugins) so their skills,
  // rules, subagents and commands are available in every mode — not just in
  // whichever project happens to be open.
  ipcMain.handle("plugins:install", async (_event, entry) => {
    const res = await installMarketplacePlugin(globalPluginsDir(), entry, { isTargetDir: true });
    ctx.window()?.webContents.send("skills:changed");
    return res;
  });
  ipcMain.handle("plugins:uninstall", async (_event, id: string) => {
    // Deterministic cleanup: dispose executable state BEFORE deleting files
    // so tools/listeners/providers cannot survive uninstall.
    await disposePlugin(String(id)).catch(() => undefined);
    await uninstallPluginAnywhere(id, ctx.active().projectRoot || undefined);
    ctx.window()?.webContents.send("skills:changed");
  });
  // v1 executable plugin platform: validation, lifecycle, capability listing.
  ipcMain.handle("plugins:validate-manifest", async (_event, raw: unknown) => validatePluginManifest(raw));
  ipcMain.handle("plugins:executable:status", async () => {
    return listManagedPlugins().map((p) => ({
      id: p.id,
      dir: p.dir,
      status: p.status,
      error: p.error,
      capabilities: p.capabilities,
      grantedPermissions: getGrantedPermissions(p.id),
      manifest: p.manifest ? {
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        apiVersion: p.manifest.apiVersion,
        description: p.manifest.description,
        capabilities: p.manifest.capabilities,
        modes: p.manifest.modes,
        modesImplicit: p.manifest.modesImplicit,
        permissions: p.manifest.permissions,
        ui: p.manifest.ui,
      } : undefined,
    }));
  });
  ipcMain.handle("plugins:enable", async (_event, id: string, approvedPermissions: unknown) => {
    const pluginId = String(id || "").trim();
    if (!pluginId) throw new Error("Plugin id is required.");
    const approved = Array.isArray(approvedPermissions) ? approvedPermissions.filter((p): p is string => typeof p === "string") : [];
    // Discover from the installed bundle dir when not yet managed.
    const dir = path.join(globalPluginsDir(), pluginId);
    let record = listManagedPlugins().find((p) => p.id === pluginId.toLowerCase());
    if (!record) {
      record = await discoverExecutablePlugin(dir);
    }
    if (!record.manifest) throw new Error(record.error || "Plugin manifest invalid.");
    const result = await enablePlugin({
      id: pluginId,
      appVersion: app.getVersion(),
      approvedPermissions: approved as never,
    });
    if (!result.ok) throw new Error(result.error);
    return { id: result.plugin.id, status: result.plugin.status, capabilities: result.plugin.capabilities };
  });
  ipcMain.handle("plugins:disable", async (_event, id: string) => {
    const pluginId = String(id || "").trim();
    if (!pluginId) throw new Error("Plugin id is required.");
    return disablePlugin(pluginId);
  });
  // Plugin UI bridge: serve a DECLARED ui[].entry file as text (the renderer
  // mounts it in a sandboxed iframe), and execute a plugin tool through the
  // gated boundary. Both validate every field; the renderer is never trusted
  // for paths, permissions, or modes.
  ipcMain.handle("plugins:read-ui", async (_event, input: unknown) => {
    const validated = validateUiRequest(input);
    if (!validated.ok) throw new Error(validated.error);
    const { pluginId, entry } = validated.request;
    const dir = path.join(globalPluginsDir(), pluginId);
    if (!existsSync(dir)) throw new Error(`Plugin "${pluginId}" is not installed.`);
    let record = listManagedPlugins().find((p) => p.id === pluginId);
    if (!record) record = await discoverExecutablePlugin(dir);
    if (!record.manifest) throw new Error(record.error || "Plugin manifest invalid.");
    return readPluginUiHtml(dir, record.manifest, entry);
  });
  ipcMain.handle("plugins:call-tool", async (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool call must be an object.");
    const { pluginId, tool, args, mode } = input as { pluginId?: unknown; tool?: unknown; args?: unknown; mode?: unknown };
    if (typeof pluginId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId.trim())) throw new Error("Invalid plugin id.");
    if (typeof tool !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(tool.trim()) || tool.trim().length > 64) {
      throw new Error("Invalid tool name.");
    }
    const validModes = ["home", "code", "notebook"];
    if (typeof mode !== "string" || !validModes.includes(mode)) throw new Error("Invalid mode.");
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      throw new Error("Tool args must be an object.");
    }
    const id = pluginId.trim().toLowerCase();
    const grants = getGrantedPermissions(id);
    // No approval channel on this path: tools that require per-call approval
    // are denied by default inside executePluginTool (no silent execution).
    const result = await executePluginTool(
      id,
      tool.trim(),
      args ?? {},
      { pluginId: id, mode: mode as "home" | "code" | "notebook" },
      { granted: grants }
    );
    return result;
  });
  ipcMain.handle("capabilities:list", async (_event, filter: unknown) => {
    const f = (filter && typeof filter === "object" ? filter : {}) as { kind?: string; mode?: string };
    const allowedKinds = ["tool", "command", "provider", "ui", "service"];
    const kind = typeof f.kind === "string" && allowedKinds.includes(f.kind) ? f.kind as never : undefined;
    const allowedModes = ["home", "code", "notebook"];
    const mode = typeof f.mode === "string" && allowedModes.includes(f.mode) ? f.mode as never : undefined;
    // Strip handler payloads (may contain functions) — metadata only.
    return listCapabilities({ kind, mode }).map((c) => ({
      id: c.id,
      kind: c.kind,
      owner: c.owner,
      name: c.name,
      description: c.description,
      modes: c.modes,
      permissions: c.permissions,
      registeredAt: c.registeredAt,
    }));
  });
}
