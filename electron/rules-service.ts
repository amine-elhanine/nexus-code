import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectRuleFile {
  filename: string;
  relativePath: string;
  content: string;
  source: "cursorrules" | "agent_md" | "claude_md" | "windsurf" | "nexus" | "forgepilot" | "system";
}

export interface ProjectRulesResult {
  hasRules: boolean;
  ruleFiles: ProjectRuleFile[];
  combinedPromptSection: string;
}

export function systemRulesDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "system-rules");
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

export async function discoverSystemRules(projectRoot?: string): Promise<ProjectRuleFile[]> {
  const rules: ProjectRuleFile[] = [];
  const sysDir = systemRulesDir();
  try {
    // 1. Common ECC standards (testing, security, coding style, git workflow)
    const commonDir = path.join(sysDir, "common");
    const commonEntries = await fs.readdir(commonDir, { withFileTypes: true }).catch(() => []);
    for (const entry of commonEntries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await fs.readFile(path.join(commonDir, entry.name), "utf8").catch(() => "");
        if (content.trim()) {
          rules.push({
            filename: entry.name,
            relativePath: `system-rules/common/${entry.name}`,
            content: content.trim(),
            source: "system",
          });
        }
      }
    }

    if (projectRoot) {
      const root = path.resolve(projectRoot);
      const pkgPath = path.join(root, "package.json");
      let hasPkg = false;
      try {
        await fs.access(pkgPath);
        hasPkg = true;
      } catch { /* no package.json */ }

      if (hasPkg) {
        const pkgRaw = await fs.readFile(pkgPath, "utf8").catch(() => "{}");
        const pkg = JSON.parse(pkgRaw || "{}");
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const stackDirs = ["web"];
        let hasTs = Boolean(allDeps.typescript);
        if (!hasTs) {
          try {
            await fs.access(path.join(root, "tsconfig.json"));
            hasTs = true;
          } catch { /* no tsconfig */ }
        }
        if (hasTs) stackDirs.push("typescript");
        if (allDeps.react || allDeps["react-dom"]) stackDirs.push("react");
        if (allDeps["react-native"]) stackDirs.push("react-native");
        if (allDeps.vue) stackDirs.push("vue");
        if (allDeps["@angular/core"]) stackDirs.push("angular");

        for (const stack of stackDirs) {
          const sDir = path.join(sysDir, stack);
          const sEntries = await fs.readdir(sDir, { withFileTypes: true }).catch(() => []);
          for (const entry of sEntries) {
            if (entry.isFile() && entry.name.endsWith(".md")) {
              const content = await fs.readFile(path.join(sDir, entry.name), "utf8").catch(() => "");
              if (content.trim()) {
                rules.push({
                  filename: entry.name,
                  relativePath: `system-rules/${stack}/${entry.name}`,
                  content: content.trim(),
                  source: "system",
                });
              }
            }
          }
        }
      }

      // Python
      let hasPy = false;
      try {
        await fs.access(path.join(root, "pyproject.toml"));
        hasPy = true;
      } catch {
        try {
          await fs.access(path.join(root, "requirements.txt"));
          hasPy = true;
        } catch { /* no python */ }
      }
      if (hasPy) {
        const pyDir = path.join(sysDir, "python");
        const pyEntries = await fs.readdir(pyDir, { withFileTypes: true }).catch(() => []);
        for (const entry of pyEntries) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            const content = await fs.readFile(path.join(pyDir, entry.name), "utf8").catch(() => "");
            if (content.trim()) rules.push({ filename: entry.name, relativePath: `system-rules/python/${entry.name}`, content: content.trim(), source: "system" });
          }
        }
      }

      // Rust
      let hasRust = false;
      try {
        await fs.access(path.join(root, "Cargo.toml"));
        hasRust = true;
      } catch { /* no rust */ }
      if (hasRust) {
        const rustDir = path.join(sysDir, "rust");
        const rustEntries = await fs.readdir(rustDir, { withFileTypes: true }).catch(() => []);
        for (const entry of rustEntries) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            const content = await fs.readFile(path.join(rustDir, entry.name), "utf8").catch(() => "");
            if (content.trim()) rules.push({ filename: entry.name, relativePath: `system-rules/rust/${entry.name}`, content: content.trim(), source: "system" });
          }
        }
      }

      // Golang
      let hasGo = false;
      try {
        await fs.access(path.join(root, "go.mod"));
        hasGo = true;
      } catch { /* no go */ }
      if (hasGo) {
        const goDir = path.join(sysDir, "golang");
        const goEntries = await fs.readdir(goDir, { withFileTypes: true }).catch(() => []);
        for (const entry of goEntries) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            const content = await fs.readFile(path.join(goDir, entry.name), "utf8").catch(() => "");
            if (content.trim()) rules.push({ filename: entry.name, relativePath: `system-rules/golang/${entry.name}`, content: content.trim(), source: "system" });
          }
        }
      }
    }
  } catch { /* ignore */ }

  return rules;
}

export async function discoverAllRules(projectRoot: string): Promise<ProjectRulesResult> {
  const projectResult = await discoverProjectRules(projectRoot);
  const sysRules = await discoverSystemRules(projectRoot);

  const combinedFiles = [...projectResult.ruleFiles, ...sysRules];
  if (combinedFiles.length === 0) {
    return { hasRules: false, ruleFiles: [], combinedPromptSection: "" };
  }

  const projectSections = projectResult.ruleFiles.map((rf) => `### [Project Rule: ${rf.relativePath}]\n${rf.content}`);
  const sysSections = sysRules.map((rf) => `### [ECC Standard: ${rf.relativePath}]\n${rf.content}`);

  let combinedPromptSection = "";
  if (projectSections.length > 0) {
    combinedPromptSection += `\n\n## Project-Specific Rules & Guidelines\nThe following rules have been defined for this repository. You MUST adhere to all instructions and style guides below:\n\n${projectSections.join("\n\n")}\n`;
  }
  if (sysSections.length > 0) {
    combinedPromptSection += `\n\n## ECC Engineering Standards & Harness Rules\nThe following standards govern software development in this workspace:\n\n${sysSections.join("\n\n")}\n`;
  }

  return {
    hasRules: true,
    ruleFiles: combinedFiles,
    combinedPromptSection,
  };
}
