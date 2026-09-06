/**
 * Minimal opencode-style bash permission scaffolding.
 * - deny: destructive / privilege-escalation patterns (never run).
 * - ask: reserved for future UI approval (currently treated as allow-but-logged
 *   at the execution layer; the agent prompt tells the model to prefer safe variants).
 * - allow: everything else.
 */

const DENY_PATTERNS: RegExp[] = [
  /\brm\s+.*-rf\s+\/(?:\s|$)/i, // rm -rf /
  /\brm\s+.*--no-preserve-root/i,
  /\bmkfs\b/i,
  /\bdd\b\s+.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bformat\s+[a-z]:/i,
  /takeown|icacls.*\/grant/i,
];

export type CommandPermission = "allow" | "ask" | "deny";

export function classifyCommand(command: string): CommandPermission {
  const cmd = (command || "").trim();
  if (!cmd) return "deny";
  if (DENY_PATTERNS.some((re) => re.test(cmd))) return "deny";
  return "allow";
}

export function isDeniedCommand(command: string): boolean {
  return classifyCommand(command) === "deny";
}
