/**
 * Strips the project root (in Windows host, POSIX without drive, Git-bash, or
 * relative form) from a file or directory path passed by the LLM.
 *
 * LLMs frequently hallucinate POSIX absolute paths from the host project root
 * (e.g. converting `C:\Users\alice\Desktop\my-app` into `/Users/alice/Desktop/my-app`),
 * or pass full Windows paths. When DeepAgents FilesystemBackend strips the leading `/`,
 * `/Users/...` turns into relative `Users/...` which resolves INSIDE the project folder,
 * creating duplicate nested directories like `<project>/Users/alice/Desktop/<project>/...`.
 *
 * Furthermore, on Windows, `path.resolve(root, "/src/App.tsx")` resolves to the drive root
 * `C:\src\App.tsx` instead of the project directory.
 *
 * This function strips any host or virtual project root prefix and always returns a clean
 * workspace-relative path (e.g. `src/App.tsx` or `dahab-coffee/src/Hero.tsx`), with forward
 * slashes and without leading slashes. If the target is the project root itself, returns `""`.
 */
export function stripProjectRoot(rawPath: string, projectRoot: string): string {
  if (!rawPath || typeof rawPath !== "string") return "";
  let trimmed = rawPath.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed || trimmed === "." || trimmed === "/" || trimmed === "\\") return "";
  if (!projectRoot) return trimmed.replace(/\\/g, "/").replace(/^\/+/, "");

  const normPath = trimmed.replace(/\\/g, "/");
  const normRoot = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");

  const isWindows = process.platform === "win32" || /^[a-zA-Z]:/.test(normRoot);
  const compare = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsWith = (str: string, prefix: string) =>
    isWindows ? str.toLowerCase().startsWith(prefix.toLowerCase()) : str.startsWith(prefix);

  // Collect candidate prefixes that represent the project root
  const prefixes = [normRoot, normRoot.replace(/^\/+/, "")];

  if (/^[a-zA-Z]:/.test(normRoot)) {
    const driveLetter = normRoot.charAt(0);
    const withoutDrive = normRoot.replace(/^[a-zA-Z]:/, ""); // e.g. /Users/alice/Desktop/my-app
    prefixes.push(withoutDrive);
    prefixes.push(withoutDrive.replace(/^\/+/, "")); // e.g. Users/alice/Desktop/my-app
    prefixes.push("/" + driveLetter.toLowerCase() + withoutDrive); // e.g. /c/Users/alice/Desktop/my-app
    prefixes.push("/" + driveLetter.toUpperCase() + withoutDrive); // e.g. /C/Users/alice/Desktop/my-app
    prefixes.push(driveLetter.toLowerCase() + withoutDrive); // e.g. c/Users/alice/Desktop/my-app
    prefixes.push(driveLetter.toUpperCase() + withoutDrive); // e.g. C/Users/alice/Desktop/my-app
  }

  // Sort longest prefix first to match most specific prefix
  prefixes.sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (!prefix) continue;
    if (compare(normPath, prefix)) {
      return "";
    }
    const withSlash = prefix.endsWith("/") ? prefix : prefix + "/";
    if (startsWith(normPath, withSlash)) {
      const remainder = normPath.slice(withSlash.length).replace(/^\/+/, "");
      return remainder;
    }
  }

  // If no prefix matched, still strip any leading slashes so it is relative to root
  // (preventing Windows path.resolve from resolving to drive root C:\)
  return normPath.replace(/^\/+/, "");
}

/**
 * Normalizes a path to a virtual workspace path (starting with `/`).
 * If the path contains the host or pseudo-POSIX project root, it is stripped.
 */
export function normalizeVirtualPath(rawPath: string, projectRoot: string): string {
  const stripped = stripProjectRoot(rawPath, projectRoot);
  if (!stripped) return "/";
  return `/${stripped}`;
}

/**
 * Normalizes directory navigation (`cd` or `pushd`) within a shell command string
 * to prevent the model from cding into hallucinated `/Users/...` or full host paths.
 */
export function normalizeCommandPaths(command: string, projectRoot: string): string {
  if (!command || !projectRoot) return command;
  // Match cd or pushd followed by a target path
  return command.replace(
    /((?:^|[&;|\n])\s*(?:cd|pushd)\s+)(["'][^"']+["']|[^\s&;|\n]+)/gi,
    (match, prefix, target) => {
      let unquoted = target.trim();
      const hasQuotes =
        (unquoted.startsWith('"') && unquoted.endsWith('"')) ||
        (unquoted.startsWith("'") && unquoted.endsWith("'"));
      if (hasQuotes) unquoted = unquoted.slice(1, -1);
      const stripped = stripProjectRoot(unquoted, projectRoot);
      if (stripped === "") {
        return prefix + ".";
      }
      const quote = hasQuotes || /\s/.test(stripped) ? '"' : "";
      return prefix + quote + stripped + quote;
    }
  );
}
