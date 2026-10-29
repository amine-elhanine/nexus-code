// Legacy agent settings + app settings + notebook parser config routes.

import { ipcMain } from "electron";
import {
  getAppSettings, getNotebookParserConfig, isMaskedSecret, saveAppSettings, saveNotebookParserConfig,
} from "../store.js";
import type { AgentSettings } from "../agent-types.js";
import type { MainIpcContext } from "./context.js";

export function registerSettingsRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("settings:get", () => {
    const settings = ctx.settings.get();
    return { ...settings, apiKey: settings.apiKey ? "********" : "" };
  });
  ipcMain.handle("settings:save", (_event, next: AgentSettings) => {
    const { apiKey, ...rest } = next;
    const settings = ctx.settings.get();
    // A masked round-trip means "keep the stored key" — deleting it here used
    // to wipe the key on any unrelated settings change.
    ctx.settings.set({ ...settings, ...rest, ...(isMaskedSecret(apiKey) ? {} : { apiKey }) });
    const saved = ctx.settings.get();
    return { ...saved, apiKey: saved.apiKey ? "********" : "" };
  });
  ipcMain.handle("app-settings:get", () => getAppSettings());
  ipcMain.handle("app-settings:save", (_event, input: Parameters<typeof saveAppSettings>[0]) => saveAppSettings(input));
  ipcMain.handle("notebook:parser:get", async () => {
    const config = await getNotebookParserConfig();
    return { ...config, apiKey: config.apiKey ? "********" : "" };
  });
  ipcMain.handle("notebook:parser:save", async (_event, input: Parameters<typeof saveNotebookParserConfig>[0]) => {
    const existing = await getNotebookParserConfig();
    const config = await saveNotebookParserConfig({ ...input, apiKey: isMaskedSecret(input.apiKey) ? existing.apiKey : input.apiKey });
    return { ...config, apiKey: config.apiKey ? "********" : "" };
  });
}
