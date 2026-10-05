import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Project instruction files (OpenCode/Claude-Code-style memory):
 * user-authored markdown that is auto-loaded into every Code-mode run.
 *
 * Discovery order per level:
 * - Project: AGENTS.md, then CLAUDE.md (the cross-tool standard first so a
 *   repo carrying both for different tools doesn't double-inject).
 * - Global: ~/.nexus/AGENTS.md (user-level instructions across all projects).
 *
 * Both levels are independent: a repo with AGENTS.md still gets the global
 * file, matching Claude Code's user CLAUDE.md + project CLAUDE.md behavior.
 * Files are read at run start (cheap single reads) and capped — a runaway
 * instructions file must not consume the whole prompt budget.
 */

export const PROJECT_INSTRUCTIONS_CAP = 24000;

export type ProjectInstructionsFile = {
  path: string;
  source: "project" | "global";
  name: string;
  content: string;
  truncated: boolean;
};

export type ProjectInstructions = {
  files: ProjectInstructionsFile[];
  /** Ready-to-inject prompt section; "" when nothing was found. */
  section: string;
};

async function readCapped(filePath: string): Promise<{ content: string; truncated: boolean } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= PROJECT_INSTRUCTIONS_CAP) return { content: trimmed, truncated: false };
  return {
    content: `${trimmed.slice(0, PROJECT_INSTRUCTIONS_CAP)}\n\n[…instructions truncated at ${PROJECT_INSTRUCTIONS_CAP} characters — keep AGENTS.md under the cap so nothing is cut]`,
    truncated: true,
  };
}

const PROJECT_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const GLOBAL_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

export async function discoverProjectInstructions(projectRoot: string): Promise<ProjectInstructions> {
  const files: ProjectInstructionsFile[] = [];

  for (const name of PROJECT_CANDIDATES) {
    const filePath = path.join(projectRoot, name);
    const read = await readCapped(filePath);
    if (read) {
      files.push({ path: filePath, source: "project", name, content: read.content, truncated: read.truncated });
      break;
    }
  }

  const globalRoot = path.join(os.homedir(), ".nexus");
  for (const name of GLOBAL_CANDIDATES) {
    const filePath = path.join(globalRoot, name);
    const read = await readCapped(filePath);
    if (read) {
      files.push({ path: filePath, source: "global", name, content: read.content, truncated: read.truncated });
      break;
    }
  }

  return { files, section: buildInstructionsSection(files) };
}

export function buildInstructionsSection(files: ProjectInstructionsFile[]): string {
  if (!files.length) return "";
  const parts = files.map((file) => {
    const header = file.source === "project"
      ? `Instructions for this repository (${file.name} — user-authored, follow strictly; they override general preferences below):`
      : `User instructions (${file.name} — apply across all projects):`;
    return `${header}\n${file.content}`;
  });
  return `\n\n## Project Instructions\n${parts.join("\n\n")}\n`;
}
