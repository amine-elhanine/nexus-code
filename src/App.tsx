import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen, Check, ChevronDown, ChevronRight, Code2, Download, FileCode2, FileText,
  Folder, FolderOpen, GitBranch, Home, Sparkles, X, Globe,
  MessageSquare, MoreHorizontal, PanelLeft, PanelRight, Pencil, Plus, RefreshCw, Search,
  Terminal, Trash2, SlidersHorizontal, Database, Cpu, Brain, Command, TriangleAlert
} from "lucide-react";
import { WindowControls } from "./components/common/WindowControls.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { ErrorBoundary } from "./components/common/ErrorBoundary.js";
import { ProviderModal } from "./modals/ProviderModal.js";
import { McpModal } from "./modals/McpModal.js";
import { SkillsModal } from "./modals/SkillsModal.js";
import { SettingsModal } from "./modals/SettingsModal.js";
import { CommandPalette } from "./components/ui/CommandPalette.js";
import { DaemonsModal } from "./components/daemons/DaemonsModal.js";
import { ProjectRulesModal } from "./components/rules/ProjectRulesModal.js";
const MonacoDiffModal = lazy(() => import("./components/diff/MonacoDiffModal.js").then((module) => ({ default: module.MonacoDiffModal })));
const ArtifactViewer = lazy(() => import("./components/artifacts/ArtifactViewer.js").then((module) => ({ default: module.ArtifactViewer })));
const FilePreviewModal = lazy(() => import("./components/home/FilePreviewModal.js").then((module) => ({ default: module.FilePreviewModal })));
const AttachmentPreviewModal = lazy(() => import("./components/home/AttachmentPreviewModal.js").then((module) => ({ default: module.AttachmentPreviewModal })));
import { SidebarBrowser } from "./components/browser/SidebarBrowser.js";
import { AgentBrowserHost } from "./components/browser/AgentBrowserHost.js";
const XTermView = lazy(() => import("./components/terminal/XTermView.js").then((module) => ({ default: module.XTermView })));
import { VisualFullscreenLayer } from "./components/common/VisualFullscreen.js";
import { AgentView } from "./views/AgentView.js";
const HomeView = lazy(() => import("./views/HomeView.js").then((module) => ({ default: module.HomeView })));
import { HomeCanvasDrawer } from "./components/home/HomeCanvasDrawer.js";
const NotebookView = lazy(() => import("./views/NotebookView.js").then((module) => ({ default: module.NotebookView })));
const MonacoEditorView = lazy(() => import("./components/editor/MonacoEditorView.js").then((module) => ({ default: module.MonacoEditorView })));
import { useNotebookController } from "./state/useNotebookController.js";
import { useHomeController } from "./state/useHomeController.js";
const DiffView = lazy(() => import("./views/DiffView.js").then((module) => ({ default: module.DiffView })));
import { MemoryView } from "./views/MemoryView.js";
import { useAppController, sortSessionsByUpdatedAt } from "./state/useAppController.js";
import { getStoredThemeId, isThemeLight } from "./state/theme.js";
import { getSessionUsage, getSessionContextUsage, fileIcon } from "./utils/format.js";
import type { ChatAttachment, SessionRecord, UpdaterState, FileEntry } from "./types.js";

function groupHomeSessions(sessions: SessionRecord[]): Array<{ label: string; sessions: SessionRecord[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets: Array<{ label: string; sessions: SessionRecord[] }> = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Previous 7 days", sessions: [] },
    { label: "Older", sessions: [] },
  ];
  for (const session of [...sessions].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))) {
    const t = Date.parse(session.updatedAt || session.createdAt || "") || 0;
    if (t >= startOfToday) buckets[0].sessions.push(session);
    else if (t >= startOfToday - day) buckets[1].sessions.push(session);
    else if (t >= startOfToday - 7 * day) buckets[2].sessions.push(session);
    else buckets[3].sessions.push(session);
  }
  return buckets.filter((b) => b.sessions.length > 0);
}

