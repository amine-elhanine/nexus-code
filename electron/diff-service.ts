import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type WorkspaceDiffFile = { path: string; directory: string; name: string; additions: number; deletions: number; status: string; patch: string };

function parseNumstat(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [additions, deletions, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    return { path: filePath, additions: additions === "-" ? 0 : Number(additions) || 0, deletions: deletions === "-" ? 0 : Number(deletions) || 0 };
  });
}

export async function getWorkspaceDiffFiles(projectRoot: string): Promise<WorkspaceDiffFile[]> {
  try {
    let numstat = "";
    try { numstat = (await execFileAsync("git", ["diff", "HEAD", "--no-ext-diff", "--no-renames", "--numstat", "--", "."], { cwd: projectRoot, maxBuffer: 4_000_000 })).stdout; }
    catch { numstat = (await execFileAsync("git", ["diff", "--no-ext-diff", "--no-renames", "--numstat", "--", "."], { cwd: projectRoot, maxBuffer: 4_000_000 })).stdout; }
    const tracked = parseNumstat(numstat);
    const statusOutput = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot, maxBuffer: 4_000_000 })).stdout;
    const statusByPath = new Map<string, string>();
    for (const line of statusOutput.split(/\r?\n/).filter(Boolean)) {
      const code = line.slice(0, 2).trim() || "M";
      const filePath = line.slice(3).replace(/^"|"$/g, "");
      statusByPath.set(filePath.replace(/\\/g, "/"), code);
    }
    const entries = new Map<string, WorkspaceDiffFile>();
    for (const item of tracked) {
      const normalized = item.path.replace(/\\/g, "/");
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
      try {
        const result = await execFileAsync("git", ["diff", "HEAD", "--no-ext-diff", "--unified=3", "--", file.path], { cwd: projectRoot, maxBuffer: 2_000_000 });
        file.patch = result.stdout || file.patch;
      } catch {
        try { file.patch = (await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "--", file.path], { cwd: projectRoot, maxBuffer: 2_000_000 })).stdout || file.patch; } catch { /* Keep generated untracked patch. */ }
      }
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
      await execFileAsync("git", ["checkout", "HEAD", "--", normalized], { cwd: root, maxBuffer: 100_000 });
      return true;
    } catch {
      await execFileAsync("git", ["restore", normalized], { cwd: root, maxBuffer: 100_000 });
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

export async function revertAllWorkspaceChanges(projectRoot: string): Promise<boolean> {
  const root = path.resolve(projectRoot);
  try {
    try { await execFileAsync("git", ["checkout", "HEAD", "--", "."], { cwd: root, maxBuffer: 200_000 }); } catch { /* ignore */ }
    try { await execFileAsync("git", ["clean", "-fd"], { cwd: root, maxBuffer: 200_000 }); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

type CheckpointSnapshot = { id: string; projectRoot: string; timestamp: string; files: Map<string, string | null> };
const checkpoints = new Map<string, CheckpointSnapshot>();

export async function createWorkspaceCheckpoint(projectRoot: string, checkpointId: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const diffs = await getWorkspaceDiffFiles(root);
  const snapshot = new Map<string, string | null>();
  for (const file of diffs) {
    try {
      const content = await fs.readFile(path.resolve(root, file.path), "utf8");
      snapshot.set(file.path, content);
    } catch {
      snapshot.set(file.path, null);
    }
  }
  checkpoints.set(checkpointId, { id: checkpointId, projectRoot: root, timestamp: new Date().toISOString(), files: snapshot });
  return checkpointId;
}

export async function restoreWorkspaceCheckpoint(projectRoot: string, checkpointId: string): Promise<boolean> {
  const root = path.resolve(projectRoot);
  const checkpoint = checkpoints.get(checkpointId);
  if (!checkpoint) {
    return await revertAllWorkspaceChanges(root);
  }
  const currentDiffs = await getWorkspaceDiffFiles(root);
  for (const file of currentDiffs) {
    const priorContent = checkpoint.files.get(file.path);
    const abs = path.resolve(root, file.path);
    if (priorContent === undefined || priorContent === null) {
      await revertWorkspaceFile(root, file.path);
    } else {
      await fs.writeFile(abs, priorContent, "utf8");
    }
  }
  return true;
}

