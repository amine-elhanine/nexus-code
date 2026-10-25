// Bounded child-process execution for trusted binaries invoked on
// (potentially hostile) repositories: git quality-tested sites that pass
// cwd = the user's project. Repo-level git hooks and fsmonitor daemons make
// even plain `git status`/`checkout` runs capable of hanging or streaming
// unbounded output, so every call gets a default wall-clock timeout and an
// output cap — never an unbounded wait. Committed hooks that outlive the
// timed-out git parent are killed process-tree-wide, not just the direct
// child. Unlike promisify(execFile), rejection errors carry .stdout/.stderr.
import { execFile, spawn } from "node:child_process";

export type BoundedExecOptions = { cwd?: string; env?: NodeJS.ProcessEnv; /** Wall-clock cap in ms. Defaults to 300s so a hung repo hook can never block a run forever. */ timeout?: number; maxBuffer?: number; windowsHide?: boolean };

export const DEFAULT_PROC_TIMEOUT_MS = 300_000;
export const DEFAULT_PROC_MAXBUFFER = 8_000_000;

function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* already gone */ }
}

export function boundedExecFile(file: string, args: string[], options: BoundedExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? DEFAULT_PROC_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_PROC_MAXBUFFER,
      windowsHide: options.windowsHide ?? true,
    }, (error, stdout, stderr) => {
      if (error) {
        if ((error as { killed?: boolean }).killed) killTree(child.pid);
        (error as any).stdout = stdout;
        (error as any).stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}
