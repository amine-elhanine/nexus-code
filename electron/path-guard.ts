// Shared containment-checked path resolution for agent file tools.
//
// Single source of truth for the safePath guard previously duplicated (with
// drift) between code-tools.ts and edit-tools.ts: strips the project-root
// prefix, refuses lexical escapes, refuses paths that traverse an in-repo
// symlink pointing outside the root (resolving the deepest existing ancestor
// for not-yet-existing files), and — for write-capable tools — refuses the
// legacy .deepagents state directory (Nexus state lives only in .nexus/).

import { promises as fs } from "node:fs";
import path from "node:path";
import { stripProjectRoot } from "./path-utils.js";
import { LEGACY_STATE_REJECTION } from "./state-guard.js";

export async function safePath(
  projectRoot: string,
  requested: string,
  options: { forWrite?: boolean } = {},
): Promise<string> {
  const root = await fs.realpath(path.resolve(projectRoot));
  const stripped = stripProjectRoot(requested, projectRoot);
  const candidate = path.resolve(root, stripped || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the selected project root.");
  }
  if (options.forWrite) {
    const relToRoot = path.relative(root, candidate).replace(/\\/g, "/").toLowerCase();
    if (relToRoot === ".deepagents" || relToRoot.startsWith(".deepagents/")) {
      throw new Error(LEGACY_STATE_REJECTION);
    }
  }
  // Resolve the existing target, or the nearest existing parent for a new
  // file. This prevents a lexical-safe path from traversing an in-repo
  // symlink that points outside the selected project.
  let probe = candidate;
  while (probe !== root) {
    try {
      const realProbe = await fs.realpath(probe);
      if (realProbe !== root && !realProbe.startsWith(`${root}${path.sep}`)) {
        throw new Error("Path follows a symlink outside the selected project root.");
      }
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      probe = path.dirname(probe);
    }
  }
  return candidate;
}
