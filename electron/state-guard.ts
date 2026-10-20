import { normalizeVirtualPath } from "./path-utils.js";

/**
 * Nexus state lives only in `.nexus/`. The DeepAgents stack behind us is also
 * used by other frameworks whose convention is `.deepagents/` — nothing in
 * Nexus creates that folder, but the model sometimes invents it from prior
 * knowledge of that convention. These helpers hard-block every agent write
 * path that could materialize it, pointing the model back to `.nexus/`.
 */
export const LEGACY_STATE_DIR = ".deepagents";

export const LEGACY_STATE_REJECTION =
  "Blocked: do not create or write into `.deepagents/`. Nexus stores project state, skills, and telemetry under `.nexus/` only. Use `.nexus/` (e.g. `.nexus/skills/<name>/SKILL.md`) instead.";

/** True when the requested virtual path points at (or into) `.deepagents/`. */
export function isLegacyStatePath(rawPath: string, projectRoot?: string): boolean {
  const normalized = (projectRoot ? normalizeVirtualPath(rawPath, projectRoot) : String(rawPath || ""))
    .replace(/\\/g, "/")
    .trim();
  const stripped = normalized.replace(/^[a-z]:\//i, "").replace(/^\/+/, "").toLowerCase();
  return stripped === LEGACY_STATE_DIR || stripped.startsWith(`${LEGACY_STATE_DIR}/`);
}

/**
 * Wrap an agent backend's mutating methods so any attempt to write into
 * `.deepagents/` fails with an explanatory error instead of touching disk.
 * Deleting inside `.deepagents` stays allowed: removing legacy leftovers is fine.
 */
export function guardAgainstLegacyStateDir(backend: any, projectRoot?: string): void {
  if (!backend || typeof backend !== "object") return;
  for (const action of ["write", "edit"] as const) {
    const original = backend[action]?.bind(backend);
    if (typeof original !== "function") continue;
    backend[action] = async (filePath: string, ...rest: any[]) => {
      if (isLegacyStatePath(filePath, projectRoot)) throw new Error(LEGACY_STATE_REJECTION);
      return original(filePath, ...rest);
    };
  }
}
