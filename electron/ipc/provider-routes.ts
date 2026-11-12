// Provider + MCP IPC routes. The renderer never holds real API keys — every
// read path returns masked keys, and write paths treat masked round-trips
// as "keep the stored key".

import { ipcMain } from "electron";
import { autoDiscoverModelContextWindow, autoDiscoverModelEfforts, fetchRemoteModels, resolveModelContextWindow, resolveModelEfforts, resolveModelMaxOutput, PROVIDERS } from "../providers.js";
import {
  createProviderConnection, isMaskedSecret, listMcpServersMasked, listProviders, removeMcpServer,
  removeProvider, removeProviderModel, setProviderEnabled, updateProviderConnection, updateProviderKey,
  upsertMcpServer, addProviderModels, updateProviderModel,
  type ChatEndpointKind, type McpServerConfig, type ProviderConfig,
} from "../store.js";
import { testMcpServer } from "../mcp-service.js";
import {
  assertPayload, ProviderCreateSchema, ProviderUpdateMetaSchema, ProviderUpdateKeySchema, ProviderSetEnabledSchema,
  ProviderModelsAddSchema, ProviderModelsUpdateSchema, ProviderModelDetectSchema, ProviderModelsRemoveSchema,
  ProviderRemoveSchema, ProviderFetchModelsSchema, McpSaveSchema, McpTestSchema, McpRemoveSchema,
} from "./schemas.js";
import type { MainIpcContext } from "./context.js";

const maskProviders = (list: ProviderConfig[]) => list.map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" }));

