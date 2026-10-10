// Plugins-as-bundles: a plugin is a directory under .nexus/plugins/<name>/
// that may carry a manifest.json (metadata only), a skills/ folder, and a
// hooks.json. Nothing else is required — every subsystem (skills, hooks)
// picks plugins up automatically. Marketplace installs stage a complete
// bundle before atomically replacing a previous version.
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { getPluginRegistryConfig, savePluginRegistryConfig, type PluginRegistryEntry } from "./store.js";

export type PluginManifest = { id?: string; name?: string; description?: string; version?: string; author?: string; capabilities?: string[] };
export type PluginInfo = { name: string; dir: string; manifest: PluginManifest };
export type MarketplacePlugin = PluginRegistryEntry & { installed?: boolean; installedVersion?: string };

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

function safeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("A plugin needs a valid id or name.");
  return id;
}

function normalizeEntry(raw: unknown): PluginRegistryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PluginRegistryEntry>;
  if (typeof value.name !== "string" || typeof value.source !== "string" || !value.name.trim() || !value.source.trim()) return null;
  try {
    return { id: safeId(typeof value.id === "string" ? value.id : value.name), name: value.name.trim(), source: value.source.trim(), description: typeof value.description === "string" ? value.description : "", version: typeof value.version === "string" ? value.version : "", author: typeof value.author === "string" ? value.author : "", capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((x): x is string => typeof x === "string") : [] };
  } catch { return null; }
}

/** Reads the developer catalog and, optionally, a public registry JSON document.
 * The public document is intentionally plain JSON: { plugins: PluginRegistryEntry[] }. */
export async function listMarketplace(projectRoot?: string): Promise<MarketplacePlugin[]> {
  const config = await getPluginRegistryConfig();
  let remote: PluginRegistryEntry[] = [];
  if (config.registryUrl) {
    try {
      const response = await fetch(config.registryUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Registry returned ${response.status}`);
      const payload = await response.json() as { plugins?: unknown[] } | unknown[];
      const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.plugins) ? payload.plugins : [];
      remote = entries.map(normalizeEntry).filter((entry): entry is PluginRegistryEntry => Boolean(entry));
    } catch { /* The local catalog still makes Marketplace useful offline. */ }
  }
  const combined = new Map<string, PluginRegistryEntry>();
  for (const entry of [...remote, ...(config.developerCatalog || [])]) {
    const valid = normalizeEntry(entry);
    if (valid) combined.set(valid.id, valid);
  }
  const installed = projectRoot ? await discoverPlugins(projectRoot) : [];
  return [...combined.values()].map((entry) => {
    const match = installed.find((plugin) => {
      try { return safeId(plugin.manifest.id || plugin.name) === entry.id; }
      catch { return false; }
    });
    return { ...entry, installed: Boolean(match), installedVersion: match?.manifest.version };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Adds a local bundle to the developer catalog. Publish the generated registry
 * JSON from any static host later; no app server or account is required. */
export async function publishLocalPlugin(source: string): Promise<PluginRegistryEntry> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("Choose a plugin folder containing manifest.json.");
  let manifest: PluginManifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8")); }
  catch { throw new Error("The plugin folder must include a valid manifest.json."); }
  const entry = normalizeEntry({ id: manifest.id || manifest.name || path.basename(source), name: manifest.name || path.basename(source), description: manifest.description, version: manifest.version || "0.1.0", author: manifest.author, capabilities: manifest.capabilities, source: path.resolve(source) });
  if (!entry) throw new Error("The plugin manifest needs a name.");
  const config = await getPluginRegistryConfig();
  const catalog = (config.developerCatalog || []).filter((item) => item.id !== entry.id);
  catalog.push(entry);
  await savePluginRegistryConfig({ ...config, developerCatalog: catalog });
  return entry;
}

export async function removeMarketplacePlugin(id: string): Promise<void> {
  const config = await getPluginRegistryConfig();
  await savePluginRegistryConfig({ ...config, developerCatalog: (config.developerCatalog || []).filter((entry) => entry.id !== id) });
}

async function copyBundle(source: string, target: string) {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("Local plugin source is unavailable.");
  await fs.cp(source, target, { recursive: true, force: true, filter: (file) => !path.basename(file).startsWith(".") || path.basename(file) === ".nexusignore" });
}

async function extractZip(source: string, target: string) {
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Plugin download failed (${response.status}).`);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
  // A bundle may be rooted at manifest.json or wrapped in one folder.
  const wrapper = names.find((name) => /^([^/]+)\/manifest\.json$/i.test(name))?.split("/")[0];
  const hasRootManifest = names.some((name) => name === "manifest.json");
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const normalized = path.posix.normalize(name).replace(/^\/+/, "");
    if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("Plugin archive contains an unsafe path.");
    const parts = normalized.split("/");
    const relative = !hasRootManifest && wrapper && parts[0] === wrapper ? parts.slice(1) : parts;
    const output = path.join(target, ...relative);
    if (!path.resolve(output).startsWith(path.resolve(target) + path.sep)) throw new Error("Plugin archive escapes its destination.");
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, await file.async("nodebuffer"));
  }
}

export async function installMarketplacePlugin(projectRoot: string, entry: PluginRegistryEntry): Promise<PluginInfo> {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error("Invalid plugin listing.");
  const root = pluginsDir(projectRoot);
  const target = path.join(root, normalized.id);
  await fs.mkdir(root, { recursive: true });
  const staging = `${target}.installing-${Date.now().toString(36)}`;
  try {
    if (/^https:\/\//i.test(normalized.source)) await extractZip(normalized.source, staging);
    else await copyBundle(normalized.source, staging);
    if (!existsSync(path.join(staging, "manifest.json"))) throw new Error("Plugin bundle is missing manifest.json.");
    await fs.rm(target, { recursive: true, force: true });
    try {
      await fs.rename(staging, target);
    } catch (error: unknown) {
      // Windows can reject a directory rename in protected/synced locations
      // even after the destination is removed. The staged bundle has already
      // passed validation, so copying it is a safe compatibility fallback.
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : "";
      if (code !== "EPERM" && code !== "EXDEV") throw error;
      await fs.cp(staging, target, { recursive: true, force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const installed = (await discoverPlugins(projectRoot)).find((plugin) => plugin.dir === target);
  if (!installed) throw new Error("Plugin installed but could not be discovered.");
  return installed;
}

export async function uninstallPlugin(projectRoot: string, id: string): Promise<void> {
  const target = path.join(pluginsDir(projectRoot), safeId(id));
  if (!path.resolve(target).startsWith(path.resolve(pluginsDir(projectRoot)) + path.sep)) throw new Error("Invalid plugin id.");
  await fs.rm(target, { recursive: true, force: true });
}
