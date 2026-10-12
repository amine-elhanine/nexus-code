// Plugins-as-bundles: a plugin is a directory under .nexus/plugins/<name>/
// that may carry a manifest.json (metadata only), a skills/ folder, and a
// hooks.json. Nothing else is required — every subsystem (skills, hooks)
// picks plugins up automatically. Marketplace installs stage a complete
// bundle before atomically replacing a previous version.
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { getPluginRegistryConfig, savePluginRegistryConfig, type PluginRegistryEntry } from "./store.js";

export type PluginManifest = { id?: string; name?: string; description?: string; version?: string; author?: string; capabilities?: string[]; modes?: unknown };
export type PluginInfo = { name: string; dir: string; manifest: PluginManifest };
export type MarketplacePlugin = PluginRegistryEntry & { installed?: boolean; installedVersion?: string };

/** Agent modes a plugin may serve. [] / omitted = all modes. Mirrors
 * skills-service normalizeSkillModes but lives here so skills-service can
 * import it without a require cycle (skills-service → plugins-service). */
export type PluginMode = "home" | "code" | "notebook";
export const ALL_PLUGIN_MODES: PluginMode[] = ["home", "code", "notebook"];

export function normalizePluginModes(value: unknown): PluginMode[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const cleaned = parts
    .map((part) => String(part || "").trim().toLowerCase())
    .filter((part): part is PluginMode => (ALL_PLUGIN_MODES as string[]).includes(part));
  if (!cleaned.length) return [];
  if (cleaned.length >= ALL_PLUGIN_MODES.length) return [];
  return [...new Set(cleaned)];
}

export function pluginAppliesToMode(modes: unknown, mode: PluginMode): boolean {
  const normalized = Array.isArray(modes) ? (modes as PluginMode[]) : normalizePluginModes(modes);
  return normalized.length === 0 || normalized.includes(mode);
}

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
    const detectedCaps = detectPluginCapabilities(dir);
    const caps = Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0
      ? manifest.capabilities
      : detectedCaps;
    manifest = { ...manifest, capabilities: caps };
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
  return (await pluginSkillDirsWithModes(projectRoot)).map((entry) => entry.dir);
}

/** Skill folders with the owning plugin's default modes ([] = all modes).
 * A skill's own `modes:` frontmatter overrides this default (see skills-service). */
export async function pluginSkillDirsWithModes(projectRoot: string): Promise<Array<{ dir: string; modes: PluginMode[] }>> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => ({
      dir: path.join(plugin.dir, "skills"),
      modes: normalizePluginModes((plugin.manifest as { modes?: unknown })?.modes),
    }))
    .filter((entry) => existsSync(entry.dir));
}

/** Agent folders contributed by plugins (one per plugin, if present). */
export async function pluginAgentDirs(projectRoot: string): Promise<string[]> {
  return (await pluginAgentDirsWithModes(projectRoot)).map((entry) => entry.dir);
}

/** Agent folders with the owning plugin's default modes ([] = all modes). */
export async function pluginAgentDirsWithModes(projectRoot: string): Promise<Array<{ dir: string; modes: PluginMode[] }>> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => ({
      dir: path.join(plugin.dir, "agents"),
      modes: normalizePluginModes((plugin.manifest as { modes?: unknown })?.modes),
    }))
    .filter((entry) => existsSync(entry.dir));
}

/** Command folders contributed by plugins (one per plugin, if present). */
export async function pluginCommandDirs(projectRoot: string): Promise<string[]> {
  return (await pluginCommandDirsWithModes(projectRoot)).map((entry) => entry.dir);
}

/** Command folders with the owning plugin's default modes ([] = all modes). */
export async function pluginCommandDirsWithModes(projectRoot: string): Promise<Array<{ dir: string; modes: PluginMode[] }>> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => ({
      dir: path.join(plugin.dir, "commands"),
      modes: normalizePluginModes((plugin.manifest as { modes?: unknown })?.modes),
    }))
    .filter((entry) => existsSync(entry.dir));
}

/** Rule folders contributed by plugins (one per plugin, if present). */
export async function pluginRuleDirs(projectRoot: string): Promise<string[]> {
  return (await pluginRuleDirsWithModes(projectRoot)).map((entry) => entry.dir);
}

