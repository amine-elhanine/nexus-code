// Minimal LSP client (Phase B code intelligence). Lazy-spawns ONE language
// server per language per project and speaks JSON-RPC 2.0 with LSP framing
// over stdio — hand-rolled, no protocol dependency. Surface is deliberately
// limited to what pays for an agent: definition, references, documentSymbol,
// publishDiagnostics. Any failure (server missing, init timeout, request
// timeout, crash) resolves null and marks the language unavailable, so
// callers degrade to the tree-sitter/regex tools and a run is never blocked.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${SERVER_LABEL[this.language]} initialize timed out after 30s`)), INIT_TIMEOUT_MS)),
      ]);
      if (!initResult?.capabilities) return false;
      await this.notify("initialized", {});
      this.scheduleIdleShutdown();
      return true;
    } catch {
      this.shutdown();
      return false;
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
  private async ensureOpened(filePath: string): Promise<string | null> {
    const abs = path.resolve(filePath);
    const uri = toLspUri(abs);
    if (this.openedUris.has(uri)) return uri;
    let text: string;
    try {
      const raw = await fsPromises.readFile(abs);
      if (raw.length > MAX_OPEN_BYTES) return null;
      text = raw.toString("utf8");
    } catch {
      return null;
    }
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.language === "typescript" ? "typescript" : this.language, version: 1, text },
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

  diagnosticsFor(filePath: string): DiagnosticItem[] {
    const uri = toLspUri(path.resolve(filePath));
    return (this.diagnostics.get(uri) ?? []).map((d) => ({ ...d, file: path.relative(this.projectRoot, filePath).replace(/\\/g, "/") }));
  }

  /** didOpen + brief wait for the server to push publishDiagnostics. */
  async collectDiagnostics(filePath: string, waitMs = 1500): Promise<DiagnosticItem[]> {
    const uri = await this.ensureOpened(filePath);
    if (!uri) return [];
    this.diagnostics.delete(uri);
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
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
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
