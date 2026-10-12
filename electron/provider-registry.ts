// Provider registry: replaceable model integrations behind a stable interface.
// Existing PROVIDERS in providers.ts remain the defaults; new providers can
// be registered by plugins (with `providers.register` permission) without
// editing orchestration code.

import { PROVIDERS, createChatModel as createChatModelImpl, type ProviderDefinition } from "./providers.js";
import type { ProviderConfig } from "./store.js";

export type ProviderCapability = {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision?: boolean;
};

export type RegisteredProvider = {
  id: string;
  owner: string;
  definition: ProviderDefinition;
  capabilities: ProviderCapability;
  registeredAt: string;
};

const registry = new Map<string, RegisteredProvider>();

function defaultCapabilitiesFor(id: string): ProviderCapability {
  // Conservative defaults; plugin providers must declare accurately.
  void id;
  return { streaming: true, toolCalling: true, structuredOutput: false };
}

export function listRegisteredProviders(): RegisteredProvider[] {
  if (registry.size === 0) {
    for (const def of PROVIDERS) {
      registry.set(def.id, {
        id: def.id,
        owner: "builtin",
        definition: def,
        capabilities: defaultCapabilitiesFor(def.id),
        registeredAt: new Date(0).toISOString(),
      });
    }
  }
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getRegisteredProvider(id: string): RegisteredProvider | undefined {
  if (registry.size === 0) listRegisteredProviders();
  return registry.get(id);
}

export function registerProvider(input: {
  owner: string;
  definition: ProviderDefinition;
  capabilities?: Partial<ProviderCapability>;
}): { ok: true; id: string } | { ok: false; error: string } {
  if (registry.size === 0) listRegisteredProviders();
  const id = String(input.definition?.id || "").trim();
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    return { ok: false, error: `invalid provider id "${id}"` };
  }
  if (registry.has(id)) {
    return { ok: false, error: `provider "${id}" already registered by "${registry.get(id)?.owner}"` };
  }
  if (!input.definition.label || !input.definition.models || input.definition.models.length === 0) {
    return { ok: false, error: `provider "${id}" needs a label and at least one model` };
  }
  registry.set(id, {
    id,
    owner: input.owner,
    definition: input.definition,
    capabilities: { ...defaultCapabilitiesFor(id), ...(input.capabilities ?? {}) },
    registeredAt: new Date().toISOString(),
  });
  return { ok: true, id };
}

export function unregisterProvider(id: string, owner: string): boolean {
  const existing = registry.get(id);
  if (!existing) return false;
  if (existing.owner === "builtin") return false; // builtins cannot be removed by plugins
  if (existing.owner !== owner) return false;
  return registry.delete(id);
}

export function unregisterOwnerProviders(owner: string): string[] {
  const removed: string[] = [];
  for (const [id, entry] of registry) {
    if (entry.owner === owner) {
      registry.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** Preserve current behavior: delegate model creation to providers.ts.
 *  Plugin-registered custom providers (OpenAI-compatible) are handled here
 *  without touching the built-in SDK matrix. */
export async function createRegisteredChatModel(config: ProviderConfig, modelName: string): Promise<unknown> {
  const entry = getRegisteredProvider(config.provider);
  if (!entry) throw new Error(`Unknown provider "${config.provider}".`);
  if (entry.owner !== "builtin") {
    // Plugin providers speak OpenAI-compatible chat completions. Accurate
    // capability reporting matters: we only claim what this path supports.
    const { ChatOpenAI } = await import("@langchain/openai");
    const baseUrl = (config.baseUrl || (entry.definition as { defaultBaseUrl?: string }).defaultBaseUrl || "").trim();
    if (!baseUrl) throw new Error(`Provider "${entry.id}" needs a base URL.`);
    return new ChatOpenAI({
      apiKey: config.apiKey || "not-needed",
      model: modelName,
      temperature: 0.1,
      configuration: { baseURL: baseUrl },
    });
  }
  return createChatModelImpl(config, modelName);
}

/** Test helper. */
export function clearPluginProviders(): void {
  for (const [id, entry] of [...registry]) {
    if (entry.owner !== "builtin") registry.delete(id);
  }
}
