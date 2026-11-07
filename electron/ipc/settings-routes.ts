// Legacy agent settings + app settings + notebook parser config routes.

import { ipcMain } from "electron";
import {
  getAppSettings, getSearchConfig, saveSearchConfig, getNotebookParserConfig, isMaskedSecret, saveAppSettings, saveNotebookParserConfig,
} from "../store.js";
import type { AgentSettings } from "../agent-types.js";
import { assertPayload, AgentSettingsSaveSchema, AppSettingsSaveSchema, NotebookParserSaveSchema } from "./schemas.js";
import type { MainIpcContext } from "./context.js";

export function registerSettingsRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("settings:get", () => {
    const settings = ctx.settings.get();
    return { ...settings, apiKey: settings.apiKey ? "********" : "" };
  });
  ipcMain.handle("settings:save", (_event, next: AgentSettings) => {
    assertPayload(AgentSettingsSaveSchema, next, "settings:save");
    const { apiKey, ...rest } = next;
    const settings = ctx.settings.get();
    // A masked round-trip means "keep the stored key" — deleting it here used
    // to wipe the key on any unrelated settings change.
    ctx.settings.set({ ...settings, ...rest, ...(isMaskedSecret(apiKey) ? {} : { apiKey }) });
    const saved = ctx.settings.get();
    return { ...saved, apiKey: saved.apiKey ? "********" : "" };
  });
  ipcMain.handle("app-settings:get", () => getAppSettings());
  // Search backend config: keys return MASKED (never the plaintext), saves
  // skip masked values so a re-save of untouched fields keeps the sealed key.
  ipcMain.handle("search-config:get", async () => {
    const config = await getSearchConfig();
    return {
      backend: config.backend,
      searxngBaseUrl: config.searxngBaseUrl,
      hasTavilyKey: Boolean(config.tavilyKey),
      hasBraveKey: Boolean(config.braveKey),
      hasExaKey: Boolean(config.exaKey),
    };
  });
  ipcMain.handle("search-config:save", (_event, input: { backend?: string; tavilyKey?: string | null; braveKey?: string | null; exaKey?: string | null; searxngBaseUrl?: string | null }) => {
    const BACKENDS = new Set(["auto", "tavily", "brave", "exa", "searxng", "ddg"]);
    const backend = BACKENDS.has(String(input.backend)) ? (input.backend as any) : undefined;
    const unmask = (value?: string | null) => (isMaskedSecret(value as string) ? undefined : value);
    return saveSearchConfig({
      backend,
      tavilyKey: unmask(input.tavilyKey),
      braveKey: unmask(input.braveKey),
      exaKey: unmask(input.exaKey),
      searxngBaseUrl: input.searxngBaseUrl,
    });
  });
  ipcMain.handle("app-settings:save", (_event, input: Parameters<typeof saveAppSettings>[0]) => {
    assertPayload(AppSettingsSaveSchema, input, "app-settings:save");
    return saveAppSettings(input);
  });
  ipcMain.handle("notebook:parser:get", async () => {
    const config = await getNotebookParserConfig();
    return { ...config, apiKey: config.apiKey ? "********" : "" };
  });
  ipcMain.handle("notebook:parser:save", async (_event, input: Parameters<typeof saveNotebookParserConfig>[0]) => {
    assertPayload(NotebookParserSaveSchema, input, "notebook:parser:save");
    const existing = await getNotebookParserConfig();
    const config = await saveNotebookParserConfig({ ...input, apiKey: isMaskedSecret(input.apiKey) ? existing.apiKey : input.apiKey });
    return { ...config, apiKey: config.apiKey ? "********" : "" };
  });
}
