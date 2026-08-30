import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProjectRuleFile {
  filename: string;
  relativePath: string;
  content: string;
  source: "cursorrules" | "agent_md" | "claude_md" | "windsurf" | "nexus" | "forgepilot";
}

export interface ProjectRulesResult {
  hasRules: boolean;
  ruleFiles: ProjectRuleFile[];
  combinedPromptSection: string;
}

const RULE_CANDIDATES = [
  { file: ".cursorrules", source: "cursorrules" as const },
  { file: "AGENT.md", source: "agent_md" as const },
  { file: "AGENTS.md", source: "agent_md" as const },
  { file: "CLAUDE.md", source: "claude_md" as const },
  { file: ".windsurfrules", source: "windsurf" as const },
];

export async function discoverProjectRules(projectRoot: string): Promise<ProjectRulesResult> {
  const ruleFiles: ProjectRuleFile[] = [];
  const root = path.resolve(projectRoot);

  for (const candidate of RULE_CANDIDATES) {
    const fullPath = path.join(root, candidate.file);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      if (content.trim()) {
        ruleFiles.push({
          filename: candidate.file,
          relativePath: candidate.file,
          content: content.trim(),
          source: candidate.source,
        });
      }
    } catch {
      // File doesn't exist or is unreadable
    }
  }

  // Check .nexus/rules/ (primary) and .forgepilot/rules/ (fallback)
  const candidateDirs = [
    { dir: path.join(root, ".nexus", "rules"), prefix: ".nexus/rules" },
    { dir: path.join(root, ".forgepilot", "rules"), prefix: ".forgepilot/rules" },
  ];

  for (const item of candidateDirs) {
    try {
      const entries = await fs.readdir(item.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt") || entry.name.endsWith(".rule"))) {
          const fullPath = path.join(item.dir, entry.name);
          try {
            const content = await fs.readFile(fullPath, "utf8");
            if (content.trim()) {
              ruleFiles.push({
                filename: entry.name,
                relativePath: `${item.prefix}/${entry.name}`,
                content: content.trim(),
                source: "nexus",
              });
            }
          } catch {
            // ignore unreadable
          }
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  if (ruleFiles.length === 0) {
    return {
      hasRules: false,
      ruleFiles: [],
      combinedPromptSection: "",
    };
  }

  const sections = ruleFiles.map((rf) => {
    return `### [Rule file: ${rf.relativePath}]\n${rf.content}`;
  });

  const combinedPromptSection = `\n\n## Project-Specific Rules & Guidelines\nThe following rules have been defined for this repository. You MUST adhere to all instructions and style guides below:\n\n${sections.join("\n\n")}\n`;

  return {
    hasRules: true,
    ruleFiles,
    combinedPromptSection,
  };
}
