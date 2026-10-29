// Terminal, custom commands, and background daemon IPC routes.
// Output streaming goes to the current main window; when the window is
// re(a)loaded the still-alive sessions keep their subscribers but sends are
// simply dropped until the new webContents registers listeners again.

import { ipcMain } from "electron";
import { terminalService } from "../terminal-service.js";
import { discoverCustomCommands } from "../custom-commands-service.js";
import { daemonService } from "../daemon-service.js";
import type { MainIpcContext } from "./context.js";

export function registerTerminalRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("terminal:create", async (_event, { id, cwd, cols, rows }: { id: string; cwd?: string; cols?: number; rows?: number }) => {
    const root = cwd || ctx.active().projectRoot || process.cwd();
    const session = await terminalService.createSession(id, root, (data) => {
      ctx.window()?.webContents.send("terminal:data", { id, data });
    }, { cols, rows });
    // The live session holds an onData callback and a ChildProcess handle; both
    // are uncloneable over IPC, so only plain serializable fields cross back.
    return { id: session.id, mode: session.mode, cols: session.cols, rows: session.rows, alive: session.alive };
  });

  ipcMain.handle("terminal:write", (_event, { id, data }: { id: string; data: string }) => {
    return terminalService.write(id, data);
  });

  ipcMain.handle("terminal:kill", (_event, id: string) => {
    return terminalService.killSession(id);
  });

  ipcMain.handle("terminal:resize", (_event, { id, cols, rows }: { id: string; cols?: number; rows?: number }) => {
    return terminalService.resize(id, cols || 80, rows || 24);
  });

  // Custom Slash Commands (optional scope: "home" | "code" | "notebook" — omit for all)
  ipcMain.handle("commands:listCustom", async (_event, scope?: "home" | "code" | "notebook") => {
    return await discoverCustomCommands(ctx.active().projectRoot || undefined, scope);
  });

  // Background Daemons & Services
  ipcMain.handle("daemons:list", () => {
    return daemonService.listDaemons();
  });

  ipcMain.handle("daemons:start", (_event, { name, command, cwd }: { name: string; command: string; cwd?: string }) => {
    const root = cwd || ctx.active().projectRoot || process.cwd();
    const created = daemonService.startDaemon(name, command, root);
    // Stream this service's output under its id (the renderer filters live
    // log lines by selected service id).
    daemonService.subscribeToLogs(created.id, (data) => {
      ctx.window()?.webContents.send("daemon:log", { id: created.id, data });
    });
    return created;
  });

  ipcMain.handle("daemons:stop", (_event, id: string) => {
    return daemonService.stopDaemon(id);
  });

  ipcMain.handle("daemons:remove", (_event, id: string) => {
    return daemonService.removeDaemon(id);
  });

  ipcMain.handle("daemons:restart", (_event, id: string) => {
    return daemonService.restartDaemon(id);
  });

  ipcMain.handle("daemons:logs", (_event, id: string) => {
    return daemonService.getDaemonLogs(id);
  });
}
