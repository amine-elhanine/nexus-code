import React, { useEffect, useState, useMemo } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  Download,
  ExternalLink,
  FolderCode,
  FolderPlus,
  Globe,
  Info,
  LayoutGrid,
  List,
  Loader2,
  Package,
  PackageCheck,
  PackageSearch,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";
import { Modal } from "../common/Modal.js";
import { ExecutablePlugins } from "./ExecutablePlugins.js";

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

type CapabilityFilter = "all" | "skills" | "agents" | "commands" | "rules" | "hooks";
const CAPABILITY_TABS: Array<{ id: CapabilityFilter; label: string; icon: React.ReactNode }> = [
  { id: "all", label: "All types", icon: <Puzzle size={12} /> },
  { id: "skills", label: "Skills", icon: <Sparkles size={12} /> },
  { id: "agents", label: "Agents", icon: <Bot size={12} /> },
  { id: "commands", label: "Commands", icon: <Terminal size={12} /> },
  { id: "rules", label: "Rules", icon: <Shield size={12} /> },
  { id: "hooks", label: "Hooks", icon: <Zap size={12} /> },
];

const DEFAULT_PLUGIN_REGISTRY_URL =
  "https://raw.githubusercontent.com/amine-elhanine/nexus-code/main/registry.json";

function getPluginThemeClass(plugin: Plugin): string {
  const id = plugin.id.toLowerCase();
  if (id.includes("engineering") || plugin.capabilities?.includes("rules") || plugin.capabilities?.includes("commands")) {
    return "theme-engineering";
  }
  if (id.includes("research") || id.includes("studio") || id.includes("doc")) {
    return "theme-research";
  }
  if (id.includes("content") || id.includes("brand")) {
    return "theme-creative";
  }
  return "theme-standard";
}

