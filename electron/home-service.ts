import { promises as fs } from "node:fs";
import path from "node:path";
import { app, dialog, shell } from "electron";

export const HOME_PROJECT_ID = "home";

// The Home area is a built-in project rooted at a fixed folder. Files the
// general assistant creates (documents, spreadsheets, slides, LaTeX, notes)
// land here, and the user downloads/copies them wherever they want.
export function getHomeRoot(): string {
  const docs = (() => {
    try {
      return app?.getPath ? app.getPath("documents") : null;
    } catch {
      return null;
    }
  })();
  const base = docs || process.env.USERPROFILE || process.cwd();
  return path.join(base, "Nexus");
}

export async function ensureHomeDir(): Promise<string> {
  const root = getHomeRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

export type HomeFileEntry = { path: string; name: string; size: number; modified: string };

export async function listHomeFiles(): Promise<HomeFileEntry[]> {
  const root = await ensureHomeDir();
  const entries: HomeFileEntry[] = [];
  async function walk(dir: string) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else {
        try {
          const stat = await fs.stat(full);
          entries.push({
            path: path.relative(root, full).replace(/\\/g, "/"),
            name: dirent.name,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch { /* ignore unreadable files */ }
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return entries.slice(0, 200);
}

// Ownership: each file in the shared Home folder belongs to exactly one
// session — the most recent session created at or before the file's mtime.
// This works even for files produced indirectly via `execute` (e.g. a Python
// script generating report.docx), where tool args never name the output.
export async function listHomeSessionFiles(
  sessionId: string,
  sessions: Array<{ id: string; createdAt: string }>
): Promise<HomeFileEntry[]> {
  if (!sessionId || !sessions.length) return [];
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) return [];
  const all = await listHomeFiles();
  const ordered = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const TOLERANCE_MS = 60_000;
  const targetTime = new Date(target.createdAt).getTime();
  if (Number.isNaN(targetTime)) return [];
  const owned = all.filter((file) => {
    const mtime = new Date(file.modified).getTime();
    if (Number.isNaN(mtime)) return false;
    // Latest session whose creation precedes (or roughly matches) the file.
    let owner: string | null = null;
    for (const s of ordered) {
      const created = new Date(s.createdAt).getTime();
      if (Number.isNaN(created)) continue;
      if (created <= mtime + TOLERANCE_MS) owner = s.id;
      else break;
    }
    // Files predating every session surface under the earliest session so
    // nothing is orphaned.
    if (!owner) owner = ordered[0]?.id ?? null;
    return owner === sessionId;
  });
  return owned;
}

// Download = save dialog, then copy. Returns the chosen destination or null
// when the user cancels.
export async function downloadHomeFile(relativePath: string): Promise<string | null> {
  const root = await ensureHomeDir();
  const source = path.resolve(root, relativePath);
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the Home folder.");
  }
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: path.basename(relativePath),
    title: "Download file",
  });
  if (canceled || !filePath) return null;
  await fs.copyFile(source, filePath);
  return filePath;
}

export async function openHomeFolder(): Promise<void> {
  const root = await ensureHomeDir();
  await shell.openPath(root);
}

// After a Home run produces document deliverable(s) (docx, xlsx, pptx, pdf…),
// the throwaway generator script (e.g. generate_report.py) used to build them
// must not linger in the Nexus folder. This safety net covers cases where the
// agent forgets its "delete the generator" instruction: any script file
// created during the run is removed once at least one fresh deliverable exists.
// Runs where the user explicitly asked for code/scripts are left untouched.
const GENERATOR_EXTS = new Set(["py", "js", "mjs", "cjs", "ts", "sh", "ps1", "bat", "cmd", "rb", "pl"]);
const DELIVERABLE_EXTS = new Set(["docx", "xlsx", "xls", "pptx", "ppsx", "pdf", "odt", "ods", "odp"]);
const CODE_REQUEST_PATTERN = /\b(python|javascript|typescript|script|code|programme|\.py\b|\.js\b|\.ts\b|\.sh\b|powershell|batch)\b/i;

export async function cleanupHomeGeneratorScripts(runStartMs: number, requestText = ""): Promise<string[]> {
  if (Number.isNaN(runStartMs)) return [];
  // User asked for a script as the deliverable — the .py/.js file IS the point.
  if (requestText && CODE_REQUEST_PATTERN.test(requestText)) return [];
  const root = await ensureHomeDir();
  const all = await listHomeFiles();
  const TOLERANCE_MS = 60_000;
  const fresh = all.filter((f) => {
    const mtime = new Date(f.modified).getTime();
    return !Number.isNaN(mtime) && mtime >= runStartMs - TOLERANCE_MS;
  });
  const hasFreshDeliverable = fresh.some((f) => {
    const ext = f.name.split(".").pop()?.toLowerCase() || "";
    return DELIVERABLE_EXTS.has(ext);
  });
  if (!hasFreshDeliverable) return [];
  const deleted: string[] = [];
  for (const f of fresh) {
    const ext = f.name.split(".").pop()?.toLowerCase() || "";
    if (!GENERATOR_EXTS.has(ext)) continue;
    const abs = path.resolve(root, f.path);
    if (abs === root || !abs.startsWith(`${root}${path.sep}`)) continue;
    try {
      await fs.unlink(abs);
      deleted.push(f.path);
    } catch { /* best effort — file may already be gone */ }
  }
  return deleted;
}

export type HomeFileContent = { name: string; path: string; size: number; base64: string };

// Reads a Home file for in-app preview. Capped so a huge file degrades to
// "download instead" rather than blowing up IPC/renderer memory.
const PREVIEW_SIZE_CAP = 30 * 1024 * 1024;

export async function readHomeFile(relativePath: string): Promise<HomeFileContent> {
  const root = await ensureHomeDir();
  const source = path.resolve(root, relativePath);
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the Home folder.");
  }
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error("Not a file.");
  if (stat.size > PREVIEW_SIZE_CAP) {
    throw new Error(`File is too large to preview (${Math.round(stat.size / 1024 / 1024)} MB). Download it instead.`);
  }
  const buffer = await fs.readFile(source);
  return {
    name: path.basename(source),
    path: relativePath,
    size: stat.size,
    base64: buffer.toString("base64"),
  };
}
