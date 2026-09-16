import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getHeadCommit, resetNexusCommitsOnly } from "./repo-service.js";

const execFileAsync = promisify(execFile);
export type WorkspaceDiffFile = { path: string; directory: string; name: string; additions: number; deletions: number; status: string; patch: string };

function parseNumstat(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [additions, deletions, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    return { path: filePath, additions: additions === "-" ? 0 : Number(additions) || 0, deletions: deletions === "-" ? 0 : Number(deletions) || 0 };
  });
}

const IGNORED_PREFIXES = [".nexus/", ".forgepilot/", ".deepagents/", ".git/"];
function isIgnoredPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  return IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix) || normalized.includes(`/${prefix}`));
}

// Split a unified diff into one patch block per file, keyed by the path on the
// `+++ b/<path>` line. --no-renames is always passed, so a/b paths match.
function splitUnifiedDiff(output: string): Map<string, string> {
  const patches = new Map<string, string>();
  const blocks = output.split(/(?=^diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git")) continue;
    const fileMatch = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!fileMatch) continue;
    const filePath = fileMatch[2].replace(/\r$/, "");
    const decoded = filePath.startsWith('"') && filePath.endsWith('"')
      ? JSON.parse(filePath)
      : filePath;
    patches.set(decoded, block);
  }
  return patches;
}

export async function getWorkspaceDiffFiles(projectRoot: string): Promise<WorkspaceDiffFile[]> {
  try {
    let numstat = "";
    let unified = "";
    try {
      [numstat, unified] = await Promise.all([
        execFileAsync("git", ["diff", "HEAD", "--no-ext-diff", "--no-renames", "--numstat", "--", "."], { cwd: projectRoot, maxBuffer: 8_000_000 }).then((r) => r.stdout),
        execFileAsync("git", ["diff", "HEAD", "--no-ext-diff", "--no-renames", "--unified=3", "--", "."], { cwd: projectRoot, maxBuffer: 16_000_000 }).then((r) => r.stdout),
      ]);
    } catch {
      // No HEAD yet (repo without commits) — fall back to the index-less diff.
      try {
        [numstat, unified] = await Promise.all([
          execFileAsync("git", ["diff", "--no-ext-diff", "--no-renames", "--numstat", "--", "."], { cwd: projectRoot, maxBuffer: 8_000_000 }).then((r) => r.stdout),
          execFileAsync("git", ["diff", "--no-ext-diff", "--no-renames", "--unified=3", "--", "."], { cwd: projectRoot, maxBuffer: 16_000_000 }).then((r) => r.stdout),
        ]);
      } catch {
        numstat = "";
        unified = "";
      }
    }
    const patchesByPath = splitUnifiedDiff(unified);
    const tracked = parseNumstat(numstat).filter((item) => !isIgnoredPath(item.path));
    // Independent try: on non-git folders (e.g. Home) the diffs above
    // already failed — a status throw here must degrade to "no changes",
    // not propagate.
    let statusOutput = "";
    try {
      statusOutput = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot, maxBuffer: 8_000_000 })).stdout;
    } catch { /* non-git folder or git failure: no status info */ }
    const statusByPath = new Map<string, string>();
    for (const line of statusOutput.split(/\r?\n/).filter(Boolean)) {
      const code = line.slice(0, 2).trim() || "M";
      const filePath = line.slice(3).replace(/^"|"$/g, "");
      const normalizedPath = filePath.replace(/\\/g, "/");
      if (!isIgnoredPath(normalizedPath)) {
        statusByPath.set(normalizedPath, code);
      }
    }
    const entries = new Map<string, WorkspaceDiffFile>();
    for (const item of tracked) {
      const normalized = item.path.replace(/\\/g, "/");
      if (isIgnoredPath(normalized)) continue;
      const name = path.posix.basename(normalized); const directory = path.posix.dirname(normalized) === "." ? "" : `${path.posix.dirname(normalized)}/`;
      entries.set(normalized, { ...item, path: normalized, name, directory, status: statusByPath.get(normalized) || "M", patch: "" });
    }
    for (const [filePath, status] of statusByPath) {
      if (entries.has(filePath) || !status.includes("?") && status !== "A") continue;
      const absolute = path.resolve(projectRoot, filePath);
      let additions = 0; let patch = "";
      try {
        const content = await fs.readFile(absolute, "utf8");
        additions = content ? content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0) : 0;
        patch = content.split(/\r?\n/).map((line) => `+${line}`).join("\n");
      } catch { /* Ignore unreadable files. */ }
      const name = path.posix.basename(filePath); const directory = path.posix.dirname(filePath) === "." ? "" : `${path.posix.dirname(filePath)}/`;
      entries.set(filePath, { path: filePath, name, directory, additions, deletions: 0, status, patch });
    }
    for (const file of entries.values()) {
      file.patch = patchesByPath.get(file.path) || file.patch;
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

export async function revertWorkspaceFile(projectRoot: string, relativePath: string): Promise<boolean> {
  const root = path.resolve(projectRoot);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const target = path.resolve(root, normalized);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
    throw new Error("Target file escapes project root.");
  }
  try {
    const statusOutput = (await execFileAsync("git", ["status", "--porcelain=v1", "--", normalized], { cwd: root, maxBuffer: 100_000 })).stdout.trim();
    if (statusOutput.startsWith("??") || statusOutput.startsWith("A ")) {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    }
    try {
      // Preserve the committed blob's bytes on Windows instead of allowing a
      // user's global core.autocrlf setting to rewrite line endings during a
      // discard operation.
      await execFileAsync("git", ["-c", "core.autocrlf=false", "checkout", "HEAD", "--", normalized], { cwd: root, maxBuffer: 100_000 });
      return true;
    } catch {
      await execFileAsync("git", ["-c", "core.autocrlf=false", "restore", normalized], { cwd: root, maxBuffer: 100_000 });
      return true;
    }
  } catch (error) {
    // If not a git repository or git fails, try removing if untracked
    try {
      await fs.rm(target, { force: true });
      return true;
    } catch {
      throw error;
    }
  }
}

