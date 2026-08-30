import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-electron",
  ".next",
  ".turbo",
  "coverage",
  ".DS_Store",
]);

function safePath(projectRoot: string, requested: string) {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, requested || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the selected project root.");
  }
  return candidate;
}

async function walk(root: string, current = root, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute) || ".";
    output.push(entry.isDirectory() ? `${relative}/` : relative);
    if (entry.isDirectory()) output.push(...(await walk(root, absolute, depth + 1)));
  }
  return output;
}

export async function listWorkspaceFiles(projectRoot: string) {
  return (await walk(projectRoot)).slice(0, 800);
}

export async function readWorkspaceFile(projectRoot: string, file: string) {
  const target = safePath(projectRoot, file);
  const content = await fs.readFile(target, "utf8");
  return { file, content, lines: content.split(/\r?\n/).length };
}

export async function writeWorkspaceFile(projectRoot: string, file: string, content: string) {
  const target = safePath(projectRoot, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return { file, content, lines: content.split(/\r?\n/).length };
}

export async function getWorkspaceGit(projectRoot: string) {
  try {
    const [{ stdout: branch }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd: projectRoot, maxBuffer: 200000 }),
      execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd: projectRoot, maxBuffer: 200000 }),
    ]);
    const lines = status.trim().split(/\r?\n/).filter(Boolean);
    return { isRepository: true, branch: branch.trim() || "HEAD", status: lines.slice(1), aheadBehind: lines[0] || "" };
  } catch {
    return { isRepository: false, branch: "No Git repository", status: [], aheadBehind: "" };
  }
}
