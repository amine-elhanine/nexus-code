import React, { useState, useEffect } from "react";
import { FolderOpen, Puzzle, Trash2, Upload, Plus, FileCode2, File, X } from "lucide-react";
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

/** Canonical select value for a modes array ([] = All). Unknown values fall back to All. */
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

/** Per-skill mode selector: one dropdown (All, singles, or pairs). */
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
      style={{ marginTop: 6, width: "100%" }}
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

  return (
    <>
      <div className="toggle-row">
        <span>
          <strong>Enable skills middleware</strong>
          <small>Allow the agent to load global and project SKILL.md files.</small>
        </span>
        <Toggle
          checked={enabled}
          onChange={(next) => void onToggle(next)}
          title={enabled ? "Disable skills middleware" : "Enable skills middleware"}
        />
      </div>

      <div className="provider-layout">
        <div className="provider-list">
          <div className="pane-top" style={{ padding: "0 0 8px 0" }}>
            <span>GLOBAL SKILLS ({globalSkills.length})</span>
            <div style={{ display: "flex", gap: "4px" }}>
              <button className="pane-action" title="Open global skills folder" onClick={() => void openFolder("global")}><FolderOpen size={13} /></button>
            </div>
          </div>
          {globalSkills.map((skill) => (
            <div className={`provider-card ${previewSkill?.path === skill.path ? "active" : ""}`} key={skill.path}>
              <div className="provider-card-main" onClick={() => void handleSelectPreview(skill)} style={{ cursor: "pointer" }}>
                <span className="provider-logo"><Puzzle size={13} /></span>
                <div style={{ minWidth: 0 }}>
                  <strong>{skill.name}</strong>
                  <small>{skill.description || "No description"}</small>
                  <div onClick={(e) => e.stopPropagation()} title="Which modes can use this skill">
                    <ModeSelector modes={skill.modes || []} disabled={savingModesPath === skill.path} onChange={(next) => void handleSetModes(skill, next)} />
                  </div>
                </div>
              </div>
              <div className="provider-card-actions">
                <button className="danger" onClick={(e) => { e.stopPropagation(); setDeleteTarget(skill); }} title="Delete skill"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {!globalSkills.length && <div className="empty-provider"><Puzzle size={16} /><p>No global skills yet.</p></div>}

          {hasProject && (
            <>
              <div className="pane-top" style={{ padding: "12px 0 8px 0" }}>
                <span>PROJECT SKILLS ({projectSkills.length})</span>
                <button className="pane-action" title="Open project skills folder" onClick={() => void openFolder("project")}><FolderOpen size={13} /></button>
              </div>
              {projectSkills.map((skill) => (
                <div className={`provider-card ${previewSkill?.path === skill.path ? "active" : ""}`} key={skill.path}>
                  <div className="provider-card-main" onClick={() => void handleSelectPreview(skill)} style={{ cursor: "pointer" }}>
                    <span className="provider-logo"><Puzzle size={13} /></span>
                    <div style={{ minWidth: 0 }}>
                      <strong>{skill.name}</strong>
                      <small>{skill.description || "No description"}</small>
                      <div onClick={(e) => e.stopPropagation()} title="Which modes can use this skill">
                        <ModeSelector modes={skill.modes || []} disabled={savingModesPath === skill.path} onChange={(next) => void handleSetModes(skill, next)} />
                      </div>
                    </div>
                  </div>
                  <div className="provider-card-actions">
                    <button className="danger" onClick={(e) => { e.stopPropagation(); setDeleteTarget(skill); }} title="Delete skill"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
              {!projectSkills.length && <div className="empty-provider"><Puzzle size={16} /><p>No project skills yet.</p></div>}
            </>
          )}
          {loadError && <small className="fetch-error">{loadError}</small>}
        </div>

        <div className="provider-form">
          <div className="skills-tab-bar">
            <button className={`skills-tab-btn ${activeTab === "import" ? "active" : ""}`} onClick={() => setActiveTab("import")}>
              <Upload size={12} /> Import files
            </button>
            <button className={`skills-tab-btn ${activeTab === "create" ? "active" : ""}`} onClick={() => setActiveTab("create")}>
              <Plus size={12} /> Create skill
            </button>
            {previewSkill && (
              <button className={`skills-tab-btn ${activeTab === "preview" ? "active" : ""}`} onClick={() => setActiveTab("preview")}>
                <FileCode2 size={12} /> Inspect: {previewSkill.name}
              </button>
            )}
          </div>

          {activeTab === "import" && (
            <>
              <div className="form-title">
                <span>Import Skill Files</span>
                <small>SKILL.md, ZIP or folder</small>
              </div>
              <label>
                Destination Library
                <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">Global (available to all projects)</option>
                  <option value="project" disabled={!hasProject}>Current project {hasProject ? "" : "(open a project first)"}</option>
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
                <div style={{ padding: "14px", border: "1px dashed #283648", borderRadius: "6px", textAlign: "center", color: "#748296", fontSize: "11px", margin: "8px 0 14px" }}>
                  <Upload size={18} style={{ margin: "0 auto 6px", display: "block", color: "#54657c" }} />
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
                <small>Write instructions for agent</small>
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
                Description (when should agent activate this skill?)
                <input value={newSkillDesc} onChange={(e) => setNewSkillDesc(e.target.value)} placeholder="e.g. Use when writing, reviewing or refactoring React components" />
              </label>
              <label>
                Usable in modes
              </label>
              <ModeSelector modes={newSkillModes} onChange={setNewSkillModes} />
              <label>
                SKILL.md Instructions (Markdown)
                <textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  rows={6}
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
              <div className="form-title">
                <span>{previewSkill.name}</span>
                <span className={`skill-scope-tag ${previewSkill.source}`}>{previewSkill.source}</span>
              </div>
              <small style={{ color: "#7f8d9f", fontSize: "10px", wordBreak: "break-all" }}>{previewSkill.path}</small>
              <small style={{ color: "#7f8d9f", fontSize: "11px" }}>Modes: {modesLabel(previewSkill.modes)}</small>
              <div onClick={(e) => e.stopPropagation()} title="Which modes can use this skill">
                <ModeSelector modes={previewSkill.modes || []} disabled={savingModesPath === previewSkill.path} onChange={(next) => void handleSetModes(previewSkill, next)} />
              </div>
              <pre className="skill-preview-box">{previewContent}</pre>
              <div className="modal-actions" style={{ justifyContent: "space-between", marginTop: "10px" }}>
                <button className="secondary danger-btn" onClick={() => setDeleteTarget(previewSkill)}>
                  <Trash2 size={13} /> Delete this skill
                </button>
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
    </>
  );
}
