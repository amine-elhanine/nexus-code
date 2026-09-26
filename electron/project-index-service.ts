import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSymbolsFromCode } from "./code-tools.js";

type IndexedFile = { mtimeMs: number; size: number; symbols: string[]; imports: string[]; references?: string[]; dependencies?: string[] };
type ProjectIndex = { version: 1; files: Record<string, IndexedFile> };

const IGNORE = new Set([".git", ".nexus", "node_modules", "dist", "dist-electron", "build", "coverage", ".next", "target", "venv", ".venv"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".swift"]);
const MAX_FILES = 4000;
const MAX_RESULTS = 50;

function indexPath(root: string) { return path.join(root, ".nexus", "project-index.json"); }
function terms(task: string) { return [...new Set((task.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).slice(0, 40))]; }

async function load(root: string): Promise<ProjectIndex> {
  try {
    const value = JSON.parse(await fs.readFile(indexPath(root), "utf8"));
    if (value?.version === 1 && value.files) return value;
  } catch { /* rebuild */ }
  return { version: 1, files: {} };
}

async function walk(root: string) {
  const result: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 10 || result.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= MAX_FILES || (entry.isDirectory() && (IGNORE.has(entry.name) || entry.name.startsWith(".")))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (CODE.has(path.extname(entry.name).toLowerCase())) result.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
  await visit(root, 0);
  return result;
}

function localImports(content: string) {
  return [...new Set([...content.matchAll(/(?:from\s*["']|import\s*["']|require\(\s*["'])(\.?\.?\/[^"']+)/g)].map((m) => m[1]))].slice(0, 16);
}

function references(content: string) {
  // Keep a bounded identifier set rather than source text. This is enough to
  // identify likely callers/dependents while keeping the on-disk index small.
  return [...new Set(content.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [])].slice(0, 500);
}

function score(file: string, item: IndexedFile, wanted: string[], relatedSymbols: string[] = []) {
  const haystack = `${file} ${item.symbols.join(" ")} ${item.imports.join(" ")}`.toLowerCase();
  const direct = wanted.reduce((total, word) => total + (haystack.includes(word) ? (file.toLowerCase().includes(word) ? 5 : 2) : 0), 0);
  const refs = new Set((item.references || []).map((value) => value.toLowerCase()));
  const dependent = relatedSymbols.reduce((total, symbol) => total + (refs.has(symbol.toLowerCase()) ? 4 : 0), 0);
  return direct + dependent;
}

function resolveImport(from: string, imported: string, files: Set<string>) {
  if (!imported.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), imported));
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"].map((ext) => `${base}${ext}`), ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => files.has(candidate)) || null;
}

export async function getProjectIndexSection(projectRoot: string, task = "") {
  const root = path.resolve(projectRoot);
  const old = await load(root);
  const next: Record<string, IndexedFile> = {};
  for (const relative of await walk(root)) {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = await fs.stat(absolute); } catch { continue; }
    const cached = old.files[relative];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { next[relative] = cached; continue; }
    try {
      const content = await fs.readFile(absolute, "utf8");
      next[relative] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        symbols: parseSymbolsFromCode(content, relative).slice(0, 80).map((s) => `${s.kind} ${s.name}`),
        imports: localImports(content),
        references: references(content),
      };
    } catch { next[relative] = { mtimeMs: stat.mtimeMs, size: stat.size, symbols: [], imports: [] }; }
  }
  const fileSet = new Set(Object.keys(next));
  const reverseDependencies = new Map<string, string[]>();
  for (const [file, item] of Object.entries(next)) {
    item.dependencies = item.imports.map((entry) => resolveImport(file, entry, fileSet)).filter((entry): entry is string => Boolean(entry));
    for (const dependency of item.dependencies) {
      const dependents = reverseDependencies.get(dependency) || [];
      dependents.push(file);
    reverseDependencies.set(dependency, dependents);
  }
  try {
    await fs.mkdir(path.join(root, ".nexus"), { recursive: true });
    await fs.writeFile(indexPath(root), JSON.stringify({ version: 1, files: next }), "utf8");
  } catch { /* index is an optimization; never fail an agent run */ }
  }
  const wanted = terms(task);
  const directRanked = Object.entries(next)
    .map(([file, item]) => ({ file, item, points: score(file, item, wanted) }))
    .sort((a, b) => b.points - a.points || a.file.localeCompare(b.file));
  const relatedSymbols = directRanked
    .filter((entry) => entry.points > 0)
    .slice(0, 12)
    .flatMap((entry) => entry.item.symbols.map((symbol) => symbol.replace(/^[a-z]+\s+/i, "")))
    .filter((symbol) => symbol.length > 2);
  const directFiles = new Set(directRanked.filter((entry) => entry.points > 0).slice(0, 20).map((entry) => entry.file));
  const dependentFiles = new Set([...directFiles].flatMap((file) => reverseDependencies.get(file) || []));
  const ranked = Object.entries(next)
    .map(([file, item]) => ({ file, item, points: score(file, item, wanted, relatedSymbols) + (dependentFiles.has(file) ? 10 : 0) }))
    .filter((entry) => !wanted.length || entry.points > 0)
    .sort((a, b) => b.points - a.points || a.file.localeCompare(b.file))
    .slice(0, MAX_RESULTS);
  if (!ranked.length) return "";
  const lines = ranked.map(({ file, item }) => {
    const relation = dependentFiles.has(file) ? "; dependent of a task-relevant module" : "";
    return `- ${file}${item.symbols.length ? ` — ${item.symbols.slice(0, 12).join(", ")}` : ""}${item.imports.length ? `; imports ${item.imports.slice(0, 8).join(", ")}` : ""}${relation}`;
  });
  return `PROJECT INDEX (cached symbols, local imports, and reverse dependencies; use read_file_range for source)\n${lines.join("\n")}`;
}
