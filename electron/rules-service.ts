import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginRuleDirsWithModes } from "./plugins-service.js";

export interface ProjectRuleFile {
  filename: string;
  relativePath: string;
  content: string;
  source: "cursorrules" | "agent_md" | "claude_md" | "windsurf" | "nexus" | "forgepilot" | "system" | "plugin";
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
    // 1. Common standards (testing, security, coding style, git workflow) —
    // always loaded for code runs.
    await loadRuleDir(path.join(sysDir, "common"), "system-rules/common", rules);

    if (!projectRoot) return rules;

    // 2. Stack-specific standards, selected by detecting the project's actual
    // toolchain. A stack whose detector misses (e.g. a pom.xml project) ships
    // rule files that would never load — every shipped stack dir MUST have a
    // detector here.
    const root = path.resolve(projectRoot);
    const deps = await readPackageDeps(root);
    for (const source of STACK_RULE_SOURCES) {
      let detected = false;
      try {
        detected = await source.detect(root, deps);
      } catch {
        detected = false;
      }
      if (!detected) continue;
      await loadRuleDir(path.join(sysDir, source.dir), `system-rules/${source.dir}`, rules);
    }
  } catch { /* ignore */ }

  return rules;
}

type StackRuleSource = {
  dir: string;
  /** root = absolute project root; deps = merged dependencies+devDependencies from package.json ({} when absent). */
  detect: (root: string, deps: Record<string, string>) => boolean | Promise<boolean>;
};

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function anyExists(root: string, ...names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await fileExists(path.join(root, name))) return true;
  }
  return false;
}

/** True when any root entry ends with one of the extensions (files or dirs, e.g. .xcodeproj). */
async function hasRootExtension(root: string, extensions: string[]): Promise<boolean> {
  try {
    const entries = await fs.readdir(root);
    return entries.some((entry) => extensions.some((ext) => entry.toLowerCase().endsWith(ext)));
  } catch {
    return false;
  }
}

async function readPackageDeps(root: string): Promise<Record<string, string>> {
  if (!(await fileExists(path.join(root, "package.json")))) return {};
  try {
    const pkg = JSON.parse((await fs.readFile(path.join(root, "package.json"), "utf8")) || "{}");
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    return {};
  }
}

const STACK_RULE_SOURCES: StackRuleSource[] = [
  // Node project marker: any package.json project gets the web standards.
  { dir: "web", detect: (root) => fileExists(path.join(root, "package.json")) },
  { dir: "typescript", detect: (root, deps) => Boolean(deps.typescript) || fileExists(path.join(root, "tsconfig.json")) },
  { dir: "react", detect: (_root, deps) => Boolean(deps.react || deps["react-dom"]) },
  { dir: "react-native", detect: (_root, deps) => Boolean(deps["react-native"]) },
  { dir: "vue", detect: (_root, deps) => Boolean(deps.vue || deps.nuxt) },
  { dir: "angular", detect: (_root, deps) => Boolean(deps["@angular/core"]) },
  { dir: "nuxt", detect: (_root, deps) => Boolean(deps.nuxt) },
  { dir: "python", detect: (root) => anyExists(root, "pyproject.toml", "requirements.txt") },
  { dir: "rust", detect: (root) => fileExists(path.join(root, "Cargo.toml")) },
  { dir: "golang", detect: (root) => fileExists(path.join(root, "go.mod")) },
  { dir: "java", detect: (root) => anyExists(root, "pom.xml", "build.gradle", "build.gradle.kts") },
  { dir: "kotlin", detect: async (root) => (await anyExists(root, "build.gradle.kts", "settings.gradle.kts")) || fileExists(path.join(root, "src", "main", "kotlin")) },
  { dir: "cpp", detect: (root) => anyExists(root, "CMakeLists.txt", "Makefile") },
  { dir: "csharp", detect: (root) => hasRootExtension(root, [".csproj", ".sln"]) },
  { dir: "fsharp", detect: (root) => hasRootExtension(root, [".fsproj"]) },
  { dir: "dart", detect: (root) => fileExists(path.join(root, "pubspec.yaml")) },
  { dir: "ruby", detect: async (root) => (await anyExists(root, "Gemfile")) || hasRootExtension(root, [".gemspec"]) },
  { dir: "php", detect: (root) => fileExists(path.join(root, "composer.json")) },
  { dir: "perl", detect: (root) => anyExists(root, "Makefile.PL", "Build.PL", "cpanfile") },
  { dir: "swift", detect: async (root) => (await anyExists(root, "Package.swift")) || hasRootExtension(root, [".xcodeproj"]) },
  { dir: "arkts", detect: (root) => anyExists(root, "hvigorfile.ts", "oh-package.json5") },
];

