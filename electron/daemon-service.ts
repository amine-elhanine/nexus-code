import { spawn, execFile, type ChildProcess } from "node:child_process";
import net from "node:net";

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
        // Stale exits (from a process already detached by stop/restart) must
        // not overwrite the status — a force-killed process exits with code
        // 1, which would otherwise flip an intentional "stopped" to "crashed".
        if (active.process !== child) return;
        active.process = undefined;
        info.status = code === 0 || code === null ? "stopped" : "crashed";
        handleData(`\n[Process exited with code ${code}]\n`);
      });
    } catch (err) {
      info.status = "crashed";
      const errorMsg = `Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`;
      active.logs.push(errorMsg);
      info.logsCount = active.logs.length;
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static execFileAsync(file: string, args: string[], timeoutMs = 8000): Promise<string> {
    return new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        resolve(error ? "" : String(stdout || ""));
      });
    });
  }

  // True while something accepts TCP connections on the port.
  private static isPortInUse(port: number, timeoutMs = 600): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (inUse: boolean) => {
        if (done) return;
        done = true;
        resolve(inUse);
      };
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        finish(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        finish(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        socket.destroy();
        finish(false);
      });
      socket.connect(port, "127.0.0.1");
    });
  }

  private static async waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await DaemonService.isPortInUse(port))) return true;
      if (Date.now() >= deadline) return false;
      await DaemonService.sleep(400);
    }
  }

  // Last resort for orphaned grandchildren (e.g. npm spawns vite after the
  // parent cmd.exe dies, escaping the tree kill): kill whatever still holds
  // the port. Only ever targets the daemon's own detected port.
  private static async killProcessOnPort(port: number): Promise<void> {
    try {
      if (process.platform === "win32") {
        const out = await DaemonService.execFileAsync("netstat", ["-ano"]);
        const pids = new Set<string>();
        for (const line of out.split("\n")) {
          if (!/LISTENING/i.test(line)) continue;
          if (!new RegExp(`[.:]${port}\\b`).test(line)) continue;
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) pids.add(pid);
        }
        for (const pid of pids) {
          await DaemonService.execFileAsync("taskkill", ["/PID", pid, "/F"]);
        }
      } else {
        const lsof = await DaemonService.execFileAsync("lsof", ["-ti", `tcp:${port}`]);
        const pids = lsof.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
        if (pids.length) {
          await DaemonService.execFileAsync("kill", ["-9", ...pids]);
        } else {
          await DaemonService.execFileAsync("fuser", ["-k", `${port}/tcp`]);
        }
      }
    } catch { /* best effort — the caller re-checks the port */ }
  }

  // Kills the whole process tree on Windows and waits for taskkill to
  // finish (previously this was fire-and-forget, so failures — and the
  // process staying alive — went unnoticed).
  private static killTreeWindows(pid: number, timeoutMs = 8000): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try {
          killer.kill();
        } catch { /* already gone */ }
        finish(false);
      }, timeoutMs);
      const killer = spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => finish(false));
      killer.on("exit", (code) => finish(code === 0));
    });
  }

  private static waitForExit(child: ChildProcess, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve();
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", onExit);
    });
  }

  public async stopDaemon(id: string): Promise<boolean> {
    const active = this.daemons.get(id);
    if (!active) return false;

    const child = active.process;
    if (!child || !child.pid) {
      // No supervised process — but a previous stop may have orphaned the
      // server (still holding the port). Retry the port cleanup so Stop on a
      // stale entry can still finish the job.
      if (active.info.port) {
        if (await DaemonService.waitForPortFree(active.info.port, 1200)) {
          active.info.status = "stopped";
          return true;
        }
        await DaemonService.killProcessOnPort(active.info.port);
        if (await DaemonService.waitForPortFree(active.info.port, 4000)) {
          active.info.status = "stopped";
          return true;
        }
        return false;
      }
      active.info.status = "stopped";
      active.process = undefined;
      return true;
    }

    // Detach first: the pending exit event becomes stale (see above) so it
    // can't flip the final status. "stopped" is only set once the kill is
    // verified below — never optimistically.
    active.process = undefined;
    const pid = child.pid;
    const port = active.info.port;

    try {
      if (process.platform === "win32") {
        await DaemonService.killTreeWindows(pid);
        // Second sweep: catches children spawned while the first kill ran
        // (e.g. npm spawning the dev server after cmd.exe died).
        await DaemonService.sleep(1000);
        await DaemonService.killTreeWindows(pid);
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch { /* already gone */ }
        }
        await DaemonService.sleep(500);
        try {
          process.kill(-pid, "SIGKILL");
        } catch { /* already gone */ }
      }
      await DaemonService.waitForExit(child);
      const childAlive = child.exitCode === null && child.signalCode === null;

      // The supervised process can be dead while an orphaned grandchild
      // still serves the port — verify the port actually went down.
      let portFree = true;
      if (port) {
        portFree = await DaemonService.waitForPortFree(port, 5000);
        if (!portFree) {
          await DaemonService.killProcessOnPort(port);
          portFree = await DaemonService.waitForPortFree(port, 4000);
        }
      }

      if (childAlive) {
        // Still alive — don't lie about it; put it back as running.
        active.process = child;
        active.info.status = "running";
        return false;
      }
      if (!portFree) {
        // Supervised process is dead but something still holds the port.
        // Honest state: not stopped — Stop stays available for retry.
        active.info.status = "crashed";
        return false;
      }
      active.info.status = "stopped";
      active.logs.push("[Stopped by user]");
      active.info.logsCount = active.logs.length;
      return true;
    } catch {
      active.process = child;
      active.info.status = "running";
      return false;
    }
  }

  public async restartDaemon(id: string): Promise<boolean> {
    const active = this.daemons.get(id);
    if (!active) return false;

    await this.stopDaemon(id);
    active.logs.push(`\n--- Restarting ${active.info.name} ---\n`);
    this.spawnProcess(active);
    return true;
  }

  // Removes a service from the list. A still-running process is stopped
  // first so deleting can never orphan a live child.
  public removeDaemon(id: string): boolean {
    const active = this.daemons.get(id);
    if (!active) return false;
    if (active.process?.pid) {
      this.stopDaemon(id);
    }
    active.listeners.clear();
    return this.daemons.delete(id);
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

  public async stopAllDaemons(): Promise<void> {
    await Promise.all(
      Array.from(this.daemons.keys()).map((id) =>
        this.stopDaemon(id).catch(() => false)
      )
    );
  }
}

export const daemonService = new DaemonService();
