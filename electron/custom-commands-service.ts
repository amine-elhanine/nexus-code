import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CustomSlashCommand {
  command: string;          // e.g. "/review"
  name: string;             // e.g. "Code Review"
  description: string;      // e.g. "Run an in-depth security and quality review"
  mode?: "plan" | "ask" | "auto";
  promptTemplate: string;   // Prompt text with optional placeholders
  source: "builtin" | "project";
  filePath?: string;
  /** Which assistant area may use the command. Absent = all areas. */
  scope?: CommandScope;
}

/** Assistant area a command may serve. Mirrors the system-skills folder convention. */
export type CommandScope = "all" | "home" | "code" | "notebook";
export const ALL_COMMAND_SCOPES: CommandScope[] = ["all", "home", "code", "notebook"];

/** Normalizes frontmatter/user input ("home,code", ["home"], "all", "") → scope. "all" means every area. */
export function normalizeCommandScope(value: unknown): CommandScope {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const cleaned = parts.map((part) => String(part || "").trim().toLowerCase());
  if (cleaned.includes("all") || cleaned.length === 0) return "all";
  const known = cleaned.find((part): part is CommandScope =>
    (["home", "code", "notebook"] as string[]).includes(part));
  return known ?? "all";
}

/** True when the command may be used in the given area ("all" = every area). */
export function commandAppliesToScope(cmd: Pick<CustomSlashCommand, "scope">, scope: Exclude<CommandScope, "all">): boolean {
  const s = cmd.scope ?? "all";
  return s === "all" || s === scope;
}

export function systemCommandsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "system-commands");
}

const MAX_COMMAND_FILE_BYTES = 100_000;
const MAX_COMMAND_PROMPT_CHARS = 20_000;
const VALID_COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

