import { promises as fs } from "node:fs";
import path from "node:path";

export interface CustomSlashCommand {
  command: string;          // e.g. "/review"
  name: string;             // e.g. "Code Review"
  description: string;      // e.g. "Run an in-depth security and quality review"
  mode?: "plan" | "ask" | "auto";
  promptTemplate: string;   // Prompt text with optional placeholders
  source: "builtin" | "project";
  filePath?: string;
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
];

export async function discoverCustomCommands(projectRoot?: string): Promise<CustomSlashCommand[]> {
  const commands = [...BUILTIN_COMMANDS];
  if (!projectRoot) return commands;

  const customDirs = [
    path.join(projectRoot, ".nexus", "commands"),
    path.join(projectRoot, ".forgepilot", "commands"),
  ];

  for (const customDir of customDirs) {
    try {
      const entries = await fs.readdir(customDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
          const filePath = path.join(customDir, entry.name);
          try {
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

  return commands;
}

export function parseCommandFile(fileName: string, content: string, filePath: string): CustomSlashCommand | null {
  const baseName = fileName.replace(/\.(md|txt)$/, "").toLowerCase();
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

  return {
    command: commandName,
    name,
    description,
    mode,
    promptTemplate,
    source: "project",
    filePath,
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
  result = result.replace(/\{\{activeFile\}\}/gi, variables.activeFile || "the current workspace files");
  result = result.replace(/\{\{gitBranch\}\}/gi, variables.gitBranch || "main");
  result = result.replace(/\{\{diffSummary\}\}/gi, variables.diffSummary || "no current changes");
  return result.trim();
}
