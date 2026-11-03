// Window control IPC routes (window:minimize / maximize / close / isMaximized).

import { ipcMain } from "electron";
import type { MainIpcContext } from "./context.js";

export function registerWindowRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("window:minimize", () => { ctx.window()?.minimize(); });
  ipcMain.handle("window:maximize", () => {
    const win = ctx.window();
    if (win?.isMaximized()) {
      win.unmaximize();
      return false;
    } else {
      win?.maximize();
      return true;
    }
  });
  ipcMain.handle("window:close", () => { ctx.window()?.close(); });
  ipcMain.handle("window:isMaximized", () => ctx.window()?.isMaximized() ?? false);
}