async function isInsideProject(projectRoot: string, candidate: string): Promise<boolean> {
  try {
    const root = await fs.realpath(path.resolve(projectRoot));
    const actual = await fs.realpath(candidate);
    return actual === root || actual.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

export const BUILTIN_COMMANDS: CustomSlashCommand[] = [
  {
    command: "/plan",
    name: "Plan Mode",
    description: "Switch to Plan mode for multi-step reasoning before making edits",
    mode: "plan",
    promptTemplate: "Create an implementation plan for: {{input}}",
    source: "builtin",
  },
  {
    command: "/auto",
    name: "Auto Mode",
    description: "Autonomous end-to-end implementation and verification",
    mode: "auto",
    promptTemplate: "{{input}}",
    source: "builtin",
  },
  {
    command: "/ask",
    name: "Ask Mode",
    description: "Ask questions or investigate without making file modifications",
    mode: "ask",
    promptTemplate: "{{input}}",
    source: "builtin",
  },
  {
    command: "/review",
    name: "Code Review",
    description: "Perform an in-depth code review on active file or recent changes",
    mode: "ask",
    promptTemplate: "Review the code in {{activeFile}} and the current Git diff. Check for bugs, edge cases, performance bottlenecks, and security vulnerabilities.",
    source: "builtin",
  },
  {
    command: "/test",
    name: "Run Verification Tests",
    description: "Execute project tests and verify workspace integrity",
    mode: "auto",
    promptTemplate: "Run the project's test suite and verification commands. If any test fails, analyze the root cause and propose or apply fixes.",
    source: "builtin",
  },
  {
    command: "/refactor",
    name: "Refactor Code",
    description: "Refactor selected file or logic for readability and simplicity",
    mode: "auto",
    promptTemplate: "Refactor {{activeFile}} to improve readability, remove duplication, and enhance maintainability while preserving exact behavior.",
    source: "builtin",
  },
  {
    command: "/docs",
    name: "Generate Documentation",
    description: "Generate comprehensive docstrings, README, or API docs",
    mode: "auto",
    promptTemplate: "Generate clear, production-grade documentation and type docstrings for {{activeFile}}.",
    source: "builtin",
  },
  {
    command: "/security",
    name: "Security Audit",
    description: "Audit workspace for injection, auth, and dependency risks",
    mode: "ask",
    promptTemplate: "Perform a security audit of the workspace. Check for injection risks, unsanitized inputs, sensitive credential exposure, and unsafe dependencies.",
    source: "builtin",
  },
  {
    command: "/checkpoint",
    name: "Workspace Checkpoint",
    description: "Inspect checkpoint rollback status and git diff",
    mode: "ask",
    promptTemplate: "Inspect current workspace checkpoint and review all changes made in this session.",
    source: "builtin",
  },
  {
    command: "/tdd",
    name: "TDD Workflow",
    description: "Enforce Test-Driven Development (RED-GREEN-REFACTOR cycle with 80%+ coverage)",
    mode: "auto",
    promptTemplate: "Follow the TDD workflow for: {{input}}. 1) Write failing tests first (RED). 2) Run tests to confirm failure. 3) Implement minimal code to pass tests (GREEN). 4) Refactor for cleanliness and maintainability (REFACTOR). Verify 80%+ test coverage.",
    source: "builtin",
  },
  {
    command: "/quality-gate",
    name: "Quality Gate",
    description: "Run multi-tier quality checks: typecheck, lint, security audit, and test suite",
    mode: "auto",
    promptTemplate: "Run the full quality gate on the repository: 1) Run typecheck and syntax verification. 2) Run linting. 3) Check for hardcoded secrets and security issues. 4) Run the test suite. Report any failing checks and fix them.",
    source: "builtin",
  },
  {
    command: "/build-fix",
    name: "Build Fixer",
    description: "Diagnose and fix compiler errors, type errors, and bundler failures",
    mode: "auto",
    promptTemplate: "Diagnose and resolve build or compilation errors for the project. Run the build/check command, analyze failure logs, and incrementally fix compiler and type errors until the build succeeds.",
    source: "builtin",
  },
  {
    command: "/test-coverage",
    name: "Test Coverage",
    description: "Analyze test coverage for active files and add missing test cases",
    mode: "auto",
    promptTemplate: "Analyze test coverage for {{activeFile}} and the workspace. Identify untested edge cases, error conditions, and branches, and implement comprehensive tests.",
    source: "builtin",
  },
  {
    command: "/architect",
    name: "System Architecture",
    description: "Design modular architecture, component boundaries, and API contracts",
    mode: "plan",
    promptTemplate: "Design a modular architecture and blueprint for: {{input}}. Detail component boundaries, data contracts, state management, migration strategy, and technical trade-offs.",
    source: "builtin",
  },
];

// Hardcoded mode-switch and code-action commands only make sense in the Code
// area — Home/Notebook get their scoped system commands instead.
BUILTIN_COMMANDS.forEach((c) => { c.scope = "code"; });

export async function discoverCustomCommands(projectRoot?: string, scope?: Exclude<CommandScope, "all">): Promise<CustomSlashCommand[]> {
  const commands = [...BUILTIN_COMMANDS];

  // Discover bundled system commands. Layout mirrors system-skills:
  // system-commands/{all,home,code,notebook}/<name>.md — the folder sets the
  // scope, an explicit `modes:` frontmatter key overrides it. Loose .md files
  // directly under system-commands/ stay scope "all" (backward compat).
  const sysDir = systemCommandsDir();
  const scopeFolders: Array<{ dir: string; scope: CommandScope }> = [
    { dir: "", scope: "all" },
    { dir: "all", scope: "all" },
    { dir: "home", scope: "home" },
    { dir: "code", scope: "code" },
    { dir: "notebook", scope: "notebook" },
  ];
  const pushSystemFile = async (filePath: string, fileName: string, folderScope: CommandScope) => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const cmd = parseCommandFile(fileName, raw, filePath);
      if (cmd) {
        cmd.source = "builtin";
        // An explicit `modes:` frontmatter key overrides the folder scope.
        const parsed = parseCommandModes(raw);
        cmd.scope = parsed.explicit ? parsed.scope : folderScope;
        const existingIdx = commands.findIndex((c) => c.command === cmd.command);
        if (existingIdx < 0) {
          commands.push(cmd);
        }
      }
    } catch { /* ignore unreadable system command */ }
  };
  for (const { dir, scope: folderScope } of scopeFolders) {
    const target = dir ? path.join(sysDir, dir) : sysDir;
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Top-level scan only takes files (subfolders are scanned as scopes);
      // scoped-folder scans only take files inside them.
      if (!entry.isFile() || !(entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) continue;
      if (!dir && (ALL_COMMAND_SCOPES as string[]).includes(entry.name.replace(/\.(md|txt)$/i, "").toLowerCase())) continue;
      await pushSystemFile(path.join(target, entry.name), entry.name, dir ? folderScope : "all");
    }
  }

  if (!projectRoot) return scope ? commands.filter((c) => commandAppliesToScope(c, scope)) : commands;

  const customDirs = [
    path.join(projectRoot, ".nexus", "commands"),
    path.join(projectRoot, ".forgepilot", "commands"),
  ];

  for (const customDir of customDirs) {
    try {
      if (!(await isInsideProject(projectRoot, customDir))) continue;
      const entries = await fs.readdir(customDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
          const filePath = path.join(customDir, entry.name);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size > MAX_COMMAND_FILE_BYTES || !(await isInsideProject(projectRoot, filePath))) continue;
            const raw = await fs.readFile(filePath, "utf8");
            const cmd = parseCommandFile(entry.name, raw, filePath);
            if (cmd) {
              // Replace builtin if exact name collision, else append
              const existingIdx = commands.findIndex((c) => c.command === cmd.command);
              if (existingIdx >= 0) {
                commands[existingIdx] = cmd;
              } else {
                commands.push(cmd);
              }
            }
          } catch {
            // Ignore unreadable custom command file
          }
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  return scope ? commands.filter((c) => commandAppliesToScope(c, scope)) : commands;
}

/** Parses the `modes:` frontmatter key (same convention as skills), reporting whether it was declared. */
export function parseCommandModes(content: string): { scope: CommandScope; explicit: boolean } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { scope: "all", explicit: false };
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^\s*modes\s*:\s*(.*)$/i);
    if (pair) return { scope: normalizeCommandScope(pair[1].trim().replace(/^["']|["']$/g, "")), explicit: true };
  }
  return { scope: "all", explicit: false };
}

export function parseCommandFile(fileName: string, content: string, filePath: string): CustomSlashCommand | null {
  const baseName = fileName.replace(/\.(md|txt)$/, "").toLowerCase();
  if (!VALID_COMMAND_NAME.test(baseName)) return null;
  const commandName = baseName.startsWith("/") ? baseName : `/${baseName}`;

  let name = baseName.charAt(0).toUpperCase() + baseName.slice(1);
  let description = `Custom command ${commandName}`;
  let mode: CustomSlashCommand["mode"] = "auto";
  let promptTemplate = content.trim();

  // Simple frontmatter parsing
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const header = frontmatterMatch[1];
    promptTemplate = frontmatterMatch[2].trim();

    for (const line of header.split("\n")) {
      const [key, ...rest] = line.split(":");
      if (!key || !rest.length) continue;
      const val = rest.join(":").trim();
      const k = key.trim().toLowerCase();
      if (k === "name") name = val;
      if (k === "description" || k === "desc") description = val;
      if (k === "mode" && (val === "plan" || val === "ask" || val === "auto")) {
        mode = val;
      }
    }
  }

  if (!promptTemplate || promptTemplate.length > MAX_COMMAND_PROMPT_CHARS) return null;
  if (name.length > 120 || description.length > 500) return null;
  return {
    command: commandName,
    name,
    description,
    mode,
    promptTemplate,
    source: "project",
    filePath,
    scope: parseCommandModes(content).scope,
  };
}

export function substituteCommandPlaceholders(
  template: string,
  variables: {
    input?: string;
    activeFile?: string;
    gitBranch?: string;
    diffSummary?: string;
  }
): string {
  let result = template;
  result = result.replace(/\{\{input\}\}/gi, variables.input || "");
  // $ARGUMENTS is the Claude-Code convention several bundled commands were
  // written with — treat it as an alias of {{input}} so both styles expand.
  result = result.replace(/\$ARGUMENTS/g, variables.input || "");
  result = result.replace(/\{\{activeFile\}\}/gi, variables.activeFile || "the current workspace files");
  result = result.replace(/\{\{gitBranch\}\}/gi, variables.gitBranch || "main");
  result = result.replace(/\{\{diffSummary\}\}/gi, variables.diffSummary || "no current changes");
  return result.trim();
}

/**
 * Expands a leading slash command ("/name rest of line") into its full
 * prompt template. Unknown commands and plain text pass through untouched,
 * so the agent never sees a mangled request. `scope` filters which bundled/
 * project commands are eligible (same convention as the slash popup UI).
 */
export async function expandSlashCommand(
  request: string,
  projectRoot?: string,
  scope?: Exclude<CommandScope, "all">
): Promise<string> {
  const raw = (request || "").trimStart();
  const match = raw.match(/^\/([a-z0-9][a-z0-9_-]{0,31})\b[ \t]*([\s\S]*)$/);
  if (!match) return request;
  const name = match[1].toLowerCase();
  const input = (match[2] || "").trim();
  let commands: CustomSlashCommand[];
  try {
    commands = await discoverCustomCommands(projectRoot, scope);
  } catch {
    return request;
  }
  const cmd = commands.find((c) => c.command === `/${name}`);
  if (!cmd || !cmd.promptTemplate) return request;
  return substituteCommandPlaceholders(cmd.promptTemplate, { input });
}
