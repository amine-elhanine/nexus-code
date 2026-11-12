// Virtual filesystem backend — the self-built replacement for deepagents'
// FilesystemBackend + CompositeBackend. A backend roots every agent file
// operation at ONE directory (virtual mode: agent paths are absolute under
// "/", host paths never leak), supports route mounts for skills, and carries
// the run-policy gates (read-only, edit approval, legacy-state guard, output
// caps, LSP diagnostics) that used to be layered on by monkey-patching the
// deepagents object in command-service.getAgentBackend.
//
// The backend protocol mirrors what the built-in tools expect:
//   ls(path) -> { files: [{ path, is_dir, size? }], error? }
//   glob(pattern, path) -> { files, error? }
//   grep(pattern, path, globFilter?, maxCount?) -> { matches: [{ path, line, text }], truncated?, error? }
//   read(file, offset?, limit?) -> { content, startLine?, endLine?, totalLines?, error? }
//   write(file, content) -> { error?, occurrences? }
//   edit(file, oldString, newString, replaceAll?) -> { error?, occurrences? }
//   delete(file) -> { error?, path? }
//   execute(command) -> { output, exitCode, truncated }

import { promises as fsPromises, existsSync } from "node:fs";
import path from "node:path";
import { normalizeVirtualPath } from "../path-utils.js";
import { isLegacyStatePath, LEGACY_STATE_REJECTION } from "../state-guard.js";
import { executeCommand, readCommandPolicyWithTrust } from "../command-service.js";
import { collectPostEditDiagnostics } from "../lsp-service.js";
import { requestCommandApproval } from "../approval-service.js";
import type { ProjectRecord } from "../store.js";

export type FileInfo = { path: string; is_dir: boolean; size?: number };
export type GrepMatch = { path: string; line: number; text: string };

export interface AgentBackend {
  id: string;
  /** Route prefix this backend serves under a composite root ("/" for the workspace). */
  route?: string;
  /** Host root directory (workspace backends). */
  rootDir?: string;
  /** Virtual path as the agent sees it (workspace backends). */
  virtualOf?(key: string): string;
  resolvePath(key: string): string;
  ls(path?: string): Promise<{ files: FileInfo[]; error?: string }>;
  glob(pattern: string, path?: string): Promise<{ files: FileInfo[]; error?: string }>;
  grep(pattern: string, path?: string, globFilter?: string | null, maxCount?: number): Promise<{ matches: GrepMatch[]; truncated?: boolean; error?: string }>;
  read(file: string, offset?: number, limit?: number): Promise<{ content: string; startLine?: number; endLine?: number; totalLines?: number; mimeType?: string; error?: string }>;
  write(file: string, content: string): Promise<{ error?: string; occurrences?: number }>;
  edit(file: string, oldString: string, newString: string, replaceAll?: boolean): Promise<{ error?: string; occurrences?: number }>;
  delete(file: string): Promise<{ error?: string; path?: string }>;
  execute?(command: string): Promise<{ output: string; exitCode: number | null; truncated?: boolean }>;
  mounts?: Record<string, AgentBackend>;
}

const MAX_LIST_ENTRIES = 200;
const MAX_GREP_MATCHES = 100;
const MAX_LINE_LENGTH = 5000;
const DEFAULT_READ_LIMIT = 100;

