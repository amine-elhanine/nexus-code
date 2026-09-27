import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "@langchain/core/tools";
import electronPkg from "electron";
const app = (electronPkg as any)?.app || (electronPkg as any)?.default?.app;
const shell = (electronPkg as any)?.shell || (electronPkg as any)?.default?.shell;
import { z } from "zod";

// Skills are plain folders containing a SKILL.md (name + description frontmatter,
// instructions below). Per-project skills live inside the repository; the global
// library lives in app data and is mounted into the agent's backend as
// /global-skills (see agent-service.ts). Bundled system skills ship with the
// app, mount as /system-skills, and are invisible + read-only in the UI.
//
// Project skills used to live in .deepagents/skills (a leftover from the
// library's default layout that Nexus never otherwise used — hence the empty
// folder on every project). They now live in .nexus/skills alongside all
// other Nexus telemetry; the old location is still READ (never written) so
// existing skills keep working.
export const PROJECT_SKILLS_DIR = ".nexus/skills";
const LEGACY_PROJECT_SKILLS_DIR = ".deepagents/skills";
export const GLOBAL_SKILLS_ROUTE = "/global-skills";
export const SYSTEM_SKILLS_ROUTE = "/system-skills";

export type SkillInfo = { name: string; description: string; path: string; source: "global" | "project" | "system"; modes: SkillMode[] };

/** Agent modes a skill may serve. Empty `modes` on a skill = all modes. */
export type SkillMode = "home" | "code" | "notebook";
export const ALL_SKILL_MODES: SkillMode[] = ["home", "code", "notebook"];

/** Normalizes frontmatter/user input ("home,code", ["home"], "all", "") → modes. [] means all modes. */
export function normalizeSkillModes(value: unknown): SkillMode[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const cleaned = parts
    .map((part) => String(part || "").trim().toLowerCase())
    .filter((part): part is SkillMode => (ALL_SKILL_MODES as string[]).includes(part));
  if (!cleaned.length) return [];
  if (cleaned.length >= ALL_SKILL_MODES.length) return [];
  return [...new Set(cleaned)];
}

/** True when the skill may be used in the given mode ([] = all modes). */
export function skillAppliesToMode(skill: Pick<SkillInfo, "modes">, mode: SkillMode): boolean {
  const modes = skill.modes || [];
  return modes.length === 0 || modes.includes(mode);
}

export function globalSkillsDir() {
  if (app?.getPath) return path.join(app.getPath("userData"), "skills");
  return path.join(process.cwd(), ".nexus", "skills");
}

/**
 * Bundled system skills shipped with the app (electron/system-skills/ copied
 * next to the compiled backend). Read-only at runtime, invisible in the
 * settings UI, and unreachable by the edit/delete/modes IPC (path validation
 * only allows the global/project libraries).
 */
export function systemSkillsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "system-skills");
}

/** System skills only — never listed in the UI, never user-editable. Layout:
 *  system-skills/{all,home,code,notebook}/<skill-name>/SKILL.md. The folder
 *  sets the scope (all/ = every mode); an explicit `modes:` frontmatter key
 *  overrides the folder for subset combos (e.g. home+notebook). */
export async function listSystemSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  const modeFolders: Array<{ dir: string; modes: SkillMode[] }> = [
    { dir: "all", modes: [] },
    { dir: "home", modes: ["home"] },
    { dir: "code", modes: ["code"] },
    { dir: "notebook", modes: ["notebook"] },
  ];
  for (const { dir, modes: folderModes } of modeFolders) {
    const modeRoot = path.join(systemSkillsDir(), dir);
    let entries: string[];
    try {
      entries = (await fs.readdir(modeRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const info = await readSkillInfo(path.join(modeRoot, entry), "system");
        if (!info) continue;
        const content = await fs.readFile(info.path, "utf8").catch(() => "");
        const parsed = parseSkillModes(content);
        info.modes = parsed.explicit ? parsed.modes : folderModes;
        skills.push(info);
      } catch { /* skip unreadable skill folders */ }
    }
  }
  return skills;
}

