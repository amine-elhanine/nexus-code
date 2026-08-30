import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export interface TerminalSession {
  id: string;
  cwd: string;
  mode: "pty" | "pipes";
  cols: number;
  rows: number;
  alive: boolean;
}

type SessionEntry = TerminalSession & { onData: (data: string) => void; proc?: ChildProcess };
type PtyHost = { child: ChildProcess; ready: boolean };

// Terminals run through an out-of-process PTY host (electron/pty-host.cjs)
// because native PTY bindings target system Node's ABI and cannot load inside
// Electron. When the host is unavailable — no system Node on PATH, or a
// packaged build without the unpacked helper — sessions transparently fall
// back to piped stdio, which works for line-oriented tools but is not a TTY.
class TerminalService {
  private sessions = new Map<string, SessionEntry>();
  private host: PtyHost | null = null;
  private hostStarting: Promise<PtyHost | null> | null = null;

  private hostPath() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-host.cjs");
  }

  private startHost(): Promise<PtyHost | null> {
    if (this.host?.ready) return Promise.resolve(this.host);
    if (this.hostStarting) return this.hostStarting;
    this.hostStarting = new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn("node", [this.hostPath()], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch {
        this.hostStarting = null;
        resolve(null);
        return;
      }
      const state: PtyHost = { child, ready: false };
      let buffer = "";
      let settled = false;
      const finish = (result: PtyHost | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.off("data", onStdout);
        this.hostStarting = null;
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
          if (msg.ev === "ready") { state.ready = true; finish(state); return; }
          if (msg.ev === "fatal") { child.kill(); finish(null); return; }
          this.onHostEvent(msg);
        }
      };
      const timer = setTimeout(() => { if (!state.ready) { child.kill(); finish(null); } }, 5000);
      child.stdout?.on("data", onStdout);
      child.on("error", () => finish(null));
      child.on("exit", () => {
        this.host = null;
        for (const session of this.sessions.values()) {
          if (session.mode === "pty" && session.alive) {
            session.alive = false;
            session.onData("\r\n[PTY host terminated]\r\n");
          }
        }
        this.sessions.clear();
        finish(null);
      });
    });
    return this.hostStarting;
  }

  private send(op: object): boolean {
    if (!this.host?.child.stdin?.writable) return false;
    try {
      this.host.child.stdin.write(JSON.stringify(op) + "\n");
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
    const shell = isWindows ? "powershell.exe" : process.env.SHELL || "bash";
    const shellArgs = isWindows ? ["-NoLogo"] : ["-i"];
    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const entry: SessionEntry = { id, cwd, mode: "pipes", cols: 80, rows: 24, alive: true, onData, proc };
    this.sessions.set(id, entry);

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
    const session = this.sessions.get(id);
    if (!session || !session.alive) return false;
    if (session.mode === "pty") return this.send({ op: "write", id, data });
    if (!session.proc?.stdin?.writable) return false;
    session.proc.stdin.write(data);
    return true;
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
    const session = this.sessions.get(id);
    if (!session || !session.alive || cols < 2 || rows < 2) return false;
    if (session.mode !== "pty") return false;
    session.cols = cols;
    session.rows = rows;
    return this.send({ op: "resize", id, cols, rows });
  }

  public killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.killSession(id);
    }
    if (this.host) {
      // Killing the host closes its stdin; the host then kills every PTY it owns.
      try { this.host.child.kill(); } catch { /* already exited */ }
      this.host = null;
    }
  }

  public getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }
}

export const terminalService = new TerminalService();
