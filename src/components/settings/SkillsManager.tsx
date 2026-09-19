import React, { useState, useEffect, useMemo } from "react";
import { FolderOpen, Puzzle, Trash2, Upload, Plus, FileCode2, File, X, Search, Sparkles, BookOpen, Layers, Check } from "lucide-react";
import { ConfirmModal } from "../../modals/ConfirmModal.js";
import { Toggle } from "../common/Toggle.js";
import type { SkillInfo } from "../../types.js";

const MODE_ORDER = ["home", "code", "notebook"] as const;

function isAllModes(modes: string[] | undefined): boolean {
  return !modes || modes.length === 0;
}

function capMode(mode: string): string {
  return mode ? mode[0].toUpperCase() + mode.slice(1) : mode;
}

function modesKey(modes: string[] | undefined): string {
  if (isAllModes(modes)) return "";
  const known = modes!.filter((m) => (MODE_ORDER as readonly string[]).includes(m));
  if (!known.length) return "";
  return MODE_ORDER.filter((m) => known.includes(m)).join(",");
}

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All modes" },
  ...MODE_ORDER.map((m) => ({ value: m, label: `${capMode(m)} only` })),
  { value: "home,code", label: "Home + Code" },
  { value: "home,notebook", label: "Home + Notebook" },
  { value: "code,notebook", label: "Code + Notebook" },
];