export function PluginMarketplace({ hasProject }: { hasProject: boolean }) {
  const api = window.nexus || window.forgepilot;
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [devCatalogIds, setDevCatalogIds] = useState<Set<string>>(new Set());
  const [registryUrl, setRegistryUrl] = useState("");
  const [devRoot, setDevRoot] = useState("");
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [savingRegistry, setSavingRegistry] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "installed" | "available" | "dev">("all");
  const [capFilter, setCapFilter] = useState<CapabilityFilter>("all");
  const [sortBy, setSortBy] = useState<"featured" | "name" | "installed">("featured");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null);
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
      setDevRoot(config?.devRoot || "");
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
        setDevRoot(config?.devRoot || "");
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
      await api.savePluginRegistry({
        registryUrl: url,
        developerCatalog: config?.developerCatalog || [],
        devRoot: devRoot.trim() || undefined,
      });
      setRegistryUrl(url);
      await refresh(true);
      setShowConfigModal(false);
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
      await api.savePluginRegistry({
        registryUrl: DEFAULT_PLUGIN_REGISTRY_URL,
        developerCatalog: config?.developerCatalog || [],
        devRoot: config?.devRoot,
      });
      setRegistryUrl(DEFAULT_PLUGIN_REGISTRY_URL);
      await refresh(true);
      setShowConfigModal(false);
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not reset registry URL.",
      });
    } finally {
      setSavingRegistry(false);
    }
  }

  async function handlePickDevRoot() {
    setBusy("devroot");
    try {
      const picked = await api.pickDevRoot();
      if (!picked) return;
      const config = await api.getPluginRegistry();
      await api.savePluginRegistry({
        registryUrl: config?.registryUrl,
        developerCatalog: config?.developerCatalog || [],
        devRoot: picked,
      });
      setDevRoot(picked);
      await refresh();
      setFeedback({
        type: "success",
        message: "Dev folder linked — plugins inside it appear automatically in your catalog.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not link dev folder.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleClearDevRoot() {
    setBusy("devroot");
    setFeedback(null);
    try {
      const config = await api.getPluginRegistry();
      await api.savePluginRegistry({
        registryUrl: config?.registryUrl,
        developerCatalog: config?.developerCatalog || [],
      });
      setDevRoot("");
      await refresh(true);
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Could not unlink dev folder.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handlePublish() {
    setBusy("publish");
    try {
      const entry = await api.publishPlugin();
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
      if (selectedPlugin?.id === plugin.id) {
        setSelectedPlugin((prev) => (prev ? { ...prev, installed: true, installedVersion: plugin.version } : null));
      }
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
      if (selectedPlugin?.id === plugin.id) {
        setSelectedPlugin((prev) => (prev ? { ...prev, installed: false, installedVersion: undefined } : null));
      }
      setFeedback({
        type: "success",
        message: `"${plugin.name}" uninstalled from this project.`,
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
      if (plugin.installed && hasProject) {
        await api.uninstallPlugin(plugin.id).catch(() => undefined);
      }
      await api.removePublishedPlugin(plugin.id);
      await refresh();
      if (selectedPlugin?.id === plugin.id) setSelectedPlugin(null);
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

  const isDevPlugin = (plugin: Plugin) =>
    devCatalogIds.has(plugin.id) || !plugin.source.toLowerCase().startsWith("https://");

  const counts = useMemo(() => {
    const installed = plugins.filter((p) => p.installed).length;
    const dev = plugins.filter(isDevPlugin).length;
    const available = plugins.filter((p) => !p.installed).length;
    const byCap: Record<Exclude<CapabilityFilter, "all">, number> = {
      skills: 0,
      agents: 0,
      commands: 0,
      rules: 0,
      hooks: 0,
    };
    for (const p of plugins) {
      for (const cap of p.capabilities || []) {
        const key = cap.toLowerCase() as Exclude<CapabilityFilter, "all">;
        if (key in byCap) byCap[key]++;
      }
    }
    return { all: plugins.length, installed, available, dev, byCap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, devCatalogIds]);

  const filteredPlugins = useMemo(() => {
    let result = plugins.filter((plugin) => {
      if (filterTab === "installed" && !plugin.installed) return false;
      if (filterTab === "available" && plugin.installed) return false;
      if (filterTab === "dev" && !isDevPlugin(plugin)) return false;
      if (capFilter !== "all" && !(plugin.capabilities || []).some((c) => c.toLowerCase() === capFilter)) return false;

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

    if (sortBy === "name") {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "installed") {
      result = [...result].sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
    } else {
      // "featured": prioritize official suites, then installed, then alphabetical
      result = [...result].sort((a, b) => {
        const aOfficial = (a.author || "").toLowerCase().includes("nexus") ? 1 : 0;
        const bOfficial = (b.author || "").toLowerCase().includes("nexus") ? 1 : 0;
        if (aOfficial !== bOfficial) return bOfficial - aOfficial;
        if (Boolean(a.installed) !== Boolean(b.installed)) return a.installed ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, filterTab, capFilter, searchQuery, sortBy, devCatalogIds]);

  // Spotlight suite (featured at the top when browsing All with no search)
  const spotlightPlugin = useMemo(() => {
    if (filterTab !== "all" || capFilter !== "all" || searchQuery.trim()) return null;
    return plugins.find((p) => p.id === "nexus-engineering-suite") || plugins[0] || null;
  }, [plugins, filterTab, capFilter, searchQuery]);

  return (
    <div className="marketplace-container">
      {/* Redesigned Hero Header Bar */}
      <div className="market-hero-card">
        <div className="market-hero-main">
          <div className="market-hero-title-row">
            <div className="market-hero-badge-icon">
              <Package className="hero-icon-svg" size={22} />
              <div className="hero-icon-glow" />
            </div>
            <div>
              <div className="market-hero-kicker">EXTENSIONS & WORKSPACE BUNDLES</div>
              <h3 className="market-hero-title">Plugin Marketplace</h3>
            </div>
          </div>
          <p className="market-hero-subtitle">
            Equip your Nexus agents with specialized subagents, custom slash commands, software architecture skills, coding rule sets, and execution hooks.
          </p>
        </div>

        {/* Live Metrics & Quick Actions */}
        <div className="market-hero-meta">
          <div className="market-metrics-row">
            <div className="market-metric-pill" title="Total plugins in current catalog">
              <span className="metric-num">{counts.all}</span>
              <span className="metric-lbl">Available</span>
            </div>
            <div className="market-metric-pill active" title="Installed in this project workspace">
              <CheckCircle2 size={13} className="text-nexus-green" />
              <span className="metric-num">{counts.installed}</span>
              <span className="metric-lbl">Installed</span>
            </div>
            {counts.dev > 0 && (
              <div className="market-metric-pill dev" title="Local developer plugins">
                <FolderCode size={13} className="text-orange" />
                <span className="metric-num">{counts.dev}</span>
                <span className="metric-lbl">Local Dev</span>
              </div>
            )}
          </div>

          <div className="market-hero-actions">
            <span
              className={`market-registry-pill ${isCustomRegistry ? "custom" : "official"}`}
              onClick={() => setShowConfigModal(true)}
              title={registryUrl}
            >
              <span className="status-pulse-dot" />
              <Globe size={11} />
              <span>{isCustomRegistry ? "Custom Feed" : "Official Registry"}</span>
            </span>

            <button
              type="button"
              className="market-hero-btn"
              onClick={() => void handleRefresh()}
              disabled={refreshing || loading}
              title="Check registry for updates"
            >
              <RefreshCw size={12} className={refreshing ? "spin" : ""} />
              <span>{refreshing ? "Syncing…" : "Sync"}</span>
            </button>

            <button
              type="button"
              className="market-hero-btn primary"
              onClick={() => void handlePublish()}
              disabled={busy === "publish"}
              title="Add a local plugin directory for development and testing"
            >
              {busy === "publish" ? <Loader2 size={12} className="spin" /> : <FolderPlus size={12} />}
              <span>Import Local</span>
            </button>

            <button
              type="button"
              className="market-hero-btn icon-only"
              onClick={() => setShowConfigModal(true)}
              title="Registry & Developer settings"
            >
              <Settings size={13} />
            </button>
          </div>
        </div>
      </div>

      <ExecutablePlugins hasProject={hasProject} />

      {/* Global mode notification when no project is open */}
      {!hasProject && (
        <div className="market-notice-banner warning">
          <Info size={15} style={{ flex: "none" }} />
          <div style={{ flex: 1 }}>
            <strong>Browsing in Global Mode</strong> — Plugins are installed per workspace repository. Open a project workspace to install and activate extensions.
          </div>
        </div>
      )}

      {/* Interactive feedback alert */}
      {feedback && (
        <div className={`market-notice-banner ${feedback.type}`}>
          {feedback.type === "success" && <CheckCircle2 size={15} style={{ flex: "none" }} />}
          {feedback.type === "error" && <AlertCircle size={15} style={{ flex: "none" }} />}
          {feedback.type === "info" && <Info size={15} style={{ flex: "none" }} />}
          <div style={{ flex: 1 }}>{feedback.message}</div>
          <button
            type="button"
            className="market-notice-close"
            onClick={() => setFeedback(null)}
            title="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Spotlight Card (Hero Showcase) */}
      {spotlightPlugin && (
        <div className={`market-spotlight-card ${getPluginThemeClass(spotlightPlugin)}`}>
          <div className="market-spotlight-glow" />
          <div className="market-spotlight-content">
            <div className="market-spotlight-left">
              <div className="market-spotlight-badge">
                <Sparkles size={11} /> FEATURED BUNDLE
              </div>
              <div className="market-spotlight-title-row">
                <h4>{spotlightPlugin.name}</h4>
                {spotlightPlugin.version && <span className="market-version-pill">v{spotlightPlugin.version}</span>}
                {spotlightPlugin.installed && (
                  <span className="market-badge installed">
                    <Check size={10} /> Active
                  </span>
                )}
              </div>
              <p className="market-spotlight-desc">
                {spotlightPlugin.description || "Comprehensive plugin suite designed for autonomous desktop workflows."}
              </p>
              <div className="market-spotlight-tags">
                {(spotlightPlugin.capabilities || []).map((cap) => (
                  <span key={cap} className="market-spotlight-cap-pill">
                    {cap === "skills" ? <Sparkles size={10} /> : cap === "agents" ? <Bot size={10} /> : cap === "commands" ? <Terminal size={10} /> : cap === "rules" ? <Shield size={10} /> : <Zap size={10} />}
                    {cap}
                  </span>
                ))}
              </div>
            </div>
            <div className="market-spotlight-actions">
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => setSelectedPlugin(spotlightPlugin)}
              >
                Inspect Details
              </button>
              {spotlightPlugin.installed ? (
                <button
                  type="button"
                  className="market-btn danger-subtle"
                  onClick={() => setConfirmTarget({ type: "uninstall", plugin: spotlightPlugin })}
                  disabled={busy === spotlightPlugin.id}
                >
                  {busy === spotlightPlugin.id ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                  <span>Uninstall</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="market-btn primary"
                  onClick={() => void handleInstall(spotlightPlugin)}
                  disabled={busy === spotlightPlugin.id || !hasProject}
                >
                  {busy === spotlightPlugin.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                  <span>Install Suite</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Unified Toolbar: Search, Filters & View Mode */}
      <div className="market-toolbar-wrap">
        <div className="market-toolbar-primary">
          {/* Omni Search Box */}
          <div className="market-omni-search">
            <Search size={14} className="market-search-icon" />
            <input
              type="text"
              className="market-omni-input"
              placeholder="Search extensions by title, tags, commands, author, or capabilities…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="market-search-clear-btn"
                onClick={() => setSearchQuery("")}
                title="Clear search query"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Status Tabs */}
          <div className="market-segmented-control">
            <button
              type="button"
              className={`market-segment-tab ${filterTab === "all" ? "active" : ""}`}
              onClick={() => setFilterTab("all")}
            >
              All <span className="tab-count">{counts.all}</span>
            </button>
            <button
              type="button"
              className={`market-segment-tab ${filterTab === "installed" ? "active" : ""}`}
              onClick={() => setFilterTab("installed")}
            >
              Installed <span className="tab-count green">{counts.installed}</span>
            </button>
            <button
              type="button"
              className={`market-segment-tab ${filterTab === "available" ? "active" : ""}`}
              onClick={() => setFilterTab("available")}
            >
              Available <span className="tab-count">{counts.available}</span>
            </button>
            {counts.dev > 0 && (
              <button
                type="button"
                className={`market-segment-tab ${filterTab === "dev" ? "active" : ""}`}
                onClick={() => setFilterTab("dev")}
              >
                Dev <span className="tab-count orange">{counts.dev}</span>
              </button>
            )}
          </div>

          {/* Sort & View Mode Switcher */}
          <div className="market-view-controls">
            <div className="market-sort-select-wrap">
              <SlidersHorizontal size={12} className="sort-icon" />
              <select
                className="market-sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
              >
                <option value="featured">Featured</option>
                <option value="name">Name (A-Z)</option>
                <option value="installed">Installed first</option>
              </select>
            </div>

            <div className="market-view-toggle">
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === "grid" ? "active" : ""}`}
                onClick={() => setViewMode("grid")}
                title="Grid view"
              >
                <LayoutGrid size={13} />
              </button>
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === "list" ? "active" : ""}`}
                onClick={() => setViewMode("list")}
                title="List view"
              >
                <List size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Capability Filter Chips */}
        <div className="market-cap-chips-row">
          <span className="cap-label">Filter by:</span>
          {CAPABILITY_TABS.map((tab) => {
            const count = tab.id === "all" ? counts.all : counts.byCap[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                className={`market-cap-chip ${capFilter === tab.id ? "active" : ""}`}
                onClick={() => setCapFilter(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
                <span className="chip-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Grid / List of Plugins */}
      {loading ? (
        <div className="market-empty-state">
          <Loader2 size={28} className="spin text-nexus-green" />
          <h4>Loading plugin catalog…</h4>
          <p>Syncing extensions from registry.</p>
        </div>
      ) : filteredPlugins.length === 0 ? (
        <div className="market-empty-state">
          {searchQuery ? (
            <>
              <PackageSearch size={36} className="text-faint" />
              <h4>No extensions matching &ldquo;{searchQuery}&rdquo;</h4>
              <p>Try searching for a different keyword or clear your filter.</p>
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
              <Puzzle size={36} className="text-faint" />
              <h4>No plugins installed in this project</h4>
              <p>
                {hasProject
                  ? "Explore available plugins above to empower your agent with skills, rules, and subagents."
                  : "Open a project workspace to install and use plugins."}
              </p>
              <button
                type="button"
                className="market-btn primary"
                onClick={() => setFilterTab("available")}
              >
                Explore available plugins
              </button>
            </>
          ) : filterTab === "dev" ? (
            <>
              <FolderCode size={36} className="text-faint" />
              <h4>No developer plugins registered</h4>
              <p>Add a local folder containing manifest.json to test custom plugins.</p>
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => void handlePublish()}
              >
                <FolderPlus size={13} /> Add local plugin
              </button>
            </>
          ) : capFilter !== "all" ? (
            <>
              <Puzzle size={36} className="text-faint" />
              <h4>No {CAPABILITY_TABS.find((t) => t.id === capFilter)?.label} plugins</h4>
              <p>No plugin in the catalog provides this capability yet.</p>
              <button
                type="button"
                className="market-btn secondary"
                onClick={() => setCapFilter("all")}
              >
                Show all types
              </button>
            </>
          ) : (
            <>
              <Package size={36} className="text-faint" />
              <h4>No plugins in catalog</h4>
              <p>Check for updates from the {isCustomRegistry ? "custom" : "official"} registry or import a local plugin.</p>
              <button
                type="button"
                className="market-btn primary"
                onClick={() => void handleRefresh()}
              >
                <RefreshCw size={13} /> Sync registry
              </button>
            </>
          )}
        </div>
      ) : viewMode === "grid" ? (
        /* Grid View */
        <div className="market-card-grid">
          {filteredPlugins.map((plugin) => {
            const isDev = isDevPlugin(plugin);
            const isBusy = busy === plugin.id;
            const hasUpdate = Boolean(
              plugin.installed &&
                plugin.version &&
                (plugin.installedVersion || "") !== plugin.version
            );
            const themeClass = getPluginThemeClass(plugin);
            const isOfficial = (plugin.author || "").toLowerCase().includes("nexus");

            return (
              <div
                key={plugin.id}
                className={`market-redesigned-card ${plugin.installed ? "installed" : ""} ${themeClass}`}
                onClick={() => setSelectedPlugin(plugin)}
              >
                <div className="card-top-header">
                  <div className="card-icon-avatar">
                    {isDev ? (
                      <FolderCode size={20} />
                    ) : plugin.capabilities?.includes("hooks") ? (
                      <Zap size={20} />
                    ) : plugin.capabilities?.includes("agents") ? (
                      <Bot size={20} />
                    ) : plugin.capabilities?.includes("skills") ? (
                      <Sparkles size={20} />
                    ) : (
                      <Puzzle size={20} />
                    )}
                  </div>

                  <div className="card-heading-group">
                    <div className="card-title-row">
                      <span className="card-title" title={plugin.name}>
                        {plugin.name}
                      </span>
                      {plugin.version && <span className="market-version-pill">v{plugin.version}</span>}
                    </div>
                    <div className="card-sub-row">
                      <span className="card-author">by {plugin.author || "Community"}</span>
                      {isOfficial && (
                        <span className="market-official-badge" title="Official Nexus extension">
                          <ShieldCheck size={11} />
                          <span>Official</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Dev remove button */}
                  {isDev && (
                    <button
                      type="button"
                      className="card-quick-remove-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmTarget({ type: "removeDev", plugin });
                      }}
                      disabled={isBusy}
                      title="Remove from developer catalog"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                <p className="card-description">
                  {plugin.description || "No description provided."}
                </p>

                {/* Capabilities and modes */}
                <div className="card-pills-row">
                  {(plugin.capabilities || []).map((cap) => (
                    <span key={cap} className="market-cap-pill">
                      {cap === "skills" ? (
                        <Sparkles size={9} />
                      ) : cap === "hooks" ? (
                        <Zap size={9} />
                      ) : cap === "agents" ? (
                        <Bot size={9} />
                      ) : cap === "commands" ? (
                        <Terminal size={9} />
                      ) : cap === "rules" ? (
                        <Shield size={9} />
                      ) : (
                        <Tag size={9} />
                      )}
                      <span>{cap}</span>
                    </span>
                  ))}
                  {(plugin.modes || []).map((mode) => (
                    <span key={mode} className="market-mode-pill" title={`Available in ${mode} mode`}>
                      {mode}
                    </span>
                  ))}
                </div>

                {/* Card Footer */}
                <div className="card-bottom-footer" onClick={(e) => e.stopPropagation()}>
                  <div className="card-status-indicator">
                    {plugin.installed ? (
                      <span className="status-label installed">
                        <Check size={11} /> Installed
                      </span>
                    ) : isDev ? (
                      <span className="status-label dev">
                        <FolderCode size={11} /> Local Dev
                      </span>
                    ) : (
                      <span className="status-label ready">
                        <Globe size={11} /> Ready
                      </span>
                    )}
                  </div>

                  <div className="card-actions-cluster">
                    <button
                      type="button"
                      className="card-details-btn"
                      onClick={() => setSelectedPlugin(plugin)}
                      title="View plugin details and manifest"
                    >
                      Details
                    </button>

                    {hasUpdate && (
                      <button
                        type="button"
                        className="market-btn-action update"
                        onClick={() => void handleInstall(plugin)}
                        disabled={isBusy || !hasProject}
                        title={`Update to v${plugin.version}`}
                      >
                        {isBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                        <span>Update</span>
                      </button>
                    )}

                    {plugin.installed ? (
                      <button
                        type="button"
                        className="market-btn-action danger"
                        onClick={() => setConfirmTarget({ type: "uninstall", plugin })}
                        disabled={isBusy}
                        title="Uninstall from workspace"
                      >
                        {isBusy ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                        <span>Uninstall</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="market-btn-action primary"
                        onClick={() => void handleInstall(plugin)}
                        disabled={isBusy || !hasProject}
                        title={hasProject ? "Install into workspace" : "Open a project to install"}
                      >
                        {isBusy ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                        <span>Install</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* List View */
        <div className="market-list-view">
          {filteredPlugins.map((plugin) => {
            const isDev = isDevPlugin(plugin);
            const isBusy = busy === plugin.id;
            const hasUpdate = Boolean(
              plugin.installed &&
                plugin.version &&
                (plugin.installedVersion || "") !== plugin.version
            );
            const isOfficial = (plugin.author || "").toLowerCase().includes("nexus");

            return (
              <div
                key={plugin.id}
                className={`market-list-row ${plugin.installed ? "installed" : ""}`}
                onClick={() => setSelectedPlugin(plugin)}
              >
                <div className="list-icon-avatar">
                  {isDev ? (
                    <FolderCode size={18} />
                  ) : plugin.capabilities?.includes("hooks") ? (
                    <Zap size={18} />
                  ) : plugin.capabilities?.includes("agents") ? (
                    <Bot size={18} />
                  ) : (
                    <Sparkles size={18} />
                  )}
                </div>

                <div className="list-info-cluster">
                  <div className="list-title-row">
                    <span className="list-title">{plugin.name}</span>
                    {plugin.version && <span className="market-version-pill">v{plugin.version}</span>}
                    {isOfficial && (
                      <span className="market-official-badge compact">
                        <ShieldCheck size={10} />
                      </span>
                    )}
                    {plugin.installed && (
                      <span className="market-badge installed">
                        <Check size={9} /> Installed
                      </span>
                    )}
                    {isDev && <span className="market-badge dev">Dev</span>}
                  </div>
                  <p className="list-desc">{plugin.description || "No description."}</p>
                </div>

                <div className="list-tags-cluster">
                  {(plugin.capabilities || []).map((cap) => (
                    <span key={cap} className="market-cap-pill compact">
                      {cap}
                    </span>
                  ))}
                </div>

                <div className="list-actions-cluster" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="card-details-btn"
                    onClick={() => setSelectedPlugin(plugin)}
                  >
                    Details
                  </button>
                  {hasUpdate && (
                    <button
                      type="button"
                      className="market-btn-action update"
                      onClick={() => void handleInstall(plugin)}
                      disabled={isBusy || !hasProject}
                    >
                      {isBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                      <span>Update</span>
                    </button>
                  )}
                  {plugin.installed ? (
                    <button
                      type="button"
                      className="market-btn-action danger"
                      onClick={() => setConfirmTarget({ type: "uninstall", plugin })}
                      disabled={isBusy}
                    >
                      {isBusy ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                      <span>Uninstall</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="market-btn-action primary"
                      onClick={() => void handleInstall(plugin)}
                      disabled={isBusy || !hasProject}
                    >
                      {isBusy ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                      <span>Install</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Plugin Details Modal */}
      {selectedPlugin && (
        <Modal
          title={selectedPlugin.name}
          subtitle={`Extension details, capabilities, and workspace status`}
          onClose={() => setSelectedPlugin(null)}
          wide
        >
          <div className="market-modal-body">
            <div className="modal-hero-split">
              <div className="modal-plugin-identity">
                <div className="modal-avatar-large">
                  {isDevPlugin(selectedPlugin) ? (
                    <FolderCode size={26} />
                  ) : selectedPlugin.capabilities?.includes("hooks") ? (
                    <Zap size={26} />
                  ) : selectedPlugin.capabilities?.includes("agents") ? (
                    <Bot size={26} />
                  ) : (
                    <Sparkles size={26} />
                  )}
                </div>
                <div>
                  <div className="modal-name-row">
                    <h3>{selectedPlugin.name}</h3>
                    {selectedPlugin.version && <span className="market-version-pill large">v{selectedPlugin.version}</span>}
                    {selectedPlugin.installed && (
                      <span className="market-badge installed">
                        <Check size={11} /> Installed in current project
                      </span>
                    )}
                  </div>
                  <span className="modal-author-lbl">
                    Created by <strong>{selectedPlugin.author || "Nexus Contributor"}</strong>
                  </span>
                </div>
              </div>

              <div className="modal-top-actions">
                {selectedPlugin.installed ? (
                  <button
                    type="button"
                    className="market-btn danger"
                    onClick={() => setConfirmTarget({ type: "uninstall", plugin: selectedPlugin })}
                    disabled={busy === selectedPlugin.id}
                  >
                    {busy === selectedPlugin.id ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                    <span>Uninstall Extension</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="market-btn primary"
                    onClick={() => void handleInstall(selectedPlugin)}
                    disabled={busy === selectedPlugin.id || !hasProject}
                  >
                    {busy === selectedPlugin.id ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                    <span>{hasProject ? "Install into Project" : "Open Project to Install"}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="modal-section">
              <h5 className="modal-section-title">Overview</h5>
              <p className="modal-desc-full">
                {selectedPlugin.description || "No detailed description provided for this extension."}
              </p>
            </div>

            <div className="modal-section">
              <h5 className="modal-section-title">Bundled Capabilities</h5>
              <div className="modal-caps-grid">
                {(selectedPlugin.capabilities || []).map((cap) => (
                  <div key={cap} className="modal-cap-card">
                    <div className="cap-icon-wrap">
                      {cap === "skills" ? (
                        <Sparkles size={16} />
                      ) : cap === "agents" ? (
                        <Bot size={16} />
                      ) : cap === "commands" ? (
                        <Terminal size={16} />
                      ) : cap === "rules" ? (
                        <Shield size={16} />
                      ) : (
                        <Zap size={16} />
                      )}
                    </div>
                    <div>
                      <strong className="cap-card-title">{cap.toUpperCase()}</strong>
                      <p className="cap-card-sub">
                        {cap === "skills"
                          ? "Injects procedural skill knowledge and guidelines for agent execution."
                          : cap === "agents"
                          ? "Equips specialist subagents accessible via agent delegation."
                          : cap === "commands"
                          ? "Registers custom slash commands in chat."
                          : cap === "rules"
                          ? "Provides framework standards and coding best practices."
                          : "Executes lifecycle hooks on agent steps and events."}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-section">
              <h5 className="modal-section-title">Technical Details</h5>
              <div className="modal-specs-table">
                <div className="spec-row">
                  <span className="spec-key">Extension ID</span>
                  <span className="spec-val"><code>{selectedPlugin.id}</code></span>
                </div>
                <div className="spec-row">
                  <span className="spec-key">Supported Modes</span>
                  <span className="spec-val">
                    {(selectedPlugin.modes && selectedPlugin.modes.length > 0)
                      ? selectedPlugin.modes.join(", ")
                      : "All Modes (Code, Home, Notebook)"}
                  </span>
                </div>
                <div className="spec-row">
                  <span className="spec-key">Distribution Source</span>
                  <span className="spec-val font-mono">{selectedPlugin.source}</span>
                </div>
                {selectedPlugin.installedVersion && (
                  <div className="spec-row">
                    <span className="spec-key">Installed Version</span>
                    <span className="spec-val font-mono">v{selectedPlugin.installedVersion}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Developer & Registry Settings Modal */}
      {showConfigModal && (
        <Modal
          title="Marketplace Feeds & Developer Settings"
          subtitle="Configure external registry feeds and auto-discovery directories for custom extensions."
          onClose={() => setShowConfigModal(false)}
        >
          <div className="market-config-modal-body">
            {/* Custom Registry Section */}
            <div className="config-section-card">
              <div className="config-card-header">
                <Globe size={16} className="text-nexus-green" />
                <div>
                  <h4>Registry Feed URL</h4>
                  <p>Point to a public JSON registry index or GitHub raw document.</p>
                </div>
              </div>

              <div className="config-field-group">
                <input
                  type="text"
                  className="market-config-input"
                  value={registryUrl}
                  onChange={(e) => setRegistryUrl(e.target.value)}
                  placeholder={DEFAULT_PLUGIN_REGISTRY_URL}
                  spellCheck={false}
                />
                <div className="config-btn-row">
                  <button
                    type="button"
                    className="market-btn primary"
                    onClick={() => void handleSaveRegistry()}
                    disabled={savingRegistry}
                  >
                    {savingRegistry ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                    <span>Save & Sync</span>
                  </button>

                  {isCustomRegistry && (
                    <button
                      type="button"
                      className="market-btn secondary"
                      onClick={() => void handleResetRegistry()}
                      disabled={savingRegistry}
                      title="Reset to official Nexus registry feed"
                    >
                      <RefreshCw size={13} />
                      <span>Reset to Official</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Dev Root Directory */}
            <div className="config-section-card">
              <div className="config-card-header">
                <FolderCode size={16} className="text-orange" />
                <div>
                  <h4>Local Dev Auto-Discovery Folder</h4>
                  <p>Every subfolder containing a <code>manifest.json</code> is automatically listed in your catalog.</p>
                </div>
              </div>

              <div className="config-field-group">
                <div className="devroot-display-box" title={devRoot || "No directory linked"}>
                  {devRoot || "No folder currently linked"}
                </div>
                <div className="config-btn-row">
                  <button
                    type="button"
                    className="market-btn secondary"
                    onClick={() => void handlePickDevRoot()}
                    disabled={busy === "devroot"}
                  >
                    {busy === "devroot" ? <Loader2 size={13} className="spin" /> : <FolderPlus size={13} />}
                    <span>{devRoot ? "Change Dev Folder" : "Link Dev Folder"}</span>
                  </button>

                  {devRoot && (
                    <button
                      type="button"
                      className="market-btn danger-subtle"
                      onClick={() => void handleClearDevRoot()}
                      disabled={busy === "devroot"}
                    >
                      <X size={13} />
                      <span>Unlink</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}

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
              ? `This will remove the plugin bundle from this project's .nexus/plugins folder. Its skills, subagents, rules, and hooks will no longer be available during agent runs.`
              : confirmTarget.plugin.installed
              ? `This will remove the plugin from your developer catalog AND uninstall its bundle from this project. The source folder on your computer will remain intact.`
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