/** Rule folders with the owning plugin's default modes ([] = all modes). */
export async function pluginRuleDirsWithModes(projectRoot: string): Promise<Array<{ dir: string; modes: PluginMode[] }>> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => ({
      dir: path.join(plugin.dir, "rules"),
      modes: normalizePluginModes((plugin.manifest as { modes?: unknown })?.modes),
    }))
    .filter((entry) => existsSync(entry.dir));
}

/** hooks.json paths contributed by plugins (one per plugin, if present). */
export async function pluginHookFiles(projectRoot: string): Promise<string[]> {
  return (await pluginHookFilesWithModes(projectRoot)).map((entry) => entry.file);
}

/** Hook files with the owning plugin's default modes ([] = all modes). */
export async function pluginHookFilesWithModes(projectRoot: string): Promise<Array<{ file: string; modes: PluginMode[] }>> {
  const plugins = await discoverPlugins(projectRoot);
  return plugins
    .map((plugin) => ({
      file: path.join(plugin.dir, "hooks.json"),
      modes: normalizePluginModes((plugin.manifest as { modes?: unknown })?.modes),
    }))
    .filter((entry) => existsSync(entry.file));
}

export function detectPluginCapabilities(pluginDir: string): string[] {
  const caps: string[] = [];
  try {
    if (existsSync(path.join(pluginDir, "skills"))) caps.push("skills");
    if (existsSync(path.join(pluginDir, "agents"))) caps.push("agents");
    if (existsSync(path.join(pluginDir, "commands"))) caps.push("commands");
    if (existsSync(path.join(pluginDir, "rules"))) caps.push("rules");
    if (existsSync(path.join(pluginDir, "hooks.json"))) caps.push("hooks");
    const manifestPath = path.join(pluginDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      const contrib = raw && typeof raw === "object" && raw.contributes && typeof raw.contributes === "object" ? raw.contributes : null;
      if (contrib) {
        if (Array.isArray(contrib.tools) && contrib.tools.length > 0 && !caps.includes("tools")) caps.push("tools");
        if (Array.isArray(contrib.providers) && contrib.providers.length > 0 && !caps.includes("providers")) caps.push("providers");
        if (Array.isArray(contrib.commands) && contrib.commands.length > 0 && !caps.includes("commands")) caps.push("commands");
        if (Array.isArray(contrib.hooks) && contrib.hooks.length > 0 && !caps.includes("hooks")) caps.push("hooks");
        if (
          (Array.isArray(contrib.panels) && contrib.panels.length > 0) ||
          (Array.isArray(contrib.statusBar) && contrib.statusBar.length > 0) ||
          (Array.isArray(contrib.composerActions) && contrib.composerActions.length > 0)
        ) {
          if (!caps.includes("ui")) caps.push("ui");
        }
      }
    }
  } catch { /* ignore */ }
  return caps;
}

function safeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("A plugin needs a valid id or name.");
  return id;
}

function normalizeEntry(raw: unknown): PluginRegistryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PluginRegistryEntry> & { modes?: unknown };
  if (typeof value.name !== "string" || typeof value.source !== "string" || !value.name.trim() || !value.source.trim()) return null;
  try {
    return { id: safeId(typeof value.id === "string" ? value.id : value.name), name: value.name.trim(), source: value.source.trim(), description: typeof value.description === "string" ? value.description : "", version: typeof value.version === "string" ? value.version : "", author: typeof value.author === "string" ? value.author : "", capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((x): x is string => typeof x === "string") : [], modes: normalizePluginModes(value.modes) };
  } catch { return null; }
}

/** Reads the developer catalog and, optionally, a public registry JSON document.
 * The public document is intentionally plain JSON: { plugins: PluginRegistryEntry[] }.
 * When a dev root folder is configured, every subfolder containing a valid
 * manifest.json is listed automatically — no per-plugin registration. */
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
  const scanned = config.devRoot ? await scanPluginRoot(config.devRoot).catch(() => []) : [];
  const combined = new Map<string, PluginRegistryEntry>();
  // Later sources win on id clashes: explicit developer-catalog picks beat
  // auto-scanned folders, which beat the remote registry.
  for (const entry of [...remote, ...scanned, ...(config.developerCatalog || [])]) {
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

/** Builds a registry entry from a plugin folder on disk. Returns null when
 * the folder has no valid manifest.json — callers skip such folders. */
export async function entryFromFolder(dir: string): Promise<PluginRegistryEntry | null> {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null) return null;
  } catch { return null; }
  const detectedCaps = detectPluginCapabilities(dir);
  const capabilities = Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0
    ? manifest.capabilities
    : detectedCaps;
  return normalizeEntry({
    id: manifest.id || manifest.name || path.basename(dir),
    name: manifest.name || path.basename(dir),
    description: manifest.description,
    version: manifest.version || "0.1.0",
    author: manifest.author,
    capabilities,
    modes: manifest.modes,
    source: path.resolve(dir),
  });
}

