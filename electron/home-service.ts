import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { writeFileAtomic, withFileLock } from "./atomic-write.js";

const electronRequire = createRequire(import.meta.url);
type ElectronShim = {
  app?: { getPath: (name: string) => string };
  dialog?: { showSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }> };
  shell?: { openPath: (path: string) => Promise<string> };
};
function electronMod(): ElectronShim {
  try {
    const mod = electronRequire("electron") as unknown;
    if (mod && typeof mod === "object") return mod as ElectronShim;
    return {};
  } catch {
    return {};
  }
}

export const HOME_PROJECT_ID = "home";

// The Home area is a built-in project rooted at a fixed folder. Files the
// general assistant creates (documents, spreadsheets, slides, LaTeX, notes)
// land here, and the user downloads/copies them wherever they want.
export function getHomeRoot(): string {
  // Test/CI override: lets the Home workspace be pointed at a scratch dir.
  const configured = process.env.NEXUS_HOME_ROOT;
  if (configured) return path.resolve(configured);
  const docs = (() => {
    try {
      const app = electronMod().app;
      if (app?.getPath) return app.getPath("documents");
    } catch { /* not in electron */ }
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      const oneDriveDocs = path.join(userProfile, "OneDrive", "Documents");
      if (existsSync(oneDriveDocs)) return oneDriveDocs;
      const regularDocs = path.join(userProfile, "Documents");
      if (existsSync(regularDocs)) return regularDocs;
    }
    return null;
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

const MANIFEST_REL_PATH = path.join(".nexus", "home-manifest.json");

export type HomeManifest = Record<string, { sessionId: string; updatedAt: string }>;

export async function loadHomeManifest(): Promise<HomeManifest> {
  const root = await ensureHomeDir();
  const file = path.join(root, MANIFEST_REL_PATH);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveHomeManifest(manifest: HomeManifest): Promise<void> {
  const root = await ensureHomeDir();
  const file = path.join(root, MANIFEST_REL_PATH);
  try {
    await writeFileAtomic(file, JSON.stringify(manifest, null, 2));
  } catch { /* best effort */ }
}

// Manifest mutations are load→modify→save cycles on one shared file; two
// chats finishing at once would otherwise lose entries to a stale snapshot.
// The save happens INSIDE the lock: saving after release lets a stale
// snapshot overwrite a concurrent mutation that landed in between.
function mutateHomeManifest(fn: (manifest: HomeManifest) => HomeManifest | Promise<HomeManifest>): Promise<HomeManifest> {
  return withFileLock("home-manifest", async () => {
    const next = await fn(await loadHomeManifest());
    await saveHomeManifest(next);
    return next;
  });
}

export async function recordHomeFilesOwnedBySession(sessionId: string, relativePaths: string[]): Promise<void> {
  if (!sessionId || !relativePaths.length) return;
  await mutateHomeManifest((manifest) => {
    const now = new Date().toISOString();
    for (const p of relativePaths) {
      manifest[p.replace(/\\/g, "/")] = { sessionId, updatedAt: now };
    }
    return manifest;
  });
}

export async function recordHomeRunFiles(sessionId: string, runStartMs: number, responseText = ""): Promise<string[]> {
  if (!sessionId) return [];
  const all = await listHomeFiles();
  const TOLERANCE_MS = 10_000;
  const created: string[] = [];
  for (const f of all) {
    const mtime = new Date(f.modified).getTime();
    const isRecent = !Number.isNaN(mtime) && mtime >= runStartMs - TOLERANCE_MS;
    const isMentioned = responseText ? (responseText.includes(f.name) || responseText.includes(f.path)) : false;
    if (isRecent || isMentioned) {
      created.push(f.path);
    }
  }
  if (created.length) {
    await recordHomeFilesOwnedBySession(sessionId, created);
  }
  return created;
}

export async function removeSessionFromManifest(sessionId: string): Promise<void> {
  await mutateHomeManifest((manifest) => {
    for (const [key, entry] of Object.entries(manifest)) {
      if (entry.sessionId === sessionId) delete manifest[key];
    }
    return manifest;
  });
}

export type SessionInfoForAttribution = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  messages?: Array<{ text?: string; createdAt?: string }>;
};

// Ownership: each file in the shared Home folder belongs to the session that
// produced it. Resolution order:
// 1. Explicit run manifest (.nexus/home-manifest.json)
// 2. Transcript message match (filename explicitly mentioned in session turns)
// 3. Activity proximity (session active around file's mtime)
// 4. Earliest session fallback for predated/unclaimed files
export async function listHomeSessionFiles(
  sessionId: string,
  sessions: SessionInfoForAttribution[]
): Promise<HomeFileEntry[]> {
  if (!sessionId || !sessions.length) return [];
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) return [];
  const all = await listHomeFiles();
  if (!all.length) return [];

  const manifest = await loadHomeManifest();

  // Per-session joined transcript text: the cheap .includes prefilter runs
  // against one string per session instead of every message for every file.
  const sessionTexts = sessions.map((s) => ({
    id: s.id,
    text: (s.messages || []).map((m) => m.text || "").join("\n"),
  }));

  // Transcript mentions promote to durable ownership, but the write goes
  // through the locked mutate (same as run attribution) — an unlocked
  // load→save here could drop entries a concurrent run just recorded.
  const promotions: Array<{ path: string; owner: string }> = [];

  const owned = all.filter((file) => {
    // 1. Explicit manifest assignment
    const manifestEntry = manifest[file.path] || manifest[file.name];
    if (manifestEntry?.sessionId) {
      return manifestEntry.sessionId === sessionId;
    }

    // 2. Transcript message matching: does any session explicitly mention this file?
    let messageOwner: string | null = null;
    let newestMentionTime = -1;
    if (sessionTexts.some((s) => s.text.includes(file.name) || s.text.includes(file.path))) {
      for (const s of sessions) {
        if (!s.messages?.length) continue;
        for (const m of s.messages) {
          if (m.text && (m.text.includes(file.name) || m.text.includes(file.path))) {
            const t = new Date(m.createdAt || s.updatedAt || s.createdAt).getTime();
            if (t > newestMentionTime) {
              newestMentionTime = t;
              messageOwner = s.id;
            }
          }
        }
      }
    }
    if (messageOwner) {
      promotions.push({ path: file.path, owner: messageOwner });
      return messageOwner === sessionId;
    }

    // 3. Activity proximity matching: which session was active when the file was modified?
    // Display-only heuristic: proximity guesses are NOT persisted into the
    // manifest (a wrong guess would become durable ownership that file
    // deletion trusts) and do not count for delete-with-chat decisions.
    const mtime = new Date(file.modified).getTime();
    if (!Number.isNaN(mtime)) {
      let bestSessionId: string | null = null;
      let minDistance = Infinity;

      for (const s of sessions) {
        const timestamps: number[] = [];
        if (s.createdAt) {
          const t = new Date(s.createdAt).getTime();
          if (!Number.isNaN(t)) timestamps.push(t);
        }
        if (s.updatedAt) {
          const t = new Date(s.updatedAt).getTime();
          if (!Number.isNaN(t)) timestamps.push(t);
        }
        for (const m of s.messages || []) {
          if (m.createdAt) {
            const t = new Date(m.createdAt).getTime();
            if (!Number.isNaN(t)) timestamps.push(t);
          }
        }

        for (const t of timestamps) {
          const diff = mtime - t;
          // Prefer turns that occurred before or within 2 minutes after mtime
          const distance = diff >= -120_000 ? Math.abs(diff) : Math.abs(diff) + 1_000_000;
          if (distance < minDistance && distance < 45 * 60_000) {
            minDistance = distance;
            bestSessionId = s.id;
          }
        }
      }

      if (bestSessionId) {
        return bestSessionId === sessionId;
      }
    }

    // 4. Fallback for files predating all sessions or with no matching activity:
    const ordered = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const fallbackOwner = ordered[0]?.id ?? null;
    return fallbackOwner === sessionId;
  });

  if (promotions.length) {
    await mutateHomeManifest((current) => {
      const now = new Date().toISOString();
      for (const promo of promotions) {
        const name = promo.path.split("/").pop() || promo.path;
        // First writer wins: if a concurrent run claimed this file between
        // our snapshot and this locked apply, that entry stays.
        if (!current[promo.path] && !current[name]) {
          current[promo.path] = { sessionId: promo.owner, updatedAt: now };
        }
      }
      return current;
    });
  }

  return owned;
}

// Deletion uses ONLY high-confidence ownership: explicit manifest entries
// (transcript mentions get promoted there during display resolution) plus a
// direct transcript mention by THIS session. Proximity guesses and the
// oldest-session fallback are display heuristics — deleting on them could
// remove the user's own pre-existing files that the agent never touched.
export async function listHomeSessionFilesForDeletion(
  sessionId: string,
  sessions: SessionInfoForAttribution[]
): Promise<HomeFileEntry[]> {
  if (!sessionId || !sessions.length) return [];
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) return [];
  const all = await listHomeFiles();
  if (!all.length) return [];
  const manifest = await loadHomeManifest();
  const targetText = (target.messages || []).map((m) => m.text || "").join("\n");
  return all.filter((file) => {
    const manifestEntry = manifest[file.path] || manifest[file.name];
    if (manifestEntry?.sessionId) return manifestEntry.sessionId === sessionId;
    return Boolean(targetText) && (targetText.includes(file.name) || targetText.includes(file.path));
  });
}

