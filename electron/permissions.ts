/**
 * Minimal opencode-style bash permission scaffolding.
 * - deny: destructive / privilege-escalation patterns (never run). This is a
 *   backstop against catastrophic agent mistakes, not a sandbox: it blocks
 *   wiping disks/home dirs, killing the machine, and seizing accounts — never
 *   legitimate workflows.
 * - ask: requires an explicit user approval before execution.
 * - allow: everything else.
 *
 * Risky download-and-execute commands are not hard-denied: they require an
 * explicit approval. Ordinary downloads, `reg query`, and
 * service/task-scheduler management remain available without approval.
 */

const DENY_PATTERNS: RegExp[] = [
  // --- disk / filesystem destruction ---
  /\brm\s+.*-rf\s+\/(?:\s|$)/i, // rm -rf /
  /\brm\s+.*--no-preserve-root/i,
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+~(\/|$|\s)/i, // rm -rf ~ (any -rf/-fr/-rfv bundle)
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+\$HOME(\/|$|\s)/i, // rm -rf $HOME
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+["']?\$\{HOME\}(?:[\\/]|["']|$|\s)/i, // rm -rf ${HOME}
  /\brm\s+[^;|&]*-(?=[a-zA-Z]*[rR])(?=[a-zA-Z]*[fF])[a-zA-Z]+[^;|&]*\s+["']?(?:\$(?:WINDIR|SYSTEMROOT|PROGRAMDATA|PROGRAMFILES(?:_X86)?)|\$\{(?:WINDIR|SYSTEMROOT|PROGRAMDATA|PROGRAMFILES(?:_X86)?)\})(?:[\\/]|["']|$|\s)/i, // rm -rf system-directory environment variables
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
  /\b(?:rd|rmdir)\b[^;|&]*\/s\b[^;|&]*[a-z]:\\?(\s|$)/i, // rd /s /q C:\ (cmd.exe)
  /\bdel\b[^;|&]*\/s[^;|&]*[a-z]:\\[^;|&\s]*/i, // del /s … C:\…
  /\b(?:del|erase|rmdir|rd)\b[^;|&]*\/s\b[^;|&]*(?:[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|[\s"';&|]|$)|%(?:windir|systemroot|programfiles(?:\(x86\))?|programdata)%|%systemdrive%\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|[\s"';&|]|$))/i, // cmd recursive deletion of Windows system directories
  /\b(?:Remove-Item|ri)\b[^;|&]*-(?:recurse|r\w*)\b[^;|&]*(?:[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|[\s"';&|]|$)|%(?:windir|systemroot|programfiles(?:\(x86\))?|programdata)%|%systemdrive%\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|[\s"';&|]|$)|\$env:(?:windir|systemroot|programdata|programfiles(?:\(x86\))?))(?:[\\/]|["']|$|\s)/i, // PowerShell recursive deletion of Windows system directories
  /\b(?:del|erase|rmdir|rd)\b[^;|&]*\/s\b[^;|&]*(?:%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|%HOMEPATH%)(?:[\\/]|["']|$|\s)/i, // cmd recursive delete of the current user's profile
  /\b(?:Remove-Item|ri)\b[^;|&]*-(?:recurse|r\w*)\b[^;|&]*(?:%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|%HOMEPATH%)(?:[\\/]|["']|$|\s)/i, // PowerShell with cmd-style environment expansion
  /\b(?:Remove-Item|ri|rmdir|rd)\b[^;|&]*-(?:recurse|r\w*)\b[^;|&]*\s+(~|\$HOME|\$env:USERPROFILE)([\s"'\\/]|$)/i, // PowerShell Remove-Item aliases and abbreviated -Recurse
  /\b(?:Remove-Item|ri|rmdir|rd)\b[^;|&]*-(?:recurse|r\w*)\b[^;|&]*\s+[a-z]:\\?(?:\s|["']|$)/i, // PowerShell recursive deletion of a drive root
  // Recursive deletion through a relative parent path can escape the selected
  // workspace even though the shell starts inside it (this app is not an OS sandbox).
  /\b(?:rm|del|erase|Remove-Item|ri)\b[^;|&\n]*(?:--recursive|-(?:[a-z]*r[a-z]*|recurse|recursive)\b|\/s\b)[^;|&\n]*(?:^|[\s"'=\\/])\.\.(?:[\\/]|[\s"';&|]|$)/im,
  /\b(?:rmdir|rd)\b[^;|&\n]*(?:^|[\s"'=\\/])\.\.(?:[\\/]|[\s"';&|]|$)/im,
  /\breg\s+delete\b/i, // registry deletes (query stays allowed)
  // --- account seizure / privilege escalation ---
  /takeown|icacls.*\/grant/i,
  /\bnet\s+user\b[^;|&]*\/add/i,
  /\bnet\s+localgroup\b[^;|&]*\/add/i,
];

const REMOTE_CODE_PIPE_PATTERN =
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*(?:\|\s*)(?:sh|bash|zsh|dash|fish|python(?:3(?:\.\d+)?)?|perl|ruby|node|pwsh|powershell|iex|invoke-expression)\b/i;
const DOWNLOAD_THEN_RUN_PATTERN =
  /\b(?:curl|wget)\b[^\n]*(?:&&|;|\|\|)\s*(?:(?:\.\/|\.\\)[^\s;&|]+|(?:sh|bash|zsh|python(?:3(?:\.\d+)?)?|perl|ruby|node|pwsh|powershell)\b)/i;
const POWERSHELL_DYNAMIC_EXEC_PATTERN =
  /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*-(?:e|enc|encodedcommand)\s+|\b(?:invoke-expression|iex)\b/i;
const WINDOWS_DOWNLOAD_PATTERN =
  /\bstart-bitstransfer\b|\bbitsadmin\b[^\n]*\/(?:transfer|addfile)\b|\bcertutil\b[^\n]*-urlcache\b/i;
const HTTP_MUTATION_PATTERN =
  /\b(?:curl|wget)\b[^\n]*(?:--(?:request|method)(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b|--(?:data(?:-[a-z]+)?|post-data|post-file|upload-file|form)(?:=|\s+))/i;
const CURL_SHORT_MUTATION_PATTERN = /\bcurl\b[^\n]*(?:\s-d\S*|\s-F\S*|\s-T\S*)/;

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
      /\b(?:npm|pnpm|yarn|pip|pip3|cargo|poetry|uv)\s+(?:install|add|remove|uninstall)\b/i.test(cmd) ||
      /\bgo\s+get\b/i.test(cmd) ||
      /\bmvn\s+(?:dependency|install)\b/i.test(cmd) ||
      /\bdotnet\s+(?:add|remove|restore)\b/i.test(cmd) ||
      REMOTE_CODE_PIPE_PATTERN.test(cmd) ||
      DOWNLOAD_THEN_RUN_PATTERN.test(cmd) ||
      POWERSHELL_DYNAMIC_EXEC_PATTERN.test(cmd) ||
      isWindowsDownloadCommand(cmd) ||
      isHttpMutationCommand(cmd) ||
      /\b(?:Invoke-WebRequest|iwr|irm)\b/i.test(cmd)) return "ask";
  return "allow";
}

export function isHttpMutationCommand(command: string): boolean {
  const cmd = command || "";
  return HTTP_MUTATION_PATTERN.test(cmd) || CURL_SHORT_MUTATION_PATTERN.test(cmd);
}

export function isWindowsDownloadCommand(command: string): boolean {
  return WINDOWS_DOWNLOAD_PATTERN.test(command || "");
}

export function isDeniedCommand(command: string): boolean {
  return classifyCommand(command) === "deny";
}
