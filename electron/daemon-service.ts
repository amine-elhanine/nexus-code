import { spawn, type ChildProcess } from "node:child_process";

export interface DaemonProcessInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: "running" | "stopped" | "crashed";
  pid?: number;
  port?: number;
  startTime: string;
  logsCount: number;
}

interface ActiveDaemon {
  info: DaemonProcessInfo;
  process?: ChildProcess;
  logs: string[];
  listeners: Set<(data: string) => void>;
}

// Only structural environment variables reach a spawned dev server; secrets
// and API keys from the host environment stay behind.
const DAEMON_ENV_PASSTHROUGH = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "windir",
  "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ProgramData", "PROGRAMFILES",
  "ProgramFiles(x86)", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "OS", "LANG",
  "LC_ALL", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "ALLUSERSPROFILE",
];

function daemonEnvironment(): NodeJS.ProcessEnv {
  const env: Record<string, string> = { FORCE_COLOR: "1" };
  for (const key of DAEMON_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export class DaemonService {
  private daemons = new Map<string, ActiveDaemon>();

  public startDaemon(
    name: string,
    command: string,
    cwd: string,
    onData?: (data: string) => void
  ): DaemonProcessInfo {
    const id = `daemon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const startTime = new Date().toISOString();

    const info: DaemonProcessInfo = {
      id,
      name,
      command,
      cwd,
      status: "running",
      startTime,
      logsCount: 0,
    };

    const active: ActiveDaemon = {
      info,
      logs: [],
      listeners: new Set(),
    };

    if (onData) active.listeners.add(onData);
    this.daemons.set(id, active);

    this.spawnProcess(active);
    return info;
  }

  private spawnProcess(active: ActiveDaemon) {
    const { info } = active;

    try {
      const isWin = process.platform === "win32";
      // Invoke the shell explicitly rather than using spawn({ shell: true }),
      // which causes Node's shell-string deprecation warning and can change
      // quoting semantics across Node versions.
      const shell = isWin ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
      const shellArgs = isWin ? ["/d", "/s", "/c", info.command] : ["-c", info.command];
      const child = spawn(shell, shellArgs, {
        cwd: info.cwd,
        // Dev servers don't need host secrets; passing the full parent
        // environment would hand them every API key in it.
        env: daemonEnvironment(),
        windowsHide: true,
        windowsVerbatimArguments: isWin,
        detached: !isWin,
      });

      info.pid = child.pid;
      info.status = "running";
      active.process = child;

      const handleData = (chunk: Buffer | string) => {
        const text = chunk.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          active.logs.push(line);
          if (active.logs.length > 1000) active.logs.shift();

          // Port detection e.g. "localhost:5173", "127.0.0.1:3000", "port 8080"
          const portMatch = line.match(/(?:localhost|127\.0\.0\.1):(\d{4,5})|port\s+(\d{4,5})/i);
          if (portMatch) {
            const detectedPort = parseInt(portMatch[1] || portMatch[2], 10);
            if (!isNaN(detectedPort)) {
              info.port = detectedPort;
            }
          }
        }
        info.logsCount = active.logs.length;

        for (const listener of active.listeners) {
          try {
            listener(text);
          } catch {
            // Ignore listener errors
          }
        }
      };

      child.stdout?.on("data", handleData);
      child.stderr?.on("data", handleData);

      child.on("error", (err) => {
        info.status = "crashed";
        handleData(`\n[Process error: ${err.message}]\n`);
      });

      child.on("exit", (code) => {
        info.status = code === 0 || code === null ? "stopped" : "crashed";
        handleData(`\n[Process exited with code ${code}]\n`);
        active.process = undefined;
      });
    } catch (err) {
      info.status = "crashed";
      const errorMsg = `Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`;
      active.logs.push(errorMsg);
      info.logsCount = active.logs.length;
    }
  }

  public stopDaemon(id: string): boolean {
    const active = this.daemons.get(id);
    if (!active) return false;

    if (!active.process || !active.process.pid) {
      active.info.status = "stopped";
      return true;
    }

    try {
      const pid = active.process.pid;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-pid, "SIGKILL");
      }
      active.info.status = "stopped";
      active.process = undefined;
      return true;
    } catch {
      try {
        active.process?.kill();
        active.info.status = "stopped";
        active.process = undefined;
        return true;
      } catch {
        return false;
      }
    }
  }

  public restartDaemon(id: string): boolean {
    const active = this.daemons.get(id);
    if (!active) return false;

    this.stopDaemon(id);
    active.logs.push(`\n--- Restarting ${active.info.name} ---\n`);
    this.spawnProcess(active);
    return true;
  }

  public listDaemons(): DaemonProcessInfo[] {
    return Array.from(this.daemons.values()).map((d) => ({ ...d.info, logsCount: d.logs.length }));
  }

  public getDaemonLogs(id: string, limit = 200): string[] {
    const active = this.daemons.get(id);
    if (!active) return [];
    return active.logs.slice(-limit);
  }

  public subscribeToLogs(id: string, listener: (data: string) => void): () => void {
    const active = this.daemons.get(id);
    if (!active) return () => {};
    active.listeners.add(listener);
    return () => active.listeners.delete(listener);
  }

  public stopAllDaemons() {
    for (const [id] of this.daemons) {
      this.stopDaemon(id);
    }
  }
}

export const daemonService = new DaemonService();
