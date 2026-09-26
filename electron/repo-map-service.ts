import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSymbolsFromCode } from "./code-tools.js";

// Aider-style repo map: a cheap symbol outline of the project injected into
// every code run so the model orients without reading files first. No
// embeddings, no vector DB — just the existing regex symbol parser plus an
// mtime-keyed cache, so rebuilds after the first are a fast stat walk.

const MAP_IGNORED_DIRS = new Set([
  ".git",
  ".nexus",
  ".forgepilot",
  ".deepagents",
  "node_modules",
  "dist",
  "dist-electron",
  "dist-electron-tmp",
  ".next",
  ".turbo",
  ".nuxt",
  "coverage",
  ".nyc_output",
  ".venv",
  "venv",
  "target",
  "build",
  "out",
  "release",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vscode",
  "vendor",
  "Pods",
]);

// Listed bare (no symbols) — useful orientation, never parsed.
const MAP_LIST_ONLY_EXTS = new Set([
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".env", ".example", ".lock", ".css", ".scss", ".less", ".html",
  ".xml", ".sql", ".graphql", ".gql", ".proto", ".dockerfile",
]);

// Never listed: binaries, media, archives, generated lockfiles that add noise.
const MAP_SKIPPED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
  ".mp3", ".mp4", ".wav", ".ogg", ".mov", ".webm",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".node", ".bin",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".map", ".log", ".lock", ".db", ".sqlite", ".pyc", ".pyo", ".o", ".a",
]);

const MAP_FILE_SIZE_CAP = 300_000;
const MAX_MAP_FILES = 800;
const MAX_SYMBOLS_PER_FILE = 60;
const MAX_MAP_CHARS = 15000;
const MAP_CACHE_VERSION = 2;

type MapCacheEntry = { mtimeMs: number; size: number; symbols: string[]; imports: string[]; listOnly: boolean };
type MapCache = { version: number; files: Record<string, MapCacheEntry> };

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "then", "make", "add", "change", "fix", "update", "use"]);

function taskTerms(task: string): string[] {
  return [...new Set((task.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((term) => !STOP_WORDS.has(term)))].slice(0, 40);
}

function relevanceScore(relativePath: string, entry: MapCacheEntry, terms: string[]): number {
  if (!terms.length) return 0;
  const pathText = relativePath.toLowerCase().replace(/[\\/_.-]+/g, " ");
  const symbolText = entry.symbols.join(" ").toLowerCase();
  const importText = entry.imports.join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (new RegExp(`(^|\\s)${term.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?=\\s|$)`, "i").test(pathText)) score += 12;
    else if (pathText.includes(term)) score += 5;
    if (symbolText.includes(term)) score += 8;
    if (importText.includes(term)) score += 2;
  }
  return score;
}

function mapCachePath(projectRoot: string) {
  return path.join(projectRoot, ".nexus", "repo-map-cache.json");
}

async function loadMapCache(projectRoot: string): Promise<MapCache> {
  try {
    const raw = await fs.readFile(mapCachePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as MapCache;
    if (parsed && parsed.version === MAP_CACHE_VERSION && parsed.files) return parsed;
  } catch { /* cold cache — full rebuild */ }
  return { version: MAP_CACHE_VERSION, files: {} };
}

async function saveMapCache(projectRoot: string, cache: MapCache): Promise<void> {
  try {
    await fs.mkdir(path.join(projectRoot, ".nexus"), { recursive: true });
    await fs.writeFile(mapCachePath(projectRoot), JSON.stringify(cache), "utf8");
  } catch { /* cache is best-effort; the map still works without it */ }
}

async function walkMapFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 8 || output.length >= MAX_MAP_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= MAX_MAP_FILES) return;
      // Dot-directories (.git, .github, .vscode, …) are never mapped;
      // dot-files (.env, .cursorrules, AGENTS.md style) fall through below.
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (MAP_IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (!relative || relative === ".") continue;
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const base = path.basename(entry.name).toLowerCase();
        if (MAP_SKIPPED_EXTS.has(ext)) continue;
        if (base === "package-lock.json" || base === "yarn.lock" || base === "pnpm-lock.yaml") continue;
        output.push(relative);
      }
    }
  }
  await walk(root, 0);
  return output;
}

