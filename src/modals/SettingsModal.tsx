import React, { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, FolderOpen, ChevronRight, Globe, Puzzle, Server, Terminal, Download, RefreshCw, Loader2, Check } from "lucide-react";
import { Modal } from "../components/common/Modal.js";
import { ProviderManager } from "../components/settings/ProviderManager.js";
import { McpManager } from "../components/settings/McpManager.js";
import { SkillsManager } from "../components/settings/SkillsManager.js";
import { MemoryRow } from "../views/MemoryView.js";
import type { ProviderConfig, ProviderDefinition, UpdaterState } from "../types.js";

type SettingsSection = "browser" | "providers" | "mcp" | "skills" | "services" | "updates" | "workspace";

export function SettingsModal({
  area,
  hasProject,
  skillsEnabled,
  onToggleSkills,
  providers,
  providerDefinitions,
  onProvidersChange,
  onManageServices,
  updater,
  appVersion,
  onCheckUpdates,
  onQuitAndInstall,
  onClose,
}: {
  area: "home" | "code";
  hasProject: boolean;
  skillsEnabled: boolean;
  onToggleSkills: (enabled: boolean) => Promise<void>;
  providers: ProviderConfig[];
  providerDefinitions: ProviderDefinition[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
  onManageServices: () => void;
  updater: UpdaterState;
  appVersion: string;
  onCheckUpdates: () => void;
  onQuitAndInstall: () => void;
  onClose: () => void;
}) {
  const api = window.nexus || window.forgepilot;
  const [section, setSection] = useState<SettingsSection>("browser");
  const [headless, setHeadless] = useState(true);

  useEffect(() => {
    const typed = api as unknown as { getBrowserHeadless?: () => Promise<boolean> };
    if (typeof typed.getBrowserHeadless === "function") {
      typed.getBrowserHeadless().then(setHeadless).catch(() => {});
    }
  }, []);

  async function setHeadlessValue(next: boolean) {
    setHeadless(next);
    try {
      const typed = api as unknown as { setBrowserHeadless?: (v: boolean) => Promise<boolean> };
      if (typeof typed.setBrowserHeadless === "function") {
        setHeadless(await typed.setBrowserHeadless(next));
      }
    } catch {
      setHeadless(!next);
    }
  }

  const items: Array<{ id: SettingsSection; label: string; icon: React.ReactNode; hidden?: boolean }> = [
    { id: "browser", label: "Browser", icon: <Globe size={13} /> },
    { id: "providers", label: "Providers", icon: <KeyRound size={13} /> },
    { id: "mcp", label: "MCP servers", icon: <Server size={13} /> },
    { id: "skills", label: "Skills", icon: <Puzzle size={13} /> },
    { id: "services", label: "Services", icon: <Terminal size={13} /> },
    { id: "updates", label: "Updates", icon: <Download size={13} /> },
    { id: "workspace", label: "Workspace", icon: <FolderOpen size={13} />, hidden: area !== "home" },
  ];

  return (
    <Modal title="Settings" subtitle="Application preferences. Changes apply immediately." onClose={onClose}>
      <div className="settings-layout">
        <aside className="settings-side">
          {items
            .filter((item) => !item.hidden)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                className={section === item.id ? "active" : ""}
                onClick={() => setSection(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
        </aside>
        <section className="settings-body">
          {section === "browser" && (
            <div className="setting-card">
              <div className="setting-row">
                <span className="setting-icon">{headless ? <EyeOff size={14} /> : <Eye size={14} />}</span>
                <div className="setting-text">
                  <strong>Agent browser visibility</strong>
                  <small>
                    {headless
                      ? "Hidden — the agent inspects and operates pages in the background."
                      : "Watching — the built-in Browser tab follows the agent live."}
                  </small>
                </div>
              </div>
              <div className="seg" role="group" aria-label="Agent browser visibility">
                <button
                  type="button"
                  className={headless ? "active" : ""}
                  onClick={() => void setHeadlessValue(true)}
                >
                  <EyeOff size={12} /> Headless
                </button>
                <button
                  type="button"
                  className={!headless ? "active" : ""}
                  onClick={() => void setHeadlessValue(false)}
                >
                  <Eye size={12} /> Watching
                </button>
              </div>
              <div className="settings-note" style={{ marginTop: "10px" }}>
                <Globe size={12} />
                <span>Same switch lives in the Browser tab toolbar. Follow the agent with the Follow banner there.</span>
              </div>
            </div>
          )}

          {section === "providers" && (
            <ProviderManager providers={providers} definitions={providerDefinitions} onProvidersChange={onProvidersChange} />
          )}

          {section === "mcp" && (
            <McpManager />
          )}

          {section === "skills" && (
            <SkillsManager hasProject={hasProject} enabled={skillsEnabled} onToggle={onToggleSkills} />
          )}

          {section === "services" && (
            <div className="setting-card">
              <button className="setting-nav-row" onClick={onManageServices}>
                <span className="setting-icon"><Terminal size={14} /></span>
                <span className="setting-text">
                  <strong>Background services</strong>
                  <small>Dev servers and daemons need their live logs view — open it</small>
                </span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          {section === "updates" && (
            <div className="setting-card">
              <div className="setting-row">
                <span className="setting-icon"><Download size={14} /></span>
                <div className="setting-text">
                  <strong>App updates</strong>
                  <small>Checked automatically on launch. Installs on restart.</small>
                </div>
              </div>
              <div style={{ marginTop: "10px" }}>
                <MemoryRow label="Installed version" value={appVersion ? `v${appVersion}` : "…"} />
                {updater.status === "checking" && (
                  <MemoryRow label="Status" value="Checking for updates…" />
                )}
                {(updater.status === "idle" || updater.status === "up-to-date") && (
                  <MemoryRow
                    label="Status"
                    value={updater.status === "up-to-date" ? "You're on the latest version" : "Not checked yet"}
                  />
                )}
                {updater.status === "available" && (
                  <MemoryRow label="Status" value={`v${updater.version} found — downloading…`} />
                )}
                {updater.status === "downloading" && (
                  <MemoryRow label="Status" value={`Downloading v${updater.version}… ${updater.percent}%`} />
                )}
                {updater.status === "downloaded" && (
                  <MemoryRow label="Status" value={`v${updater.version} ready to install`} />
                )}
                {updater.status === "error" && (
                  <MemoryRow label="Status" value={`Check failed: ${updater.message}`} />
                )}
              </div>
              <div className="modal-actions" style={{ marginTop: "12px" }}>
                {updater.status === "downloaded" ? (
                  <button className="primary full" onClick={onQuitAndInstall}>
                    <Check size={14} /> Restart to install v{updater.version}
                  </button>
                ) : (
                  <button
                    className="secondary full"
                    disabled={updater.status === "checking" || updater.status === "downloading"}
                    onClick={onCheckUpdates}
                  >
                    {updater.status === "checking" || updater.status === "downloading" ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    {updater.status === "checking" || updater.status === "downloading" ? "Working…" : "Check for updates"}
                  </button>
                )}
              </div>
              <div className="settings-note" style={{ marginTop: "10px" }}>
                <Download size={12} />
                <span>Auto-update covers the installed app. Portable builds must be re-downloaded manually.</span>
              </div>
            </div>
          )}

          {section === "workspace" && area === "home" && (
            <div className="setting-card">
              <button className="setting-nav-row" onClick={() => void api.openHomeFolder()}>
                <span className="setting-icon"><FolderOpen size={14} /></span>
                <span className="setting-text">
                  <strong>Nexus folder</strong>
                  <small>Where Home documents land — open it in your file manager</small>
                </span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
