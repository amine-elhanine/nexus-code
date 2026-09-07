/**
 * Minimal opencode-style bash permission scaffolding.
 * - deny: destructive / privilege-escalation patterns (never run). This is a
 *   backstop against catastrophic agent mistakes, not a sandbox: it blocks
 *   wiping disks/home dirs, killing the machine, and seizing accounts — never
 *   legitimate workflows.
 * - ask: reserved for future UI approval (currently treated as allow-but-logged
 *   at the execution layer; the agent prompt tells the model to prefer safe variants).
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

export function classifyCommand(command: string): CommandPermission {
  const cmd = (command || "").trim();
  if (!cmd) return "deny";
  if (DENY_PATTERNS.some((re) => re.test(cmd))) return "deny";
  return "allow";
}

export function isDeniedCommand(command: string): boolean {
  return classifyCommand(command) === "deny";
}