function formatSymbol(s: { kind: string; name: string; signature: string }): string {
  const sig = (s.signature || `${s.kind} ${s.name}`).slice(0, 100);
  return `- ${sig}`;
}

function extractLocalImports(content: string, relPath: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const found = [...content.matchAll(/(?:from\s*["']|import\s*["']|require\(\s*["'])(\.?\.?\/[^"']+)["']/g)].map((match) => match[1]);
    return [...new Set(found)].slice(0, 12);
  }
  if ([".py"].includes(ext)) {
    const found = [...content.matchAll(/(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/g)].map((match) => match[1] || match[2]).filter((value) => value?.startsWith("."));
    return [...new Set(found)].slice(0, 12);
  }
  return [];
}

// Returns the markdown section ("" when the project has nothing mappable).
// Incremental: per-file mtime+size cache under .nexus/ — unchanged files are
// never re-read or re-parsed.
export async function getRepoMapSection(projectRoot: string, task = ""): Promise<string> {
  const root = path.resolve(projectRoot);
  let relPaths: string[];
  try {
    relPaths = await walkMapFiles(root);
  } catch {
    return "";
  }
  if (!relPaths.length) return "";

  const cache = await loadMapCache(root);
  const nextFiles: Record<string, MapCacheEntry> = {};
  const sections: string[] = [];
  const terms = taskTerms(task);
  const rankedPaths = relPaths.map((rel, index) => ({ rel, index, score: 0, entry: null as MapCacheEntry | null }));
  const rankedByPath = new Map(rankedPaths.map((item) => [item.rel, item]));
  let used = 0;
  let truncated = false;

  for (const rel of relPaths) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const cached = cache.files[rel];
    let entry: MapCacheEntry | null = null;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      entry = cached;
    } else {
      const ext = path.extname(rel).toLowerCase();
      const listOnly = MAP_LIST_ONLY_EXTS.has(ext) || path.basename(rel) === "Dockerfile";
      let symbols: string[] = [];
      let imports: string[] = [];
      if (!listOnly && stat.size <= MAP_FILE_SIZE_CAP) {
        try {
          const content = await fs.readFile(abs, "utf8");
          imports = extractLocalImports(content, rel);
          // parseSymbolsFromCode(content, filename): content holds newlines so
          // the arg-order heuristic resolves correctly.
          symbols = parseSymbolsFromCode(content, rel)
            .slice(0, MAX_SYMBOLS_PER_FILE)
            .map(formatSymbol);
        } catch { /* unreadable — list bare */ }
      }
      entry = { mtimeMs: stat.mtimeMs, size: stat.size, symbols, imports, listOnly };
    }
    nextFiles[rel] = entry;
    const ranked = rankedByPath.get(rel)!;
    ranked.entry = entry;
    ranked.score = relevanceScore(rel, entry, terms);
  }

  rankedPaths.sort((a, b) => b.score - a.score || a.index - b.index);
  for (const ranked of rankedPaths) {
    const entry = ranked.entry;
    if (!entry) continue;
    const body = entry.listOnly || entry.symbols.length === 0 ? "" : `\n${entry.symbols.join("\n")}`;
    const imports = entry.imports?.length ? `\n  imports: ${entry.imports.join(", ")}` : "";
    const block = `## ${ranked.rel}${imports}${body}`;
    if (used + block.length > MAX_MAP_CHARS) { truncated = true; continue; }
    sections.push(block);
    used += block.length;
  }

  // Await the cache write so callers can rely on the cache existing when the
  // map promise resolves (and so a follow-up run does not race the first one).
  await saveMapCache(root, { version: MAP_CACHE_VERSION, files: nextFiles });

  if (!sections.length) return "";
  return (
    `REPO MAP (${terms.length ? "task-ranked symbol outline and local dependency hints" : "symbol outline and local dependency hints"} — paths relative to /. ` +
    `Read the specific files you need with read_file_range before editing; do not re-list the tree.)\n` +
    sections.join("\n") +
    (truncated ? `\n…[map truncated to ${MAX_MAP_CHARS} chars — grep_search for the rest]` : "")
  );
}
