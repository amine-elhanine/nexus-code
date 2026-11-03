// Mid-run provider failover for Home agent runs.
//
// A long Home run that exhausts its rate-limit retry budget on a throttled
// free-tier provider used to pause and wait for the user to manually switch
// models. When other usable providers are configured, the run can instead
// swap models mid-flight and resume from the checkpointed transcript — the
// transcript is provider-agnostic (plain LangChain messages), so the only
// thing that must change is the chat model.

import type { ProviderConfig } from "../store.js";

export type FailoverTarget = { config: ProviderConfig; model: string };

function hasUsableKey(provider: ProviderConfig): boolean {
  return Boolean(provider.apiKey) || provider.provider === "ollama" || provider.provider === "custom";
}

/**
 * Ordered failover candidates: every OTHER configured provider that has a
 * key (or needs none) and at least one model, in list order. The active
 * provider is excluded by id; the caller's provider is authoritative even
 * when it is not in the stored list (legacy settings.provider fallback).
 */
export function buildFailoverChain(active: ProviderConfig | undefined, all: ProviderConfig[]): FailoverTarget[] {
  const chain: FailoverTarget[] = [];
  const seen = new Set<string>();
  for (const provider of all) {
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    if (active && provider.id === active.id) continue;
    const model = provider.models?.[0];
    if (!model) continue;
    if (!hasUsableKey(provider)) continue;
    chain.push({ config: provider, model });
  }
  return chain;
}
