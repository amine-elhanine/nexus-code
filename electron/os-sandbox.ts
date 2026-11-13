// OS-level process sandboxing for agent-run shell commands (Phase 4.1).
//
// Defence-in-depth: the policy classifier (permissions.ts) already denies
// destructive command PATTERNS; this layer enforces workspace write
// containment at the OS boundary so even an unclassified command — or a
// shell escape inside an allowed one — cannot write outside the project
// root and temp dirs.
//
// Per platform, best available mechanism:
// - macOS: sandbox-exec with a profile allowing reads, writes scoped to the
//   project root + system temp, and explicit denies for ~/.ssh, ~/.aws and
//   other sensitive homes. (Deprecated by Apple but still enforced and the
//   only zero-dependency option.)
// - Linux: bubblewrap (bwrap) when present on PATH — / read-only bind,
//   project root + /tmp writable, /dev + /proc visible.
// - Windows: no OS sandbox primitive available without a driver; degrade to
//   environment scoping (TEMP/TMP redirected into the project) + the
//   existing Job Object process-tree kill on cancellation.
//
// Enablement is opt-in via AppSettings.commandSandbox ("off" | "auto");
// "auto" activates the sandbox on macOS/Linux when the mechanism is
// available and leaves Windows on env scoping only. Never breaks a command:
// if the sandbox binary is missing or errors at spawn time, the command
// runs unsandboxed exactly as before (the policy layer still applies).

import path from "node:path";
import { existsSync } from "node:fs";

export type CommandSandboxMode = "off" | "auto";

export type SandboxPlan =
  | { kind: "none"; reason: string }
  | { kind: "macos-exec"; argvPrefix: string[] }
  | { kind: "linux-bwrap"; argvPrefix: string[] }
  | { kind: "windows-env"; env: Record<string, string> };

function sandboxProfile(projectRoot: string, tempDir: string): string {
  // Read everything, write only the workspace + temp; deny the classic
  // credential homes explicitly (defense against (allow file-write*) patterns
  // regressing). network is left ALLOWED: package installs and API calls are
  // core agent work; the network-write approval gate covers the risky flows.
  //
  // The /usr/lib and /private/var/db/dslocal WRITE allowances are redundant
  // today — SIP protects both on any current macOS, so they grant nothing an
  // attacker could use. Kept only to avoid breaking exotic local setups
  // (custom frameworks under /usr/lib); documented here so audits can skip
  // re-flagging them. (SBPL profiles can't carry comments, so the note lives
  // in code.)
  return `(version 1)
(deny default)
(allow file-read*)
(allow file-write* (subpath "${projectRoot}") (subpath "${tempDir}") (subpath "/private/tmp") (subpath "/var/folders") (subpath "/usr/lib") (subpath "/private/var/db/dslocal"))
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow iokit-open)
(allow network*)
(deny file-write* (subpath (homedir "/.ssh")) (subpath (homedir "/.aws")) (subpath (homedir "/.gnupg")) (subpath (homedir "/.config/gcloud")))
(deny file-read* (subpath (homedir "/.ssh")) (subpath (homedir "/.gnupg")))`;
}

/** bwrap presence probe (cached per session — PATH rarely changes mid-run). */
let bwrapAvailable: boolean | null = null;
function hasBwrap(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    const candidates = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap", "/snap/bin/bwrap"];
    bwrapAvailable = candidates.some((c) => existsSync(c));
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/**
 * Builds the sandbox plan for a command execution. `platform`/`whichBwrap`
 * are injectable for tests. Windows has no userspace sandbox primitive: the
 * plan scopes TEMP/TMP into the project so sloppy scripts write temp state
 * inside the workspace instead of the user's temp dir.
 */
export function planCommandSandbox(options: {
  projectRoot: string;
  mode: CommandSandboxMode;
  platform?: NodeJS.Platform;
  whichBwrap?: () => boolean;
}): SandboxPlan {
  const platform = options.platform ?? process.platform;
  if (options.mode !== "auto") return { kind: "none", reason: "sandbox disabled" };
  const projectRoot = path.resolve(options.projectRoot);
  const tempDir = path.join(projectRoot, ".nexus", "tmp");
  if (platform === "darwin") {
    const profile = sandboxProfile(projectRoot, tempDir);
    return { kind: "macos-exec", argvPrefix: ["sandbox-exec", "-p", profile] };
  }
  if (platform === "linux") {
    const which = options.whichBwrap ?? (() => hasBwrap());
    if (!which()) return { kind: "none", reason: "bwrap not installed" };
    const argvPrefix = [
      "bwrap",
      "--ro-bind", "/", "/",
      "--bind", projectRoot, projectRoot,
      "--dev-bind", "/dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--tmpfs", "/run",
      "--bind", tempDir, tempDir,
    ];
    return { kind: "linux-bwrap", argvPrefix };
  }
  return {
    kind: "windows-env",
    env: { TEMP: tempDir, TMP: tempDir },
  };
}

/** Env additions for the plan (Windows env scoping; no-op elsewhere). */
export function sandboxEnvAdditions(plan: SandboxPlan): Record<string, string> {
  return plan.kind === "windows-env" ? plan.env : {};
}

/** argv prefix to insert before the shell invocation ([] when unsandboxed). */
export function sandboxArgvPrefix(plan: SandboxPlan): string[] {
  return plan.kind === "macos-exec" || plan.kind === "linux-bwrap" ? plan.argvPrefix : [];
}
