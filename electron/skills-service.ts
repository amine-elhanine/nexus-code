import { promises as fs } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";

// Skills are plain folders containing a SKILL.md (name + description frontmatter,
// instructions below). Per-project skills live inside the repository; the global
// library lives in app data and is mounted into the agent's backend as
// /global-skills (see agent-service.ts).
export const PROJECT_SKILLS_DIR = ".deepagents/skills";
export const GLOBAL_SKILLS_ROUTE = "/global-skills";

export type SkillInfo = { name: string; description: string; path: string; source: "global" | "project" };

export function globalSkillsDir() { return path.join(app.getPath("userData"), "skills"); }
export function projectSkillsDir(projectRoot: string) { return path.join(projectRoot, PROJECT_SKILLS_DIR); }

function skillsRootFor(scope: "global" | "project", projectRoot: string) {
  return scope === "global" ? globalSkillsDir() : projectSkillsDir(projectRoot);
}

// Minimal frontmatter reader: the agent only needs name/description, and a
// forgiving parser keeps half-written SKILL.md files from breaking the list.
function parseFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (pair) result[pair[1].trim()] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

async function readSkillInfo(skillDir: string, source: "global" | "project"): Promise<SkillInfo | null> {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  try {
    const stat = await fs.stat(skillMdPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const content = await fs.readFile(skillMdPath, "utf8");
  const frontmatter = parseFrontmatter(content);
  return {
    name: frontmatter?.name || path.basename(skillDir),
    description: frontmatter?.description || "",
    path: skillMdPath,
    source,
  };
}

export async function listSkills(projectRoot?: string | null): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  const scopes: ("global" | "project")[] = projectRoot ? ["global", "project"] : ["global"];
  for (const scope of scopes) {
    const root = skillsRootFor(scope, projectRoot || "");
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const info = await readSkillInfo(path.join(root, entry), scope);
        if (info) skills.push(info);
      } catch { /* skip unreadable skill folders */ }
    }
  }
  return skills;
}

export async function createSkill(projectRoot: string, input: { name: string; description?: string; scope: "global" | "project"; content?: string }): Promise<SkillInfo> {
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(name)) throw new Error("Skill names must be 2-64 letters, numbers, dashes or underscores.");
  const skillDir = path.join(skillsRootFor(input.scope, projectRoot), name);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  try {
    await fs.access(skillMdPath);
    throw new Error(`A skill named "${name}" already exists in the ${input.scope} library.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }
  await fs.mkdir(skillDir, { recursive: true });
  const description = input.description?.trim() || "Describe when the agent should use this skill — be specific so it triggers reliably.";
  const body = input.content?.trim() || `---
name: ${name}
description: ${description}
---

# ${name}

Write step-by-step instructions for the agent here. Keep them concrete: which files
to inspect, what commands to run, and what the finished result should look like.
`;
  await fs.writeFile(skillMdPath, body, "utf8");
  return { name, description, path: skillMdPath, source: input.scope };
}

function sanitizeSkillName(raw: string): string {
  const clean = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || "custom-skill";
}

export async function importSkill(projectRoot: string, sourcePath: string, scope: "global" | "project"): Promise<SkillInfo> {
  const source = path.resolve(sourcePath);
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new Error(`The selected Skill path does not exist: ${sourcePath}`);
  }

  const destinationRoot = skillsRootFor(scope, projectRoot);
  await fs.mkdir(destinationRoot, { recursive: true });

  if (stat.isFile()) {
    const content = await fs.readFile(source, "utf8");
    const metadata = parseFrontmatter(content);
    const baseWithoutExt = path.basename(source, path.extname(source));
    const rawName = metadata?.name || (baseWithoutExt.toLowerCase() === "skill" ? path.basename(path.dirname(source)) : baseWithoutExt);
    const name = sanitizeSkillName(rawName);
    const description = metadata?.description || `Imported from ${path.basename(source)}`;

    const targetDir = path.join(destinationRoot, name);
    await fs.mkdir(targetDir, { recursive: true });
    const targetSkillMd = path.join(targetDir, "SKILL.md");

    let finalBody = content;
    if (!metadata) {
      finalBody = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;
    }
    await fs.writeFile(targetSkillMd, finalBody, "utf8");

    return {
      name,
      description,
      path: targetSkillMd,
      source: scope,
    };
  }

  if (stat.isDirectory()) {
    const entries = await fs.readdir(source);
    let skillFileName = entries.find((f) => f.toLowerCase() === "skill.md");
    if (!skillFileName) {
      skillFileName = entries.find((f) => f.toLowerCase().endsWith(".md") || f.toLowerCase().endsWith(".markdown") || f.toLowerCase().endsWith(".txt"));
    }

    let rawName = path.basename(source);
    let description = `Imported skill folder ${path.basename(source)}`;

    if (skillFileName) {
      try {
        const fileContent = await fs.readFile(path.join(source, skillFileName), "utf8");
        const metadata = parseFrontmatter(fileContent);
        if (metadata?.name) rawName = metadata.name;
        if (metadata?.description) description = metadata.description;
      } catch {
        // ignore read error, fallback to folder name
      }
    }

    const name = sanitizeSkillName(rawName);
    const targetDir = path.join(destinationRoot, name);

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.cp(source, targetDir, { recursive: true });

    const targetSkillMd = path.join(targetDir, "SKILL.md");
    try {
      await fs.access(targetSkillMd);
    } catch {
      if (skillFileName) {
        const foundPath = path.join(targetDir, skillFileName);
        const mdContent = await fs.readFile(foundPath, "utf8");
        const metadata = parseFrontmatter(mdContent);
        let finalBody = mdContent;
        if (!metadata) {
          finalBody = `---\nname: ${name}\ndescription: ${description}\n---\n\n${mdContent}`;
        }
        await fs.writeFile(targetSkillMd, finalBody, "utf8");
      } else {
        const body = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nImported skill instructions from folder.\n`;
        await fs.writeFile(targetSkillMd, body, "utf8");
      }
    }

    return {
      name,
      description,
      path: targetSkillMd,
      source: scope,
    };
  }

  throw new Error("The selected Skill source is not a valid file or directory.");
}

export async function ensureSkillSourceDirs(projectRoot?: string | null) {
  await fs.mkdir(globalSkillsDir(), { recursive: true });
  if (projectRoot) {
    await fs.mkdir(projectSkillsDir(projectRoot), { recursive: true });
  }
}

export async function openSkillsFolder(scope: "global" | "project", projectRoot: string) {
  const root = skillsRootFor(scope, projectRoot);
  await fs.mkdir(root, { recursive: true });
  const errorMessage = await shell.openPath(root);
  if (errorMessage) throw new Error(errorMessage);
}

export async function deleteSkill(skillPath: string) {
  const stat = await fs.stat(skillPath);
  let targetDir = skillPath;
  if (stat.isFile()) {
    targetDir = path.dirname(skillPath);
  }
  await fs.rm(targetDir, { recursive: true, force: true });
}

export async function readSkillContent(skillPath: string): Promise<string> {
  return fs.readFile(skillPath, "utf8");
}