export function registerProviderRoutes(_ctx: MainIpcContext): void {
  ipcMain.handle("providers:definitions", () => PROVIDERS);
  ipcMain.handle("providers:list", async () => {
    const list = await listProviders();
    // Non-blocking background fill for legacy models that have no modelEfforts entry
    for (const p of list) {
      if (!p.models || !p.models.length) continue;
      const missing = p.models.filter((m) => !p.modelEfforts || p.modelEfforts[m] === undefined || !p.modelContextWindows || p.modelContextWindows[m] === undefined);
      if (missing.length > 0) {
        setTimeout(async () => {
          for (const m of missing) {
            try {
              const detected = await autoDiscoverModelEfforts(p, m);
              const ctx = await autoDiscoverModelContextWindow(p, m);
              await updateProviderModel(p.id, m, {
                efforts: detected,
                contextWindow: ctx?.contextWindow,
                maxOutput: ctx?.maxOutput,
              });
            } catch (err) {
              // Best-effort metadata discovery failure during background fill; ignore so provider listing stays fast
            }
          }
        }, 100);
      }
    }
    return maskProviders(list);
  });
  // Granular provider CRUD: the renderer never sends (or holds) the real key
  // except through provider:updateKey, and model edits cannot touch it.
  ipcMain.handle("provider:create", async (_event, input: { provider: string; label: string; apiKey: string; baseUrl?: string }) => {
    assertPayload(ProviderCreateSchema, input, "provider:create");
    return maskProviders([await createProviderConnection(input)])[0];
  });
  ipcMain.handle("provider:updateMeta", async (_event, providerId: string, patch: { label?: string; baseUrl?: string }) => {
    assertPayload(ProviderUpdateMetaSchema, patch, "provider:updateMeta");
    return maskProviders([await updateProviderConnection(providerId, patch)])[0];
  });
  ipcMain.handle("provider:updateKey", async (_event, providerId: string, apiKey: string) => {
    assertPayload(ProviderUpdateKeySchema, [providerId, apiKey], "provider:updateKey");
    return maskProviders([await updateProviderKey(providerId, apiKey)])[0];
  });
  ipcMain.handle("provider:setEnabled", async (_event, providerId: string, enabled: boolean) => {
    assertPayload(ProviderSetEnabledSchema, [providerId, enabled], "provider:setEnabled");
    return maskProviders([await setProviderEnabled(providerId, enabled)])[0];
  });
  ipcMain.handle("provider:models:add", async (_event, providerId: string, models: string[], efforts?: Record<string, string[]>) => {
    assertPayload(ProviderModelsAddSchema, [providerId, models, efforts], "provider:models:add");
    const rawProviders = await listProviders();
    const stored = rawProviders.find((p) => p.id === providerId);
    const resolvedEfforts: Record<string, string[]> = { ...(efforts || {}) };
    const resolvedContexts: Record<string, number> = {};
    const resolvedMaxOutputs: Record<string, number> = {};
    if (stored) {
      for (const m of models) {
        if (!resolvedEfforts[m]) {
          try {
            const detected = await autoDiscoverModelEfforts(stored, m);
            if (detected && detected.length) {
              resolvedEfforts[m] = detected;
            }
          } catch {
            const fallback = resolveModelEfforts(stored.provider, m, stored);
            if (fallback.length) resolvedEfforts[m] = fallback;
          }
        }
        try {
          const ctx = await autoDiscoverModelContextWindow(stored, m);
          if (ctx?.contextWindow) resolvedContexts[m] = ctx.contextWindow;
          if (ctx?.maxOutput) resolvedMaxOutputs[m] = ctx.maxOutput;
        } catch {
          const fallbackCtx = resolveModelContextWindow(stored.provider, m, stored);
          if (fallbackCtx) resolvedContexts[m] = fallbackCtx;
        }
      }
    }
    return maskProviders([await addProviderModels(providerId, models, resolvedEfforts, resolvedContexts, resolvedMaxOutputs)])[0];
  });
  ipcMain.handle("provider:models:update", async (_event, providerId: string, model: string, patch: { newName?: string; endpoint?: "" | ChatEndpointKind; efforts?: string[] }) => {
    assertPayload(ProviderModelsUpdateSchema, [providerId, model, patch], "provider:models:update");
    if (patch.newName && !patch.efforts) {
      const rawProviders = await listProviders();
      const stored = rawProviders.find((p) => p.id === providerId);
      if (stored) {
        try {
          const detected = await autoDiscoverModelEfforts(stored, patch.newName);
          if (detected && detected.length) {
            patch.efforts = detected;
          }
        } catch {
          const fallback = resolveModelEfforts(stored.provider, patch.newName, stored);
          if (fallback.length) patch.efforts = fallback;
        }
      }
    }
    return maskProviders([await updateProviderModel(providerId, model, patch)])[0];
  });
  ipcMain.handle("provider:model:detect-context", async (_event, providerId: string, model: string) => {
    assertPayload(ProviderModelDetectSchema, [providerId, model], "provider:model:detect");
    const rawProviders = await listProviders();
    const stored = rawProviders.find((p) => p.id === providerId);
    if (!stored) return { contextWindow: 128_000 };
    try {
      const detected = await autoDiscoverModelContextWindow(stored, model);
      await updateProviderModel(providerId, model, {
        contextWindow: detected.contextWindow,
        maxOutput: detected.maxOutput,
      });
      return detected;
    } catch {
      const fallback = resolveModelContextWindow(stored.provider, model, stored);
      const maxOutput = resolveModelMaxOutput(stored.provider, model, stored);
      return { contextWindow: fallback, maxOutput };
    }
  });
  ipcMain.handle("provider:model:detect-efforts", async (_event, providerId: string, model: string) => {
    assertPayload(ProviderModelDetectSchema, [providerId, model], "provider:model:detect");
    const rawProviders = await listProviders();
    const stored = rawProviders.find((p) => p.id === providerId);
    if (!stored) return [];
    try {
      const detected = await autoDiscoverModelEfforts(stored, model);
      if (detected) {
        await updateProviderModel(providerId, model, { efforts: detected });
      }
      return detected || [];
    } catch {
      const fallback = resolveModelEfforts(stored.provider, model, stored);
      if (fallback.length) {
        await updateProviderModel(providerId, model, { efforts: fallback });
      }
      return fallback;
    }
  });
  ipcMain.handle("provider:models:remove", async (_event, providerId: string, model: string) => {
    assertPayload(ProviderModelsRemoveSchema, [providerId, model], "provider:models:remove");
    return maskProviders([await removeProviderModel(providerId, model)])[0];
  });
  ipcMain.handle("provider:remove", async (_event, providerId: string) => {
    assertPayload(ProviderRemoveSchema, [providerId], "provider:remove");
    return maskProviders(await removeProvider(providerId));
  });
  // Model discovery: when the renderer has no key (it never does — only a
  // mask), the server resolves the STORED key for the given provider.
  ipcMain.handle("providers:fetch-models", async (_event, input: { providerId?: string; baseUrl?: string; apiKey?: string }) => {
    assertPayload(ProviderFetchModelsSchema, input, "providers:fetch-models");
    let apiKey = (input?.apiKey || "").trim();
    if ((!apiKey || isMaskedSecret(apiKey)) && input?.providerId) {
      const stored = (await listProviders()).find((provider) => provider.id === input.providerId);
      if (stored?.apiKey) apiKey = stored.apiKey;
    }
    return fetchRemoteModels(input?.baseUrl || "", apiKey);
  });

  ipcMain.handle("mcp:list", async () => listMcpServersMasked());
  ipcMain.handle("mcp:save", (_event, input: Omit<McpServerConfig, "id"> & { id?: string }) => {
    assertPayload(McpSaveSchema, input, "mcp:save");
    return upsertMcpServer(input);
  });
  ipcMain.handle("mcp:remove", (_event, serverId: string) => {
    assertPayload(McpRemoveSchema, [serverId], "mcp:remove");
    return removeMcpServer(serverId);
  });
  ipcMain.handle("mcp:test", (_event, input: Omit<McpServerConfig, "id" | "enabled">) => {
    assertPayload(McpTestSchema, input, "mcp:test");
    return testMcpServer(input);
  });
}
