const ENCRYPTED_PREFIX = 'safeStorage:v1:';

/** Providers eligible for automatic selection by a headless Nexus process. */
export function isHeadlessProviderUsable(provider) {
  if (!provider || (provider.apiKey || '').startsWith(ENCRYPTED_PREFIX)) return false;
  if (provider.apiKey) return true;
  return provider.provider === 'ollama' || (provider.provider === 'custom' && Boolean(provider.baseUrl));
}

/** Explicit selection may return a desktop-only provider so callers can give a useful key error. */
export function selectConfiguredProvider(providers, selection) {
  if (selection) {
    const wanted = String(selection).toLowerCase();
    return providers.find((provider) => provider.id?.toLowerCase() === wanted || provider.label?.toLowerCase() === wanted) ?? null;
  }
  return providers.find(isHeadlessProviderUsable) ?? null;
}
