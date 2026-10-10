import React, { useEffect, useState } from "react";
import { Download, Loader2, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";

type Plugin = { id: string; name: string; description?: string; version?: string; author?: string; source: string; capabilities?: string[]; installed?: boolean; installedVersion?: string };

/** A deliberately small Marketplace UI. The registry is an ordinary JSON feed,
 * so developers can host it anywhere and users never need an account. */
export function PluginMarketplace({ hasProject }: { hasProject: boolean }) {
  const api = window.nexus || window.forgepilot;
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [registryUrl, setRegistryUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const refresh = async () => {
    try {
      const [items, config] = await Promise.all([api.listMarketplacePlugins(), api.getPluginRegistry()]);
      setPlugins(items); setRegistryUrl(config.registryUrl || "");
    } catch (error) { setNote(error instanceof Error ? error.message : "Could not load Marketplace."); }
  };
  useEffect(() => { void refresh(); }, []);

  async function saveRegistry() {
    setBusy("registry"); setNote("");
    try { await api.savePluginRegistry({ registryUrl, developerCatalog: (await api.getPluginRegistry()).developerCatalog || [] }); await refresh(); setNote("Registry saved and refreshed."); }
    catch (error) { setNote(error instanceof Error ? error.message : "Could not save registry."); }
    finally { setBusy(null); }
  }
  async function publish() {
    setBusy("publish"); setNote("");
    try { const entry = await api.publishPlugin(); if (entry) { await refresh(); setNote("Added to your developer catalog."); } }
    catch (error) { setNote(error instanceof Error ? error.message : "Could not add plugin."); }
    finally { setBusy(null); }
  }
  async function install(plugin: Plugin) {
    if (!hasProject) { setNote("Open a project before installing a plugin."); return; }
    setBusy(plugin.id); setNote("");
    try { await api.installPlugin(plugin); await refresh(); setNote(`${plugin.name} is installed and ready for the next agent run.`); }
    catch (error) { setNote(error instanceof Error ? error.message : "Plugin installation failed."); }
    finally { setBusy(null); }
  }
  async function uninstall(plugin: Plugin) {
    setBusy(plugin.id); setNote("");
    try { await api.uninstallPlugin(plugin.id); await refresh(); setNote(`${plugin.name} was removed from this project.`); }
    catch (error) { setNote(error instanceof Error ? error.message : "Could not remove plugin."); }
    finally { setBusy(null); }
  }

  return <div className="setting-card plugin-marketplace">
    <div className="setting-row"><span className="setting-icon"><Puzzle size={14} /></span><div className="setting-text"><strong>Plugin Marketplace</strong><small>Install bundles into this project with one click. Skills and hooks become available automatically.</small></div></div>
    <div className="setting-row" style={{ gap: 8, alignItems: "end" }}><label className="field" style={{ flex: 1 }}><span>Public registry URL</span><input value={registryUrl} onChange={(e) => setRegistryUrl(e.target.value)} placeholder="https://example.com/nexus-registry.json" /></label><button className="secondary-btn" type="button" onClick={() => void saveRegistry()} disabled={busy === "registry"}>{busy === "registry" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Refresh</button></div>
    <div className="setting-row" style={{ marginTop: 12 }}><div className="setting-text"><strong>Developer catalog</strong><small>Add a local plugin folder to test or curate it. A hosted registry uses <code>{'{ plugins: [...] }'}</code> with HTTPS zip sources.</small></div><button className="secondary-btn" type="button" onClick={() => void publish()} disabled={busy === "publish"}>{busy === "publish" ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Add plugin</button></div>
    <div className="plugin-market-list">
      {plugins.length === 0 && <p className="empty-state">No plugins yet. Add one from a local folder or connect your registry URL.</p>}
      {plugins.map((plugin) => <div className="plugin-market-item" key={plugin.id}><div><strong>{plugin.name}</strong><small>{plugin.description || "No description provided."}</small><em>{[plugin.author, plugin.version && `v${plugin.version}`, ...(plugin.capabilities || [])].filter(Boolean).join(" · ")}</em></div><div className="plugin-actions">{plugin.installed ? <button className="secondary-btn" type="button" onClick={() => void uninstall(plugin)} disabled={busy === plugin.id}>{busy === plugin.id ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Remove</button> : <button className="primary-btn" type="button" onClick={() => void install(plugin)} disabled={busy === plugin.id}>{busy === plugin.id ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Install</button>}</div></div>)}
    </div>
    {!!note && <div className="settings-note" style={{ marginTop: 10 }}>{note}</div>}
  </div>;
}