export function App() {
  const {
    projects,
    activeProject,
    sessions,
    activeSession,
    providers,
    providerDefinitions,
    selectedProviderId,
    selectedModel,
    selectedEffort,
    files,
    expandedFolders,
    gitBranch,
    activeFile,
    openFiles,
    fileContent,
    setFileContent,
    dirty,
    diff,
    draft,
    setDraft,
    streamingText,
    liveEvents,
    view,
    setView,
    mode,
    setMode,
    running,
    showSessions,
    setShowSessions,
    showContext,
    setShowContext,
    showProviders,
    setShowProviders,
    showMcp,
    setShowMcp,
    showSkills,
    setShowSkills,
    skillsEnabled,
    rulesEnabled,
    setRulesEnabled,
    setSkillsEnabled,
    confirmDialog,
    setConfirmDialog,
    activeArtifact,
    setActiveArtifact,
    worktreeStatus,
    attachedImages,
    setAttachedImages,
    attachments,
    setAttachments,
    projectRules,
    showRulesModal,
    setShowRulesModal,
    customCommands,
    installedSkills,
    refreshSkills,
    showDaemonsModal,
    setShowDaemonsModal,
    inspectDiffFile,
    setInspectDiffFile,
    selectedProvider,
    currentMessages,
    visibleFiles,
    area,
    enterHome,
    enterCode,
    enterNotebook,
    setArea,
    activateProject,
    deleteProjectById,
    openProjectFromDialog,
    createSession,
    activateSession,
    deleteActiveSession,
    renameSession,
    gitStatus,
    openFile,
    saveFile,
    workspacePreviewPath,
    setWorkspacePreviewPath,
    toggleFolder,
    loadWorkspace,
    refreshDiff,
    revertSingleFile,
    revertSingleHunk,
    revertAllChanges,
    undoRun,
    undoLatest,
    undoLevels,
    canUndo,
    undoing,
    keepChanges,
    switchModel,
    switchEffort,
    handleProvidersChange,
    removeProjectFact,
    clearSessionMemory,
    submit,
    stopAgent,
    truncateSession,
    forkSession,
    setActiveFile,
    setOpenFiles,
  } = useAppController();

  const api = window.nexus;
  const sortedSessions = useMemo(() => sortSessionsByUpdatedAt(sessions), [sessions]);
  // Codex-style sidebar: every opened project listed with its own sessions.
  const [projectSessions, setProjectSessions] = useState<Record<string, SessionRecord[]>>({});
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  // Lazily load sessions for each project (the controller only keeps the
  // active project's sessions in `sessions`).
  useEffect(() => {
    if (area !== "code") return;
    const missing = projects.filter((p) => !projectSessions[p.id]);
    if (!missing.length) return;
    let cancelled = false;
    for (const p of missing) {
      api
        .listSessions(p.id)
        .then((list) => {
          if (cancelled) return;
          setProjectSessions((prev) => ({ ...prev, [p.id]: sortSessionsByUpdatedAt(list as unknown as SessionRecord[]) }));
        })
        .catch(() => {
          if (cancelled) return;
          setProjectSessions((prev) => ({ ...prev, [p.id]: [] }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, projects]);

  // Keep the active project's block in sync with the authoritative `sessions`.
  useEffect(() => {
    if (activeProject) {
      setProjectSessions((prev) => ({ ...prev, [activeProject.id]: sortedSessions }));
    }
  }, [activeProject?.id, sortedSessions]);

  // The active project starts expanded.
  useEffect(() => {
    if (activeProject) {
      setExpandedProjects((prev) => (prev.has(activeProject.id) ? prev : new Set(prev).add(activeProject.id)));
    }
  }, [activeProject?.id]);

  const toggleProjectExpanded = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        if (!projectSessions[id] && typeof api?.listSessions === "function") {
          api
            .listSessions(id)
            .then((list) => {
              setProjectSessions((p) => ({ ...p, [id]: sortSessionsByUpdatedAt(list as unknown as SessionRecord[]) }));
            })
            .catch(() => {
              setProjectSessions((p) => ({ ...p, [id]: [] }));
            });
        }
      }
      return next;
    });
  };

  const openProjectSession = async (projectId: string, sessionId: string) => {
    if (activeProject?.id !== projectId) {
      await activateProject(projectId, sessionId);
    } else {
      await activateSession(sessionId);
    }
    setCodeMainTab("agent");
  };
  const home = useHomeController(area === "home");
  const notebook = useNotebookController(area === "notebook");

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<ChatAttachment | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const [currentThemeId, setCurrentThemeId] = useState(() => getStoredThemeId());

  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ id: string; isLight: boolean }>;
      if (customEvent.detail?.id) {
        setCurrentThemeId(customEvent.detail.id);
      }
    };
    window.addEventListener("nexus-theme-change", handleThemeChange);
    return () => window.removeEventListener("nexus-theme-change", handleThemeChange);
  }, []);

  const isLightTheme = isThemeLight(currentThemeId);
  const [codeSideTab, setCodeSideTab] = useState<"tasks" | "files">("tasks");
  const [codeMainTab, setCodeMainTab] = useState<"agent" | "editor" | "diff" | "terminal" | "browser" | "memory">("agent");
  const [codeSelectedArtifact, setCodeSelectedArtifact] = useState<string | null>(null);
  const [codeSidebarExpanded, setCodeSidebarExpanded] = useState(false);
  const [codeBrowserActive, setCodeBrowserActive] = useState(false);
  const [codeBrowserLatestUrl, setCodeBrowserLatestUrl] = useState<string | null>(null);
  const [codeRightSidebarTab, setCodeRightSidebarTab] = useState<"artifact" | "browser">("artifact");

  useEffect(() => {
    if (typeof api?.onBrowserAgentActivity === "function") {
      const unsub = api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        if (payload.autoFollow) {
          setCodeBrowserLatestUrl(payload.url);
          setCodeBrowserActive(true);
          setCodeRightSidebarTab("browser");
        }
      });
      return unsub;
    }
  }, [api]);

  const currentSessionUsage = getSessionUsage(activeSession);
  const currentSessionContextUsage = getSessionContextUsage(activeSession);

  // Electron Updater & System status
  const [updater, setUpdater] = useState<UpdaterState>({ status: "idle" });
  const [appVersion, setAppVersion] = useState("");
  const [approvalRequest, setApprovalRequest] = useState<{ id: string; runId?: string; command: string; cwd: string; reason: string; approvalKey?: string } | null>(null);
  const [userQuestion, setUserQuestion] = useState<{ id: string; sessionId: string; questions: Array<{ header: string; question: string; options: string[] }> } | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getAppVersion().then(setAppVersion).catch(() => {});
    void api.getUpdaterState?.().then((state) => {
      if (state && typeof state === "object" && "status" in state) setUpdater(state as UpdaterState);
    }).catch(() => {});
    return api.onUpdaterStatus((state) => setUpdater(state as UpdaterState));
  }, [api]);

  useEffect(() => api.onCommandApprovalRequest((request) => setApprovalRequest(request)), [api]);
  useEffect(() => {
    const off = (api as unknown as { onUserQuestionRequest?: (l: (r: { id: string; sessionId: string; questions: Array<{ header: string; question: string; options: string[] }> }) => void) => () => void }).onUserQuestionRequest?.((request) => {
      setQuestionAnswers({});
      setUserQuestion(request);
    });
    return off;
  }, [api]);

  async function answerApproval(decision: "once" | "session" | "deny") {
    const request = approvalRequest;
    if (!request) return;
    setApprovalRequest(null);
    await api.resolveCommandApproval(request.id, decision).catch(() => {});
  }

  function openImagePreview(src: string) {
    const match = attachments.find((a) => a.url === src);
    if (match) setAttachmentPreview(match);
    else setAttachmentPreview({ url: src, name: src.split("/").pop() || "image", mimeType: "image/png", size: 0 });
  }

  function openSettingsSection(sec?: string) {
    setSettingsInitialSection(sec);
    setShowSettings(true);
  }

  // Keyboard Shortcuts
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setShowCommandPalette((v) => !v);
      } else if (key === "b") {
        event.preventDefault();
        setSidebarCollapsed((v) => !v);
      } else if (key === ",") {
        event.preventDefault();
        openSettingsSection("appearance");
      } else if (key === "1") {
        event.preventDefault();
        void enterHome();
      } else if (key === "2") {
        event.preventDefault();
        void enterCode();
      } else if (key === "3") {
        event.preventDefault();
        enterNotebook();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enterHome, enterCode, enterNotebook]);

  // Filtered sessions for Home mode
  const filteredHomeSessions = useMemo(() => {
    const query = searchFilter.trim().toLowerCase();
    if (!query) return home.sessions;
    return home.sessions.filter((s) => (s.title || "").toLowerCase().includes(query));
  }, [home.sessions, searchFilter]);

  const groupedHomeSessions = useMemo(() => {
    return groupHomeSessions(filteredHomeSessions);
  }, [filteredHomeSessions]);

  const handleStartRename = (session: { id: string; title: string }) => {
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  };

  const handleCommitRename = () => {
    if (editingSessionId && editingSessionTitle.trim()) {
      if (area === "home") {
        home.commitRename();
      } else {
        void renameSession(editingSessionId, editingSessionTitle);
      }
    }
    setEditingSessionId(null);
    setEditingSessionTitle("");
  };

  return (
    <div className={`app-root ${isLightTheme ? "theme-light" : ""}`} data-theme={currentThemeId}>

      {/* Main Collapsible Sidebar */}
      <aside className={`app-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        {/* Sidebar Header */}
        <div className="sidebar-header">
          {!sidebarCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-dot" />
              <span>Nexus</span>
            </div>
          )}
          <button
            className="btn btn-icon btn-ghost"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
          >
            <PanelLeft size={16} />
          </button>
        </div>

        {/* Mode Switcher */}
        {!sidebarCollapsed && (
          <div className="mode-switcher-container">
            <div className="mode-switcher">
              <button
                className={`mode-pill mode-home ${area === "home" ? "active" : ""}`}
                onClick={() => void enterHome()}
                title="Home (ChatGPT conversation mode)"
              >
                <Sparkles size={14} />
                <span>Home</span>
              </button>
              <button
                className={`mode-pill mode-code ${area === "code" ? "active" : ""}`}
                onClick={() => void enterCode()}
                title="Code (Codex developer mode)"
              >
                <Code2 size={14} />
                <span>Code</span>
              </button>
              <button
                className={`mode-pill mode-notebook ${area === "notebook" ? "active" : ""}`}
                onClick={() => enterNotebook()}
                title="Notebook (NotebookLM research studio)"
              >
                <BookOpen size={14} />
                <span>Notebook</span>
              </button>
            </div>
          </div>
        )}

        {/* Primary Action Button */}
        {!sidebarCollapsed && (
          <div className="sidebar-action-wrap">
            {area === "home" && (
              <button
                className="sidebar-new-btn"
                onClick={() => void home.createChat()}
              >
                <Plus size={15} />
                <span>New chat</span>
              </button>
            )}
            {area === "code" && (
              <button
                className="sidebar-new-btn"
                onClick={() => void createSession()}
              >
                <Plus size={15} />
                <span>New task</span>
              </button>
            )}
            {area === "notebook" && (
              <button
                className="sidebar-new-btn"
                onClick={() => void notebook.createNotebook("New notebook")}
              >
                <Plus size={15} />
                <span>New notebook</span>
              </button>
            )}
          </div>
        )}

        {/* Fixed Search Input in Home Sidebar so it never clips */}
        {!sidebarCollapsed && area === "home" && (
          <div className="sidebar-search-wrap">
            <div className="sidebar-search-box">
              <Search size={13} />
              <input
                placeholder="Search chats..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />
              {searchFilter && (
                <button
                  type="button"
                  onClick={() => setSearchFilter("")}
                  style={{ display: "inline-flex", color: "var(--text-tertiary)" }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Sidebar Middle Content */}
        {!sidebarCollapsed && (
          <div className="sidebar-content">
            {/* HOME MODE: Date-grouped Chat History */}
            {area === "home" && (
              <>
                {groupedHomeSessions.map((group) => (
                  <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div className="history-group-title">{group.label}</div>
                    {group.sessions.map((s) => {
                      const isActive = home.activeSession?.id === s.id;
                      const isEditing = editingSessionId === s.id;
                      return (
                        <div
                          key={s.id}
                          className={`history-item ${isActive ? "active" : ""}`}
                          onClick={() => void home.selectChat(s.id)}
                        >
                          {isEditing ? (
                            <input
                              className="input"
                              style={{ padding: "2px 6px", fontSize: "0.82rem" }}
                              value={editingSessionTitle}
                              autoFocus
                              onChange={(e) => setEditingSessionTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleCommitRename();
                                else if (e.key === "Escape") setEditingSessionId(null);
                              }}
                              onBlur={handleCommitRename}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <>
                              <span className="history-item-label">{s.title || "Untitled chat"}</span>
                              <div className="history-actions" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className="btn btn-icon-sm btn-ghost"
                                  title="Rename"
                                  onClick={() => handleStartRename(s)}
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  className="btn btn-icon-sm btn-ghost"
                                  title="Delete"
                                  onClick={() => void home.deleteChat(s.id)}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </>
            )}

            {/* CODE MODE: Task Sessions & File Explorer */}
            {area === "code" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="history-group-title">Active Workspace</div>
                <button
                  className="card"
                  style={{ padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                  onClick={openProjectFromDialog}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <FolderOpen size={14} style={{ color: "var(--accent-code)", flexShrink: 0 }} />
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {activeProject ? activeProject.name : "Select Project"}
                    </span>
                  </div>
                  {gitBranch && (
                    <span className="badge badge-code" style={{ fontSize: "0.68rem" }}>
                      <GitBranch size={10} /> {gitBranch}
                    </span>
                  )}
                </button>

                <div className="mode-switcher" style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    className={`mode-pill ${codeSideTab === "tasks" ? "active mode-code" : ""}`}
                    onClick={() => setCodeSideTab("tasks")}
                  >
                    <MessageSquare size={12} />
                    <span>Tasks ({sortedSessions.length})</span>
                  </button>
                  <button
                    type="button"
                    className={`mode-pill ${codeSideTab === "files" ? "active mode-code" : ""}`}
                    onClick={() => setCodeSideTab("files")}
                  >
                    <Folder size={12} />
                    <span>Files ({files.length})</span>
                  </button>
                </div>

                {codeSideTab === "tasks" ? (
                  <>
                    <div className="history-group-title" style={{ marginTop: 4 }}>Projects</div>
                    {projects.map((p) => {
                      const isActiveProject = activeProject?.id === p.id;
                      const isExpanded = expandedProjects.has(p.id);
                      const projSessions = projectSessions[p.id];
                      return (
                        <div key={p.id} className="project-tree">
                          <div
                            className={`history-item project-row ${isActiveProject ? "active" : ""}`}
                            onClick={() => {
                              toggleProjectExpanded(p.id);
                            }}
                            title={p.name}
                          >
                            {isExpanded ? <ChevronDown size={12} style={{ flexShrink: 0 }} /> : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
                            <FolderOpen size={13} style={{ flexShrink: 0, color: "var(--accent-code)" }} />
                            <span className="history-item-label">{p.name}</span>
                            {projSessions && (
                              <span className="project-session-count">{projSessions.length}</span>
                            )}
                          </div>
                          {isExpanded && (
                            <div className="project-sessions">
                              {(projSessions || []).map((s) => {
                                const isActive = activeSession?.id === s.id && isActiveProject;
                                return (
                                  <div
                                    key={s.id}
                                    className={`history-item ${isActive ? "active" : ""}`}
                                    onClick={() => void openProjectSession(p.id, s.id)}
                                  >
                                    <MessageSquare size={12} style={{ flexShrink: 0 }} />
                                    <span className="history-item-label">{s.title || "Untitled task"}</span>
                                    <div className="history-actions" onClick={(e) => e.stopPropagation()}>
                                      {isActiveProject && (
                                        <button
                                          className="btn btn-icon-sm btn-ghost"
                                          title="Delete"
                                          onClick={() => void deleteActiveSession(s.id)}
                                        >
                                          <Trash2 size={12} />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              {projSessions && projSessions.length === 0 && (
                                <div className="project-empty">No sessions yet</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 4 }}>
                    {visibleFiles.map((entry: FileEntry) => {
                      const isFolder = entry.kind === "folder";
                      const isOpen = expandedFolders.has(entry.path);
                      const isSelected = activeFile === entry.path;
                      const parts = entry.path.split("/");
                      const name = parts[parts.length - 1] || entry.path;
                      const depth = Math.max(0, parts.length - 1);
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          className={`tree-row ${isSelected ? "active" : ""}`}
                          style={{ paddingLeft: `${8 + depth * 12}px` }}
                          onClick={() => {
                            if (isFolder) {
                              toggleFolder(entry.path);
                            } else {
                              void openFile(entry.path);
                              setCodeMainTab("editor");
                            }
                          }}
                        >
                          <span className="twist">
                            {isFolder ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
                          </span>
                          <span className="ficon">
                            {isFolder ? <Folder size={13} /> : fileIcon(name)}
                          </span>
                          <span className="fname">{name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* NOTEBOOK MODE: Notebook Switcher */}
            {area === "notebook" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div className="history-group-title">Notebooks</div>
                {notebook.notebooks.map((nb) => {
                  const isActive = notebook.activeNotebook?.id === nb.id;
                  return (
                    <div
                      key={nb.id}
                      className={`history-item ${isActive ? "active" : ""}`}
                      onClick={() => notebook.enterNotebook(nb)}
                    >
                      <BookOpen size={13} style={{ flexShrink: 0, color: "var(--accent-notebook)" }} />
                      <span className="history-item-label">{nb.name}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Sidebar Footer */}
        {!sidebarCollapsed && (
          <div className="sidebar-footer">
            <button
              className="footer-btn"
              onClick={() => setShowCommandPalette(true)}
              title="Command Palette (⌘K)"
            >
              <Command size={14} />
              <span>Commands</span>
              <kbd style={{ marginLeft: "auto", fontSize: "0.7rem", opacity: 0.6 }}>⌘K</kbd>
            </button>
            <button
              className="footer-btn"
              onClick={() => openSettingsSection("general")}
              title="Settings (⌘,)"
            >
              <SlidersHorizontal size={14} />
              <span>Settings</span>
            </button>
          </div>
        )}
      </aside>

      {/* Main View Area */}
      <main className="app-main">
        <div className={`app-view-stage${area === "home" ? " area-home" : ""}`}>
          <ErrorBoundary>
            <Suspense fallback={<div className="modal-overlay">Loading...</div>}>
              {area === "home" && (
                <HomeView
                  messages={home.currentMessages}
                  draft={home.draft}
                  setDraft={home.setDraft}
                  submit={(override) => void home.submit(override, { providerId: selectedProviderId, model: selectedModel, effort: selectedEffort })}
                  running={home.running}
                  onStop={() => void home.stopAgent()}
                  streamingText={home.streamingText}
                  liveEvents={home.liveEvents}
                  selectedProviderId={selectedProviderId}
                  selectedModel={selectedModel}
                  selectedEffort={selectedEffort}
                  providers={providers}
                  definitions={providerDefinitions}
                  switchModel={(pId, m, eff) => void switchModel(pId, m, eff)}
                  switchEffort={(eff) => void switchEffort(eff)}
                  onOpenProviders={() => setShowProviders(true)}
                  sessionUsage={home.sessionUsage}
                  contextUsage={getSessionContextUsage(home.activeSession)}
                  activeSessionId={home.activeSession?.id}
                  sessionTitle={home.activeSession?.title}
                  onTruncateSession={(idx) => home.truncateChat(idx)}
                  onForkSession={(idx) => home.forkChat(idx)}
                  attachedImages={home.attachedImages}
                  setAttachedImages={home.setAttachedImages}
                  attachments={home.attachments}
                  setAttachments={home.setAttachments}
                  hasProvider={providers.length > 0}
                  onOpenImage={(src) => setAttachmentPreview({ url: src, name: "image", mimeType: "image/png", size: 0 })}
                  onOpenAttachment={(a) => setAttachmentPreview(a)}
                  onDownloadFile={(path) => void api.downloadHomeFile(path)}
                  customCommands={customCommands}
                  skills={installedSkills}
                  onRefreshSkills={refreshSkills}
                />
              )}

              {area === "code" && (
                <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "hidden" }}>
                  {/* Top Codex Workbench Header */}
                  <header className="code-workbench-header">
                    <div className="code-workbench-tabs">
                      <button
                        type="button"
                        className={`code-workbench-tab ${codeMainTab === "agent" ? "active" : ""}`}
                        onClick={() => setCodeMainTab("agent")}
                      >
                        <Code2 size={13} />
                        <span>Agent</span>
                      </button>
                      <button
                        type="button"
                        className={`code-workbench-tab ${codeMainTab === "editor" ? "active" : ""}`}
                        onClick={() => setCodeMainTab("editor")}
                      >
                        <FileCode2 size={13} />
                        <span>Editor</span>
                        {openFiles.length > 0 && <span className="code-workbench-badge">{openFiles.length}</span>}
                      </button>
                      <button
                        type="button"
                        className={`code-workbench-tab ${codeMainTab === "diff" ? "active" : ""}`}
                        onClick={() => setCodeMainTab("diff")}
                      >
                        <GitBranch size={13} />
                        <span>Diff</span>
                        {diff.length > 0 && <span className="code-workbench-badge">{diff.length}</span>}
                      </button>
                      <button
                        type="button"
                        className={`code-workbench-tab ${codeMainTab === "terminal" ? "active" : ""}`}
                        onClick={() => setCodeMainTab("terminal")}
                      >
                        <Terminal size={13} />
                        <span>Terminal</span>
                      </button>
                      <button
                        type="button"
                        className={`code-workbench-tab ${codeMainTab === "browser" ? "active" : ""}`}
                        onClick={() => setCodeMainTab("browser")}
                      >
                        <Search size={13} />
                        <span>Browser</span>
                      </button>
                      <button
                        type="button"
                        className={`code-workbench-tab ${codeMainTab === "memory" ? "active" : ""}`}
                        onClick={() => setCodeMainTab("memory")}
                      >
                        <Brain size={13} />
                        <span>Memory</span>
                      </button>
                    </div>
                  </header>

                  {/* Active Code Mode Surface */}
                  {codeMainTab === "agent" && (
                    <div className="code-agent-container" style={{ display: "flex", flex: 1, minHeight: 0, width: "100%", height: "100%", overflow: "hidden" }}>
                      <div style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, height: "100%" }}>
                        <AgentView
                          hasProject={Boolean(activeProject)}
                          activeFile={activeFile}
                          messages={currentMessages}
                          draft={draft}
                          setDraft={setDraft}
                          submit={(override) => void submit(override)}
                          running={running}
                          onStop={() => void stopAgent()}
                          streamingText={streamingText}
                          liveEvents={liveEvents}
                          mode={mode}
                          setMode={setMode}
                          selectedProviderId={selectedProviderId}
                          selectedModel={selectedModel}
                          selectedEffort={selectedEffort}
                          providers={providers}
                          definitions={providerDefinitions}
                          files={files}
                          checkpointId={activeSession?.checkpointId}
                          diffCount={diff.length}
                          diffFiles={diff}
                          undoLevels={undoLevels}
                          onUndoRun={(id) => void undoRun(id)}
                          onKeepChanges={() => void keepChanges()}
                          switchModel={(pId, m, eff) => void switchModel(pId, m, eff)}
                          switchEffort={(eff) => void switchEffort(eff)}
                          onOpenProviders={() => setShowProviders(true)}
                          onAttachFile={() => {
                            setDraft((curr) => `${curr}${curr ? "\n" : ""}@${activeFile || "current-file"}`);
                          }}
                          onAttachDiff={() => {
                            setDraft((curr) => `${curr}${curr ? "\n" : ""}Review the current Git diff`);
                          }}
                          sessionUsage={currentSessionUsage}
                          contextUsage={currentSessionContextUsage}
                          activeSessionId={activeSession?.id}
                          attachedImages={attachedImages}
                          setAttachedImages={setAttachedImages}
                          attachments={attachments}
                          setAttachments={setAttachments}
                          onOpenImage={openImagePreview}
                          onOpenAttachment={(a) => setAttachmentPreview(a)}
                          onOpenArtifact={(art) => {
                            setCodeSelectedArtifact(art.path || art.filename || art.name);
                            setCodeRightSidebarTab("artifact");
                          }}
                          customCommands={customCommands}
                          skills={installedSkills}
                          onRefreshSkills={refreshSkills}
                          onTruncateSession={(idx: number) => truncateSession(idx)}
                          onForkSession={(idx: number) => forkSession(idx)}
                        />
                      </div>
                      {(codeSelectedArtifact || codeBrowserActive) && (
                        <aside
                          className="workbench-right-sidebar"
                          style={{
                            width: codeSidebarExpanded ? 780 : 480,
                            maxWidth: codeSidebarExpanded ? "75%" : "55%",
                            height: "100%",
                            borderLeft: "1px solid var(--border-default)",
                            background: "var(--bg-surface)",
                            display: "flex",
                            flexDirection: "column",
                            minWidth: 340,
                            position: "relative",
                            zIndex: 10,
                            transition: "width 0.22s cubic-bezier(0.16, 1, 0.3, 1), max-width 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
                          }}
                        >
                          {codeSelectedArtifact && codeBrowserActive && (
                            <div className="sidebar-tab-strip">
                              <button
                                type="button"
                                className={`sidebar-tab ${codeRightSidebarTab === "artifact" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("artifact")}
                                title={codeSelectedArtifact}
                              >
                                <FileText size={12} />
                                <span className="sidebar-tab-text">{codeSelectedArtifact.split("/").pop() || "Artifact"}</span>
                              </button>
                              <button
                                type="button"
                                className={`sidebar-tab ${codeRightSidebarTab === "browser" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("browser")}
                                title="Agent Browser"
                              >
                                <Globe size={12} />
                                <span className="sidebar-tab-text">Browser</span>
                              </button>
                              <div style={{ flex: 1 }} />
                              <button
                                type="button"
                                className="sidebar-tab-close"
                                onClick={() => {
                                  if (codeRightSidebarTab === "artifact") {
                                    setCodeSelectedArtifact(null);
                                    setCodeRightSidebarTab("browser");
                                  } else {
                                    setCodeBrowserActive(false);
                                    setCodeRightSidebarTab("artifact");
                                  }
                                }}
                                title="Close active tab"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          )}

                          {codeRightSidebarTab === "artifact" && codeSelectedArtifact && (
                            <div style={{ display: "flex", flex: 1, minHeight: 0, width: "100%", height: "100%" }}>
                              <HomeCanvasDrawer
                                filePath={codeSelectedArtifact}
                                scope="code"
                                width="100%"
                                isExpanded={codeSidebarExpanded}
                                onToggleExpand={() => setCodeSidebarExpanded((p) => !p)}
                                refreshToken={running ? "running" : `${currentMessages.length}`}
                                onClose={() => {
                                  setCodeSelectedArtifact(null);
                                  if (codeBrowserActive) setCodeRightSidebarTab("browser");
                                }}
                                onDownload={(path: string) => {
                                  void (api.downloadWorkspaceFile ? api.downloadWorkspaceFile(path) : api.downloadHomeFile(path));
                                }}
                                onRefine={(prompt: string) => void submit(prompt)}
                              />
                            </div>
                          )}

                          {codeRightSidebarTab === "browser" && codeBrowserActive && (
                            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, width: "100%", height: "100%", position: "relative" }}>
                              {!codeSelectedArtifact && (
                                <div className="sidebar-single-header">
                                  <div className="sidebar-single-title">
                                    <Globe size={13} style={{ color: "#38bdf8" }} />
                                    <span>Agent Browser</span>
                                  </div>
                                  <button
                                    type="button"
                                    className="icon-plain"
                                    onClick={() => setCodeBrowserActive(false)}
                                    title="Close Browser Sidebar"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              )}
                              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                                <SidebarBrowser
                                  sessionId={activeSession?.id}
                                  browserScope="code"
                                  initialUrl={codeBrowserLatestUrl || undefined}
                                  projectRoot={activeProject?.root}
                                  files={files}
                                  onSendToAgent={(prompt) => void submit(prompt)}
                                />
                              </div>
                            </div>
                          )}
                        </aside>
                      )}
                    </div>
                  )}

                  {codeMainTab === "editor" && (
                    <MonacoEditorView
                      activeFile={activeFile}
                      openFiles={openFiles}
                      setActiveFile={setActiveFile}
                      setOpenFiles={setOpenFiles}
                      content={fileContent}
                      setContent={setFileContent}
                      dirty={dirty}
                      save={() => void saveFile()}
                    />
                  )}

                  {codeMainTab === "diff" && (
                    <DiffView
                      diff={diff}
                      checkpointId={activeSession?.checkpointId}
                      undoing={undoing}
                      onUndoRun={(id) => void undoRun(id)}
                      onRefresh={() => void refreshDiff()}
                      onRevertFile={(path) => void revertSingleFile(path)}
                      onRevertAll={() => void revertAllChanges()}
                      onInspectFile={(file) => setInspectDiffFile(file)}
                      onRevertHunk={(path, hunkHeader) => void revertSingleHunk(path, hunkHeader)}
                    />
                  )}

                  {codeMainTab === "terminal" && (
                    <XTermView
                      projectRoot={activeProject?.root}
                      files={files}
                    />
                  )}

                  {codeMainTab === "browser" && (
                    <SidebarBrowser
                      sessionId={activeSession?.id}
                      browserScope="code"
                      projectRoot={activeProject?.root}
                      files={files}
                      onSendToAgent={(prompt) => {
                        setCodeMainTab("agent");
                        void submit(prompt);
                      }}
                    />
                  )}

                  {codeMainTab === "memory" && (
                    <MemoryView
                      project={activeProject}
                      session={activeSession}
                      onRemoveFact={(fact) => void removeProjectFact(fact)}
                      onClearSessionMemory={() => void clearSessionMemory()}
                    />
                  )}
                </div>
              )}

              {area === "notebook" && (
                <NotebookView
                  notebooks={notebook.notebooks}
                  sourceCounts={notebook.sourceCounts}
                  activeNotebook={notebook.activeNotebook}
                  setActiveNotebook={(nb) => notebook.enterNotebook(nb)}
                  sources={notebook.sources}
                  activeChat={notebook.activeChat}
                  stats={notebook.stats}
                  draft={notebook.draft}
                  setDraft={notebook.setDraft}
                  asking={notebook.asking}
                  notice={notebook.notice}
                  excludedIds={notebook.excludedIds}
                  scopedIds={notebook.scopedIds}
                  streaming={notebook.activeChat ? notebook.streamByChat[notebook.activeChat.id] || "" : ""}
                  workingSteps={notebook.activeChat ? notebook.stepsByChat[notebook.activeChat.id] || [] : []}
                  agentThinking={notebook.activeChat ? notebook.thinkingByChat[notebook.activeChat.id] || "" : ""}
                  passage={notebook.passage}
                  settings={notebook.settings}
                  notes={notebook.notes}
                  documents={notebook.documents}
                  quizzes={notebook.quizzes}
                  flashcards={notebook.flashcards}
                  mindmaps={notebook.mindmaps}
                  generatingDoc={notebook.generatingDoc}
                  generatingQuiz={notebook.generatingQuiz}
                  generatingFlashcards={notebook.generatingFlashcards}
                  generatingMindmap={notebook.generatingMindmap}
                  docSteps={notebook.activeNotebook ? notebook.stepsByChat[`nbdoc:${notebook.activeNotebook.id}`] || [] : []}
                  quizSteps={notebook.activeNotebook ? notebook.stepsByChat[`nbquiz:${notebook.activeNotebook.id}`] || [] : []}
                  fichesSteps={notebook.activeNotebook ? notebook.stepsByChat[`nbfiches:${notebook.activeNotebook.id}`] || [] : []}
                  mapSteps={notebook.activeNotebook ? notebook.stepsByChat[`nbmap:${notebook.activeNotebook.id}`] || [] : []}
                  onGenerateDocument={(kind, format, prompt) => void notebook.generateDocument(kind, format, prompt, selectedProviderId, selectedModel)}
                  onCancelGeneration={(kind) => void notebook.stopGeneration(kind)}
                  onGenerateQuiz={(topic, count, quizType) => void notebook.generateQuiz(topic, count, quizType, selectedProviderId, selectedModel)}
                  onDeleteQuiz={(quiz) => setConfirmDialog({
                    title: `Delete quiz "${quiz.title}"?`,
                    message: "This permanently deletes the quiz. It can't be undone.",
                    confirmLabel: "Delete quiz",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeQuiz(quiz.id);
                    },
                  })}
                  onGenerateFlashcards={(topic, count) => void notebook.generateFlashcards(topic, count, selectedProviderId, selectedModel)}
                  onDeleteFlashcards={(set) => setConfirmDialog({
                    title: `Delete flashcards "${set.title}"?`,
                    message: "This permanently deletes the card set. It can't be undone.",
                    confirmLabel: "Delete flashcards",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeFlashcards(set.id);
                    },
                  })}
                  onGenerateMindmap={(topic) => void notebook.generateMindmap(topic, selectedProviderId, selectedModel)}
                  onDeleteMindmap={(map) => setConfirmDialog({
                    title: `Delete mind map "${map.title}"?`,
                    message: "This permanently deletes the mind map. It can't be undone.",
                    confirmLabel: "Delete mind map",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeMindmap(map.id);
                    },
                  })}
                  summaries={notebook.summaries}
                  generatingSummary={notebook.generatingSummary}
                  summarySteps={notebook.activeNotebook ? notebook.stepsByChat[`nbsum:${notebook.activeNotebook.id}`] || [] : []}
                  onGenerateSummary={(topic, length) => void notebook.generateSummary(topic, length, selectedProviderId, selectedModel)}
                  onDeleteSummary={(summary) => setConfirmDialog({
                    title: `Delete summary "${summary.title}"?`,
                    message: "This permanently deletes the summary. It can't be undone.",
                    confirmLabel: "Delete summary",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeSummary(summary.id);
                    },
                  })}
                  audioOverviews={notebook.audioOverviews}
                  generatingAudio={notebook.generatingAudio}
                  onGenerateAudio={(topic) => void notebook.generateAudioOverview(topic, selectedProviderId, selectedModel)}
                  onDeleteAudio={(audio) => setConfirmDialog({
                    title: `Delete audio overview "${audio.title}"?`,
                    message: "This permanently deletes the audio overview script. It can't be undone.",
                    confirmLabel: "Delete audio overview",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeAudioOverview(audio.id);
                    },
                  })}
                  onDownloadDocument={(id) => void notebook.downloadDocument(id)}
                  onDeleteDocument={(doc) => setConfirmDialog({
                    title: `Delete document "${doc.title}"?`,
                    message: "This permanently deletes the document — the generated file on disk is removed too.",
                    confirmLabel: "Delete document",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeDocument(doc.id);
                    },
                  })}
                  onCreateNotebook={(name) => void notebook.createNotebook(name)}
                  onDeleteNotebook={(nb) => setConfirmDialog({
                    title: `Delete session "${nb.name}"?`,
                    message: "This permanently deletes the session with all its sources, index, chats, notes, and generated outputs.",
                    confirmLabel: "Delete session",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeNotebook(nb.id);
                    },
                  })}
                  onPickFiles={() => void notebook.uploadFromPicker()}
                  onImportYouTube={(url) => void notebook.importYouTube(url)}
                  onImportWebsite={(url) => void notebook.importWebsite(url)}
                  onBrowserFiles={(browserFiles) => void notebook.uploadBrowserFiles(browserFiles)}
                  importingLink={notebook.importingLink}
                  isUploading={notebook.isUploading}
                  ingestDetail={notebook.ingestDetail}
                  onRefresh={() => {
                    if (notebook.activeNotebook) void notebook.refreshNotebookDetail(notebook.activeNotebook.id);
                  }}
                  onToggleScope={(id) => notebook.toggleScope(id)}
                  onSetScopeExcluded={(ids) => notebook.setScopeExcluded(ids)}
                  onResetScope={() => notebook.resetScope()}
                  onOpenPassage={(chunkId) => void notebook.openPassage(chunkId)}
                  onClosePassage={() => notebook.closePassage()}
                  onPassageAction={(action, passage) => {
                    const citation = {
                      index: 1,
                      sourceId: passage.sourceId,
                      sourceName: passage.sourceName,
                      chunkId: passage.chunkId,
                      heading: passage.headingPath.join(" › ") || passage.sourceName,
                      excerpt: passage.text.slice(0, 400),
                      snippet: passage.text.replace(/\s+/g, " ").slice(0, 200),
                      score: 1,
                    };
                    if (action === "save") {
                      void notebook.saveNote({ title: passage.headingPath.at(-1) || passage.sourceName, content: passage.text, citations: [citation] });
                      return;
                    }
                    const prompts = {
                      explain: "Explain this passage clearly, define the important terms, and stay grounded in my notebook sources.",
                      simplify: "Rewrite this passage in simpler language without losing important meaning.",
                      compare: "Compare this passage with the other relevant sources in my notebook. Point out agreements, differences, and uncertainty.",
                      quiz: "Create a short quiz about this passage. Ask me one question at a time and wait for my answer.",
                    } as const;
                    notebook.closePassage();
                    void notebook.ask(selectedProviderId, selectedModel, "8", `${prompts[action]}\n\nPassage from ${passage.sourceName} (${passage.headingPath.join(" › ")}):\n${passage.text}`);
                  }}
                  onSaveInstructions={(value) => void notebook.saveInstructions(value)}
                  onSaveNote={(note) => void notebook.saveNote(note)}
                  onDeleteNote={(note) => setConfirmDialog({
                    title: `Delete note "${note.title}"?`,
                    message: "This permanently deletes the note. It can't be undone.",
                    confirmLabel: "Delete note",
                    danger: true,
                    onConfirm: () => {
                      setConfirmDialog(null);
                      void notebook.removeNote(note.id);
                    },
                  })}
                  onRename={(name) => void notebook.renameCurrentNotebook(name)}
                  onReindexAll={() => void notebook.reindexAll()}
                  onDeleteSource={(source) => setConfirmDialog({
                    title: `Delete source "${source.filename}"?`,
                    message: "This removes the file and all its derived index data. Re-upload it to restore.",
                    confirmLabel: "Delete source",
                    danger: true,
                    onConfirm: async () => {
                      setConfirmDialog(null);
                      if (!notebook.activeNotebook) return;
                      try {
                        await (api as unknown as { notebookDeleteSource: (a: string, b: string) => Promise<unknown> }).notebookDeleteSource(notebook.activeNotebook.id, source.id);
                        await notebook.refreshNotebookDetail(notebook.activeNotebook.id);
                      } catch (error) {
                        notebook.setNotice(error instanceof Error ? error.message : "Delete failed.");
                      }
                    },
                  })}
                  onReindexSource={async (sourceId) => {
                    if (!notebook.activeNotebook) return;
                    try {
                      notebook.setNotice("Re-indexing source…");
                      await (api as unknown as { notebookReindexSource: (a: string, b: string) => Promise<unknown> }).notebookReindexSource(notebook.activeNotebook.id, sourceId);
                      await notebook.refreshNotebookDetail(notebook.activeNotebook.id);
                      notebook.setNotice("Source re-indexed.");
                    } catch (error) {
                      notebook.setNotice(error instanceof Error ? error.message : "Re-index failed.");
                    }
                  }}
                  onAsk={() => void notebook.ask(selectedProviderId, selectedModel, selectedEffort)}
                  onStop={() => void notebook.stopAsk()}
                  onExitToSessions={() => notebook.exitToSessions()}
                  onHandoffToCode={(prompt) => {
                    void enterCode();
                    setDraft(prompt);
                  }}
                  onHandoffToHome={(prompt) => {
                    void enterHome();
                    home.setDraft(prompt);
                  }}
                  selectedProviderId={selectedProviderId}
                  selectedModel={selectedModel}
                  selectedEffort={selectedEffort}
                  providers={providers}
                  definitions={providerDefinitions}
                  switchModel={(pId, m, eff) => void switchModel(pId, m, eff)}
                  onOpenProviders={() => setShowProviders(true)}
                  hasProvider={providers.length > 0}
                  customCommands={customCommands}
                />
              )}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      {/* Global Modals & Palettes */}
      {showCommandPalette && (
        <CommandPalette
          open={showCommandPalette}
          onClose={() => setShowCommandPalette(false)}
          mainArea={area}
          onSwitchArea={(targetArea) => {
            if (targetArea === "home") void enterHome();
            else if (targetArea === "code") void enterCode();
            else if (targetArea === "notebook") enterNotebook();
          }}
          onNewHomeChat={() => void home.createChat()}
          onNewCodeSession={() => void createSession()}
          onNewNotebook={() => void notebook.createNotebook("New notebook")}
          onOpenProject={() => void openProjectFromDialog()}
          onToggleLeftSidebar={() => setSidebarCollapsed((v) => !v)}
          onToggleRightDrawer={() => {}}
          onOpenContextTab={() => {}}
          onOpenSettingsSection={(sec) => openSettingsSection(sec)}
          sessions={sessions}
          homeSessions={home.sessions}
          notebooks={notebook.notebooks}
          onSelectCodeSession={(id) => void activateSession(id)}
          onSelectHomeSession={(id) => void home.selectChat(id)}
          onSelectNotebook={(id) => {
            const match = notebook.notebooks.find((n) => n.id === id);
            if (match) notebook.enterNotebook(match);
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          area={area}
          hasProject={Boolean(activeProject)}
          skillsEnabled={skillsEnabled}
          onToggleSkills={async (enabled) => {
            setSkillsEnabled(enabled);
            await api.saveSkillsConfig({ enabled });
          }}
          rulesEnabled={rulesEnabled}
          onToggleRules={async (enabled) => {
            setRulesEnabled(enabled);
            await api.saveRulesConfig({ enabled });
          }}
          providers={providers}
          providerDefinitions={providerDefinitions}
          onProvidersChange={handleProvidersChange}
          onManageServices={() => {
            setShowSettings(false);
            setShowDaemonsModal(true);
          }}
          updater={updater}
          appVersion={appVersion}
          onCheckUpdates={() => void api.checkForUpdates()}
          onQuitAndInstall={() => void api.quitAndInstallUpdate()}
          onClose={() => setShowSettings(false)}
          initialSection={settingsInitialSection}
        />
      )}

      {showProviders && (
        <ProviderModal
          providers={providers}
          definitions={providerDefinitions}
          onProvidersChange={handleProvidersChange}
          onClose={() => setShowProviders(false)}
        />
      )}

      {showMcp && (
        <McpModal
          onClose={() => setShowMcp(false)}
        />
      )}

      {showSkills && (
        <SkillsModal
          hasProject={Boolean(activeProject)}
          enabled={skillsEnabled}
          onToggle={async (enabled) => {
            setSkillsEnabled(enabled);
            await api.saveSkillsConfig({ enabled });
          }}
          onClose={() => setShowSkills(false)}
        />
      )}

      {showDaemonsModal && (
        <DaemonsModal
          onClose={() => setShowDaemonsModal(false)}
        />
      )}

      {showRulesModal && (
        <ProjectRulesModal
          ruleFiles={projectRules?.ruleFiles || []}
          onClose={() => setShowRulesModal(false)}
        />
      )}

      {/* Human in the loop approval request modal */}
      {approvalRequest && (
        <div className="modal-overlay" onClick={() => void answerApproval("deny")}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <TriangleAlert size={18} style={{ color: "var(--warning)" }} />
                <span>Command Approval Request</span>
              </div>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p>{approvalRequest.reason}</p>
              <pre><code>{approvalRequest.command}</code></pre>
              <small style={{ color: "var(--text-tertiary)" }}>Working directory: {approvalRequest.cwd}</small>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => void answerApproval("deny")}>Deny</button>
              <button className="btn btn-secondary" onClick={() => void answerApproval("session")}>Allow for run</button>
              <button className="btn btn-primary" onClick={() => void answerApproval("once")}>Allow once</button>
            </div>
          </div>
        </div>
      )}

      {/* Agent question modal */}
      {userQuestion && (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Agent Question</div>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {userQuestion.questions.map((q) => (
                <div key={q.header} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <strong>{q.header}</strong>
                  <p>{q.question}</p>
                  {q.options.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          className={`btn btn-sm ${questionAnswers[q.header] === opt ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setQuestionAnswers((curr) => ({ ...curr, [q.header]: opt }))}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const id = userQuestion.id;
                  setUserQuestion(null);
                  void (api as unknown as { resolveUserQuestion: (id: string, a: null, c: boolean) => Promise<unknown> }).resolveUserQuestion(id, null, true);
                }}
              >
                Skip
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const id = userQuestion.id;
                  const answers = { ...questionAnswers };
                  setUserQuestion(null);
                  void (api as unknown as { resolveUserQuestion: (id: string, a: Record<string, string>) => Promise<unknown> }).resolveUserQuestion(id, answers);
                }}
              >
                Send answers
              </button>
            </div>
          </div>
        </div>
      )}

      {attachmentPreview && (
        <Suspense fallback={null}>
          <AttachmentPreviewModal
            attachment={attachmentPreview}
            onClose={() => setAttachmentPreview(null)}
          />
        </Suspense>
      )}

      {confirmDialog && (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={() => {
            confirmDialog.onConfirm();
            setConfirmDialog(null);
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    

      {/* Top Window Drag Strip & Controls (rendered last so controls always receive clicks) */}
      <div className="window-drag-region">
        <div className="window-drag-band" />
        {updater.status === "downloaded" && (
          <button
            type="button"
            className="badge badge-success"
            style={{ marginRight: 12, cursor: "pointer" }}
            onClick={() => void api.quitAndInstallUpdate()}
          >
            <Download size={11} /> Restart to update
          </button>
        )}
        <WindowControls />
      </div>

      {/* Background Agent Webviews Host for real in-browser navigation & inspection */}
      <AgentBrowserHost />
    </div>
  );
}

export default App;
