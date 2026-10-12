// Versioned plugin manifest (Plugin API v1).
//
// v1 bundles (manifest.json with only id/name/version/capabilities/modes)
// keep working through the legacy tolerant path in plugins-service.ts.
// This module is the STRICT path for install/lifecycle of new plugins and
// for every executable plugin (one with an `entry` JS file).
//
// Design rules (see mission §6 + §18):
// - Reject malformed manifests, unknown modes, unknown capabilities,
//   unknown permissions, unsafe entry paths, incompatible versions.
// - NEVER interpret invalid input as "all modes / all permissions".
// - Distinguish omitted `modes` (unrestricted, implicit) from explicit
//   `modes: []` (unrestricted, explicit) from invalid (rejected).
// - No imports from plugins-service.ts / store.ts here (no cycles).

import { z } from "zod";

export const PLUGIN_API_VERSION = "1";
export const SUPPORTED_API_VERSIONS = ["1"] as const;
export type SupportedApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

export const PLUGIN_MODES = ["home", "code", "notebook"] as const;
export type PluginMode = (typeof PLUGIN_MODES)[number];

/** Declarative (no code) + executable (code) capabilities. */
export const KNOWN_CAPABILITIES = [
  "skills",
  "agents",
  "commands",
  "rules",
  "hooks",
  "tools",
  "providers",
  "services",
  "ui",
] as const;
export type PluginCapability = (typeof KNOWN_CAPABILITIES)[number];

/** Executable capabilities require an `entry` JS file and user approval. */
export const EXECUTABLE_CAPABILITIES: readonly PluginCapability[] = ["tools", "providers", "services", "ui"];

/** Least-privilege permissions a plugin may request. Enforced by the host,
 *  never self-granted at runtime. `secrets.read` is intentionally absent:
 *  plugins must never read raw credentials. */
export const KNOWN_PERMISSIONS = [
  "workspace.read",
  "workspace.write",
  "fs.read",
  "fs.write",
  "shell.execute",
  "network.fetch",
  "mcp.connect",
  "providers.register",
  "ui.contribute",
  "storage.write",
  "background.execute",
  "config.read",
] as const;
export type PluginPermission = (typeof KNOWN_PERMISSIONS)[number];

const idSchema = z
  .string()
  .trim()
  .min(1, "id must not be empty")
  .max(64, "id must be ≤ 64 chars")
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "id must match [a-z0-9._-] (letters, digits, dot, dash, underscore)");

const versionSchema = z
  .string()
  .trim()
  .min(1, "version must not be empty")
  .max(32)
  // Lenient semver: "1", "1.2", "1.2.3", optional prerelease. Rejects garbage.
  .regex(/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$|^\d+\.\d+([-.+][0-9A-Za-z.-]+)?$|^\d+([-.+][0-9A-Za-z.-]+)?$/, "version must look like semver (e.g. 1.0.0)");

const modeSchema = z.enum(PLUGIN_MODES);
const capabilitySchema = z.enum(KNOWN_CAPABILITIES);
const permissionSchema = z.enum(KNOWN_PERMISSIONS);

const uiContributionSchema = z.object({
  slot: z.enum(["settings", "sidebar", "modal", "status", "command-palette", "home-widget", "code-panel"]),
  title: z.string().trim().min(1).max(80),
  entry: z.string().trim().min(1).max(256).optional(),
});

const manifestSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1, "name must not be empty").max(80),
  version: versionSchema.default("0.1.0"),
  apiVersion: z.string().trim().min(1).max(16).default(PLUGIN_API_VERSION),
  description: z.string().trim().max(500).default(""),
  author: z.string().trim().max(120).default(""),
  capabilities: z.array(capabilitySchema).min(1, "declare at least one capability").max(16),
  // `modes` omitted => unrestricted (implicit). `modes: []` => unrestricted
  // (explicit, backward compatible). Any other value must be 1-3 known modes.
  modes: z.array(modeSchema).min(0).max(3).optional(),
  permissions: z.array(permissionSchema).max(24).default([]),
  entry: z.string().trim().min(1).max(256).optional(),
  dependencies: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(64)).default({}),
  minAppVersion: z.string().trim().max(32).optional(),
  ui: z.array(uiContributionSchema).max(16).default([]),
});

export type ValidatedPluginManifest = z.infer<typeof manifestSchema> & {
  /** True when `modes` was omitted (implicit all-modes). */
  modesImplicit: boolean;
};

export type ManifestValidationError = { field: string; message: string };