// Download = save dialog, then copy. Returns the chosen destination or null
// when the user cancels.
export async function downloadHomeFile(relativePath: string): Promise<string | null> {
  const root = await ensureHomeDir();
  const source = path.resolve(root, relativePath);
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the Home folder.");
  }
  const dialog = electronMod().dialog;
  if (!dialog) return null;
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
  const shell = electronMod().shell;
  if (shell) {
    await shell.openPath(root);
  }
}

// After a Home run produces document deliverable(s) (docx, xlsx, pptx, pdf…),
// the throwaway generator script (e.g. generate_report.py) used to build them
// must not linger in the Nexus folder. This safety net covers cases where the
// agent forgets its "delete the generator" instruction: any script file
// created during the run is removed once at least one fresh deliverable exists.
// Runs where the user explicitly asked for code/scripts are left untouched.
const GENERATOR_EXTS = new Set(["py", "js", "mjs", "cjs", "ts", "sh", "ps1", "bat", "cmd", "rb", "pl"]);
const DELIVERABLE_EXTS = new Set(["docx", "xlsx", "xls", "pptx", "ppsx", "pdf", "odt", "ods", "odp"]);
// Script-as-deliverable intent: explicit script/code words or script file
// extensions. Bare language names ("a presentation about Python") are topic
// mentions, not code requests — they must not block generator cleanup.
const CODE_REQUEST_PATTERN = /\b(script|programme|program|code|\.py\b|\.js\b|\.ts\b|\.sh\b|powershell|batch|bash)\b/i;

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
