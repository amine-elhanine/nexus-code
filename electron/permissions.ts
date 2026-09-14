/**
 * Minimal opencode-style bash permission scaffolding.
 * - deny: destructive / privilege-escalation patterns (never run). This is a
 *   backstop against catastrophic agent mistakes, not a sandbox: it blocks
 *   wiping disks/home dirs, killing the machine, and seizing accounts — never
 *   legitimate workflows.
 * - ask: requires an explicit user approval before execution.
 * - allow: everything else.
 *
 * Deliberately NOT blocked (would break normal dev work): `curl … | sh`
 * installers, `powershell -EncodedCommand`, batch `goto` loops, `reg query`,
 * service/task-scheduler management. Run those only from trusted sources.
 */

const DENY_PATTERNS: RegExp[] = [
  // --- disk / filesystem destruction ---
  /\brm\s+.*-rf\s+\/(?:\s|$)/i, // rm -rf /
  /\brm\s+.*--no-preserve-root/i,
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+~(\/|$|\s)/i, // rm -rf ~ (any -rf/-fr/-rfv bundle)
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+\$HOME(\/|$|\s)/i, // rm -rf $HOME
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+\/home\/[^;|&\s]*/i, // rm -rf /home/…
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+\/root(\/|$|\s)/i, // rm -rf /root
  /\bmkfs(\.\w+)?\b/i, // mkfs, mkfs.ext4, …
  /\bdd\b\s+.*of=\/dev\//i,
  /\bchmod\s+[^;|&]*-R[^;|&]*\s+\/(?:\s|$)/i, // chmod -R … /
  /\bchown\s+[^;|&]*-R[^;|&]*\s+\/(?:\s|$)/i, // chown -R … /
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  // --- machine / boot destruction (both shells) ---
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bvssadmin\s+delete\s+shadows/i, // shadow-copy wipe (ransomware pattern)
  /\bwmic\s+shadowcopy\s+delete/i,
  /\bbcdedit\b/i, // boot config edits
  // --- Windows recursive deletes of roots/profiles ---
  /\brd\s+\/s(\s+\/q)?\s+[a-z]:\\?(\s|$)/i, // rd /s /q C:\
  /\bdel\b[^;|&]*\/s[^;|&]*[a-z]:\\[^;|&\s]*/i, // del /s … C:\…
  /Remove-Item[^;|&]*-(Recurse|RF)[^;|&]*\s+(~|\$HOME|\$env:USERPROFILE|[a-z]:\\?)([\s"'\\/]|$)/i,
  /\breg\s+delete\b/i, // registry deletes (query stays allowed)
  // --- account seizure / privilege escalation ---
  /takeown|icacls.*\/grant/i,
  /\bnet\s+user\b[^;|&]*\/add/i,
  /\bnet\s+localgroup\b[^;|&]*\/add/i,
];

export type CommandPermission = "allow" | "ask" | "deny";
export type CommandPolicy = { allow?: string[]; ask?: string[]; deny?: string[] };

function matchesPolicy(command: string, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (typeof pattern !== "string" || !pattern.trim()) return false;
    const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i").test(command);
  });
}

export function classifyCommand(command: string, policy: CommandPolicy = {}): CommandPermission {
  const cmd = (command || "").trim();
  if (!cmd) return "deny";
  if (DENY_PATTERNS.some((re) => re.test(cmd))) return "deny";
  if (matchesPolicy(cmd, policy.deny)) return "deny";
  if (matchesPolicy(cmd, policy.allow)) return "allow";
  if (matchesPolicy(cmd, policy.ask)) return "ask";
  if (/\bgit\s+(push|reset|clean|rebase)\b/i.test(cmd) ||
      /\b(?:npm|pnpm|yarn|pip|pip3|cargo)\s+(?:install|add|remove|uninstall)\b/i.test(cmd) ||
      /\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b/i.test(cmd) ||
      /\b(?:Invoke-WebRequest|iwr|irm)\b/i.test(cmd)) return "ask";
  return "allow";
}

export function isDeniedCommand(command: string): boolean {
  return classifyCommand(command) === "deny";
}
