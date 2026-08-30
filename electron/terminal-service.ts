import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";

export interface TerminalSession {
  id: string;
  cwd: string;
  process: ChildProcess;
  alive: boolean;
}

class TerminalService {
  private sessions = new Map<string, TerminalSession>();
  private dataListeners = new Map<string, (data: string) => void>();

  public createSession(id: string, cwd: string, onData: (data: string) => void): TerminalSession {
    this.killSession(id);

    const isWindows = os.platform() === "win32";
    const shell = isWindows ? "powershell.exe" : process.env.SHELL || "bash";
    const shellArgs = isWindows ? ["-NoLogo"] : ["-i"];

    const proc = spawn(shell, shellArgs, {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: TerminalSession = {
      id,
      cwd,
      process: proc,
      alive: true,
    };

    this.sessions.set(id, session);
    this.dataListeners.set(id, onData);

    proc.stdout?.on("data", (chunk: Buffer) => {
      onData(chunk.toString("utf8"));
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      onData(chunk.toString("utf8"));
    });

    proc.on("close", (code) => {
      session.alive = false;
      onData(`\r\n[Process terminated with code ${code}]\r\n`);
    });

    proc.on("error", (err) => {
      session.alive = false;
      onData(`\r\n[Terminal Error: ${err.message}]\r\n`);
    });

    return session;
  }

  public write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.alive || !session.process.stdin?.writable) {
      return false;
    }
    session.process.stdin.write(data);
    return true;
  }

  public killSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      if (session.alive) {
        if (os.platform() === "win32") {
          spawn("taskkill", ["/pid", String(session.process.pid), "/T", "/F"]);
        } else {
          session.process.kill("SIGTERM");
        }
      }
    } catch {
      // ignore kill errors
    }
    session.alive = false;
    this.sessions.delete(id);
    this.dataListeners.delete(id);
    return true;
  }

  public resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.alive) return false;
    if ((session.process as any).resize) {
      try { (session.process as any).resize(cols, rows); } catch { /* ignore */ }
    }
    return true;
  }

  public killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.killSession(id);
    }
  }

  public getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }
}

export const terminalService = new TerminalService();
