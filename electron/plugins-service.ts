// Plugins-as-bundles: a plugin is a directory under .nexus/plugins/<name>/
// that may carry a manifest.json (metadata only), a skills/ folder, and a
// hooks.json. Nothing else is required — every subsystem (skills, hooks)
// picks plugins up automatically, and malformed plugins are skipped, never
// fatal. Local installs only; no marketplace.
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export type PluginManifest = { name?: string; description?: string; version?: string };
export type PluginInfo = { name: string; dir: string; manifest: PluginManifest };

export function pluginsDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".nexus", "plugins");
}

/** Lists installed plugins. Tolerant: unreadable or malformed entries are
 *  skipped with the directory name as the fallback plugin name. */
export async function discoverPlugins(projectRoot: string): Promise<PluginInfo[]> {
  const root = pluginsDir(projectRoot);
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const plugins: PluginInfo[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    let manifest: PluginManifest = {};
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
      if (typeof manifest !== "object" || manifest === null) manifest = {};
    } catch { /* manifest optional */ }
    plugins.push({
      name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : entry.name,
      dir,
      manifest,
    });
  }
  return plugins;
}

/** Skill folders contributed by plugins (one per plugin, if present). */
export async function pluginSkillDirs(projectRoot: string): Promise<string[]> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => path.join(plugin.dir, "skills"))
    .filter((dir) => existsSync(dir));
}

/** hooks.json paths contributed by plugins (one per plugin, if present). */
export async function pluginHookFiles(projectRoot: string): Promise<string[]> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => path.join(plugin.dir, "hooks.json"))
    .filter((file) => existsSync(file));
}