/** Capability section folders of the shared/local plugin library layout:
 * plugins/skills/<skill>/, plugins/agents/<agent>/, plugins/examples/<example>/, … */
export const PLUGIN_SECTION_FOLDERS = ["skills", "agents", "commands", "rules", "hooks", "examples"];

/** Lists every plugin bundle found under a root folder.
 * Supports both layouts: classic bundles (plugins/<id>/ with a manifest) and
 * the sectioned library (plugins/<capability>/<item>/ with a manifest per
 * item). Folders without a valid manifest.json are skipped silently. Pure
 * function of the filesystem — no global state, so tests stay isolated. */
export async function scanPluginRoot(root: string): Promise<PluginRegistryEntry[]> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch { return []; }
  const entries: PluginRegistryEntry[] = [];
  for (const dirent of dirents) {
    const dir = path.join(root, dirent.name);
    const direct = await entryFromFolder(dir).catch(() => null);
    if (direct) {
      entries.push(direct);
      continue;
    }
    // Section folder (skills/, agents/, …): each subfolder is one plugin.
    if (PLUGIN_SECTION_FOLDERS.includes(dirent.name.toLowerCase())) {
      let items: import("node:fs").Dirent[];
      try {
        items = (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      } catch { continue; }
      for (const item of items) {
        const entry = await entryFromFolder(path.join(dir, item.name)).catch(() => null);
        if (entry) entries.push(entry);
      }
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Adds a local bundle to the developer catalog. Publish the generated registry
 * JSON from any static host later; no app server or account is required.
 * The manifest's `modes` (if any) is carried into the catalog entry. */
export async function publishLocalPlugin(source: string): Promise<PluginRegistryEntry> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("Choose a plugin folder containing manifest.json.");
  const entry = await entryFromFolder(source);
  if (!entry) throw new Error("The plugin folder must include a valid manifest.json with a name.");
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

export const MAX_PLUGIN_ARCHIVE_FILES = 500;
export const MAX_PLUGIN_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50MB expanded
export const MAX_PLUGIN_ARCHIVE_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25MB download

async function extractZip(source: string, target: string) {
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Plugin download failed (${response.status}).`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PLUGIN_ARCHIVE_DOWNLOAD_BYTES) {
    throw new Error(`Plugin archive too large (${contentLength} bytes, max ${MAX_PLUGIN_ARCHIVE_DOWNLOAD_BYTES}).`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PLUGIN_ARCHIVE_DOWNLOAD_BYTES) {
    throw new Error(`Plugin archive too large (${buffer.byteLength} bytes, max ${MAX_PLUGIN_ARCHIVE_DOWNLOAD_BYTES}).`);
  }
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
  if (names.length > MAX_PLUGIN_ARCHIVE_FILES) {
    throw new Error(`Plugin archive has too many files (${names.length}, max ${MAX_PLUGIN_ARCHIVE_FILES}).`);
  }
  // A bundle may be rooted at manifest.json or wrapped in one folder.
  const wrapper = names.find((name) => /^([^/]+)\/manifest\.json$/i.test(name))?.split("/")[0];
  const hasRootManifest = names.some((name) => name === "manifest.json");
  let expandedBytes = 0;
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const normalized = path.posix.normalize(name).replace(/^\/+/, "");
    if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("Plugin archive contains an unsafe path.");
    // Reject absolute Windows paths and drive letters smuggled into zip names.
    if (/^[a-zA-Z]:[\\/]/.test(name) || name.includes("\\\\")) throw new Error("Plugin archive contains an unsafe path.");
    const parts = normalized.split("/");
    if (parts.some((part) => part === "..")) throw new Error("Plugin archive contains an unsafe path.");
    const relative = !hasRootManifest && wrapper && parts[0] === wrapper ? parts.slice(1) : parts;
    if (relative.length === 0) throw new Error("Plugin archive contains an unsafe path.");
    const output = path.join(target, ...relative);
    if (!path.resolve(output).startsWith(path.resolve(target) + path.sep)) throw new Error("Plugin archive escapes its destination.");
    const data = await file.async("nodebuffer");
    expandedBytes += data.byteLength;
    if (expandedBytes > MAX_PLUGIN_ARCHIVE_BYTES) {
      throw new Error(`Plugin archive expands beyond ${MAX_PLUGIN_ARCHIVE_BYTES} bytes (zip bomb protection).`);
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, data);
  }
}

export async function installMarketplacePlugin(projectRoot: string, entry: PluginRegistryEntry): Promise<PluginInfo> {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error("Invalid plugin listing.");
  // Remote listings are untrusted JSON. Only https:// bundle URLs are
  // fetched — plain http:// is rejected to prevent downgrade attacks, and any
  // other URL scheme (file:, ftp:, data:, …) is rejected instead of falling
  // through to a local-filesystem copy with a confusing error.
  const isHttps = /^https:\/\//i.test(normalized.source);
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized.source);
  if (!isHttps) {
    if (/^http:\/\//i.test(normalized.source)) {
      throw new Error("Refusing insecure http:// plugin source. Use an https:// bundle URL.");
    }
    if (looksLikeUrl) {
      throw new Error("Unsupported plugin source. Use an https:// bundle URL or a developer-catalog folder.");
    }
  }
  const root = pluginsDir(projectRoot);
  const target = path.join(root, normalized.id);
  await fs.mkdir(root, { recursive: true });
  const staging = `${target}.installing-${Date.now().toString(36)}`;
  // Rollback-safe update: keep the last working install aside until the new
  // bundle is fully validated + swapped in. An interrupted update must never
  // destroy the previous version.
  const backup = `${target}.backup-${Date.now().toString(36)}`;
  const hadPrevious = existsSync(target);
  try {
    if (isHttps) await extractZip(normalized.source, staging);
    else await copyBundle(normalized.source, staging);
    if (!existsSync(path.join(staging, "manifest.json"))) throw new Error("Plugin bundle is missing manifest.json.");
    // The staged bundle must actually be the plugin that was requested —
    // otherwise any local directory could be installed under an arbitrary id.
    try {
      const staged = JSON.parse(await fs.readFile(path.join(staging, "manifest.json"), "utf8")) as PluginManifest;
      const stagedId = safeId(
        typeof staged?.id === "string" && staged.id.trim()
          ? staged.id
          : typeof staged?.name === "string" && staged.name.trim()
            ? staged.name
            : ""
      );
      if (stagedId !== normalized.id) {
        throw new Error(`Plugin bundle id "${stagedId}" does not match listing "${normalized.id}".`);
      }
      // Strict v2 check for executable plugins: entry/permissions/modes must
      // validate BEFORE the old install is touched. v1 declarative bundles
      // (no entry/apiVersion) keep the legacy tolerant path.
      const needsStrict = typeof (staged as { entry?: unknown }).entry === "string" || typeof (staged as { apiVersion?: unknown }).apiVersion === "string";
      if (needsStrict) {
        const { validatePluginManifest } = await import("./plugin-manifest.js");
        const validated = validatePluginManifest(staged);
        if (!validated.ok) {
          throw new Error(`Plugin manifest invalid: ${validated.errors.map((e) => `${e.field || "manifest"}: ${e.message}`).join("; ")}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("Plugin bundle id") || error.message.startsWith("Plugin manifest invalid"))) throw error;
      throw new Error("Plugin bundle has an invalid manifest.json.");
    }
    if (hadPrevious) {
      try {
        await fs.rename(target, backup);
      } catch {
        // If the backup move fails, abort before touching the live install.
        throw new Error("Could not stage the previous installation for rollback; update aborted safely.");
      }
    }
    try {
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
      // Restore the last working install on swap failure.
      if (hadPrevious && existsSync(backup)) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        await fs.rename(backup, target).catch(() => undefined);
      }
      throw error;
    }
    // Swap succeeded: drop the backup + any staging residue.
    if (hadPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // If we never swapped, a leftover backup means the move-aside succeeded
    // but validation failed — restore it so the old version survives.
    if (hadPrevious && existsSync(backup) && !existsSync(target)) {
      await fs.rename(backup, target).catch(() => undefined);
    } else if (hadPrevious && existsSync(backup) && existsSync(target)) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
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
