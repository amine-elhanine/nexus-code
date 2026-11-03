// Minimal LSP client (Phase B code intelligence). Lazy-spawns ONE language
// server per language per project and speaks JSON-RPC 2.0 with LSP framing
// over stdio — hand-rolled, no protocol dependency. Surface is deliberately
// limited to what pays for an agent: definition, references, documentSymbol,
// publishDiagnostics. Any failure (server missing, init timeout, request
// timeout, crash) resolves null and marks the language unavailable, so
// callers degrade to the tree-sitter/regex tools and a run is never blocked.
import { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guardAgainstLegacyStateDir } from "./state-guard.js";
import type { DiagnosticItem } from "./code-tools.js";

export type LspLanguage = "typescript" | "python" | "go" | "rust" | "cpp";

const INIT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const MAX_OPEN_BYTES = 512 * 1024;

const SERVER_COMMANDS: Record<LspLanguage, { command: string; args: string[] }> = {
  typescript: { command: "npx", args: ["--no-install", "typescript-language-server", "--stdio"] },
  python: { command: "npx", args: ["--no-install", "pyright-langserver", "--stdio"] },
  go: { command: "gopls", args: [] },
  rust: { command: "rust-analyzer", args: [] },
  cpp: { command: "clangd", args: [] },
};

const EXTENSION_TO_LANGUAGE: Record<string, LspLanguage> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "typescript", ".jsx": "typescript",
  ".mjs": "typescript", ".cjs": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "cpp", ".cpp": "cpp", ".h": "cpp", ".hpp": "cpp", ".cc": "cpp",
};

export function languageForFile(filePath: string): LspLanguage | null {
  return EXTENSION_TO_LANGUAGE[path.extname(filePath).toLowerCase()] ?? null;
}

const SERVER_LABEL: Record<LspLanguage, string> = {
  typescript: "typescript-language-server",
  python: "pyright-langserver",
  go: "gopls",
  rust: "rust-analyzer",
  cpp: "clangd",
};

/** Maps an LSP SymbolKind number onto the SymbolEntry kind vocabulary. */
export function lspSymbolKindToKind(kind: number): "function" | "class" | "interface" | "type" | "variable" | "struct" | "enum" | "trait" {
  switch (kind) {
    case 5: return "class";       // Class
    case 6: case 9: case 12: return "function"; // Method, Constructor, Function
    case 10: return "enum";       // Enum
    case 11: return "interface";  // Interface
    case 23: return "struct";     // Struct
    case 26: return "type";       // TypeParameter
    default: return "variable";   // Property, Field, Variable, Constant, EnumMember, …
  }
}

/** Parses a byte buffer of LSP-framed messages into { frames, rest }. */
export function parseLspFrames(buffer: Buffer): { frames: any[]; rest: Buffer } {
  const frames: any[] = [];
  let work = buffer;
  for (;;) {
    const headerEnd = work.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = work.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (work.length < start + length) break;
    try {
      frames.push(JSON.parse(work.slice(start, start + length).toString("utf8")));
    } catch { /* skip malformed frame */ }
    work = work.slice(start + length);
  }
  return { frames, rest: work };
}

function toLspUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

function fromLspUri(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, "")).replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return uri;
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

class LspServer {
  readonly language: LspLanguage;
  private readonly projectRoot: string;
  private proc: ChildProcess | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private diagnostics = new Map<string, DiagnosticItem[]>();
  private ready: Promise<boolean>;
  private closed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private openedUris = new Set<string>();

  constructor(language: LspLanguage, projectRoot: string) {
    this.language = language;
    this.projectRoot = path.resolve(projectRoot);
    this.ready = this.initialize();
  }

  get whenReady(): Promise<boolean> {
    return this.ready;
  }

