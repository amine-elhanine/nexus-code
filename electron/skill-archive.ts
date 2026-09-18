import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Zip import for uploaded skills: a skill may be a single .md file, a folder,
// or a .zip containing markdown plus helper scripts and resources. This module
// is deliberately Electron-free so plain-node unit tests can cover it.

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_FIND_DEPTH = 3;

export type ExtractedSkillSource = { dir: string; cleanup: () => Promise<void> };

function cleanEntryParts(relPath: string): string[] | null {
  const clean: string[] = [];
  for (const part of relPath.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    // Reject traversal, junk metadata and hidden VCS dirs outright.
    if (part === ".." || part === "__MACOSX" || part === ".DS_Store" || part === ".git") return null;
    clean.push(part);
  }
  if (!clean.length) return null;
  return clean;
}

async function findFiles(root: string, matches: (name: string) => boolean, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isFile() && matches(entry.name)) found.push(abs);
      else if (entry.isDirectory() && depth < maxDepth) await walk(abs, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

function shallowestDir(paths: string[]): string {
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  return path.dirname(sorted[0]);
}

/**
 * Extracts a skill .zip into a temp dir and resolves the skill root: the
 * shallowest folder containing SKILL.md, else the shallowest folder with any
 * markdown file (the directory importer turns a lone .md into SKILL.md).
 * Throws on invalid/empty archives, zip-slip paths and size caps.
 */
export async function extractSkillArchive(buffer: Buffer): Promise<ExtractedSkillSource> {
  if (!buffer.length) throw new Error("Skill archive is empty.");
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Skill archive is too large (${Math.round(buffer.length / 1024 / 1024)} MB). Max 25 MB.`);
  }
  const mod: any = await import("jszip");
  const zip: any = await new mod.default().loadAsync(buffer).catch(() => {
    throw new Error("Not a valid zip archive.");
  });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-skill-zip-"));
  const cleanup = async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  };
  try {
    const pending: Array<{ abs: string; entry: any }> = [];
    let names = 0;
    zip.forEach((relPath: string, entry: any) => {
      if (entry && entry.dir) return;
      const parts = cleanEntryParts(relPath);
      if (!parts) return;
      names++;
      pending.push({ abs: path.join(tmp, ...parts), entry });
    });
    if (names > MAX_ENTRIES) throw new Error(`Skill archive has too many files (${names}). Max ${MAX_ENTRIES}.`);
    if (!pending.length) throw new Error("Skill archive contains no usable files.");
    let total = 0;
    for (const { abs, entry } of pending) {
      if (abs !== tmp && !abs.startsWith(`${tmp}${path.sep}`)) throw new Error("Skill archive contains unsafe paths.");
      const content: Buffer = await entry.async("nodebuffer");
      total += content.length;
      if (total > MAX_EXTRACTED_BYTES) throw new Error("Skill archive extracts to too much data (max 100 MB).");
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    const skillMds = await findFiles(tmp, (name) => name.toLowerCase() === "skill.md", MAX_FIND_DEPTH);
    if (skillMds.length) return { dir: shallowestDir(skillMds), cleanup };
    const anyMd = await findFiles(tmp, (name) => /\.(md|markdown|txt)$/i.test(name), MAX_FIND_DEPTH);
    if (anyMd.length) return { dir: shallowestDir(anyMd), cleanup };
    throw new Error("No SKILL.md or markdown file found in the archive.");
  } catch (error) {
    await cleanup();
    throw error;
  }
}