// Paths git clean must never delete during "Discard all", even untracked:
// agent telemetry, reinstallable-but-slow dirs, and local-only secrets.
const CLEAN_EXCLUDES = [
  ".nexus",
  ".forgepilot",
  ".deepagents",
  "node_modules",
  "dist",
  "dist-electron",
  "release",
  "coverage",
  ".env",
  ".env.*",
];

export async function revertAllWorkspaceChanges(projectRoot: string): Promise<boolean> {
  const root = path.resolve(projectRoot);
  try {
    try { await execFileAsync("git", ["-c", "core.autocrlf=false", "checkout", "HEAD", "--", "."], { cwd: root, maxBuffer: 200_000 }); } catch { /* ignore */ }
    // git clean -fd deletes EVERYTHING untracked — including telemetry dirs,
    // dependency installs, build output and local secrets. Those are never
    // "agent changes": exclude them explicitly. (UI still confirms first.)
    const args = ["clean", "-fd", ...CLEAN_EXCLUDES.flatMap((pattern) => ["-e", pattern])];
    try { await execFileAsync("git", args, { cwd: root, maxBuffer: 200_000 }); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

// Checkpoints persist to disk (.nexus/checkpoints/<id>/manifest.json) so an
// "Undo run" survives app restarts. Content is stored as utf8 text — the same
// fidelity the in-memory snapshot had; binary files are not checkpointed.
const MAX_CHECKPOINT_FILES = 2000;

type CheckpointFileEntry = { path: string; content: string | null };
// headCommit is the git HEAD at snapshot time (null = unborn/non-git).
// It powers the durable undo layer: restore resets only Nexus-owned commits
// made after this point, never user commits.
type CheckpointManifest = { id: string; projectRoot: string; timestamp: string; truncated: boolean; headCommit: string | null; files: CheckpointFileEntry[] };

function checkpointsDir(projectRoot: string) {
  return path.join(projectRoot, ".nexus", "checkpoints");
}

function checkpointPath(projectRoot: string, checkpointId: string) {
  const safeId = checkpointId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(checkpointsDir(projectRoot), `${safeId}.json`);
}

// Same-process index: checkpoint id -> root it was created in. The manifest
// on disk is the source of truth across restarts (looked up under the caller's
// root, which post-restart is the project root), but within a live process a
// caller may pass a different root (e.g. a worktree path, or a stale caller)
// — the index resolves those without guessing.
const checkpointRootIndex = new Map<string, string>();

export async function createWorkspaceCheckpoint(projectRoot: string, checkpointId: string, opts?: { headCommit?: string | null }): Promise<string> {
  const root = path.resolve(projectRoot);
  const diffs = await getWorkspaceDiffFiles(root);
  const files: CheckpointFileEntry[] = [];
  let truncated = false;
  for (const file of diffs) {
    if (files.length >= MAX_CHECKPOINT_FILES) { truncated = true; break; }
    try {
      const content = await fs.readFile(path.resolve(root, file.path), "utf8");
      files.push({ path: file.path, content });
    } catch {
      files.push({ path: file.path, content: null });
    }
  }
  let headCommit: string | null = opts?.headCommit ?? null;
  if (opts?.headCommit === undefined) {
    try {
      headCommit = await getHeadCommit(root);
    } catch {
      headCommit = null;
    }
  }
  const manifest: CheckpointManifest = { id: checkpointId, projectRoot: root, timestamp: new Date().toISOString(), truncated, headCommit, files };
  await fs.mkdir(checkpointsDir(root), { recursive: true });
  await fs.writeFile(checkpointPath(root, checkpointId), JSON.stringify(manifest), "utf8");
  checkpointRootIndex.set(checkpointId, root);
  return checkpointId;
}

// Finding the manifest file needs a root to look in. Check the in-process
// index first (covers caller paths that differ from the checkpoint's root),
// then search the caller's root and its worktree siblings (covers restarts).
async function loadCheckpoint(projectRoot: string, checkpointId: string): Promise<CheckpointManifest | null> {
  const roots = new Set<string>();
  const indexed = checkpointRootIndex.get(checkpointId);
  if (indexed) roots.add(indexed);
  const callerRoot = path.resolve(projectRoot);
  roots.add(callerRoot);
  try {
    // A worktree execution root: the checkpoint may live in the main root.
    const mainRootGuess = path.dirname(path.dirname(callerRoot));
    if (existsSync(path.join(mainRootGuess, ".forgepilot", "worktrees"))) roots.add(mainRootGuess);
    // A main root: checkpoints may have been taken inside one of its worktrees.
    const worktreesDir = path.join(callerRoot, ".forgepilot", "worktrees");
    if (existsSync(worktreesDir)) {
      for (const entry of await fs.readdir(worktreesDir)) {
        roots.add(path.join(worktreesDir, entry));
      }
    }
  } catch { /* best effort — keep the roots collected so far */ }
  for (const root of roots) {
    try {
      const raw = JSON.parse(await fs.readFile(checkpointPath(root, checkpointId), "utf8")) as Partial<CheckpointManifest>;
      if (raw && raw.id === checkpointId) {
        // Backfill pre-headCommit manifests.
        const manifest: CheckpointManifest = {
          id: raw.id,
          projectRoot: raw.projectRoot || root,
          timestamp: raw.timestamp || new Date(0).toISOString(),
          truncated: Boolean(raw.truncated),
          headCommit: raw.headCommit ?? null,
          files: Array.isArray(raw.files) ? raw.files as CheckpointManifest["files"] : [],
        };
        return manifest;
      }
    } catch { /* try next root */ }
  }
  return null;
}

export async function restoreWorkspaceCheckpoint(projectRoot: string, checkpointId: string): Promise<boolean> {
  const checkpoint = await loadCheckpoint(projectRoot, checkpointId);
  if (!checkpoint) {
    throw new Error(`Unknown checkpoint "${checkpointId}". It may predate checkpoint persistence or belong to another project, so the workspace cannot be safely rolled back.`);
  }
  // The manifest's recorded root is the restore target: the snapshot was
  // taken there, so its relative paths only make sense against it.
  const root = checkpoint.projectRoot;
  const snapshot = new Map(checkpoint.files.map((entry) => [entry.path, entry.content] as const));
  const currentDiffs = await getWorkspaceDiffFiles(root);
  const unionPaths = new Set([...snapshot.keys(), ...currentDiffs.map((d) => d.path)]);
  for (const filePath of unionPaths) {
    const priorContent = snapshot.get(filePath);
    const abs = path.resolve(root, filePath);
    if (priorContent === undefined) {
      // Clean before the run, changed since — back to HEAD.
      await revertWorkspaceFile(root, filePath);
    } else if (priorContent === null) {
      // Did not exist before the run — remove it (also no-op if already gone).
      await fs.rm(abs, { force: true, recursive: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, priorContent, "utf8");
    }
  }
  // Durable layer: if Nexus auto-committed on an isolated session branch
  // since the snapshot, roll those commits back. Mixed/user commits are left
  // untouched by resetNexusCommitsOnly (file restore above still applies).
  try {
    await resetNexusCommitsOnly(root, checkpoint.headCommit ?? null);
  } catch { /* file restore already succeeded — commit reset is best-effort */ }
  return true;
}

export async function deleteWorkspaceCheckpoint(projectRoot: string, checkpointId: string): Promise<void> {
  checkpointRootIndex.delete(checkpointId);
  try {
    await fs.rm(checkpointPath(path.resolve(projectRoot), checkpointId), { force: true });
  } catch { /* best effort */ }
}
