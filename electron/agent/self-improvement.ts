import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { tool } from "../agentcore/tools.js";
import {
  createSkill,
  globalSkillsDir,
  projectSkillsDir,
  skillVirtualPath,
  upsertFrontmatterKey,
  type SkillInfo,
  type SkillMode,
} from "../skills-service.js";
import type { MemoryCandidate } from "../home-memory-service.js";
import type { CodeTaskJournal } from "../code-task-service.js";
import type { HomeTaskJournal } from "../home-task-service.js";

function normalizeSkillSlug(raw: string): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (cleaned.length >= 2) return cleaned;
  return "learned-workflow";
}

function buildLearnedSkillBody(name: string, description: string, instructions: string, modes: SkillMode[]): string {
  const cleanDesc = description.replace(/\s+/g, " ").trim().slice(0, 320);
  const cleanBody = instructions.trim();
  // Strip any caller-provided frontmatter so we guarantee consistent metadata.
  const withoutFm = cleanBody.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/m, "").trim();
  let body = `---\nname: ${name}\ndescription: ${cleanDesc}\n---\n\n${withoutFm}\n`;
  if (modes.length) {
    body = upsertFrontmatterKey(body, "modes", modes.join(", "));
  }
  return body;
}

/**
 * Self-improving `learn_skill` tool: allows Home and Code agents to persist
 * verified workflows, troubleshooting playbooks, and domain patterns as
 * reusable `SKILL.md` modules (created new or refined in place).
 */
