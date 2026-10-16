// Validate a plugin folder before installation.
// Usage: node scripts/validate-plugin.mjs <plugin-dir>
// Checks manifest.json (strict v2 when entry/apiVersion present),
// required contents vs declared capabilities, and entry safety.
// Exit 0 = valid, 1 = invalid (errors printed to stderr).
import { promises as fs } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/validate-plugin.mjs <plugin-dir>");
  process.exit(2);
}

const resolved = path.resolve(dir);
let raw;
try {
  raw = JSON.parse(await fs.readFile(path.join(resolved, "manifest.json"), "utf8"));
} catch (error) {
  console.error(`manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Dynamic import of built output (build:electron first) with source fallback.
let validator;
try {
  validator = await import("../dist-electron/plugin-manifest.js");
} catch {
  console.error("dist-electron not built. Run: npm run build:electron");
  process.exit(2);
}

const result = validator.validatePluginManifest(raw);
if (!result.ok) {
  for (const issue of result.errors) {
    console.error(`error[${issue.field || "manifest"}]: ${issue.message}`);
  }
  process.exit(1);
}

const manifest = result.manifest;
const errors = [];
async function exists(rel) {
  try {
    const stat = await fs.stat(path.join(resolved, rel));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

for (const cap of manifest.capabilities) {
  if (cap === "skills" && !(await exists("skills"))) errors.push('capability "skills" declared but no skills/ folder');
  if (cap === "agents" && !(await exists("agents"))) errors.push('capability "agents" declared but no agents/ folder');
  if (cap === "commands" && !(await exists("commands"))) errors.push('capability "commands" declared but no commands/ folder');
  if (cap === "rules" && !(await exists("rules"))) errors.push('capability "rules" declared but no rules/ folder');
  if (cap === "hooks" && !(await exists("hooks.json"))) errors.push('capability "hooks" declared but no hooks.json');
}
if (manifest.entry) {
  const entryPath = path.resolve(resolved, manifest.entry);
  if (!entryPath.startsWith(resolved + path.sep)) {
    errors.push("entry escapes plugin directory");
  } else {
    try {
      const stat = await fs.stat(entryPath);
      if (!stat.isFile()) errors.push("entry is not a file");
      else if (stat.size > 256 * 1024) errors.push("entry exceeds 256KB");
    } catch {
      errors.push(`entry file missing: ${manifest.entry}`);
    }
  }
}
if (manifest.ui.length > 0 && !manifest.capabilities.includes("ui")) {
  errors.push('"ui" contributions require the "ui" capability');
}
for (const ui of manifest.ui || []) {
  if (!ui.entry) continue;
  const uiPath = path.resolve(resolved, ui.entry);
  if (uiPath !== resolved && !uiPath.startsWith(resolved + path.sep)) {
    errors.push(`ui entry escapes plugin directory: ${ui.entry}`);
  } else {
    try {
      const stat = await fs.stat(uiPath);
      if (!stat.isFile()) errors.push(`ui entry is not a file: ${ui.entry}`);
      else if (stat.size > 512 * 1024) errors.push(`ui entry exceeds 512KB: ${ui.entry}`);
      else if (!/\.html?$/i.test(ui.entry)) errors.push(`ui entry must be .html: ${ui.entry}`);
    } catch {
      errors.push(`ui entry file missing: ${ui.entry}`);
    }
  }
}

if (errors.length > 0) {
  for (const message of errors) console.error(`error: ${message}`);
  process.exit(1);
}

console.log(`OK: ${manifest.id} ${manifest.version} (api ${manifest.apiVersion}, caps: ${manifest.capabilities.join(", ")})`);