function ModeSelector({
  modes,
  onChange,
  disabled,
}: {
  modes: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={modesKey(modes)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? e.target.value.split(",") : [])}
      title="Which modes can use this skill"
      style={{ width: "100%", fontSize: "11px", padding: "4px 8px" }}
    >
      {MODE_OPTIONS.map((o) => (
        <option key={o.value || "all"} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function modesLabel(modes: string[] | undefined): string {
  if (isAllModes(modes)) return "All modes";
  return modes!.map(capMode).join(" · ");
}

export function SkillsManager({
  hasProject,
  enabled,
  onToggle,
}: {
  hasProject: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [activeTab, setActiveTab] = useState<"import" | "create" | "preview">("import");
  const [scope, setScope] = useState<"global" | "project">(hasProject ? "project" : "global");
  const [filterScope, setFilterScope] = useState<"all" | "global" | "project" | "system">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [successNote, setSuccessNote] = useState("");
  const [loadError, setLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SkillInfo | null>(null);
  const [previewSkill, setPreviewSkill] = useState<SkillInfo | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");

  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDesc, setNewSkillDesc] = useState("");
  const [newSkillContent, setNewSkillContent] = useState("");
  const [newSkillModes, setNewSkillModes] = useState<string[]>([]);
  const [savingModesPath, setSavingModesPath] = useState("");

  const api = window.nexus || window.forgepilot;

  useEffect(() => {
    void reload();
  }, [hasProject]);

  async function reload() {
    setLoadError("");
    try {
      const list = await api.listSkills();
      setSkills(list);
    } catch (loadFail) {
      setLoadError(loadFail instanceof Error ? loadFail.message : "Unable to list skills.");
    }
  }

  async function openFolder(target: "global" | "project") {
    try {
      await api.openSkillsFolder(target);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open the folder.");
    }
  }

  async function chooseFile() {
    setError("");
    setSuccessNote("");
    const paths = await api.pickSkillFile();
    if (paths.length) {
      setSelectedSources((current) => Array.from(new Set([...current, ...paths])));
    }
  }

  async function chooseFolder() {
    setError("");
    setSuccessNote("");
    const paths = await api.pickSkillFolder();
    if (paths.length) {
      setSelectedSources((current) => Array.from(new Set([...current, ...paths])));
    }
  }

  async function importSelected() {
    if (!selectedSources.length) return;
    setError("");
    setSuccessNote("");
    setImporting(true);
    try {
      for (const sourcePath of selectedSources) {
        await api.importSkill(sourcePath, scope);
      }
      const count = selectedSources.length;
      setSelectedSources([]);
      setSuccessNote(`Successfully added ${count} skill${count === 1 ? "" : "s"} to the ${scope} library.`);
      await reload();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Unable to import one or more Skills.");
    } finally {
      setImporting(false);
    }
  }

  async function handleCreateSkill() {
    if (!newSkillName.trim()) {
      setError("Please provide a skill name.");
      return;
    }
    setError("");
    setSuccessNote("");
    setImporting(true);
    try {
      await api.createSkill({
        name: newSkillName.trim(),
        description: newSkillDesc.trim(),
        scope,
        content: newSkillContent.trim() || undefined,
        modes: newSkillModes,
      });
      setSuccessNote(`Created skill "${newSkillName}" in ${scope} library.`);
      setNewSkillName("");
      setNewSkillDesc("");
      setNewSkillContent("");
      setNewSkillModes([]);
      await reload();
      setActiveTab("import");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create skill.");
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteSkill(skill: SkillInfo) {
    setError("");
    try {
      await api.deleteSkill(skill.path);
      if (previewSkill?.path === skill.path) {
        setPreviewSkill(null);
        setPreviewContent("");
        if (activeTab === "preview") setActiveTab("import");
      }
      await reload();
    } catch (delError) {
      setError(delError instanceof Error ? delError.message : "Unable to delete skill.");
    }
  }

  async function handleSelectPreview(skill: SkillInfo) {
    setPreviewSkill(skill);
    setActiveTab("preview");
    try {
      const content = await api.readSkillContent(skill.path);
      setPreviewContent(content);
    } catch {
      setPreviewContent("// Unable to read SKILL.md content");
    }
  }

  async function handleSetModes(skill: SkillInfo, modes: string[]) {
    setError("");
    setSavingModesPath(skill.path);
    try {
      const updated = await api.setSkillModes(skill.path, modes);
      setSkills((current) => current.map((s) => (s.path === skill.path ? { ...s, modes: updated?.modes || modes } : s)));
      if (previewSkill?.path === skill.path) setPreviewSkill((current) => (current ? { ...current, modes: updated?.modes || modes } : current));
    } catch (modesError) {
      setError(modesError instanceof Error ? modesError.message : "Unable to save skill modes.");
      await reload();
    } finally {
      setSavingModesPath("");
    }
  }

  const globalSkills = skills.filter((skill) => skill.source === "global");
  const projectSkills = skills.filter((skill) => skill.source === "project");
  const systemSkills = skills.filter((skill) => skill.source === "system");

  const filteredSkills = useMemo(() => {
    return skills.filter((skill) => {
      if (filterScope !== "all" && skill.source !== filterScope) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        skill.name.toLowerCase().includes(q) ||
        (skill.description && skill.description.toLowerCase().includes(q)) ||
        modesLabel(skill.modes).toLowerCase().includes(q)
      );
    });
  }, [skills, filterScope, searchQuery]);

  return (
    <div className="skills-manager-container">
      {/* Top Banner with Toggle */}
      <div className="skills-top-banner">
        <div className="skills-top-banner-info">
          <strong>
            <Sparkles size={15} style={{ color: "var(--nexus-bright)" }} />
            Skills Middleware
          </strong>
          <small>
            Autonomous task playbooks and domain guidelines for Home, Code, and Notebook modes.
          </small>
        </div>
        <Toggle
          checked={enabled}
          onChange={(next) => void onToggle(next)}
          title={enabled ? "Disable skills middleware" : "Enable skills middleware"}
        />
      </div>

      {/* Main Two-Column Layout */}
      <div className="provider-layout">
        {/* Left Column: Skill Browser */}
        <div className="provider-list">
          {/* Filter and Search Bar */}
          <div className="skills-filter-bar" style={{ marginBottom: "8px" }}>
            <div className="skills-search-wrap">
              <Search size={12} className="skills-search-icon" />
              <input
                className="skills-search-input"
                type="text"
                placeholder="Search skills…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="skills-search-clear" onClick={() => setSearchQuery("")} title="Clear search">
                  <X size={11} />
                </button>
              )}
            </div>

            <div className="skills-scope-chips">
              <button
                className={`skills-scope-chip ${filterScope === "all" ? "active" : ""}`}
                onClick={() => setFilterScope("all")}
              >
                All <span className="skills-count-pill">{skills.length}</span>
              </button>
              <button
                className={`skills-scope-chip ${filterScope === "global" ? "active" : ""}`}
                onClick={() => setFilterScope("global")}
              >
                Global <span className="skills-count-pill">{globalSkills.length}</span>
              </button>
              {hasProject && (
                <button
                  className={`skills-scope-chip ${filterScope === "project" ? "active" : ""}`}
                  onClick={() => setFilterScope("project")}
                >
                  Project <span className="skills-count-pill">{projectSkills.length}</span>
                </button>
              )}
              {systemSkills.length > 0 && (
                <button
                  className={`skills-scope-chip ${filterScope === "system" ? "active" : ""}`}
                  onClick={() => setFilterScope("system")}
                >
                  System <span className="skills-count-pill">{systemSkills.length}</span>
                </button>
              )}
            </div>
          </div>

          {/* Action Row for Folders */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 2px 6px" }}>
            <span style={{ fontSize: "10px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
              {filterScope.toUpperCase()} SKILLS ({filteredSkills.length})
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                className="skills-action-btn"
                style={{ width: "auto", padding: "2px 6px", fontSize: "10px", gap: "4px", display: "inline-flex" }}
                title="Open global skills folder in explorer"
                onClick={() => void openFolder("global")}
              >
                <FolderOpen size={11} /> Global folder
              </button>
              {hasProject && (
                <button
                  className="skills-action-btn"
                  style={{ width: "auto", padding: "2px 6px", fontSize: "10px", gap: "4px", display: "inline-flex" }}
                  title="Open project skills folder in explorer"
                  onClick={() => void openFolder("project")}
                >
                  <FolderOpen size={11} /> Project folder
                </button>
              )}
            </div>
          </div>

          {/* Skill Cards List */}
          {filteredSkills.map((skill) => {
            const isSelected = previewSkill?.path === skill.path;
            return (
              <div
                className={`skills-card ${skill.source} ${isSelected ? "active" : ""}`}
                key={skill.path}
              >
                <div className="skills-card-main" onClick={() => void handleSelectPreview(skill)}>
                  <span className="skills-card-icon">
                    <Puzzle size={14} />
                  </span>
                  <div className="skills-card-content">
                    <div className="skills-card-title-row">
                      <strong className="skills-card-title">{skill.name}</strong>
                      <span className={`skills-badge ${skill.source}`}>{skill.source}</span>
                    </div>
                    <p className="skills-card-desc">{skill.description || "No description provided."}</p>
                    <div className="skills-card-footer">
                      <span className="skills-mode-pill">
                        {modesLabel(skill.modes)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="skills-card-actions">
                  {skill.source !== "system" && (
                    <button
                      className="skills-action-btn danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(skill);
                      }}
                      title="Delete skill"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {!filteredSkills.length && !loadError && (
            <div className="empty-provider" style={{ padding: "30px 16px" }}>
              <Puzzle size={22} style={{ color: "var(--faint)", marginBottom: "6px" }} />
              <p style={{ margin: 0, fontSize: "12px", color: "var(--muted)" }}>
                {searchQuery ? `No skills match "${searchQuery}"` : "No skills found in this category."}
              </p>
            </div>
          )}

          {loadError && <small className="fetch-error">{loadError}</small>}
        </div>

        {/* Right Column: Actions / Preview */}
        <div className="provider-form">
          <div className="skills-tab-bar">
            <button
              className={`skills-tab-btn ${activeTab === "import" ? "active" : ""}`}
              onClick={() => setActiveTab("import")}
            >
              <Upload size={12} /> Import files
            </button>
            <button
              className={`skills-tab-btn ${activeTab === "create" ? "active" : ""}`}
              onClick={() => setActiveTab("create")}
            >
              <Plus size={12} /> Create skill
            </button>
            {previewSkill && (
              <button
                className={`skills-tab-btn ${activeTab === "preview" ? "active" : ""}`}
                onClick={() => setActiveTab("preview")}
              >
                <FileCode2 size={12} /> Inspect: {previewSkill.name}
              </button>
            )}
          </div>

          {activeTab === "import" && (
            <>
              <div className="form-title">
                <span>Import Skill Files</span>
                <small>SKILL.md, ZIP bundle or folder</small>
              </div>

              <label>
                Destination Library
                <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">Global (available to all projects)</option>
                  <option value="project" disabled={!hasProject}>
                    Current project {hasProject ? "" : "(open a project first)"}
                  </option>
                </select>
              </label>

              <label>Choose Skill Source Files</label>
              <div className="modal-actions" style={{ marginTop: "4px", marginBottom: "10px", justifyContent: "flex-start", gap: "8px" }}>
                <button className="secondary" disabled={scope === "project" && !hasProject} onClick={() => void chooseFile()}>
                  <FileCode2 size={13} /> Select SKILL.md / ZIP file(s)
                </button>
                <button className="secondary" disabled={scope === "project" && !hasProject} onClick={() => void chooseFolder()}>
                  <FolderOpen size={13} /> Select Skill folder
                </button>
              </div>

              {selectedSources.length > 0 ? (
                <>
                  <label>Staged Skill Files ({selectedSources.length})</label>
                  <div className="selected-file-list">
                    {selectedSources.map((sourcePath) => (
                      <div className="selected-file" key={sourcePath}>
                        <File size={13} />
                        <span title={sourcePath}>{sourcePath.split(/[\\/]/).pop()}</span>
                        <button className="pane-action" onClick={() => setSelectedSources((current) => current.filter((item) => item !== sourcePath))}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="primary full"
                    disabled={!selectedSources.length || (scope === "project" && !hasProject) || importing}
                    onClick={() => void importSelected()}
                    style={{ marginTop: "8px" }}
                  >
                    <Upload size={13} /> {importing ? "Adding to library…" : `Add ${selectedSources.length} Skill${selectedSources.length === 1 ? "" : "s"} to ${scope === "global" ? "Global" : "Project"} Library`}
                  </button>
                </>
              ) : (
                <div style={{ padding: "16px", border: "1px dashed var(--line)", borderRadius: "8px", textAlign: "center", color: "var(--muted)", fontSize: "11px", margin: "8px 0 14px" }}>
                  <Upload size={20} style={{ margin: "0 auto 8px", display: "block", color: "var(--faint)" }} />
                  Click <strong>Select SKILL.md / ZIP file(s)</strong> or <strong>Select Skill folder</strong> above to stage skills for addition.
                </div>
              )}

              {successNote && <div style={{ color: "var(--green)", fontSize: "11px", marginTop: "10px" }}>✓ {successNote}</div>}
              {error && <div style={{ color: "var(--red)", fontSize: "11px", marginTop: "10px" }}>{error}</div>}
              {!hasProject && scope === "project" && <div style={{ color: "#e3a85b", fontSize: "11px", marginTop: "8px" }}>Open a project workspace to import project-scoped skills.</div>}
            </>
          )}

          {activeTab === "create" && (
            <>
              <div className="form-title">
                <span>Create New Skill</span>
                <small>Author instructions for your agent</small>
              </div>
              <label>
                Skill Identifier
                <input value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder="e.g. react-best-practices" />
              </label>
              <label>
                Destination Library
                <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">Global (available to all projects)</option>
                  <option value="project" disabled={!hasProject}>Current project</option>
                </select>
              </label>
              <label>
                Description (when should the agent activate this skill?)
                <input value={newSkillDesc} onChange={(e) => setNewSkillDesc(e.target.value)} placeholder="e.g. Use when writing, reviewing or refactoring React components" />
              </label>
              <label>
                Usable in modes
                <ModeSelector modes={newSkillModes} onChange={setNewSkillModes} />
              </label>
              <label>
                SKILL.md Instructions (Markdown)
                <textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  rows={7}
                  placeholder={`# Skill Instructions\n\n1. Inspect the relevant components.\n2. Follow patterns specified here.\n3. Validate with tests.`}
                />
              </label>
              <button
                className="primary full"
                disabled={!newSkillName.trim() || (scope === "project" && !hasProject) || importing}
                onClick={() => void handleCreateSkill()}
                style={{ marginTop: "10px" }}
              >
                <Plus size={13} /> {importing ? "Creating skill…" : "Create Skill"}
              </button>

              {successNote && <div style={{ color: "var(--green)", fontSize: "11px", marginTop: "10px" }}>✓ {successNote}</div>}
              {error && <div style={{ color: "var(--red)", fontSize: "11px", marginTop: "10px" }}>{error}</div>}
            </>
          )}

          {activeTab === "preview" && previewSkill && (
            <>
              <div className="skills-preview-header">
                <div className="skills-preview-title">
                  <strong>{previewSkill.name}</strong>
                  <div className="skills-preview-meta">
                    <span className={`skills-badge ${previewSkill.source}`}>{previewSkill.source}</span>
                    <span>Modes: {modesLabel(previewSkill.modes)}</span>
                  </div>
                </div>
                {previewSkill.source !== "system" && (
                  <button className="skills-action-btn danger" onClick={() => setDeleteTarget(previewSkill)} title="Delete skill">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {previewSkill.source !== "system" && (
                <label style={{ margin: "6px 0" }}>
                  Usable in modes
                  <ModeSelector
                    modes={previewSkill.modes || []}
                    disabled={savingModesPath === previewSkill.path}
                    onChange={(next) => void handleSetModes(previewSkill, next)}
                  />
                </label>
              )}

              <small style={{ color: "var(--faint)", fontSize: "10px", wordBreak: "break-all", display: "block", margin: "4px 0" }}>
                {previewSkill.path}
              </small>

              <pre className="skills-preview-box-enhanced">{previewContent}</pre>

              <div className="modal-actions" style={{ justifyContent: "space-between", marginTop: "10px" }}>
                {previewSkill.source !== "system" ? (
                  <button className="secondary danger-btn" onClick={() => setDeleteTarget(previewSkill)}>
                    <Trash2 size={13} /> Delete skill
                  </button>
                ) : <span />}
                <button className="secondary" onClick={() => setActiveTab("import")}>
                  Back to import
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmModal
          title={`Delete skill "${deleteTarget.name}"?`}
          message={`Are you sure you want to delete this skill from the ${deleteTarget.source} library?`}
          confirmLabel="Delete skill"
          danger
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void handleDeleteSkill(target);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
