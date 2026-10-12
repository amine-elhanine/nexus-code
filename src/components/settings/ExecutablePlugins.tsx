import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Play, Shield, Square, TriangleAlert } from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";
import { PluginUiModal } from "../plugins/PluginUiModal.js";

type ExecPlugin = {
  id: string;
  dir: string;
  status: string;
  error?: string;
  capabilities: string[];
  grantedPermissions: string[];
  manifest?: {
    id: string;
    name: string;
    version: string;
    apiVersion: string;
    description: string;
    capabilities: string[];
    modes?: string[];
    modesImplicit: boolean;
    permissions: string[];
    ui: Array<{ slot: string; title: string; entry?: string }>;
  };
};

type OpenUi = { pluginId: string; entry: string; title: string } | null;

/**
 * Executable extensions (Plugin API v1): sandboxed `entry` plugins with
 * explicit enable/disable + permission approval. Declarative bundles
 * (skills/agents/commands/rules/hooks) keep working without this panel —
 * this only lists manifests that validated on the strict v2 path.
 */
export function ExecutablePlugins({ hasProject }: { hasProject: boolean }) {
  const api = window.nexus || window.forgepilot;
  const [items, setItems] = useState<ExecPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [pendingEnable, setPendingEnable] = useState<ExecPlugin | null>(null);
  const [openUi, setOpenUi] = useState<OpenUi>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listExecutablePlugins().catch(() => []);
      setItems(list || []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function doEnable(plugin: ExecPlugin) {
    setBusy(plugin.id);
    setNotice(null);
    try {
      await api.enablePlugin(plugin.id, plugin.manifest?.permissions || []);
      await refresh();
      setNotice({ type: "success", message: `"${plugin.manifest?.name || plugin.id}" enabled.` });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Enable failed." });
    } finally {
      setBusy(null);
      setPendingEnable(null);
    }
  }

  async function doDisable(plugin: ExecPlugin) {
    setBusy(plugin.id);
    setNotice(null);
    try {
      await api.disablePlugin(plugin.id);
      await refresh();
      setNotice({ type: "success", message: `"${plugin.manifest?.name || plugin.id}" disabled — its tools and listeners were removed.` });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Disable failed." });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="empty-pane" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Loader2 size={13} className="spin" /> Checking executable extensions…
      </div>
    );
  }

  if (!items.length) return null;

  return (
    <section className="market-section" style={{ marginBottom: 16 }}>
      <div className="project-dropdown-head">
        <span>EXECUTABLE EXTENSIONS (API v1)</span>
        <span className="notebook-head-count-pill">{items.length}</span>
      </div>
      <p style={{ color: "#687588", fontSize: "11px", lineHeight: 1.5, margin: "6px 0 10px" }}>
        Sandboxed code plugins. Enabling runs the entry in an isolated context with only the approved
        permissions below — never with full app privileges. Declarative skill/command/rule bundles are unaffected.
      </p>
      {notice && (
        <div className={`market-feedback ${notice.type}`} style={{ marginBottom: 8 }}>
          {notice.type === "error" ? <TriangleAlert size={12} /> : <Shield size={12} />}
          <span>{notice.message}</span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((plugin) => {
          const enabled = plugin.status === "enabled";
          return (
            <div key={plugin.id} className="home-file-row" style={{ alignItems: "flex-start" }}>
              <Shield size={13} style={{ flex: "none", marginTop: 2, color: enabled ? "var(--nexus-green)" : "#687588" }} />
              <div className="home-file-info">
                <span className="home-file-name">
                  {plugin.manifest?.name || plugin.id} <small>v{plugin.manifest?.version || "?"} · api {plugin.manifest?.apiVersion || "?"}</small>
                </span>
                <small>
                  {plugin.status}
                  {plugin.manifest?.modesImplicit ? " · all modes" : plugin.manifest?.modes?.length ? ` · ${plugin.manifest.modes.join(", ")}` : ""}
                  {plugin.manifest?.permissions?.length ? ` · perms: ${plugin.manifest.permissions.join(", ")}` : " · no permissions"}
                </small>
                {plugin.capabilities.length > 0 && <small>active: {plugin.capabilities.join(", ")}</small>}
                {plugin.error && <small style={{ color: "#e5484d" }}>{plugin.error}</small>}
                {plugin.manifest?.ui?.length ? (
                  <small>
                    ui: {plugin.manifest.ui.map((u) => `${u.slot}:${u.title}`).join(", ")}
                    {enabled && (
                      <>
                        {" "}
                        {plugin.manifest.ui
                          .filter((u) => u.entry)
                          .map((u) => (
                            <button
                              key={`${u.slot}:${u.title}`}
                              className="pane-action"
                              style={{ display: "inline-flex", marginLeft: 6 }}
                              onClick={() => setOpenUi({ pluginId: plugin.id, entry: u.entry as string, title: u.title })}
                              title={`Open ${u.title} (sandboxed plugin UI)`}
                            >
                              <ExternalLink size={12} /> Open {u.title}
                            </button>
                          ))}
                      </>
                    )}
                  </small>
                ) : null}
              </div>
              {enabled ? (
                <button className="pane-action" disabled={busy === plugin.id || !hasProject} onClick={() => void doDisable(plugin)} title="Disable and remove all registrations">
                  <Square size={13} /> Disable
                </button>
              ) : (
                <button
                  className="pane-action"
                  disabled={busy === plugin.id || !hasProject}
                  onClick={() => {
                    if ((plugin.manifest?.permissions || []).length > 0) setPendingEnable(plugin);
                    else void doEnable(plugin);
                  }}
                  title={hasProject ? "Enable with the listed permissions" : "Open a project first"}
                >
                  <Play size={13} /> Enable
                </button>
              )}
            </div>
          );
        })}
      </div>
      {pendingEnable && (
        <ConfirmModal
          title={`Enable "${pendingEnable.manifest?.name || pendingEnable.id}"?`}
          message={`This runs third-party code in a sandbox with these permissions:\n${(pendingEnable.manifest?.permissions || []).join(", ")}\n\nOnly enable extensions from sources you trust. You can disable it at any time.`}
          confirmLabel="Enable with these permissions"
          onConfirm={() => void doEnable(pendingEnable)}
          onCancel={() => setPendingEnable(null)}
        />
      )}
      {openUi && (
        <PluginUiModal
          pluginId={openUi.pluginId}
          entry={openUi.entry}
          title={openUi.title}
          mode="home"
          onClose={() => setOpenUi(null)}
        />
      )}
    </section>
  );
}
