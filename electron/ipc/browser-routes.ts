// Browser integration + auto-updater + app metadata IPC routes.
// Also wires the agent browser service into the current window so headless
// navigation activity and update status stream to the renderer.

import { ipcMain, shell, app } from "electron";
import { agentBrowserService, type AgentBrowserResponse } from "../browser-service.js";
import { updaterService, type UpdaterState } from "../updater-service.js";
import type { MainIpcContext } from "./context.js";

export function registerBrowserRoutes(ctx: MainIpcContext): void {
  // Browser External Navigation
  ipcMain.handle("browser:openExternal", async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // Agent browser: headless toggle + activity forwarded to the built-in
  // Browser tab so the user can follow what the agent is viewing.
  agentBrowserService.onActivity = (activity) => {
    ctx.window()?.webContents.send("browser:agent-activity", activity);
  };
  // Agent browser bridge: tool calls in main execute against the hidden
  // in-app webview (AgentBrowserHost in the renderer) and reply here.
  agentBrowserService.setSender((msg) => {
    ctx.window()?.webContents.send("browser:agent-request", msg);
  });
  ipcMain.on("browser:agent-reply", (_event, payload: AgentBrowserResponse) => {
    agentBrowserService.handleReply(payload);
  });
  ipcMain.handle("browser:headless:get", () => agentBrowserService.isHeadless());
  ipcMain.handle("browser:headless:set", (_event, value: boolean) => agentBrowserService.setHeadless(value));

  // In-app updates: renderer gets status events + manual check/install.
  updaterService.onStatus((state: UpdaterState) => {
    ctx.window()?.webContents.send("updater:status", state);
  });
  updaterService.init();
  // Lets a (re)loaded renderer pick up the current state — e.g. an update
  // that finished downloading before the UI subscribed — instead of
  // sitting on "idle" with no install button.
  ipcMain.handle("updater:getState", () => updaterService.getState());
  ipcMain.handle("updater:check", () => updaterService.check(false));
  ipcMain.handle("updater:quit-and-install", () => {
    updaterService.quitAndInstall();
    return true;
  });
  ipcMain.handle("app:getVersion", () => app.getVersion());
}