/** Reads every .md rule file in one stack dir; missing dirs contribute nothing. */
async function loadRuleDir(dir: string, prefix: string, rules: ProjectRuleFile[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const isPlugin = prefix.startsWith("plugin:");
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(dir, entry.name), "utf8").catch(() => "");
    if (content.trim()) {
      rules.push({
        filename: entry.name,
        relativePath: `${prefix}/${entry.name}`,
        content: content.trim(),
        source: isPlugin ? "plugin" : "system",
      });
    }
  }
}

export async function discoverPluginRules(projectRoot: string): Promise<ProjectRuleFile[]> {
  const rules: ProjectRuleFile[] = [];
  if (!projectRoot) return rules;

  try {
    const pluginDirs = await pluginRuleDirsWithModes(projectRoot).catch(() => []);
    const root = path.resolve(projectRoot);
    const deps = await readPackageDeps(root);

    for (const { dir } of pluginDirs) {
      const pluginName = path.basename(path.dirname(dir));
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".rule") || entry.name.endsWith(".txt"))) {
          const filePath = path.join(dir, entry.name);
          const content = await fs.readFile(filePath, "utf8").catch(() => "");
          if (content.trim()) {
            rules.push({
              filename: entry.name,
              relativePath: `plugin:${pluginName}/${entry.name}`,
              content: content.trim(),
              source: "plugin",
            });
          }
        } else if (entry.isDirectory()) {
          if (entry.name === "common") {
            await loadRuleDir(path.join(dir, "common"), `plugin:${pluginName}/common`, rules);
          } else {
            const stackSource = STACK_RULE_SOURCES.find((s) => s.dir === entry.name);
            let matches = false;
            if (stackSource) {
              try {
                matches = await stackSource.detect(root, deps);
              } catch {
                matches = false;
              }
            } else {
              matches = true;
            }
            if (matches) {
              await loadRuleDir(path.join(dir, entry.name), `plugin:${pluginName}/${entry.name}`, rules);
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  return rules;
}

export async function discoverAllRules(projectRoot: string): Promise<ProjectRulesResult> {
  const projectResult = await discoverProjectRules(projectRoot);
  const pluginRules = await discoverPluginRules(projectRoot);
  const sysRules = await discoverSystemRules(projectRoot);

  const combinedFiles = [...projectResult.ruleFiles, ...pluginRules, ...sysRules];
  if (combinedFiles.length === 0) {
    return { hasRules: false, ruleFiles: [], combinedPromptSection: "" };
  }

  const projectSections = projectResult.ruleFiles.map((rf) => `### [Project Rule: ${rf.relativePath}]\n${rf.content}`);
  const pluginSections = pluginRules.map((rf) => `### [Plugin Rule: ${rf.relativePath}]\n${rf.content}`);
  const sysSections = sysRules.map((rf) => `### [Nexus Standard: ${rf.relativePath}]\n${rf.content}`);

  let combinedPromptSection = "";
  if (projectSections.length > 0) {
    combinedPromptSection += `\n\n## Project-Specific Rules & Guidelines\nThe following rules have been defined for this repository. You MUST adhere to all instructions and style guides below:\n\n${projectSections.join("\n\n")}\n`;
  }
  if (pluginSections.length > 0) {
    combinedPromptSection += `\n\n## Plugin-Provided Rules & Standards\nThe following rules are contributed by installed plugins. You MUST adhere to all instructions below:\n\n${pluginSections.join("\n\n")}\n`;
  }
  if (sysSections.length > 0) {
    combinedPromptSection += `\n\n## Nexus Engineering Standards & Harness Rules\nThe following standards govern software development in this workspace:\n\n${sysSections.join("\n\n")}\n`;
  }

  return {
    hasRules: true,
    ruleFiles: combinedFiles,
    combinedPromptSection,
  };
}
