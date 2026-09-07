import { promises as fs } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";

// Skills are plain folders containing a SKILL.md (name + description frontmatter,
// instructions below). Per-project skills live inside the repository; the global
// library lives in app data and is mounted into the agent's backend as
// /global-skills (see agent-service.ts).
//
// Project skills used to live in .deepagents/skills (a leftover from the
// library's default layout that Nexus never otherwise used — hence the empty
// folder on every project). They now live in .nexus/skills alongside all
// other Nexus telemetry; the old location is still READ (never written) so
// existing skills keep working.
export const PROJECT_SKILLS_DIR = ".nexus/skills";
const LEGACY_PROJECT_SKILLS_DIR = ".deepagents/skills";
export const GLOBAL_SKILLS_ROUTE = "/global-skills";

export type SkillInfo = { name: string; description: string; path: string; source: "global" | "project" };

export function globalSkillsDir() { return path.join(app.getPath("userData"), "skills"); }
export function projectSkillsDir(projectRoot: string) { return path.join(projectRoot, PROJECT_SKILLS_DIR); }
function legacyProjectSkillsDir(projectRoot: string) { return path.join(projectRoot, LEGACY_PROJECT_SKILLS_DIR); }

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
  // A name present in both project locations resolves to the new copy (which
  // is also where all writes go — legacy is never written anymore). Global
  // vs project duplicates keep the old behavior: both are listed.
  const seenProject = new Set<string>();
  // Project scope reads the new location first, then the legacy one.
  const roots: Array<{ root: string; scope: "global" | "project" }> = [{ root: globalSkillsDir(), scope: "global" }];
  if (projectRoot) {
    roots.push({ root: projectSkillsDir(projectRoot), scope: "project" });
    roots.push({ root: legacyProjectSkillsDir(projectRoot), scope: "project" });
  }
  for (const { root, scope } of roots) {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const info = await readSkillInfo(path.join(root, entry), scope);
        if (!info) continue;
        if (scope === "project") {
          if (seenProject.has(info.name)) continue;
          seenProject.add(info.name);
        }
        skills.push(info);
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

function validateSkillPathAllowed(skillPath: string, projectRoot?: string | null): string {
  const resolved = path.resolve(skillPath);
  const globalRoot = path.resolve(globalSkillsDir());
  const projectRootResolved = projectRoot ? path.resolve(projectSkillsDir(projectRoot)) : null;
  const legacyRootResolved = projectRoot ? path.resolve(legacyProjectSkillsDir(projectRoot)) : null;

  const isInsideGlobal = resolved === globalRoot || resolved.startsWith(`${globalRoot}${path.sep}`);
  const isInsideProject = projectRootResolved
    ? (resolved === projectRootResolved || resolved.startsWith(`${projectRootResolved}${path.sep}`))
    : /[\\/](\.deepagents|\.nexus|\.forgepilot)[\\/]skills([\\/]|$)/i.test(resolved);
  // Legacy project skills remain readable/deletable, never writable.
  const isInsideLegacy = legacyRootResolved
    ? (resolved === legacyRootResolved || resolved.startsWith(`${legacyRootResolved}${path.sep}`))
    : false;

  if (!isInsideGlobal && !isInsideProject && !isInsideLegacy) {
    throw new Error(`Security violation: skill path '${skillPath}' is outside the authorized skills directories.`);
  }
  return resolved;
}

export async function deleteSkill(skillPath: string, projectRoot?: string | null) {
  const validated = validateSkillPathAllowed(skillPath, projectRoot);
  const stat = await fs.stat(validated);
  let targetDir = validated;
  if (stat.isFile()) {
    targetDir = path.dirname(validated);
  }
  await fs.rm(targetDir, { recursive: true, force: true });
}

export async function readSkillContent(skillPath: string, projectRoot?: string | null): Promise<string> {
  const validated = validateSkillPathAllowed(skillPath, projectRoot);
  return fs.readFile(validated, "utf8");
}

const SKILL_STOPWORDS = new Set(
  "a,an,the,and,or,for,with,that,this,from,into,using,use,used,will,can,should,have,has,are,was,were,will,what,when,where,which,who,whom,how,does,doing,done,about,also,just,like,than,then,there,their,them,they,your,you,our,out,over,under,more,most,some,such,only,very,own,same,between,through,during,before,after,above,below,off,page".split(","),
);

/** Virtual path the agent uses to read a skill through its backend. */
export function skillVirtualPath(skill: SkillInfo): string {
  const folder = path.basename(path.dirname(skill.path));
  if (skill.source === "global") return `${GLOBAL_SKILLS_ROUTE}/${folder}/SKILL.md`;
  // Legacy skills still live under .deepagents/skills — the virtual path must
  // point at the real location or the backend read misses.
  const normalized = skill.path.replace(/\\/g, "/");
  const legacy = normalized.match(/\.deepagents\/skills\/([^/]+)\/SKILL\.md$/);
  if (legacy) return `${LEGACY_PROJECT_SKILLS_DIR}/${legacy[1]}/SKILL.md`;
  return `${PROJECT_SKILLS_DIR}/${folder}/SKILL.md`;
}

/**
 * Dev-vocabulary synonyms: requests say "app" where skills say "frontend",
 * users typo ("chating") where skills say "chatting". Each group expands a
 * request word to the terms skills actually use.
 */
const SKILL_SYNONYMS: Record<string, string[]> = {
  app: ["application", "frontend", "website", "web", "site", "ui", "client"],
  frontend: ["client", "ui", "react", "web", "nextjs"],
  backend: ["server", "api", "database", "endpoint", "nestjs"],
  chat: ["chatting", "conversation", "message", "messaging"],
  llm: ["ai", "model", "openai", "gpt", "anthropic", "Muse", "gemini"],
  settings: ["setting", "config", "configuration", "preferences", "options"],
  build: ["scaffold", "create", "generate", "bootstrap"],
  design: ["styling", "css", "ux", "accessibility", "a11y"],
  test: ["testing", "tests", "spec", "coverage"],
  auth: ["authentication", "login", "security"],
  deploy: ["deployment", "ci", "cd", "pipeline", "docker", "devops"],
  docs: ["documentation", "readme", "guide"],
};

const SKILL_SYNONYM_LOOKUP = new Map<string, string[]>();
for (const [key, variants] of Object.entries(SKILL_SYNONYMS)) {
  const group = [key, ...variants];
  for (const word of group) {
    if (!SKILL_SYNONYM_LOOKUP.has(word)) SKILL_SYNONYM_LOOKUP.set(word, group);
  }
}

function skillTokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Deterministic skill recommender: keyword overlap between the request and
 * each skill's name + description, with synonym expansion and substring
 * tolerance (typos, chat/chatting). Name hits weigh 3x. Never returns more
 * than maxN, never returns zero-score skills. Pure function of its inputs so
 * the agent gets a short, relevant shortlist instead of a 17-item catalog it
 * will ignore — and it works on weak models that skip catalogs entirely.
 */
export function recommendSkills(skills: SkillInfo[], request: string, maxN = 3): SkillInfo[] {
  const words = skillTokens(request).filter((w) => !SKILL_STOPWORDS.has(w));
  if (!words.length || !skills.length) return [];
  const expanded = new Set<string>();
  for (const w of words) {
    expanded.add(w);
    for (const v of SKILL_SYNONYM_LOOKUP.get(w) ?? []) expanded.add(v);
  }
  const scored = skills
    .map((skill) => {
      const nameTokens = skillTokens(skill.name);
      const descTokens = skillTokens(skill.description || "");
      let score = 0;
      for (const w of expanded) {
        if (nameTokens.includes(w)) score += 3;
        else if (nameTokens.some((t) => partialHit(t, w))) score += 2;
        else if (descTokens.includes(w)) score += 2;
        // No partial matching on descriptions: it fires on accidents like
        // "guide" in "guidelines" or "charting" near a "chating" typo.
      }
      return { skill, score };
    })
    // Minimum score 3 = at least one strong signal (a name hit) or two
    // weak ones. Single description-word hits (e.g. "fix" matching a skill
    // that merely mentions fixing) are noise that teaches the model to
    // ignore the recommender.
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxN));
  return scored.map((s) => s.skill);
}

/** Substring match gated on length so 3-letter tokens (api, ui, llm) only match exactly. */
function partialHit(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 4) return false;
  return a.includes(b) || b.includes(a);
}