/** Parses the `modes:` frontmatter key, reporting whether it was declared. */
export function parseSkillModes(content: string): { modes: SkillMode[]; explicit: boolean } {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter || frontmatter.modes === undefined) return { modes: [], explicit: false };
  return { modes: normalizeSkillModes(frontmatter.modes), explicit: true };
}

/**
 * Direct skill-directory virtual path for framework skill loading. Unlike the
 * mounted parent directories (which expose every skill), passing these lets
 * the loader see exactly the eligible skills — this is what enforces
 * per-skill mode scoping. Detected automatically (SKILL.md at the root).
 */
export function skillDirVirtualPath(skill: SkillInfo): string {
  const file = skillVirtualPath(skill);
  return file.endsWith("/SKILL.md") ? file.slice(0, -"SKILL.md".length) : `${file}/`;
}
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

async function readSkillInfo(skillDir: string, source: SkillInfo["source"]): Promise<SkillInfo | null> {
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
    modes: parseSkillModes(content).modes,
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

export async function createSkill(projectRoot: string, input: { name: string; description?: string; scope: "global" | "project"; content?: string; modes?: unknown }): Promise<SkillInfo> {
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
  const modes = normalizeSkillModes(input.modes);
  const defaultBody = `---
name: ${name}
description: ${description}
---

# ${name}

Write step-by-step instructions for the agent here. Keep them concrete: which files
to inspect, what commands to run, and what the finished result should look like.
`;
  const rawBody = input.content?.trim() || defaultBody;
  const body = modes.length ? upsertFrontmatterKey(rawBody, "modes", modes.join(", ")) : rawBody;
  await fs.writeFile(skillMdPath, body, "utf8");
  return { name, description, path: skillMdPath, source: input.scope, modes };
}

/** Inserts or replaces a frontmatter key, preserving every other line. */
export function upsertFrontmatterKey(content: string, key: string, value: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = `${key}: ${value}`;
  if (!match) return `---\n${line}\n---\n\n${content}`;
  const lines = match[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`, "i").test(l));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return `---\n${lines.join("\n")}\n---${content.slice(match[0].length)}`;
}

/**
 * Sets which agent modes may use a skill. Stored in SKILL.md frontmatter as
 * `modes: home, code` (or `modes: all`). Empty = all modes.
 */
export async function setSkillModes(skillPath: string, modes: unknown, projectRoot?: string | null): Promise<SkillInfo> {
  const normalized = normalizeSkillModes(modes);
  const validated = validateSkillPathAllowed(skillPath, projectRoot);
  const stat = await fs.stat(validated);
  const skillMd = stat.isDirectory() ? path.join(validated, "SKILL.md") : validated;
  await fs.access(skillMd);
  const content = await fs.readFile(skillMd, "utf8");
  const next = upsertFrontmatterKey(content, "modes", normalized.length ? normalized.join(", ") : "all");
  await fs.writeFile(skillMd, next, "utf8");
  const dir = path.dirname(skillMd);
  const globalRoot = path.resolve(globalSkillsDir());
  const source: "global" | "project" = path.resolve(dir).startsWith(`${globalRoot}${path.sep}`) ? "global" : "project";
  const info = await readSkillInfo(dir, source);
  if (!info) throw new Error("Skill not found after saving modes.");
  return info;
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
    // Zipped skill packs (markdown + helper scripts + resources) extract to a
    // temp dir first, then flow through the regular directory importer below.
    if (/\.zip$/i.test(source)) {
      const { extractSkillArchive } = await import("./skill-archive.js");
      const buffer = await fs.readFile(source);
      const { dir, cleanup } = await extractSkillArchive(buffer);
      try {
        return await importSkill(projectRoot, dir, scope);
      } finally {
        await cleanup();
      }
    }
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
      modes: normalizeSkillModes(parseFrontmatter(finalBody)?.modes),
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

    const importedContent = await fs.readFile(targetSkillMd, "utf8").catch(() => "");
    return {
      name,
      description,
      path: targetSkillMd,
      source: scope,
      modes: normalizeSkillModes(parseFrontmatter(importedContent)?.modes),
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

function validateSkillPathAllowed(skillPath: string, projectRoot?: string | null, allowSystem = false): string {
  const resolved = path.resolve(skillPath);
  const globalRoot = path.resolve(globalSkillsDir());
  const projectRootResolved = projectRoot ? path.resolve(projectSkillsDir(projectRoot)) : null;
  const legacyRootResolved = projectRoot ? path.resolve(legacyProjectSkillsDir(projectRoot)) : null;
  const sysRoot = path.resolve(systemSkillsDir());

  const isInsideGlobal = resolved === globalRoot || resolved.startsWith(`${globalRoot}${path.sep}`);
  // Project skills only exist relative to a REAL project root. The old
  // no-project fallback (a regex over the whole path) accepted any directory
  // shaped like `.nexus/skills` anywhere on disk.
  const isInsideProject = projectRootResolved
    ? (resolved === projectRootResolved || resolved.startsWith(`${projectRootResolved}${path.sep}`))
    : false;
  // Legacy project skills remain readable/deletable, never writable.
  const isInsideLegacy = legacyRootResolved
    ? (resolved === legacyRootResolved || resolved.startsWith(`${legacyRootResolved}${path.sep}`))
    : false;
  const isInsideSystem = allowSystem && (resolved === sysRoot || resolved.startsWith(`${sysRoot}${path.sep}`));

  if (!isInsideGlobal && !isInsideProject && !isInsideLegacy && !isInsideSystem) {
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
  const validated = validateSkillPathAllowed(skillPath, projectRoot, true);
  return fs.readFile(validated, "utf8");
}

export async function listAllSkills(projectRoot?: string | null): Promise<SkillInfo[]> {
  const userSkills = await listSkills(projectRoot);
  const sysSkills = await listSystemSkills().catch(() => []);
  return [...userSkills, ...sysSkills];
}

const SKILL_STOPWORDS = new Set(
  "a,an,the,and,or,for,with,that,this,from,into,using,use,used,will,can,should,have,has,are,was,were,will,what,when,where,which,who,whom,how,does,doing,done,about,also,just,like,than,then,there,their,them,they,your,you,our,out,over,under,more,most,some,such,only,very,own,same,between,through,during,before,after,above,below,off,page".split(","),
);

/** Virtual path the agent uses to read a skill through its backend. */
export function skillVirtualPath(skill: SkillInfo): string {
  const folder = path.basename(path.dirname(skill.path));
  if (skill.source === "global") return `${GLOBAL_SKILLS_ROUTE}/${folder}/SKILL.md`;
  if (skill.source === "system") {
    // System skills nest one level deeper (system-skills/<mode>/<skill>).
    const rel = path.relative(systemSkillsDir(), skill.path).replace(/\\/g, "/");
    return `${SYSTEM_SKILLS_ROUTE}/${rel}`;
  }
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
export function recommendSkills(skills: SkillInfo[], request: string, maxN = 3, mode?: SkillMode): SkillInfo[] {
  const eligible = mode ? skills.filter((s) => skillAppliesToMode(s, mode)) : skills;
  const words = skillTokens(request).filter((w) => !SKILL_STOPWORDS.has(w));
  if (!words.length || !eligible.length) return [];
  const expanded = new Set<string>();
  for (const w of words) {
    expanded.add(w);
    for (const v of SKILL_SYNONYM_LOOKUP.get(w) ?? []) expanded.add(v);
  }
  const scored = eligible
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

// ---- Skill helper scripts ----

export const SKILL_SOURCE_PRIORITY: Record<SkillInfo["source"], number> = { project: 0, global: 1, system: 2 };
const SKILL_COPY_TOTAL_CAP = 8 * 1024 * 1024;

async function copySkillDir(src: string, dest: string, budget: { remaining: number }, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        await fs.mkdir(to, { recursive: true });
        await copySkillDir(from, to, budget, out);
      } else if (entry.isFile()) {
        const stat = await fs.stat(from);
        if (stat.size > budget.remaining) continue;
        await fs.copyFile(from, to);
        budget.remaining -= stat.size;
        out.push(to);
      }
    } catch { /* one bad file never fails the copy */ }
  }
}

function sanitizeSkillDest(raw: unknown, skillName: string): string {
  const fallback = path.join(".skills", sanitizeSkillName(skillName));
  const cleaned = String(raw || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = cleaned.split("/").filter((p) => p && p !== "." && p !== "..");
  if (!parts.length) return fallback;
  return path.join(...parts);
}

/**
 * Agent tool: materializes a skill's bundled files (helper scripts, templates,
 * resources) into the workspace so they can be executed. Skill folders are
 * mounted read-only (global/system) or live outside the run cwd, and shell
 * commands run in the workspace root — so scripts must be copied first, then
 * run via the returned workspace-relative paths with execute. Only skills
 * eligible for the current mode are visible here (pass the filtered catalog).
 */
export function createSkillFilesTool(eligibleSkills: SkillInfo[], workspaceRoot: string) {
  const root = path.resolve(workspaceRoot);
  return tool(async ({ skill: name, dest }: { skill: string; dest?: string }) => {
    const query = String(name || "").trim().toLowerCase();
    if (!query) return "Skill name is empty.";
    const byPriority = (a: SkillInfo, b: SkillInfo) => SKILL_SOURCE_PRIORITY[a.source] - SKILL_SOURCE_PRIORITY[b.source];
    const match =
      eligibleSkills.filter((s) => s.name.toLowerCase() === query).sort(byPriority)[0] ||
      eligibleSkills.filter((s) => s.name.toLowerCase().includes(query)).sort(byPriority)[0];
    if (!match) return `Skill "${name}" not found among the skills available in this mode.`;
    const rel = sanitizeSkillDest(dest, match.name);
    const target = path.join(root, rel);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return "Destination escapes the workspace — pick a relative folder.";
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    const copied: string[] = [];
    await copySkillDir(path.dirname(match.path), target, { remaining: SKILL_COPY_TOTAL_CAP }, copied);
    const files = copied.map((p) => path.relative(root, p).replace(/\\/g, "/")).slice(0, 100);
    return JSON.stringify({ dest: rel.replace(/\\/g, "/"), source: match.source, files });
  }, {
    name: "materialize_skill_files",
    description: "Copy an installed skill's bundled files (helper scripts, templates, resources) into the workspace so you can run them. Use this when a SKILL.md instructs you to run its scripts: skill folders are read-only and shell commands run in the workspace root, so copy first, then execute via the returned workspace-relative paths.",
    schema: z.object({ skill: z.string().min(1), dest: z.string().optional() }),
  });
}

/**
 * Builds the CompositeBackend routes mapping for global and system skills.
 * Registers singular and plural, leading slash and non-leading slash, as well as
 * trailing slash variants so that DeepAgents CompositeBackend path resolution
 * never generates double slashes or misses virtual route prefixes on Windows or POSIX.
 * Also sanitizes `resolvePath` on virtual backends so multi-slash paths (`//...`)
 * never escape root directory.
 */
export function buildSkillMounts(globalBackend?: any, systemBackend?: any): Record<string, any> {
  const mounts: Record<string, any> = {};
  const sanitizeBackend = (b: any) => {
    if (!b || typeof b !== "object") return;
    const origResolve = b.resolvePath?.bind(b);
    if (typeof origResolve === "function" && !b.__nexus_sanitized_resolve) {
      b.resolvePath = (key: string) => {
        const sanitized = "/" + String(key || "").replace(/^[/\\]+/, "");
        return origResolve(sanitized);
      };
      b.__nexus_sanitized_resolve = true;
    }
  };

  if (globalBackend) {
    sanitizeBackend(globalBackend);
    const globalPrefixes = [
      "/global-skills",
      "/global-skill",
      "global-skills",
      "global-skill",
      "//global-skills",
      "//global-skill",
    ];
    for (const prefix of globalPrefixes) {
      mounts[prefix] = globalBackend;
      mounts[`${prefix}/`] = globalBackend;
    }
  }

  if (systemBackend) {
    sanitizeBackend(systemBackend);
    const systemPrefixes = [
      "/system-skills",
      "/system-skill",
      "system-skills",
      "system-skill",
      "//system-skills",
      "//system-skill",
    ];
    for (const prefix of systemPrefixes) {
      mounts[prefix] = systemBackend;
      mounts[`${prefix}/`] = systemBackend;
    }
  }

  return mounts;
}
