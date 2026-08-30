import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getWorkspaceDiffFiles, type WorkspaceDiffFile } from "./diff-service.js";

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  sessionId: string;
  worktreePath: string;
  branch: string;
  headCommit?: string;
  isActive: boolean;
};

export function getWorktreeBaseDir(projectRoot: string): string {
  return path.join(projectRoot, ".forgepilot", "worktrees");
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
      maxBuffer: 100_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getCurrentBranch(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      maxBuffer: 100_000,
    });
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
}

export async function createSessionWorktree(
  projectRoot: string,
  sessionId: string,
  baseBranch?: string
): Promise<{ worktreePath: string; branch: string; isNew: boolean }> {
  const root = path.resolve(projectRoot);
  const isGit = await isGitRepo(root);
  if (!isGit) {
    throw new Error("Project is not a Git repository. Initialize git first to enable worktree isolation.");
  }

  const baseDir = getWorktreeBaseDir(root);
  await fs.mkdir(baseDir, { recursive: true });

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const worktreePath = path.join(baseDir, `session-${safeSessionId}`);
  const branchName = `forgepilot/session-${safeSessionId}`;

  // If worktree directory already exists and is valid, return it
  if (existsSync(worktreePath)) {
    return { worktreePath, branch: branchName, isNew: false };
  }

  const defaultBase = baseBranch || (await getCurrentBranch(root));

  // Check if branch already exists
  let branchExists = false;
  try {
    await execFileAsync("git", ["rev-parse", "--verify", branchName], { cwd: root, maxBuffer: 100_000 });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    if (branchExists) {
      // Add worktree for existing branch
      await execFileAsync("git", ["worktree", "add", worktreePath, branchName], {
        cwd: root,
        maxBuffer: 2_000_000,
      });
    } else {
      // Add worktree with a new branch created from the base branch
      await execFileAsync("git", ["worktree", "add", "-b", branchName, worktreePath, defaultBase], {
        cwd: root,
        maxBuffer: 2_000_000,
      });
    }
    return { worktreePath, branch: branchName, isNew: true };
  } catch (error) {
    // If standard worktree add failed, cleanup directory if left in corrupted state
    if (existsSync(worktreePath)) {
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getSessionWorktree(
  projectRoot: string,
  sessionId: string
): Promise<{ worktreePath: string; branch: string } | null> {
  const root = path.resolve(projectRoot);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const worktreePath = path.join(getWorktreeBaseDir(root), `session-${safeSessionId}`);
  const branchName = `forgepilot/session-${safeSessionId}`;

  if (existsSync(worktreePath)) {
    return { worktreePath, branch: branchName };
  }
  return null;
}

export async function listSessionWorktrees(projectRoot: string): Promise<WorktreeInfo[]> {
  const root = path.resolve(projectRoot);
  if (!(await isGitRepo(root))) return [];

  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      maxBuffer: 2_000_000,
    });

    const worktrees: WorktreeInfo[] = [];
    const entries = stdout.split("\n\n").filter(Boolean);

    for (const entry of entries) {
      const lines = entry.split("\n");
      let wtPath = "";
      let headCommit = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) wtPath = line.slice(9).trim();
        else if (line.startsWith("HEAD ")) headCommit = line.slice(5).trim();
        else if (line.startsWith("branch ")) branch = line.slice(7).replace("refs/heads/", "").trim();
      }

      if (wtPath && branch.startsWith("forgepilot/session-")) {
        const match = branch.match(/^forgepilot\/session-(.+)$/);
        const sessionId = match ? match[1] : path.basename(wtPath).replace(/^session-/, "");
        worktrees.push({
          sessionId,
          worktreePath: wtPath,
          branch,
          headCommit,
          isActive: existsSync(wtPath),
        });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

export async function mergeWorktreeToMain(
  projectRoot: string,
  sessionId: string,
  commitMessage?: string
): Promise<{ success: boolean; mergedBranch: string; error?: string }> {
  const root = path.resolve(projectRoot);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const branchName = `forgepilot/session-${safeSessionId}`;
  const worktreePath = path.join(getWorktreeBaseDir(root), `session-${safeSessionId}`);

  try {
    // 1. Commit any uncommitted changes in the worktree
    if (existsSync(worktreePath)) {
      try {
        await execFileAsync("git", ["add", "-A"], { cwd: worktreePath, maxBuffer: 1_000_000 });
        const status = (await execFileAsync("git", ["status", "--porcelain"], { cwd: worktreePath, maxBuffer: 500_000 })).stdout.trim();
        if (status) {
          const msg = commitMessage || `ForgePilot session ${sessionId} changes`;
          await execFileAsync("git", ["commit", "-m", msg], { cwd: worktreePath, maxBuffer: 1_000_000 });
        }
      } catch { /* proceed if nothing to commit */ }
    }

    // 2. Merge into active project root branch
    const targetBranch = await getCurrentBranch(root);
    await execFileAsync("git", ["merge", branchName, "--no-ff", "-m", commitMessage || `Merge ${branchName} into ${targetBranch}`], {
      cwd: root,
      maxBuffer: 2_000_000,
    });

    return { success: true, mergedBranch: branchName };
  } catch (error) {
    return {
      success: false,
      mergedBranch: branchName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function discardSessionWorktree(projectRoot: string, sessionId: string): Promise<boolean> {
  const root = path.resolve(projectRoot);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const worktreePath = path.join(getWorktreeBaseDir(root), `session-${safeSessionId}`);
  const branchName = `forgepilot/session-${safeSessionId}`;

  try {
    if (existsSync(worktreePath)) {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: root,
          maxBuffer: 1_000_000,
        });
      } catch {
        // Fallback manually remove folder
        await fs.rm(worktreePath, { recursive: true, force: true });
        await execFileAsync("git", ["worktree", "prune"], { cwd: root, maxBuffer: 500_000 });
      }
    }

    // Delete the branch
    try {
      await execFileAsync("git", ["branch", "-D", branchName], { cwd: root, maxBuffer: 500_000 });
    } catch { /* ignore if already gone */ }

    return true;
  } catch {
    return false;
  }
}

export async function getSessionWorktreeDiff(projectRoot: string, sessionId: string): Promise<WorkspaceDiffFile[]> {
  const wt = await getSessionWorktree(projectRoot, sessionId);
  if (!wt || !existsSync(wt.worktreePath)) return [];
  return getWorkspaceDiffFiles(wt.worktreePath);
}
