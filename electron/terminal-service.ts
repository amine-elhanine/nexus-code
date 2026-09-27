import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { scrubSecretEnv } from "./child-env.js";

export interface TerminalSession {
  id: string;
  cwd: string;
  mode: "pty" | "pipes";
  cols: number;
  rows: number;
  alive: boolean;
}

type SessionEntry = TerminalSession & { onData: (data: string) => void; proc?: ChildProcess };
type PtyHost = { child: ChildProcess; ready: boolean; generation: number };

// The PTY host must run outside the Electron main process — native node-pty
// bindings target the Node ABI, not Electron's. Preferred runtime is the
// `node` on PATH (dev machines, and any user who has Node installed); when
// that is absent, the bundled Electron binary itself serves as a plain Node
// runtime via ELECTRON_RUN_AS_NODE, keeping a packaged install self-contained.
function hostRuntimes(): { command: string; env: NodeJS.ProcessEnv }[] {
  const runtimes: { command: string; env: NodeJS.ProcessEnv }[] = [];
  if (process.platform !== "win32" || commandExists("node")) {
    runtimes.push({ command: "node", env: {} });
  }
  runtimes.push({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } });
  return runtimes;
}

function commandExists(command: string): boolean {
  try {
    // Probe the executable directly. Using shell:true here triggers Node's
    // shell-argument deprecation warning and is unnecessary for `node`.
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hostScriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-host.cjs");
}

// Terminals run through an out-of-process PTY host (electron/pty-host.cjs)
// because native PTY bindings target system Node's ABI and cannot load inside
// Electron. When the host is unavailable — no system Node on PATH, or a
// packaged build without the unpacked helper — sessions transparently fall
// back to piped stdio, which works for line-oriented tools but is not a TTY.
class TerminalService {
  private sessions = new Map<string, SessionEntry>();
  private host: PtyHost | null = null;
  private hostStarting: Promise<PtyHost | null> | null = null;
  private hostGeneration = 0;
  // Set on before-quit (killAll). Late IPC from a tearing-down renderer
  // (pending writes/resizes) must be dropped, never written to dead pipes.
  private shutdown = false;

  // A Socket/pipe write to a dead child reports EPIPE asynchronously via an
  // 'error' event — try/catch can't see it, and without a listener it becomes
  // an uncaught exception (the "JavaScript error in the main process" dialog
  // on quit). Every child stdin we write to gets a swallow listener up front.
  private guardStdin(stdin: { on: (ev: string, cb: () => void) => void } | null | undefined) {
    try {
      stdin?.on("error", () => { /* dead pipe — callers treat this as not-writable */ });
    } catch { /* already destroyed */ }
  }

  private hostPath() {
    return hostScriptPath();
  }

  private trySpawnHost(runtime: { command: string; env: NodeJS.ProcessEnv }): Promise<PtyHost | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(runtime.command, [hostScriptPath()], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...scrubSecretEnv(), ...runtime.env },
        });
      } catch {
        resolve(null);
        return;
      }
      const state: PtyHost = { child, ready: false, generation: 0 };
      this.guardStdin(child.stdin);
      let buffer = "";
      let settled = false;
      const finish = (result: PtyHost | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const onStdout = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!settled) {
            if (msg.ev === "ready") { state.ready = true; finish(state); return; }
            if (msg.ev === "fatal") { child.kill(); finish(null); return; }
          }
          if (settled) this.onHostEvent(msg);
        }
      };
      const timer = setTimeout(() => { if (!state.ready) { child.kill(); finish(null); } }, 5000);
      child.stdout?.on("data", onStdout);
      child.on("error", () => finish(null));
      // A runtime that exits before `ready` (missing binary, ABI mismatch) is
      // just another unavailable runtime — the caller moves to the next one.
      child.on("exit", () => { if (!state.ready) finish(null); });
    });
  }

  private async startHost(): Promise<PtyHost | null> {
    if (this.host?.ready) return this.host;
    if (this.hostStarting) return this.hostStarting;
    const generation = ++this.hostGeneration;
    this.hostStarting = (async () => {
      for (const runtime of hostRuntimes()) {
        const state = await this.trySpawnHost(runtime);
        if (state) {
          state.generation = generation;
          this.host = state;
          // Only the current host's exit may clear state; a stale host dying
          // after killAll()+restart must not tear down its replacement.
          state.child.on("exit", () => {
            if (this.host?.generation !== generation) return;
            this.host = null;
            for (const [id, session] of this.sessions) {
              if (session.mode === "pty" && session.alive) {
                session.alive = false;
                session.onData("\r\n[PTY host terminated]\r\n");
                this.sessions.delete(id);
              }
            }
          });
          return state;
        }
      }
      return null;
    })();
    const result = await this.hostStarting;
    this.hostStarting = null;
    return result;
  }

  private send(op: object): boolean {
    if (this.shutdown) return false;
    const stdin = this.host?.child.stdin;
    if (!stdin || !stdin.writable || stdin.destroyed || stdin.writableEnded) return false;
    try {
      // Per-write callback swallows async EPIPE (host died between the
      // writability check and the flush) so it can never go uncaught.
      stdin.write(JSON.stringify(op) + "\n", (err) => {
        if (err) this.host = this.host?.child.stdin === stdin ? null : this.host;
      });
      return true;
    } catch {
      return false;
    }
  }

  private onHostEvent(msg: any) {
    const session = this.sessions.get(msg.id);
    if (!session) return;
    if (msg.ev === "data") session.onData(String(msg.data));
    if (msg.ev === "exit") {
      session.alive = false;
      session.onData(`\r\n[Process exited with code ${msg.code}]\r\n`);
      this.sessions.delete(session.id);
    }
  }

  public async createSession(id: string, cwd: string, onData: (data: string) => void, options?: { cols?: number; rows?: number }): Promise<TerminalSession> {
    this.killSession(id);
    const cols = options?.cols || 80;
    const rows = options?.rows || 24;
    const host = await this.startHost();
    if (host) {
      const entry: SessionEntry = { id, cwd, mode: "pty", cols, rows, alive: true, onData };
      this.sessions.set(id, entry);
      if (this.send({ op: "spawn", id, cwd, cols, rows })) return entry;
      this.sessions.delete(id);
    }
    return this.createPipesSession(id, cwd, onData);
  }

  private createPipesSession(id: string, cwd: string, onData: (data: string) => void): TerminalSession {
    const isWindows = os.platform() === "win32";
    const shell = isWindows ? (process.env.ComSpec || "cmd.exe") : process.env.SHELL || "bash";
    const shellArgs = isWindows ? ["/Q"] : ["-i"];
    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...scrubSecretEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const entry: SessionEntry = { id, cwd, mode: "pipes", cols: 80, rows: 24, alive: true, onData, proc };
    this.sessions.set(id, entry);
    this.guardStdin(proc.stdin);

    proc.stdout?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
    proc.on("close", (code) => {
      entry.alive = false;
      onData(`\r\n[Process terminated with code ${code}]\r\n`);
    });
    proc.on("error", (err) => {
      entry.alive = false;
      onData(`\r\n[Terminal Error: ${err.message}]\r\n`);
    });
    return entry;
  }

  public write(id: string, data: string): boolean {
    if (this.shutdown) return false;
    const session = this.sessions.get(id);
    if (!session || !session.alive) return false;
    if (session.mode === "pty") return this.send({ op: "write", id, data });
    const stdin = session.proc?.stdin;
    if (!stdin || !stdin.writable || stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(data, (err) => {
        if (err) {
          session.alive = false;
          this.sessions.delete(id);
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  public killSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      if (session.mode === "pty") {
        this.send({ op: "kill", id });
      } else if (session.alive) {
        if (os.platform() === "win32" && session.proc?.pid) {
          spawn("taskkill", ["/pid", String(session.proc.pid), "/T", "/F"]);
        } else {
          session.proc?.kill("SIGTERM");
        }
      }
    } catch { /* ignore kill errors */ }
    session.alive = false;
    this.sessions.delete(id);
    return true;
  }

  public resize(id: string, cols: number, rows: number): boolean {
    if (this.shutdown) return false;
    const session = this.sessions.get(id);
    if (!session || !session.alive || cols < 2 || rows < 2) return false;
    if (session.mode !== "pty") return false;
    session.cols = cols;
    session.rows = rows;
    return this.send({ op: "resize", id, cols, rows });
  }

  public killAll(): void {
    this.shutdown = true;
    for (const id of [...this.sessions.keys()]) {
      this.killSession(id);
    }
    if (this.host) {
      // Killing the host closes its stdin; destroy our end too so any
      // buffered late write fails silently instead of raising EPIPE.
      try { this.host.child.stdin?.destroy(); } catch { /* already gone */ }
      try { this.host.child.kill(); } catch { /* already exited */ }
      this.host = null;
    }
  }

  public getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }
}

export const terminalService = new TerminalService();
