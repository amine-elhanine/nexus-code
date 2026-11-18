// Terminal, custom commands, and background daemon IPC routes.
// Output streaming goes to the current main window; when the window is
// re(a)loaded the still-alive sessions keep their subscribers but sends are
// simply dropped until the new webContents registers listeners again.

import { ipcMain } from "electron";
import path from "node:path";
import { terminalService } from "../terminal-service.js";
import { discoverCustomCommands } from "../custom-commands-service.js";
import { daemonService } from "../daemon-service.js";
import { safePath } from "../project-tools.js";
import { classifyCommand } from "../permissions.js";
import { requestCommandApproval } from "../approval-service.js";
import type { MainIpcContext } from "./context.js";
import {
  assertPayload,
  DaemonIdSchema,
  DaemonStartSchema,
  TerminalCreateSchema,
  TerminalIdSchema,
  TerminalResizeSchema,
  TerminalWriteSchema,
} from "./schemas.js";

function resolveSafeTerminalCwd(ctx: MainIpcContext, rawCwd?: string): string {
  const activeRoot = ctx.active().projectRoot;
  const trimmed = (rawCwd || "").trim();
  if (!trimmed) return activeRoot || process.cwd();
  if (activeRoot) {
    return safePath(activeRoot, trimmed);
  }
  const fallback = path.resolve(process.cwd());
  const resolved = path.resolve(trimmed);
  if (resolved !== fallback && !resolved.startsWith(`${fallback}${path.sep}`)) {
    throw new Error("Working directory escapes the permitted workspace root.");
  }
  return resolved;
}

export function registerTerminalRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("terminal:create", async (_event, payload: { id: string; cwd?: string; cols?: number; rows?: number }) => {
    assertPayload(TerminalCreateSchema, payload, "terminal:create");
    const { id, cwd, cols, rows } = payload;
    const root = resolveSafeTerminalCwd(ctx, cwd);
    const session = await terminalService.createSession(id, root, (data) => {
      ctx.window()?.webContents.send("terminal:data", { id, data });
    }, { cols, rows });
    // The live session holds an onData callback and a ChildProcess handle; both
    // are uncloneable over IPC, so only plain serializable fields cross back.
    return { id: session.id, mode: session.mode, cols: session.cols, rows: session.rows, alive: session.alive };
  });

  ipcMain.handle("terminal:write", (_event, payload: { id: string; data: string }) => {
    assertPayload(TerminalWriteSchema, payload, "terminal:write");
    return terminalService.write(payload.id, payload.data);
  });

  ipcMain.handle("terminal:kill", (_event, id: string) => {
    assertPayload(TerminalIdSchema, [id], "terminal:kill");
    return terminalService.killSession(id);
  });

  ipcMain.handle("terminal:resize", (_event, payload: { id: string; cols?: number; rows?: number }) => {
    assertPayload(TerminalResizeSchema, payload, "terminal:resize");
    return terminalService.resize(payload.id, payload.cols || 80, payload.rows || 24);
  });

  // Custom Slash Commands (optional scope: "home" | "code" | "notebook" — omit for all)
  ipcMain.handle("commands:listCustom", async (_event, scope?: "home" | "code" | "notebook") => {
    return await discoverCustomCommands(ctx.active().projectRoot || undefined, scope);
  });

  // Background Daemons & Services
  ipcMain.handle("daemons:list", () => {
    return daemonService.listDaemons();
  });

  ipcMain.handle("daemons:start", async (_event, payload: { name: string; command: string; cwd?: string }) => {
    assertPayload(DaemonStartSchema, payload, "daemons:start");
    const { name, command, cwd } = payload;
    const root = resolveSafeTerminalCwd(ctx, cwd);
    const perm = classifyCommand(command);
    if (perm === "deny") {
      throw new Error("Blocked by safety policy: daemon command is not permitted.");
    }
    if (perm === "ask") {
      const decision = await requestCommandApproval({
        approvalKey: `daemon:${command.trim()}`,
        command: command.trim(),
        cwd: root,
        reason: "This background service command requires your approval before running.",
      });
      if (decision === "deny") {
        throw new Error("Daemon start denied by user.");
      }
    }
    const created = daemonService.startDaemon(name, command, root);
    // Stream this service's output under its id (the renderer filters live
    // log lines by selected service id).
    daemonService.subscribeToLogs(created.id, (data) => {
      ctx.window()?.webContents.send("daemon:log", { id: created.id, data });
    });
    return created;
  });

  ipcMain.handle("daemons:stop", (_event, id: string) => {
    assertPayload(DaemonIdSchema, [id], "daemons:stop");
    return daemonService.stopDaemon(id);
  });

  ipcMain.handle("daemons:remove", (_event, id: string) => {
    assertPayload(DaemonIdSchema, [id], "daemons:remove");
    return daemonService.removeDaemon(id);
  });

  ipcMain.handle("daemons:restart", (_event, id: string) => {
    assertPayload(DaemonIdSchema, [id], "daemons:restart");
    return daemonService.restartDaemon(id);
  });

  ipcMain.handle("daemons:logs", (_event, id: string) => {
    assertPayload(DaemonIdSchema, [id], "daemons:logs");
    return daemonService.getDaemonLogs(id);
  });
}