function normalizeKey(key: string): string {
  const raw = String(key ?? "").replace(/\\/g, "/");
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** Rooted, containment-checked filesystem backend (deepagents FilesystemBackend port). */
export class WorkspaceBackend implements AgentBackend {
  id: string;
  rootDir: string;
  virtualMode: boolean;
  route?: string;
  mounts: Record<string, AgentBackend> = {};

  constructor(options: { rootDir?: string; id?: string; virtualMode?: boolean; route?: string } = {}) {
    this.rootDir = path.resolve(options.rootDir || process.cwd());
    this.virtualMode = options.virtualMode !== false;
    this.id = options.id || "workspace";
    this.route = options.route;
  }

  resolvePath(key: string): string {
    const normalized = normalizeVirtualPath(String(key ?? ""), this.rootDir);
    if (!this.virtualMode) return path.resolve(this.rootDir, normalized);
    let vpath = normalizeKey(normalized);
    if (vpath.includes("..") || vpath.startsWith("~")) throw new Error("Path traversal not allowed");
    // Collapse duplicate leading slashes (skill mounts sanitize the same way).
    vpath = "/" + vpath.replace(/^\/+/, "");
    const resolved = path.resolve(this.rootDir, vpath.slice(1) || ".");
    const rootCmp = process.platform === "win32" ? this.rootDir.toLowerCase() : this.rootDir;
    const resolvedCmp = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (resolvedCmp !== rootCmp && !resolvedCmp.startsWith(rootCmp + path.sep)) {
      throw new Error(`Path '${key}' resolves outside the workspace root`);
    }
    return resolved;
  }

  /** Virtual path as the agent sees it (used for tool outputs). */
  virtualOf(key: string): string {
    const resolved = this.resolvePath(key);
    const rel = path.relative(this.rootDir, resolved).replace(/\\/g, "/");
    return "/" + (rel || "");
  }

  private routeFor(virtualPath: string): { backend: AgentBackend; key: string } | null {
    // Collapse multi-slash prefixes ("//global-skills") so the mounted route
    // variants never miss.
    const normalized = `/${virtualPath.replace(/^\/+/, "")}`;
    for (const [prefix, backend] of Object.entries(this.mounts)) {
      const clean = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
      if (normalized === clean || normalized.startsWith(`${clean}/`) || normalized.startsWith(clean)) {
        return { backend, key: normalized.slice(clean.length) || "/" };
      }
    }
    return null;
  }

  private async routed<T>(key: string, op: (backend: AgentBackend, key: string) => Promise<T>): Promise<T> {
    const hit = this.routeFor(normalizeKey(String(key ?? "")));
    if (hit) return op(hit.backend, hit.key);
    return op(this, key);
  }

  /**
   * Route a MUTATING operation to the mounted backend's own method. Mutations
   * must never be executed directly against a mount's resolved path: doing so
   * bypasses the mount's instance-method gates (read-only skill stubs), which
   * is exactly what those stubs exist to enforce. Reads have no gates and may
   * keep using routed().
   */
  private routeMutation(key: string): { backend: AgentBackend; key: string } | null {
    const hit = this.routeFor(normalizeKey(String(key ?? "")));
    return hit && hit.backend !== (this as unknown as AgentBackend) ? hit : null;
  }

  async ls(pathKey = "/"): Promise<{ files: FileInfo[]; error?: string }> {
    return this.routed(pathKey, async (backend, key) => {
      try {
        const abs = backend.resolvePath(key);
        // Async fs throughout: these tools run in the Electron main process,
        // and synchronous I/O here freezes every window and IPC handler while
        // a large directory is scanned.
        const entries = await fsPromises.readdir(abs, { withFileTypes: true });
        const files: FileInfo[] = [];
        for (const entry of entries) {
          const full = path.join(abs, entry.name);
          if (entry.isDirectory()) files.push({ path: `${backend.virtualOf!(key).replace(/\/$/, "")}/${entry.name}`, is_dir: true });
          else {
            let size: number | undefined;
            try { size = (await fsPromises.stat(full)).size; } catch { /* stat race */ }
            files.push({ path: `${backend.virtualOf!(key).replace(/\/$/, "")}/${entry.name}`, is_dir: false, size });
          }
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { files: files.slice(0, MAX_LIST_ENTRIES) };
      } catch (error: any) {
        return { files: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async glob(pattern: string, pathKey = "/"): Promise<{ files: FileInfo[]; error?: string }> {
    return this.routed(pathKey, async (backend, key) => {
      try {
        const found: FileInfo[] = [];
        // Async BFS walk (explicit stack, bounded): same traversal as before,
        // without stalling the main-process event loop on large trees.
        const stack: Array<{ dir: string; virtual: string; depth: number }> = [{ dir: backend.resolvePath("/"), virtual: "/", depth: 0 }];
        while (stack.length && found.length < MAX_LIST_ENTRIES) {
          const { dir, virtual, depth } = stack.shift()!;
          if (depth > 12) continue;
          let entries;
          try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { continue; }
          const pendingDirs: Array<{ dir: string; virtual: string; depth: number }> = [];
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const vpath = `${virtual}/${entry.name}`;
            if (entry.isDirectory()) {
              if (entry.name === "node_modules" || entry.name === ".git") continue;
              pendingDirs.push({ dir: full, virtual: vpath, depth: depth + 1 });
            } else if (miniGlobMatch(pattern, vpath) || miniGlobMatch(pattern, entry.name)) {
              let size: number | undefined;
              try { size = (await fsPromises.stat(full)).size; } catch { /* ignore */ }
              found.push({ path: vpath, is_dir: false, size });
              if (found.length >= MAX_LIST_ENTRIES) break;
            }
          }
          stack.unshift(...pendingDirs);
        }
        return { files: found };
      } catch (error: any) {
        return { files: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async grep(pattern: string, pathKey = "/", globFilter?: string | null, maxCount = MAX_GREP_MATCHES): Promise<{ matches: GrepMatch[]; truncated?: boolean; error?: string }> {
    return this.routed(pathKey, async (backend, key) => {
      try {
        const abs = backend.resolvePath(key);
        const matches: GrepMatch[] = [];
        let truncated = false;
        // Async DFS walk: synchronous readdir/readFile here used to block the
        // Electron main process for the whole scan (frozen windows + IPC).
        const walk = async (dir: string, virtual: string, depth: number): Promise<void> => {
          if (truncated || depth > 24) return;
          let entries;
          try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (truncated) return;
            const full = path.join(dir, entry.name);
            const vpath = `${virtual}/${entry.name}`;
            if (entry.isDirectory()) {
              if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
              await walk(full, vpath, depth + 1);
              continue;
            }
            if (globFilter && !miniGlobMatch(globFilter, entry.name)) continue;
            if (/\.(bin|exe|dll|so|dylib|zip|tar|gz|7z|rar|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf)$/i.test(entry.name)) continue;
            let stat;
            try { stat = await fsPromises.stat(full); } catch { continue; }
            if (!stat.isFile() || stat.size > 2_000_000) continue;
            let text: string;
            try { text = await fsPromises.readFile(full, "utf8"); } catch { continue; }
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                matches.push({ path: vpath, line: i + 1, text: lines[i].slice(0, 300) });
                if (matches.length >= maxCount) { truncated = true; break; }
              }
            }
          }
        };
        await walk(abs, backend.virtualOf!(key).replace(/\/$/, ""), 0);
        return { matches, truncated };
      } catch (error: any) {
        return { matches: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async read(file: string, offset = 0, limit = DEFAULT_READ_LIMIT): Promise<{ content: string; startLine?: number; endLine?: number; totalLines?: number; error?: string }> {
    return this.routed(file, async (backend, key) => {
      try {
        const abs = backend.resolvePath(key);
        const stat = await fsPromises.stat(abs);
        if (stat.size > 10 * 1024 * 1024) return { content: "", error: `File too large to read (${Math.round(stat.size / 1024 / 1024)}MB exceeds 10MB limit)` };
        const text = await fsPromises.readFile(abs, "utf8");
        const lines = text.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const startLine = Math.max(0, offset);
        const endLine = Math.min(lines.length, startLine + Math.max(1, limit));
        const content = lines.slice(startLine, endLine).join("\n");
        return {
          content,
          startLine: startLine + 1,
          endLine,
          totalLines: lines.length,
        };
      } catch (error: any) {
        return { content: "", error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async write(file: string, content: string): Promise<{ error?: string }> {
    const hit = this.routeMutation(file);
    if (hit) return hit.backend.write(hit.key, content);
    return this.routed(file, async (backend, key) => {
      if (isLegacyStatePath(key, backend.rootDir)) return { error: LEGACY_STATE_REJECTION };
      try {
        const abs = backend.resolvePath(key);
        await fsPromises.mkdir(path.dirname(abs), { recursive: true });
        await fsPromises.writeFile(abs, content, "utf8");
        return {};
      } catch (error: any) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async edit(file: string, oldString: string, newString: string, replaceAll = false): Promise<{ error?: string; occurrences?: number }> {
    const hit = this.routeMutation(file);
    if (hit) return hit.backend.edit(hit.key, oldString, newString, replaceAll);
    return this.routed(file, async (backend, key) => {
      if (isLegacyStatePath(key, backend.rootDir)) return { error: LEGACY_STATE_REJECTION };
      try {
        const abs = backend.resolvePath(key);
        const current = await fsPromises.readFile(abs, "utf8");
        if (!current.includes(oldString)) return { error: `String to replace not found in file: '${key}'. The file has not been modified — check the exact text (including whitespace) with read_file first.` };
        const occurrences = current.split(oldString).length - 1;
        if (occurrences > 1 && !replaceAll) {
          return { error: `Found ${occurrences} occurrences of the string to replace. Provide more surrounding context to make the match unique, or pass replace_all=true.` };
        }
        const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
        await fsPromises.writeFile(abs, next, "utf8");
        return { occurrences: replaceAll ? occurrences : 1 };
      } catch (error: any) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async delete(file: string): Promise<{ error?: string; path?: string }> {
    const hit = this.routeMutation(file);
    if (hit) return hit.backend.delete(hit.key);
    return this.routed(file, async (backend, key) => {
      try {
        const abs = backend.resolvePath(key);
        await fsPromises.unlink(abs);
        return { path: key };
      } catch (error: any) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async execute(command: string): Promise<{ output: string; exitCode: number | null; truncated?: boolean }> {
    throw new Error("Execution not available: this backend does not implement command execution. Provide an execute policy when constructing the backend.");
  }
}

// Minimal glob matching for the patterns tools actually receive (**, *, ?).
function miniGlobMatch(pattern: string, target: string): boolean {
  if (pattern === "**" || pattern === "**/*") return true;
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(target) || new RegExp(`^.*${regex}$`).test(target);
}

export type BackendRunPolicy = {
  readOnly?: boolean;
  runId?: string;
  editPolicy?: "auto" | "ask";
  fullAccess?: boolean;
  onCommandOutput?: (command: string, chunk: string) => void;
};

/**
 * The run-scoped workspace backend: workspace root + skill mounts + every
 * policy gate the run needs (read-only stubs, command approval pipeline,
 * edit-approval gate, legacy-dir guard, LSP post-edit diagnostics, listing
 * caps). Ports the interceptions that command-service.getAgentBackend used to
 * apply by monkey-patching a deepagents backend.
 */
export async function getAgentBackend(project: ProjectRecord, options: BackendRunPolicy = {}): Promise<{ backend: CompositeAgentBackend; workspace: string }> {
  const root = path.resolve(project.root);
  const backend = new CompositeAgentBackend({ rootDir: root, id: `workspace-${project.id}` });

  if (options.readOnly) {
    const refuse = (action: string) => async () => {
      throw new Error(`Plan mode is read-only: ${action} is disabled. Explore the repository and produce an implementation plan instead of changing files.`);
    };
    backend.write = refuse("write_file") as any;
    backend.edit = refuse("edit_file") as any;
    backend.delete = refuse("delete") as any;
    backend.execute = refuse("execute") as any;
    return { backend, workspace: root };
  }

  // Pin command policy at run start: the agent must not be able to write an
  // allow rule into the workspace and use it to self-approve a later command.
  const { policy: commandPolicy, trustedAllow: commandPolicyTrusted } = await readCommandPolicyWithTrust(root);
  backend.execute = (command: string) => executeCommand(root, command, {
    runId: options.runId,
    requireApproval: true,
    fullAccess: options.fullAccess,
    policy: commandPolicy,
    policyTrusted: commandPolicyTrusted,
    onOutput: options.onCommandOutput ? (chunk) => options.onCommandOutput!(command, chunk) : undefined,
  });

  if (options.editPolicy === "ask" && !options.fullAccess) {
    const gate = (action: string, original: any) => async (filePath: string, ...rest: any[]) => {
      const decision = await requestCommandApproval({
        runId: options.runId,
        approvalKey: "file-edit",
        command: `${action} ${filePath}`,
        cwd: root,
        reason: "Edit approval is on: file changes wait for your confirmation.",
      });
      if (decision === "deny") throw new Error(`Edit denied by the user: ${action} on ${filePath} was not approved. Do not retry the same change; explain what you intended instead.`);
      return (original as (...args: any[]) => unknown)(filePath, ...rest);
    };
    for (const action of ["write", "edit", "delete"] as const) {
      const original = backend[action]?.bind(backend);
      if (original) backend[action] = gate(action, original) as any;
    }
  }

  for (const action of ["write", "edit"] as const) {
    const orig = backend[action]?.bind(backend) as ((filePath: string, ...rest: any[]) => unknown) | undefined;
    if (orig) {
      (backend[action] as any) = async (filePath: string, ...rest: any[]) => {
        const res = await orig(filePath, ...rest);
        const diags = await collectPostEditDiagnostics(root, [filePath]).catch(() => null);
        if (diags) {
          if (typeof res === "string") return res + diags;
          if (typeof res === "object" && res !== null) return { ...res, lspDiagnostics: diags };
        }
        return res;
      };
    }
  }
  return { backend, workspace: root };
}

/**
 * Composite backend: routes over mounted skill backends, delegates everything
 * else to the workspace root (deepagents CompositeBackend port).
 */
export class CompositeAgentBackend extends WorkspaceBackend {
  constructor(options: { rootDir: string; id?: string; /** Execute wiring carried over from the wrapped workspace backend. */ execute?: (command: string) => Promise<{ output: string; exitCode: number | null; truncated?: boolean }> }) {
    super({ rootDir: options.rootDir, id: options.id });
    if (options.execute) this.execute = options.execute;
  }

  /** Mount a skill backend under a virtual route (e.g. "/global-skills"). */
  mount(route: string, backend: AgentBackend): void {
    this.mounts[route] = backend;
  }
}

/** Skill-directory backend: read-only or write-scoped per the run mode. */
export function createSkillBackend(options: { rootDir: string; id: string; readOnly?: boolean; readOnlyReason?: string }): WorkspaceBackend {
  const backend = new WorkspaceBackend({ rootDir: options.rootDir, id: options.id });
  if (options.readOnly) {
    const refuse = (action: string) => async () => {
      throw new Error(`${options.readOnlyReason || "This backend"}: ${action} is disabled.`);
    };
    backend.write = refuse("write_file") as any;
    backend.edit = refuse("edit_file") as any;
    backend.delete = refuse("delete") as any;
    backend.execute = refuse("execute") as any;
  }
  return backend;
}

/** True when the path exists in the workspace (used by deliverable checks). */
export function backendFileExists(backend: AgentBackend, fileKey: string): boolean {
  try {
    const abs = (backend as unknown as { resolvePath(key: string): string }).resolvePath(fileKey);
    return existsSync(abs);
  } catch {
    return false;
  }
}
