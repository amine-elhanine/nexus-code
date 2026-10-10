import React, { useEffect, useState, useMemo } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Download,
  FolderCode,
  FolderPlus,
  Globe,
  Info,
  Loader2,
  Package,
  PackageSearch,
  Puzzle,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";

type Plugin = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  source: string;
  capabilities?: string[];
  /** [] / omitted = all modes (home, code, notebook). */
  modes?: string[];
  installed?: boolean;
  installedVersion?: string;
};

type Feedback = {
  type: "success" | "error" | "info";
  message: string;
};

type ConfirmTarget = {
  type: "uninstall" | "removeDev";
  plugin: Plugin;
};

/** Redesigned Plugin Marketplace UI.
 * Shows the official registry by default while keeping custom registry URLs
 * available under Advanced — the backend still honors any JSON feed. */
const DEFAULT_PLUGIN_REGISTRY_URL =
  "https://raw.githubusercontent.com/amine-elhanine/nexus-code/main/registry.json";

export function PluginMarketplace({ hasProject }: { hasProject: boolean }) {
  const api = window.nexus || window.forgepilot;
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [devCatalogIds, setDevCatalogIds] = useState<Set<string>>(new Set());
  const [registryUrl, setRegistryUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [savingRegistry, setSavingRegistry] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "installed" | "available" | "dev">("all");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);

  const isCustomRegistry = Boolean(
    registryUrl.trim() && registryUrl.trim() !== DEFAULT_PLUGIN_REGISTRY_URL
  );

  const refresh = async (showFeedback = false) => {
    try {
      const [items, config] = await Promise.all([
        api.listMarketplacePlugins(),
        api.getPluginRegistry(),
      ]);
      setPlugins(items || []);
      const devIds = new Set<string>((config?.developerCatalog || []).map((p: { id: string }) => p.id));
      setDevCatalogIds(devIds);
      setRegistryUrl(config?.registryUrl || DEFAULT_PLUGIN_REGISTRY_URL);
      if (showFeedback) {
        setFeedback({ type: "success", message: "Marketplace catalog is up to date." });
      }
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not load Marketplace catalog.",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [items, config] = await Promise.all([
          api.listMarketplacePlugins(),
          api.getPluginRegistry(),
        ]);
        if (cancelled) return;
        setPlugins(items || []);
        setDevCatalogIds(new Set<string>((config?.developerCatalog || []).map((p: { id: string }) => p.id)));
        setRegistryUrl(config?.registryUrl || DEFAULT_PLUGIN_REGISTRY_URL);
      } catch (error) {
        if (cancelled) return;
        setFeedback({
          type: "error",
          message: error instanceof Error ? error.message : "Could not load Marketplace catalog.",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [hasProject]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh(true);
  };

  async function handleSaveRegistry() {
    const url = registryUrl.trim() || DEFAULT_PLUGIN_REGISTRY_URL;
    setSavingRegistry(true);
    setFeedback(null);
    try {
      const config = await api.getPluginRegistry();
      await api.savePluginRegistry({ registryUrl: url, developerCatalog: config?.developerCatalog || [] });
      setRegistryUrl(url);
      await refresh(true);
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not save registry URL.",
      });
    } finally {
      setSavingRegistry(false);
    }
  }

  async function handleResetRegistry() {
    setSavingRegistry(true);
    setFeedback(null);
    try {
      const config = await api.getPluginRegistry();
      await api.savePluginRegistry({ registryUrl: DEFAULT_PLUGIN_REGISTRY_URL, developerCatalog: config?.developerCatalog || [] });
      setRegistryUrl(DEFAULT_PLUGIN_REGISTRY_URL);
      await refresh(true);
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not reset registry URL.",
      });
    } finally {
      setSavingRegistry(false);
    }
  }

  async function handlePublish() {
    setBusy("publish");
    try {
      const entry = await api.publishPlugin();
      // Dialog cancelled — keep previous feedback instead of clearing it.
      if (!entry) return;
      await refresh();
      const entryObj = entry as { name?: string };
      setFeedback({
        type: "success",
        message: `Added "${entryObj.name || "Plugin"}" to your developer catalog.`,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not add plugin to catalog.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleInstall(plugin: Plugin) {
    if (!hasProject) {
      setFeedback({
        type: "info",
        message: "Open a project workspace before installing plugins.",
      });
      return;
    }
    setBusy(plugin.id);
    setFeedback(null);
    try {
      await api.installPlugin(plugin);
      await refresh();
      setFeedback({
        type: "success",
        message: `"${plugin.name}" installed. Its skills and hooks are immediately active.`,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Plugin installation failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleUninstall(plugin: Plugin) {
    setBusy(plugin.id);
    setFeedback(null);
    try {
      await api.uninstallPlugin(plugin.id);
      await refresh();
      setFeedback({
        type: "success",
        message: `"${plugin.name}" was uninstalled from this project.`,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not remove plugin.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleRemovePublished(plugin: Plugin) {
    setBusy(plugin.id);
    setFeedback(null);
    try {
      // Backend also uninstalls the active project's bundle (see
      // plugins:developer:remove) so no orphaned install is left behind.
      if (plugin.installed && hasProject) {
        await api.uninstallPlugin(plugin.id).catch(() => undefined);
      }
      await api.removePublishedPlugin(plugin.id);
      await refresh();
      setFeedback({
        type: "success",
        message: plugin.installed
          ? `Removed "${plugin.name}" from your developer catalog and uninstalled it from this project.`
          : `Removed "${plugin.name}" from your developer catalog.`,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not remove plugin from catalog.",
      });
    } finally {
      setBusy(null);
    }
  }

  // Only https:// counts as an official remote package. Anything else
  // (local folder path, file://, insecure http://) is a dev entry.
  const isDevPlugin = (plugin: Plugin) =>
    devCatalogIds.has(plugin.id) || !plugin.source.toLowerCase().startsWith("https://");

  const counts = useMemo(() => {
    const installed = plugins.filter((p) => p.installed).length;
    const dev = plugins.filter(isDevPlugin).length;
    const available = plugins.filter((p) => !p.installed).length;
    return { all: plugins.length, installed, available, dev };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, devCatalogIds]);

  const filteredPlugins = useMemo(() => {
    return plugins.filter((plugin) => {
      if (filterTab === "installed" && !plugin.installed) return false;
      if (filterTab === "available" && plugin.installed) return false;
      if (filterTab === "dev" && !isDevPlugin(plugin)) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const nameMatch = plugin.name.toLowerCase().includes(q);
        const idMatch = plugin.id.toLowerCase().includes(q);
        const descMatch = (plugin.description || "").toLowerCase().includes(q);
        const authorMatch = (plugin.author || "").toLowerCase().includes(q);
        const versionMatch = (plugin.version || "").toLowerCase().includes(q);
        const capMatch = (plugin.capabilities || []).some((c) => c.toLowerCase().includes(q));
        if (!nameMatch && !idMatch && !descMatch && !authorMatch && !versionMatch && !capMatch) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, filterTab, searchQuery, devCatalogIds]);

  return (
    <div className="marketplace-container">
      {/* Top Banner: Status & Main Actions */}
      <div className="market-top-banner">
        <div className="market-registry-status">
          <span className="market-status-pill" title={registryUrl}>
            <span className="market-status-dot" />
            <Globe size={12} />
            {isCustomRegistry ? "Custom Registry" : "Nexus Official Registry"}
          </span>
          <span className="market-count-label">
            {plugins.length} {plugins.length === 1 ? "extension" : "extensions"} available
          </span>
        </div>
        <div className="market-top-actions">
          <button
            type="button"
            className="market-btn secondary"
            onClick={() => void handleRefresh()}
            disabled={refreshing || loading}
            title={isCustomRegistry ? `Check custom registry for updates` : "Check official registry for new or updated plugins"}
          >
            {refreshing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            <span>Check for updates</span>
          </button>
          <button
            type="button"
            className="market-btn secondary"
            onClick={() => void handlePublish()}
            disabled={busy === "publish"}
            title="Add a local plugin directory for development and testing"
          >
            {busy === "publish" ? <Loader2 size={12} className="spin" /> : <FolderPlus size={12} />}
            <span>Add dev plugin</span>
          </button>
        </div>
      </div>

      {/* Advanced: custom registry feed (restores pre-redesign flexibility) */}
      <div className="market-advanced">
        <button
          type="button"
          className="market-advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
          title="Show registry feed settings"
        >
          {showAdvanced ? "Hide" : "Advanced"}: registry feed
          {isCustomRegistry && <span className="market-badge dev" style={{ marginLeft: 6 }}>custom</span>}
        </button>
        {showAdvanced && (
          <div className="market-advanced-panel">
            <label className="market-advanced-label">
              <span>Registry URL (JSON feed with {"{ plugins: [...] }"})</span>
              <input
                type="text"
                className="market-search-input"
                value={registryUrl}
                onChange={(e) => setRegistryUrl(e.target.value)}
                placeholder={DEFAULT_PLUGIN_REGISTRY_URL}
                spellCheck={false}
              />
            </label>
            <div className="market-advanced-actions">
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => void handleSaveRegistry()}
                disabled={savingRegistry}
              >
                {savingRegistry ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
                <span>Save & refresh</span>
              </button>
              {isCustomRegistry && (
                <button
                  type="button"
                  className="market-btn secondary"
                  onClick={() => void handleResetRegistry()}
                  disabled={savingRegistry}
                  title="Restore the official Nexus registry"
                >
                  <RefreshCw size={12} />
                  <span>Reset to official</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Global mode notification when no project is open */}
      {!hasProject && (
        <div className="market-notice-banner warning">
          <Info size={14} style={{ flex: "none" }} />
          <div style={{ flex: 1 }}>
            <strong>Browsing in Global mode</strong> — Open a project workspace to install and activate plugins for coding agents.
          </div>
        </div>
      )}

      {/* Interactive feedback alert */}
      {feedback && (
        <div className={`market-notice-banner ${feedback.type}`}>
          {feedback.type === "success" && <CheckCircle2 size={14} style={{ flex: "none" }} />}
          {feedback.type === "error" && <AlertCircle size={14} style={{ flex: "none" }} />}
          {feedback.type === "info" && <Info size={14} style={{ flex: "none" }} />}
          <div style={{ flex: 1 }}>{feedback.message}</div>
          <button
            type="button"
            className="market-notice-close"
            onClick={() => setFeedback(null)}
            title="Dismiss notification"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Search and Filters toolbar */}
      <div className="market-controls">
        <div className="market-search-box">
          <Search size={13} className="market-search-icon" />
          <input
            type="text"
            className="market-search-input"
            placeholder="Search plugins by name, id, version, capability, or author…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="market-search-clear"
              onClick={() => setSearchQuery("")}
              title="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="market-filter-tabs">
          <button
            type="button"
            className={`market-filter-tab ${filterTab === "all" ? "active" : ""}`}
            onClick={() => setFilterTab("all")}
          >
            All <span className="market-tab-count">{counts.all}</span>
          </button>
          <button
            type="button"
            className={`market-filter-tab ${filterTab === "installed" ? "active" : ""}`}
            onClick={() => setFilterTab("installed")}
          >
            Installed <span className="market-tab-count">{counts.installed}</span>
          </button>
          <button
            type="button"
            className={`market-filter-tab ${filterTab === "available" ? "active" : ""}`}
            onClick={() => setFilterTab("available")}
          >
            Available <span className="market-tab-count">{counts.available}</span>
          </button>
          {counts.dev > 0 && (
            <button
              type="button"
              className={`market-filter-tab ${filterTab === "dev" ? "active" : ""}`}
              onClick={() => setFilterTab("dev")}
            >
              Dev <span className="market-tab-count">{counts.dev}</span>
            </button>
          )}
        </div>
      </div>

      {/* Plugin Grid */}
      {loading ? (
        <div className="market-empty-state">
          <Loader2 size={24} className="spin" style={{ color: "var(--nexus-green)" }} />
          <p>Loading marketplace plugins…</p>
        </div>
      ) : filteredPlugins.length === 0 ? (
        <div className="market-empty-state">
          {searchQuery ? (
            <>
              <PackageSearch size={30} style={{ color: "var(--faint)" }} />
              <h4>No plugins match &ldquo;{searchQuery}&rdquo;</h4>
              <p>Check the spelling or try searching for another keyword.</p>
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => setSearchQuery("")}
              >
                Clear search query
              </button>
            </>
          ) : filterTab === "installed" ? (
            <>
              <Puzzle size={30} style={{ color: "var(--faint)" }} />
              <h4>No plugins installed in this project</h4>
              <p>
                {hasProject
                  ? "Explore available plugins above to install skills and hooks into your workspace."
                  : "Open a project workspace to install and use plugins."}
              </p>
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => setFilterTab("available")}
              >
                Browse available plugins
              </button>
            </>
          ) : filterTab === "dev" ? (
            <>
              <FolderCode size={30} style={{ color: "var(--faint)" }} />
              <h4>No developer plugins registered</h4>
              <p>Add a local folder containing manifest.json to test custom plugins.</p>
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => void handlePublish()}
              >
                <FolderPlus size={12} /> Add local plugin
              </button>
            </>
          ) : (
            <>
              <Package size={30} style={{ color: "var(--faint)" }} />
              <h4>No plugins in catalog</h4>
              <p>Check for updates from the {isCustomRegistry ? "custom" : "official"} registry or import a local plugin.</p>
              <button
                type="button"
                className="market-btn primary"
                onClick={() => void handleRefresh()}
              >
                <RefreshCw size={12} /> Sync registry
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="market-grid">
          {filteredPlugins.map((plugin) => {
            const isDev = isDevPlugin(plugin);
            const isBusy = busy === plugin.id;
            // A missing installedVersion (legacy manual install) still counts
            // as needing an update when the catalog advertises a version.
            const hasUpdate = Boolean(
              plugin.installed &&
                plugin.version &&
                (plugin.installedVersion || "") !== plugin.version
            );

            return (
              <div
                key={plugin.id}
                className={`market-card ${plugin.installed ? "installed" : ""}`}
              >
                <div className="market-card-top">
                  <div className="market-card-identity">
                    <div className="market-card-icon">
                      {isDev ? (
                        <FolderCode size={18} />
                      ) : plugin.capabilities?.includes("hooks") ? (
                        <Terminal size={18} />
                      ) : plugin.capabilities?.includes("skills") ? (
                        <Sparkles size={18} />
                      ) : (
                        <Puzzle size={18} />
                      )}
                    </div>
                    <div className="market-card-titles">
                      <div className="market-card-name-row">
                        <span className="market-card-name" title={plugin.name}>
                          {plugin.name}
                        </span>
                        {plugin.version && (
                          <span className="market-version-pill">v{plugin.version}</span>
                        )}
                        {plugin.installed && (
                          <span className="market-badge installed">
                            <Check size={9} /> Installed
                          </span>
                        )}
                        {isDev && (
                          <span className="market-badge dev">
                            <FolderCode size={9} /> Dev
                          </span>
                        )}
                        {hasUpdate && (
                          <span className="market-badge update">
                            <Sparkles size={9} /> Update
                          </span>
                        )}
                      </div>
                      <span className="market-author">
                        by {plugin.author || "Nexus Community"}
                      </span>
                    </div>
                  </div>

                  {/* Dev remove button */}
                  {isDev && (
                    <button
                      type="button"
                      className="market-icon-btn"
                      onClick={() => setConfirmTarget({ type: "removeDev", plugin })}
                      disabled={isBusy}
                      title="Remove from developer catalog"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <p className="market-card-desc">
                  {plugin.description || "No description provided."}
                </p>

                {/* Capabilities + modes Tags */}
                {((plugin.capabilities && plugin.capabilities.length > 0) || (plugin.modes && plugin.modes.length > 0)) && (
                  <div className="market-card-tags">
                    {(plugin.capabilities || []).map((cap) => (
                      <span key={cap} className="market-cap-tag">
                        {cap === "skills" ? (
                          <Sparkles size={9} />
                        ) : cap === "hooks" ? (
                          <Terminal size={9} />
                        ) : cap === "agents" ? (
                          <Bot size={9} />
                        ) : cap === "commands" ? (
                          <FolderCode size={9} />
                        ) : cap === "rules" ? (
                          <Shield size={9} />
                        ) : (
                          <Tag size={9} />
                        )}
                        {cap}
                      </span>
                    ))}
                    {(plugin.modes || []).map((mode) => (
                      <span key={mode} className="market-cap-tag" title={`Available in ${mode} mode`}>
                        {mode}
                      </span>
                    ))}
                  </div>
                )}

                {/* Card Footer: Source hint & Action buttons */}
                <div className="market-card-footer">
                  <span className="market-source-hint" title={plugin.source}>
                    {isDev ? (
                      <>
                        <FolderCode size={10} /> Local folder
                      </>
                    ) : isCustomRegistry ? (
                      <>
                        <Globe size={10} /> Custom registry
                      </>
                    ) : (
                      <>
                        <Globe size={10} /> Official package
                      </>
                    )}
                  </span>

                  <div className="market-action-buttons">
                    {hasUpdate && (
                      <button
                        type="button"
                        className="market-action-btn update"
                        onClick={() => void handleInstall(plugin)}
                        disabled={isBusy || !hasProject}
                        title={`Update to v${plugin.version}`}
                      >
                        {isBusy ? (
                          <Loader2 size={11} className="spin" />
                        ) : (
                          <RefreshCw size={11} />
                        )}
                        <span>Update</span>
                      </button>
                    )}

                    {plugin.installed ? (
                      <button
                        type="button"
                        className="market-action-btn danger"
                        onClick={() => setConfirmTarget({ type: "uninstall", plugin })}
                        disabled={isBusy}
                        title="Uninstall plugin from this project"
                      >
                        {isBusy ? (
                          <Loader2 size={11} className="spin" />
                        ) : (
                          <Trash2 size={11} />
                        )}
                        <span>Uninstall</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="market-action-btn primary"
                        onClick={() => void handleInstall(plugin)}
                        disabled={isBusy || !hasProject}
                        title={
                          hasProject
                            ? "Install into project"
                            : "Open a project workspace to install"
                        }
                      >
                        {isBusy ? (
                          <Loader2 size={11} className="spin" />
                        ) : (
                          <Download size={11} />
                        )}
                        <span>Install</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Developer Catalog Helper Card */}
      <div className="market-dev-card">
        <div className="market-dev-card-info">
          <FolderCode size={18} style={{ color: "var(--nexus-green)", flex: "none" }} />
          <div className="market-dev-card-text">
            <strong>Plugin Development</strong>
            <small>
              Build custom bundles with <code>manifest.json</code>, <code>skills/</code>, and optional <code>hooks.json</code>. Set <code>modes</code> in the manifest (e.g. <code>["code"]</code>) to scope the whole plugin; a skill's own <code>modes:</code> frontmatter still overrides it.
            </small>
          </div>
        </div>
        <button
          type="button"
          className="market-btn secondary"
          onClick={() => void handlePublish()}
          disabled={busy === "publish"}
        >
          {busy === "publish" ? <Loader2 size={12} className="spin" /> : <FolderPlus size={12} />}
          <span>Import local bundle</span>
        </button>
      </div>

      {/* Confirmation Modal */}
      {confirmTarget && (
        <ConfirmModal
          title={
            confirmTarget.type === "uninstall"
              ? `Uninstall "${confirmTarget.plugin.name}"?`
              : `Remove "${confirmTarget.plugin.name}"?`
          }
          message={
            confirmTarget.type === "uninstall"
              ? `This will remove the plugin bundle from this project's .nexus/plugins folder. Its skills and hooks will no longer be available during agent runs.`
              : confirmTarget.plugin.installed
                ? `This will remove the plugin from your developer catalog AND uninstall its bundle from this project (so no orphaned install is left behind). The source folder on your computer will remain intact.`
                : `This will remove the plugin from your developer catalog. The source folder on your computer will remain intact.`
          }
          confirmLabel={confirmTarget.type === "uninstall" ? "Uninstall" : "Remove"}
          danger
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            if (target.type === "uninstall") {
              void handleUninstall(target.plugin);
            } else {
              void handleRemovePublished(target.plugin);
            }
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