  private spawnServer(): ChildProcess | null {
    const spec = SERVER_COMMANDS[this.language];
    try {
      if (process.platform === "win32") {
        // Node refuses to spawn .cmd shims without a shell (EINVAL since 18.20).
        const comspec = process.env.ComSpec || "cmd.exe";
        const full = [spec.command, ...spec.args].join(" ");
        return spawn(comspec, ["/d", "/s", "/c", full], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      return spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return null;
    }
  }

  private async initialize(): Promise<boolean> {
    const proc = this.spawnServer();
    if (!proc || !proc.pid) return false;
    this.proc = proc;
    // Allow standalone CLI scripts and unit tests to exit without waiting for
    // the 5-minute idle timer when no LSP request is actively awaiting a timer.
    proc.unref?.();
    (proc.stdin as any)?.unref?.();
    (proc.stdout as any)?.unref?.();
    (proc.stderr as any)?.unref?.();

    proc.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    proc.stderr?.on("data", () => { /* servers log verbosely; ignore */ });
    const dead = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.once("exit", () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("LSP server exited"));
      }
      this.pending.clear();
    });

    let initializeTimer: NodeJS.Timeout | undefined;
    try {
      const initResult = await Promise.race([
        this.request("initialize", {
          processId: process.pid,
          rootUri: toLspUri(this.projectRoot),
          capabilities: {
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: false },
              publishDiagnostics: { relatedInformation: false },
            },
          },
          // typescript-language-server refuses to start without a TypeScript
          // installation resolvable from the workspace; point it at the app's
          // own copy when the project has none of its own.
          initializationOptions: this.tsserverOptions(),
        }),
        dead.then(() => { throw new Error("server exited during initialize"); }),
        new Promise<never>((_, reject) => {
          initializeTimer = setTimeout(
            () => reject(new Error(`${SERVER_LABEL[this.language]} initialize timed out after 30s`)),
            INIT_TIMEOUT_MS,
          );
        }),
      ]);
      if (!initResult?.capabilities) return false;
      await this.notify("initialized", {});
      this.scheduleIdleShutdown();
      return true;
    } catch {
      this.shutdown();
      return false;
    } finally {
      // Promise.race does not cancel its losing promises. Without clearing this
      // timer, every successful language-server startup keeps Node/Electron
      // alive for another 30 seconds and can hold the test runner open.
      if (initializeTimer) clearTimeout(initializeTimer);
    }
  }

  private tsserverOptions(): Record<string, unknown> | undefined {
    if (this.language !== "typescript") return undefined;
    // typescript-language-server resolves the WORKSPACE's own TypeScript
    // first; fallbackPath only applies when the project has none it can use
    // (e.g. TypeScript 7 projects — tsgo ships no tsserver.js, which the
    // server requires). The typescript5 dev alias covers that case in dev
    // and CI; packaged builds rely on the project's own installation.
    const candidates = [
      path.resolve(process.cwd(), "node_modules", "typescript5", "lib", "tsserver.js"),
      path.resolve(process.cwd(), "node_modules", "typescript", "lib", "tsserver.js"),
    ];
    const fallback = candidates.find((candidate) => existsSync(candidate));
    return fallback ? { tsserver: { fallbackPath: fallback } } : undefined;
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = parseLspFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame?.method === "textDocument/publishDiagnostics") {
        this.diagnostics.set(String(frame.params?.uri ?? ""), this.parseDiagnostics(frame.params?.diagnostics));
        continue;
      }
      if (frame?.id != null && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id)!;
        this.pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) entry.reject(new Error(String(frame.error?.message ?? "LSP request failed")));
        else entry.resolve(frame.result);
      }
    }
  }

  private parseDiagnostics(items: any): DiagnosticItem[] {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 50).map((d: any) => ({
      file: "", // caller fills the file path; diagnostics are keyed per-uri
      line: (d?.range?.start?.line ?? 0) + 1,
      col: (d?.range?.start?.character ?? 0) + 1,
      code: String(d?.code ?? ""),
      message: String(d?.message ?? "").slice(0, 300),
      severity: d?.severity === 1 ? "error" : "warning",
    } as DiagnosticItem & { severity?: string }));
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    if (this.closed || !this.proc?.stdin?.writable) return Promise.reject(new Error("LSP server not running"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.closed || !this.proc?.stdin?.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    await new Promise<void>((resolve) => {
      this.proc!.stdin!.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`, () => resolve());
    });
  }

  /** didOpen the file so the server has content for position queries. */
  private async ensureOpened(filePath: string, forceRefresh = false): Promise<string | null> {
    const abs = path.resolve(filePath);
    const uri = toLspUri(abs);
    if (this.openedUris.has(uri) && !forceRefresh) return uri;
    let text: string;
    try {
      const raw = await fsPromises.readFile(abs);
      if (raw.length > MAX_OPEN_BYTES) return null;
      text = raw.toString("utf8");
    } catch {
      return null;
    }
    if (this.openedUris.has(uri)) {
      await this.notify("textDocument/didClose", { textDocument: { uri } });
      this.openedUris.delete(uri);
    }
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.language === "typescript" ? "typescript" : this.language, version: Date.now() % 1_000_000, text },
    });
    this.openedUris.add(uri);
    return uri;
  }

  async documentSymbol(filePath: string): Promise<Array<{ kind: ReturnType<typeof lspSymbolKindToKind>; name: string; line: number; detail: string }>> {
    const uri = await this.ensureOpened(filePath);
    if (!uri) return [];
    const result = await this.request("textDocument/documentSymbol", { textDocument: { uri } });
    if (!Array.isArray(result)) return [];
    // Servers may answer with hierarchical DocumentSymbol (range) or flat
    // SymbolInformation (location.range) depending on negotiated capabilities.
    return result
      .map((s: any) => {
        const start = s?.range?.start ?? s?.location?.range?.start;
        if (!s?.name || !start) return null;
        return {
          kind: lspSymbolKindToKind(Number(s.kind ?? 13)),
          name: String(s.name),
          line: (start.line ?? 0) + 1,
          detail: String(s.detail ?? "").slice(0, 120),
        };
      })
      .filter((s: any): s is NonNullable<typeof s> => s !== null);
  }

  async definition(filePath: string, line1: number, characterUtf16: number): Promise<Array<{ path: string; line: number; col: number }>> {
    const uri = await this.ensureOpened(filePath);
    if (!uri) return [];
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: Math.max(0, line1 - 1), character: Math.max(0, characterUtf16) },
    });
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return locations
      .filter((l: any) => l?.uri && l?.range?.start)
      .map((l: any) => ({ path: fromLspUri(String(l.uri)), line: (l.range.start.line ?? 0) + 1, col: (l.range.start.character ?? 0) + 1 }));
  }

  async references(filePath: string, line1: number, characterUtf16: number): Promise<Array<{ path: string; line: number; col: number }>> {
    const uri = await this.ensureOpened(filePath);
    if (!uri) return [];
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position: { line: Math.max(0, line1 - 1), character: Math.max(0, characterUtf16) },
      context: { includeDeclaration: false },
    });
    if (!Array.isArray(result)) return [];
    return result
      .filter((l: any) => l?.uri && l?.range?.start)
      .map((l: any) => ({ path: fromLspUri(String(l.uri)), line: (l.range.start.line ?? 0) + 1, col: (l.range.start.character ?? 0) + 1 }));
  }

  async rename(filePath: string, line1: number, characterUtf16: number, newName: string): Promise<Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> | null> {
    const uri = await this.ensureOpened(filePath);
    if (!uri) return null;
    const result: any = await this.request("textDocument/rename", {
      textDocument: { uri },
      position: { line: Math.max(0, line1 - 1), character: Math.max(0, characterUtf16) },
      newName,
    });
    if (!result) return null;
    const editsByFile: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> = {};
    if (result.changes) {
      for (const [docUri, textEdits] of Object.entries(result.changes)) {
        const targetPath = fromLspUri(docUri);
        editsByFile[targetPath] = (textEdits as any[]).map((e) => ({
          range: e.range,
          newText: e.newText,
        }));
      }
    } else if (Array.isArray(result.documentChanges)) {
      for (const change of result.documentChanges) {
        if (change.textDocument?.uri && Array.isArray(change.edits)) {
          const targetPath = fromLspUri(change.textDocument.uri);
          editsByFile[targetPath] = change.edits.map((e: any) => ({
            range: e.range,
            newText: e.newText,
          }));
        }
      }
    }
    return editsByFile;
  }

  diagnosticsFor(filePath: string): DiagnosticItem[] {
    const uri = toLspUri(path.resolve(filePath));
    return (this.diagnostics.get(uri) ?? []).map((d) => ({ ...d, file: path.relative(this.projectRoot, filePath).replace(/\\/g, "/") }));
  }

  /** didOpen + brief wait for the server to push publishDiagnostics. */
  async collectDiagnostics(filePath: string, waitMs = 1500): Promise<DiagnosticItem[]> {
    const abs = path.resolve(filePath);
    const uri = toLspUri(abs);
    this.diagnostics.delete(uri);
    const openedUri = await this.ensureOpened(filePath, true);
    if (!openedUri) return [];
    await new Promise((r) => setTimeout(r, waitMs));
    return this.diagnosticsFor(filePath);
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  touch(): void {
    if (!this.closed) this.scheduleIdleShutdown();
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      // exit notification is fire-and-forget; the tree kill is the guarantee.
      void this.notify("exit", {});
    } catch { /* best effort */ }
    const proc = this.proc;
    this.proc = null;
    if (!proc?.pid) return;
    try {
      if (process.platform === "win32") {
        let exited = false;
        let fallbackTimer: NodeJS.Timeout | undefined;
        proc.once("exit", () => {
          exited = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
        });
        const forceDirectCleanup = () => {
          if (exited) return;
          try { proc.kill(); } catch { /* process already gone */ }
          // A failed taskkill can leave inherited pipe handles open even after
          // the shell exits. Close our ends after the direct-child fallback.
          proc.stdin?.destroy();
          proc.stdout?.destroy();
          proc.stderr?.destroy();
        };
        const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", forceDirectCleanup);
        killer.once("close", (code) => { if (code !== 0) forceDirectCleanup(); });
        fallbackTimer = setTimeout(forceDirectCleanup, 2_000);
        fallbackTimer.unref?.();
      } else {
        proc.kill("SIGKILL");
      }
    } catch { /* already gone */ }
  }
}

// ── Manager ─────────────────────────────────────────────────────────────────

const servers = new Map<string, LspServer>();
const unavailable = new Set<string>();
const failedStarts = new Map<string, number>();

function serverKey(projectRoot: string, language: LspLanguage): string {
  return `${language}:${path.resolve(projectRoot).toLowerCase()}`;
}

async function getLspServer(projectRoot: string, language: LspLanguage): Promise<LspServer | null> {
  const key = serverKey(projectRoot, language);
  if (unavailable.has(key)) return null;
  const noteFailure = () => {
    const attempts = (failedStarts.get(key) ?? 0) + 1;
    failedStarts.set(key, attempts);
    // Two-strike: one slow cold start (AV scan, cold npx) must not disable a
    // language for the whole session, but repeated failures stop retry storms.
    if (attempts >= 2) unavailable.add(key);
  };
  let server = servers.get(key);
  if (!server) {
    server = new LspServer(language, projectRoot);
    servers.set(key, server);
    const ok = await server.whenReady;
    if (!ok) {
      servers.delete(key);
      noteFailure();
      return null;
    }
    failedStarts.delete(key);
  } else {
    const ok = await server.whenReady;
    if (!ok) {
      servers.delete(key);
      noteFailure();
      return null;
    }
    server.touch();
  }
  return server;
}

/** Kills every server for a project (call when a project session closes). */
export async function shutdownLspForProject(projectRoot: string): Promise<void> {
  const rootKey = path.resolve(projectRoot).toLowerCase();
  for (const [key, server] of servers) {
    if (key.endsWith(`:${rootKey}`)) {
      server.shutdown();
      servers.delete(key);
    }
  }
}

/** Test helper: forget unavailability marks and live servers. */
export function resetLspForTests(): void {
  for (const [, server] of servers) server.shutdown();
  servers.clear();
  unavailable.clear();
}

export interface LspLocation { path: string; line: number; col: number }

/** Type-aware definition lookup. Returns null whenever the language server
 *  is unavailable or fails — callers fall back to grep/AST results. */
export async function lspDefinition(projectRoot: string, filePath: string, line1: number, characterUtf16: number): Promise<LspLocation[] | null> {
  const language = languageForFile(filePath);
  if (!language) return null;
  try {
    const server = await getLspServer(projectRoot, language);
    if (!server) return null;
    return await server.definition(filePath, line1, characterUtf16);
  } catch {
    return null;
  }
}

/** Type-aware reference lookup. Returns null on unavailability/failure. */
export async function lspReferences(projectRoot: string, filePath: string, line1: number, characterUtf16: number): Promise<LspLocation[] | null> {
  const language = languageForFile(filePath);
  if (!language) return null;
  try {
    const server = await getLspServer(projectRoot, language);
    if (!server) return null;
    return await server.references(filePath, line1, characterUtf16);
  } catch {
    return null;
  }
}

/** Server-backed document symbols (empty array when unavailable). */
export async function lspDocumentSymbols(projectRoot: string, filePath: string): Promise<Array<{ kind: ReturnType<typeof lspSymbolKindToKind>; name: string; line: number; detail: string }>> {
  const language = languageForFile(filePath);
  if (!language) return [];
  try {
    const server = await getLspServer(projectRoot, language);
    if (!server) return [];
    return await server.documentSymbol(filePath);
  } catch {
    return [];
  }
}

/** Server-pushed diagnostics for one file. Null when no language server is
 *  available (distinct from an empty diagnostic list); callers fall back. */
export async function lspDiagnostics(projectRoot: string, filePath: string, waitMs?: number): Promise<DiagnosticItem[] | null> {
  const language = languageForFile(filePath);
  if (!language) return null;
  try {
    const server = await getLspServer(projectRoot, language);
    if (!server) return null;
    return await server.collectDiagnostics(filePath, waitMs);
  } catch {
    return null;
  }
}

/** Rename symbol across project files via LSP. Returns applied files or null. */
export async function lspRename(
  projectRoot: string,
  filePath: string,
  line1: number,
  characterUtf16: number,
  newName: string
): Promise<{ success: boolean; modifiedFiles: string[]; totalEdits: number; error?: string } | null> {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedTarget = path.resolve(resolvedRoot, filePath);
  const isWin = process.platform === "win32";
  const rootCmp = isWin ? resolvedRoot.toLowerCase() : resolvedRoot;
  const targetCmp = isWin ? resolvedTarget.toLowerCase() : resolvedTarget;
  if (targetCmp !== rootCmp && !targetCmp.startsWith(`${rootCmp}${path.sep}`)) {
    return { success: false, modifiedFiles: [], totalEdits: 0, error: "Target path is outside project workspace" };
  }
  const language = languageForFile(resolvedTarget);
  if (!language) return null;
  try {
    const server = await getLspServer(resolvedRoot, language);
    if (!server) return null;
    const editsByFile = await server.rename(resolvedTarget, line1, characterUtf16, newName);
    if (!editsByFile || Object.keys(editsByFile).length === 0) {
      return { success: false, modifiedFiles: [], totalEdits: 0, error: "No rename edits produced by language server" };
    }

    const modifiedFiles: string[] = [];
    let totalEdits = 0;

    for (const [absFile, edits] of Object.entries(editsByFile)) {
      const resolvedFile = path.resolve(absFile);
      const fileCmp = isWin ? resolvedFile.toLowerCase() : resolvedFile;
      if (fileCmp !== rootCmp && !fileCmp.startsWith(`${rootCmp}${path.sep}`)) continue;
      guardAgainstLegacyStateDir(resolvedFile);
      if (!fs.existsSync(resolvedFile)) continue;
      const content = fs.readFileSync(resolvedFile, "utf8");
      const lines = content.split("\n");

      // Sort edits in reverse document order (bottom to top, right to left) so earlier offsets remain valid
      const sorted = [...edits].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });

      for (const edit of sorted) {
        const startL = edit.range.start.line;
        const startC = edit.range.start.character;
        const endL = edit.range.end.line;
        const endC = edit.range.end.character;

        if (startL <= endL && lines[startL] !== undefined && lines[endL] !== undefined) {
          const prefix = lines[startL].slice(0, startC);
          const suffix = lines[endL].slice(endC);
          const replacementLines = (prefix + edit.newText + suffix).split("\n");
          lines.splice(startL, endL - startL + 1, ...replacementLines);
          totalEdits++;
        }
      }

      fs.writeFileSync(resolvedFile, lines.join("\n"), "utf8");
      modifiedFiles.push(path.relative(resolvedRoot, resolvedFile).replace(/\\/g, "/"));
    }

    return { success: true, modifiedFiles, totalEdits };
  } catch (err: any) {
    return { success: false, modifiedFiles: [], totalEdits: 0, error: String(err?.message || err) };
  }
}

function hasProjectLanguageConfig(projectRoot: string, language: LspLanguage): boolean {
  const root = path.resolve(projectRoot);
  if (language === "typescript") {
    return existsSync(path.join(root, "tsconfig.json")) || existsSync(path.join(root, "jsconfig.json"));
  }
  if (language === "python") {
    return existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "pyrightconfig.json"));
  }
  if (language === "go") return existsSync(path.join(root, "go.mod"));
  if (language === "rust") return existsSync(path.join(root, "Cargo.toml"));
  return false;
}

/** Collect post-edit LSP diagnostics for modified paths (immediate compiler/linter feedback). */
export async function collectPostEditDiagnostics(
  projectRoot: string,
  modifiedPaths: string[]
): Promise<string | null> {
  if (process.env.NEXUS_DISABLE_POST_EDIT_LSP === "1") return null;
  const resolvedRoot = path.resolve(projectRoot);
  const reports: string[] = [];
  for (const relOrAbs of modifiedPaths) {
    const absPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(resolvedRoot, relOrAbs);
    if (!existsSync(absPath)) continue;
    const language = languageForFile(absPath);
    if (!language) continue;
    const key = serverKey(resolvedRoot, language);
    if (!servers.has(key) && !hasProjectLanguageConfig(resolvedRoot, language)) continue;
    const diags = await lspDiagnostics(resolvedRoot, absPath, 300).catch(() => null);
    if (diags && diags.length > 0) {
      const errors = diags.filter((d) => d.severity === "error" || d.severity === "warning");
      if (errors.length > 0) {
        const rel = path.relative(resolvedRoot, absPath).replace(/\\/g, "/");
        const lines = errors.slice(0, 5).map((e) => `- Line ${e.line}: ${e.message}${e.code ? ` (${e.code})` : ""}`);
        reports.push(`Diagnostics for ${rel}:\n${lines.join("\n")}`);
      }
    }
  }
  if (reports.length === 0) return null;
  return `\n\n[LSP Diagnostics after edit]:\n${reports.join("\n\n")}`;
}

process.once("exit", () => {
  try { resetLspForTests(); } catch { /* ignore */ }
});
