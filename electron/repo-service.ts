import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GITIGNORE_ENTRIES = [".nexus", ".forgepilot", ".deepagents", "node_modules", "dist", "dist-electron", "release", ".env"];

export async function hasGitBinary(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { maxBuffer: 100_000 });
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepoLocal(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: path.resolve(projectRoot),
      maxBuffer: 100_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function ensureLocalIdentity(root: string): Promise<void> {
  try {
    const { stdout: name } = await execFileAsync("git", ["config", "--get", "user.name"], { cwd: root, maxBuffer: 100_000 }).catch(() => ({ stdout: "" }) as never);
    if (!String(name || "").trim()) {
      await execFileAsync("git", ["config", "user.name", "nexus"], { cwd: root, maxBuffer: 100_000 });
    }
  } catch { /* best effort */ }
  try {
    const { stdout: email } = await execFileAsync("git", ["config", "--get", "user.email"], { cwd: root, maxBuffer: 100_000 }).catch(() => ({ stdout: "" }) as never);
    if (!String(email || "").trim()) {
      await execFileAsync("git", ["config", "user.email", "nexus@local"], { cwd: root, maxBuffer: 100_000 });
    }
  } catch { /* best effort */ }
}

async function ensureGitignore(root: string): Promise<void> {
  const ignorePath = path.join(path.resolve(root), ".gitignore");
  try {
    let existing = "";
    try {
      existing = await fs.readFile(ignorePath, "utf8");
    } catch {
      existing = "";
    }
    const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
    if (missing.length) {
      const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
      await fs.writeFile(ignorePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
    }
  } catch { /* best effort — never block project creation */ }
}

// Ensure every project is a git repo so diff/checkpoint/undo work everywhere.
// Best-effort: never throws for missing git binary or fs errors; callers
// proceed with a non-git project (undo then no-ops by design).
export async function ensureGitRepo(projectRoot: string): Promise<{ alreadyRepo: boolean; initialized: boolean }> {
  const root = path.resolve(projectRoot);
  try {
    await fs.mkdir(root, { recursive: true });
  } catch { /* ignore */ }
  if (!(await hasGitBinary())) return { alreadyRepo: false, initialized: false };
  if (await isGitRepoLocal(root)) {
    await ensureGitignore(root);
    return { alreadyRepo: true, initialized: false };
  }
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root, maxBuffer: 200_000 });
  } catch {
    // Older git without -b: fall back to plain init.
    try {
      await execFileAsync("git", ["init"], { cwd: root, maxBuffer: 200_000 });
    } catch {
      return { alreadyRepo: false, initialized: false };
    }
  }
  await ensureLocalIdentity(root);
  await ensureGitignore(root);
  return { alreadyRepo: false, initialized: true };
}

export async function getHeadCommit(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(projectRoot),
      maxBuffer: 100_000,
    });
    const head = stdout.trim();
    return head || null;
  } catch {
    return null; // unborn HEAD or non-git — caller treats as null baseline
  }
}

export function isNexusCommitMessage(message: string): boolean {
  return /^\s*nexus[\s(:-]/i.test(message || "");
}

async function commitsBetweenOldAndHead(root: string, oldHead: string | null, head: string): Promise<string[]> {
  try {
    const range = oldHead ? `${oldHead}..${head}` : head;
    const { stdout } = await execFileAsync("git", ["log", "--format=%s", range], { cwd: root, maxBuffer: 500_000 });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Auto-commit is scoped to isolated session worktrees only — never to the
// user's main working branch — so agent WIP can't pollute shared history.
// Returns the new HEAD or null when there was nothing to commit / on failure.
export async function commitSessionWork(worktreePath: string, message: string): Promise<string | null> {
  const root = path.resolve(worktreePath);
  try {
    if (!(await isGitRepoLocal(root))) return null;
    await ensureLocalIdentity(root);
    await execFileAsync("git", ["add", "-A"], { cwd: root, maxBuffer: 2_000_000 });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: root, maxBuffer: 500_000 });
    if (!status.trim()) return await getHeadCommit(root);
    // --no-verify/--no-gpg-sign: agent checkpoints must never block on hooks
    // or prompt for signing; failures are best-effort anyway.
    await execFileAsync("git", ["commit", "--no-verify", "--no-gpg-sign", "-m", message], { cwd: root, maxBuffer: 2_000_000 });
    return await getHeadCommit(root);
  } catch {
    return null;
  }
}

// Undo for the durable layer: reset to the pre-run HEAD, but ONLY when every
// commit since then is Nexus-owned. Mixed/user commits are left untouched
// (file-level checkpoint restore still applies separately).
export async function resetNexusCommitsOnly(worktreeOrRoot: string, preRunHead: string | null): Promise<boolean> {
  const root = path.resolve(worktreeOrRoot);
  try {
    if (!(await isGitRepoLocal(root))) return false;
    const head = await getHeadCommit(root);
    if (!head || head === preRunHead) return true; // nothing to reset (or unborn stays unborn)
    if (!preRunHead) return false; // unborn baseline + existing history — never wipe user commits
    const messages = await commitsBetweenOldAndHead(root, preRunHead, head);
    if (!messages.length) return true;
    if (!messages.every(isNexusCommitMessage)) return false;
    await execFileAsync("git", ["reset", "--hard", preRunHead], { cwd: root, maxBuffer: 500_000 });
    return true;
  } catch {
    return false;
  }
}