export function createLearnSkillTool(options: {
  projectRoot: string;
  taskKind: "code" | "general";
  onLearned?: (info: { skill: SkillInfo; updated: boolean }) => void;
}) {
  return tool(
    async ({
      name,
      description,
      instructions,
      scope,
    }: {
      name: string;
      description: string;
      instructions: string;
      scope?: "project" | "global";
    }) => {
      try {
        const slug = normalizeSkillSlug(name);
        const isHome = options.taskKind === "general";
        // Project-scoped skills are strictly Code-mode-only (skills-service contract);
        // Home skills always live in the global library scoped to "home".
        const effectiveScope: "project" | "global" = isHome
          ? "global"
          : scope === "global" || !options.projectRoot
            ? "global"
            : "project";
        const modes: SkillMode[] = isHome ? ["home"] : ["code"];
        const body = buildLearnedSkillBody(slug, description, instructions, modes);

        const targetRoot = effectiveScope === "global" ? globalSkillsDir() : projectSkillsDir(options.projectRoot);
        const skillMdPath = path.join(targetRoot, slug, "SKILL.md");

        let exists = false;
        try {
          await fs.access(skillMdPath);
          exists = true;
        } catch {
          exists = false;
        }

        let skill: SkillInfo;
        if (exists) {
          await fs.writeFile(skillMdPath, body, "utf8");
          skill = {
            name: slug,
            description: description.replace(/\s+/g, " ").trim().slice(0, 320),
            path: skillMdPath,
            source: effectiveScope,
            modes,
          };
        } else {
          skill = await createSkill(options.projectRoot, {
            name: slug,
            description: description.replace(/\s+/g, " ").trim().slice(0, 320),
            scope: effectiveScope,
            content: body,
            modes,
          });
        }

        options.onLearned?.({ skill, updated: exists });
        const vpath = skillVirtualPath(skill);
        return `${exists ? "Updated" : "Created"} reusable skill "${skill.name}" (${effectiveScope} scope, mode: ${modes.join(",")}) at \`${vpath}\`. Future runs in this mode will automatically see and load it when relevant.`;
      } catch (error) {
        return `Failed to save learned skill: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "learn_skill",
      description:
        "Save or refine a reusable SKILL.md workflow when you discover a multi-step procedure, domain playbook, build/deploy recipe, or non-obvious troubleshooting pattern that will help future runs. Keep skills concise, actionable, and verified.",
      schema: z.object({
        name: z.string().min(2).max(64).describe("Short kebab-case skill name (e.g. 'electron-ipc-migration', 'executive-deck-workflow')."),
        description: z.string().min(10).max(320).describe("Specific trigger description explaining when future runs should load this skill."),
        instructions: z.string().min(20).describe("Step-by-step operational markdown instructions, exact commands, pitfalls to avoid, and verification steps."),
        scope: z.enum(["project", "global"]).optional().describe("Where to store the skill: 'project' (repo-local .nexus/skills, Code mode default) or 'global' (shared across workspaces, Home mode default)."),
      }),
    }
  );
}

/**
 * Deterministic post-run reflection (zero LLM calls): extracts high-confidence
 * facts and self-healing lessons directly from verified run telemetry.
 */
export function deriveDeterministicLessons(input: {
  taskKind: "code" | "general";
  supervisorRepairs: number;
  verification: string;
  codeJournal?: CodeTaskJournal | null;
  homeJournal?: HomeTaskJournal | null;
  existingMemory?: string;
}): MemoryCandidate[] {
  const existing = (input.existingMemory || "").toLowerCase();
  const out: MemoryCandidate[] = [];

  if (input.taskKind === "code" && input.codeJournal) {
    const passingCmds = (input.codeJournal.verification || [])
      .filter((v) => v.passed && v.command && v.command.length <= 100)
      .map((v) => v.command.trim());
    const uniquePassing = [...new Set(passingCmds)];
    for (const cmd of uniquePassing.slice(-2)) {
      const fact = `Verified working check command in this repository: \`${cmd}\``;
      if (!existing.includes(cmd.toLowerCase()) && !existing.includes(fact.toLowerCase())) {
        out.push({ category: "fact", fact: fact.slice(0, 200) });
      }
    }

    if (input.supervisorRepairs > 0 && input.verification === "passed") {
      const firstFail = input.codeJournal.verification.find((v) => !v.passed);
      if (firstFail) {
        const snippet = (firstFail.output || firstFail.command).replace(/\s+/g, " ").trim().slice(0, 110);
        const lesson = `Self-healed verification failure on \`${firstFail.command.slice(0, 50)}\` (${snippet}) — verify before finishing`.slice(0, 200);
        if (!existing.includes(lesson.toLowerCase())) {
          out.push({ category: "lesson", fact: lesson });
        }
      }
    }
  } else if (input.taskKind === "general" && input.homeJournal) {
    if (input.supervisorRepairs > 0 && input.verification === "passed" && input.homeJournal.outputs.length > 0) {
      const outNames = input.homeJournal.outputs.slice(0, 2).map((o) => path.basename(o)).join(", ");
      const lesson = `When producing ${outNames}, validate deliverable structure and content completeness directly before concluding`.slice(0, 200);
      if (!existing.includes(lesson.toLowerCase())) {
        out.push({ category: "lesson", fact: lesson });
      }
    }
  }

  return out;
}

/**
 * Decides whether a Code run merits a post-run LLM self-improvement / memory
 * extraction pass (mirrors `shouldExtractMemory` for Home runs).
 */
export function shouldExtractCodeMemory(
  request: string,
  response: string,
  opts: { repairs?: number; changedFilesCount?: number; toolCallCount?: number } = {}
): boolean {
  const req = (request || "").trim();
  const res = (response || "").trim();
  if (!req || !res || res.length > 16_000) return false;
  if ((opts.repairs ?? 0) > 0) return true;
  if (
    /\b(remember|always|never|convention|prefer|don't use|do not use|from now on|make sure to|our stack|we use|keep in mind|rule of thumb)\b/i.test(
      req
    )
  ) {
    return res.length >= 10;
  }
  return (opts.changedFilesCount ?? 0) >= 2 && res.length >= 120;
}

/**
 * Builds the post-run reflection & memory extraction prompt for both Home and
 * Code runs, including the `lesson` category for self-improvement.
 */
export function buildSelfImprovementExtractionPrompt(params: {
  taskKind: "code" | "general";
  request: string;
  response: string;
  repairs?: number;
  repairSummary?: string;
}): string {
  const scopeNote =
    params.taskKind === "code"
      ? "this software engineering repository"
      : "the user across future assistant chats";
  const categoryGuide =
    params.taskKind === "code"
      ? `'fact' (verified repo truths, commands, paths, env requirements), 'preference' (coding/style/testing conventions), 'context' (architectural decisions or active milestones), 'lesson' (root causes, pitfalls, or self-healing fixes learned from errors/repairs), or 'profile' (user's role)`
      : `'profile' (identity, role, background), 'preference' (tone, format, tools, language), 'fact' (durable personal/domain facts), 'lesson' (reusable workflow/quality lessons learned), or 'context' (ongoing projects/goals)`;
  const repairNote =
    (params.repairs ?? 0) > 0
      ? `\nSelf-healing repairs occurred (${params.repairs}x)${params.repairSummary ? `: ${params.repairSummary}` : ""}. If a concrete pitfall or fix pattern was discovered, capture it as a concise 'lesson'.`
      : "";

  return (
    `Reflect on this completed turn for ${scopeNote} and extract durable long-term memory candidates.\n` +
    `Return JSON ONLY: {"candidates":[{"category":"profile|preference|fact|context|lesson","fact":"..."}]}.\n` +
    `Categories: ${categoryGuide}.\n` +
    `Rules: at most 4 candidates; each fact one concise sentence (8-200 chars); durable and actionable for future runs.\n` +
    `NEVER include transient details: greetings, file diffs, line counts, tables, URLs, or one-off task output.\n` +
    `Return {"candidates":[]} when nothing durable was learned.${repairNote}\n\n` +
    `User: ${params.request.slice(0, 900)}\nAssistant: ${params.response.slice(0, 2600)}`
  );
}