export function validatePluginManifest(raw: unknown): { ok: true; manifest: ValidatedPluginManifest } | { ok: false; errors: ManifestValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "", message: "manifest must be a JSON object" }] };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const value = parsed.data;

  // apiVersion compatibility: only versions we can execute.
  if (!(SUPPORTED_API_VERSIONS as readonly string[]).includes(value.apiVersion)) {
    return {
      ok: false,
      errors: [{ field: "apiVersion", message: `unsupported apiVersion "${value.apiVersion}" (supported: ${SUPPORTED_API_VERSIONS.join(", ")})` }],
    };
  }

  // Dedupe capabilities/permissions/modes (zod allows repeats).
  const capabilities = [...new Set(value.capabilities)];
  const permissions = [...new Set(value.permissions)];
  const modes = value.modes ? [...new Set(value.modes)] : undefined;

  // Relationship: executable capabilities REQUIRE an entry file.
  const needsEntry = capabilities.some((c) => (EXECUTABLE_CAPABILITIES as readonly string[]).includes(c));
  if (needsEntry && !value.entry) {
    return {
      ok: false,
      errors: [{ field: "entry", message: `capabilities [${capabilities.join(", ")}] include executable code but no "entry" file is declared` }],
    };
  }
  if (value.entry) {
    const entryError = validateEntryPath(value.entry);
    if (entryError) return { ok: false, errors: [{ field: "entry", message: entryError }] };
    if (!needsEntry && value.ui.length === 0) {
      return {
        ok: false,
        errors: [{ field: "entry", message: `"entry" is declared but no executable capability (tools/providers/services/ui) needs it` }],
      };
    }
  }

  // ui contributions require the ui capability.
  if (value.ui.length > 0 && !capabilities.includes("ui")) {
    return { ok: false, errors: [{ field: "ui", message: `"ui" contributions require the "ui" capability` }] };
  }

  // minAppVersion must parse if present.
  if (value.minAppVersion && parseVersion(value.minAppVersion) === null) {
    return { ok: false, errors: [{ field: "minAppVersion", message: `minAppVersion "${value.minAppVersion}" is not valid semver` }] };
  }

  // Dependency keys must look like plugin ids; values non-empty.
  for (const [key, val] of Object.entries(value.dependencies)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key) || key.length > 64) {
      return { ok: false, errors: [{ field: `dependencies.${key}`, message: "dependency id must match [a-z0-9._-]" }] };
    }
    if (!val || !val.trim()) {
      return { ok: false, errors: [{ field: `dependencies.${key}`, message: "dependency version constraint must not be empty" }] };
    }
  }

  return {
    ok: true,
    manifest: {
      ...value,
      capabilities: capabilities as ValidatedPluginManifest["capabilities"],
      permissions: permissions as ValidatedPluginManifest["permissions"],
      modes: modes as ValidatedPluginManifest["modes"],
      modesImplicit: value.modes === undefined,
    },
  };
}

/** Entry must be a relative bundle path inside the plugin dir. Rejects
 *  absolute paths, parent traversal, URLs, and non-JS files. */
export function validateEntryPath(entry: string): string | null {
  const trimmed = entry.trim().replace(/\\/g, "/");
  if (!trimmed) return "entry must not be empty";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return "entry must be a relative file path, not a URL";
  if (trimmed.startsWith("/") || /^[a-zA-Z]:\//.test(trimmed)) return "entry must be relative, not absolute";
  // Allow an optional leading "./" (common "./dist/index.js" form).
  const withoutDotSlash = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (!withoutDotSlash || withoutDotSlash.startsWith("/")) return "entry must not be empty";
  const parts = withoutDotSlash.split("/").filter(Boolean);
  if (parts.length === 0) return "entry must not be empty";
  if (parts.includes("..")) return "entry must not contain '..'";
  if (parts.includes(".")) return "entry must not contain '.' segments";
  if (parts.some((p) => p.startsWith("."))) return "entry must not reference hidden files";
  const file = parts[parts.length - 1];
  if (!/\.(m?js|cjs)$/i.test(file)) return "entry must be a .js/.mjs/.cjs file";
  if (trimmed.length > 256) return "entry path too long";
  return null;
}

export type ParsedVersion = { major: number; minor: number; patch: number; pre: string };

export function parseVersion(input: string): ParsedVersion | null {
  const match = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?\s*$/.exec(input);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: match[4] ?? "",
  };
}

/** -1 | 0 | 1. Prerelease < release. Missing parts default to 0. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function isApiVersionCompatible(manifestApi: string): boolean {
  return (SUPPORTED_API_VERSIONS as readonly string[]).includes(manifestApi);
}

export function isAppVersionCompatible(minAppVersion: string | undefined, appVersion: string): boolean {
  if (!minAppVersion) return true;
  const cmp = compareVersions(appVersion, minAppVersion);
  if (cmp === null) return false;
  return cmp >= 0;
}

/** Mode check for validated manifests. Omitted or [] => all modes. */
export function manifestAppliesToMode(manifest: Pick<ValidatedPluginManifest, "modes">, mode: PluginMode): boolean {
  if (!manifest.modes || manifest.modes.length === 0) return true;
  return (manifest.modes as readonly string[]).includes(mode);
}
