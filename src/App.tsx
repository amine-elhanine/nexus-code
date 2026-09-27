import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain, BookOpen, Check, ChevronDown, ChevronRight, Code2, Coins, Download, FileCode2, FileText,
  FolderOpen, GitBranch, Globe, Home, Info, Loader2, Menu, Sparkles, X,
  MessageSquare, PanelRight, Pencil, Plus, RefreshCw, Undo2,
  Settings2, Terminal, Trash2, TriangleAlert, Activity
} from "lucide-react";
import { WindowControls } from "./components/common/WindowControls.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { ProviderModal } from "./modals/ProviderModal.js";
import { McpModal } from "./modals/McpModal.js";
import { SkillsModal } from "./modals/SkillsModal.js";
import { SettingsModal } from "./modals/SettingsModal.js";
import { DaemonsModal } from "./components/daemons/DaemonsModal.js";
import { MonacoDiffModal } from "./components/diff/MonacoDiffModal.js";
import { ProjectRulesModal } from "./components/rules/ProjectRulesModal.js";
import { ArtifactViewer } from "./components/artifacts/ArtifactViewer.js";
import { FilePreviewModal } from "./components/home/FilePreviewModal.js";
import { AttachmentPreviewModal } from "./components/home/AttachmentPreviewModal.js";
import { SidebarBrowser } from "./components/browser/SidebarBrowser.js";
import { MonacoEditorView } from "./components/editor/MonacoEditorView.js";
import { XTermView } from "./components/terminal/XTermView.js";
import { AgentBrowserHost } from "./components/browser/AgentBrowserHost.js";
import { AgentView } from "./views/AgentView.js";
import { HomeView } from "./views/HomeView.js";
import { NotebookView } from "./views/NotebookView.js";
import { useNotebookController } from "./state/useNotebookController.js";
import { useHomeController } from "./state/useHomeController.js";
import { DiffView } from "./views/DiffView.js";
import { MemoryView, ContextRow, MemoryRow } from "./views/MemoryView.js";
import { useAppController, sortSessionsByUpdatedAt } from "./state/useAppController.js";
import { applyTheme } from "./state/theme.js";
import { getSessionUsage, fileIcon } from "./utils/format.js";
import { timeLabel } from "./utils/format.js";
import type { ChatAttachment, UpdaterState } from "./types.js";
import { formatCost, type FileEntry } from "./types.js";

function FileRow({
  entry,
  active,
  expanded,
  onClick,
}: {
  entry: FileEntry;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const nested = entry.path.includes("/");
  return (
    <button className={`tree-row ${active ? "active" : ""} ${nested ? "nested" : ""}`} onClick={onClick}>
      {entry.kind === "folder" ? (
        <>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FolderOpen size={14} />
        </>
      ) : (
        <>
          {!nested && <span className="indent" />}
          {fileIcon(entry.path)}
        </>
      )}
      <span>{entry.path.split("/").pop()}</span>
    </button>
  );
}

function SessionRow({
  session,
  active,
  editing,
  draftTitle,
  onActivate,
  onStartEdit,
  onDraftChange,
  onCommit,
  onCancel,
  onDelete,
}: {
  session: { id: string; title: string; messages: unknown[] };
  active: boolean;
  editing: boolean;
  draftTitle: string;
  onActivate: () => void;
  onStartEdit: () => void;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const userCount = session.messages.filter((m) => (m as { role?: string }).role === "user").length;
  if (editing) {
    return (
      <div className={`session-row ${active ? "active" : ""} editing`}>
        <MessageSquare size={13} />
        <input
          className="session-rename-input"
          value={draftTitle}
          autoFocus
          maxLength={80}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit();
            else if (event.key === "Escape") onCancel();
          }}
          onBlur={onCommit}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => event.target.select()}
        />
      </div>
    );
  }
  return (
    <button
      className={`session-row ${active ? "active" : ""}`}
      onClick={onActivate}
      onDoubleClick={onStartEdit}
      title="Double-click to rename"
    >
      <MessageSquare size={13} />
      <span>{session.title}</span>
      <small title={`${userCount} message${userCount === 1 ? "" : "s"} from you`}>{userCount}</small>
      <i
        className="row-edit"
        title="Rename session"
        onClick={(event) => {
          event.stopPropagation();
          onStartEdit();
        }}
      >
        <Pencil size={12} />
      </i>
      <i
        className="row-delete"
        title="Delete session"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={12} />
      </i>
    </button>
  );
}

type HomeMemoryStructureProp = {
  profile: string[];
  preferences: string[];
  facts: string[];
  context: string[];
  recentDeliverables: Array<{ date: string; summary: string; sessionId?: string }>;
  customNotes?: string;
};

function MemoryFactList({
  items,
  category,
  onRemove,
  emptyText,
}: {
  items: string[];
  category: string;
  onRemove: (category: string, fact: string) => void;
  emptyText: string;
}) {
  if (!items.length) return <div className="empty-pane" style={{ padding: "6px" }}>{emptyText}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((fact) => (
        <div key={fact} className="home-file-row" title={fact}>
          <Brain size={13} style={{ flex: "none", color: "var(--nexus-green)" }} />
          <div className="home-file-info">
            <span className="home-file-name" style={{ whiteSpace: "normal" }}>{fact}</span>
            <small>{category}</small>
          </div>
          <button className="pane-action" onClick={() => onRemove(category, fact)} title={`Forget "${fact}"`}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function HomeMemoryPanel({
  structure,
  sessionMemory,
  sessionTitle,
  onRemoveFact,
  onClearSession,
  onOpenChat,
}: {
  structure: HomeMemoryStructureProp;
  sessionMemory: string;
  sessionTitle?: string;
  onRemoveFact: (category: string, fact: string) => void;
  onClearSession: () => void;
  onOpenChat?: (sessionId: string) => void;
}) {
  const durableCount = structure.profile.length + structure.preferences.length + structure.facts.length + structure.context.length;
  return (
    <div className="context-tab-body">
      <div className="context-section">
        <div className="context-section-title">
          <span>REMEMBERED ({durableCount})</span>
          <small>SHARED</small>
        </div>
        <p style={{ color: "#687588", fontSize: "11px", lineHeight: 1.5, margin: "0 0 8px" }}>
          Durable facts shared by every Home chat. The agent sees the relevant ones for each question — manage them here, or say “remember…” in chat.
        </p>
        <strong style={{ fontSize: "11px" }}>User profile</strong>
        <div style={{ height: 4 }} />
        <MemoryFactList items={structure.profile} category="profile" onRemove={onRemoveFact} emptyText="No profile facts yet." />
        <div style={{ height: 8 }} />
        <strong style={{ fontSize: "11px" }}>Preferences</strong>
        <div style={{ height: 4 }} />
        <MemoryFactList items={structure.preferences} category="preference" onRemove={onRemoveFact} emptyText="No preferences yet." />
        <div style={{ height: 8 }} />
        <strong style={{ fontSize: "11px" }}>Remembered facts</strong>
        <div style={{ height: 4 }} />
        <MemoryFactList items={structure.facts} category="fact" onRemove={onRemoveFact} emptyText="No remembered facts yet." />
        {structure.context.length > 0 && (
          <>
            <div style={{ height: 8 }} />
            <strong style={{ fontSize: "11px" }}>Project context</strong>
            <div style={{ height: 4 }} />
            <MemoryFactList items={structure.context} category="context" onRemove={onRemoveFact} emptyText="No project context." />
          </>
        )}
      </div>
      <div className="context-section">
        <div className="context-section-title">
          <span>RECENT ACTIVITY</span>
          <small>{structure.recentDeliverables.length} LAST</small>
        </div>
        {structure.recentDeliverables.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {structure.recentDeliverables.slice().reverse().map((d, i) => (
              <div
                key={`${d.date}-${i}`}
                className={`home-file-row${d.sessionId && onOpenChat ? " clickable" : ""}`}
                title={d.sessionId ? "Open the originating chat" : d.summary}
                onClick={d.sessionId && onOpenChat ? () => onOpenChat(d.sessionId!) : undefined}
              >
                <FileText size={13} style={{ flex: "none" }} />
                <div className="home-file-info">
                  <span className="home-file-name" style={{ whiteSpace: "normal" }}>{d.summary}</span>
                  <small>{d.date}</small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-pane">No recent activity yet. Substantive work lands here — chit-chat doesn't.</div>
        )}
      </div>
      <div className="context-section">
        <div className="context-section-title">
          <span>THIS CHAT</span>
          <button className="pane-action" onClick={onClearSession} title="Clear this chat's session notes (transcript is kept)">
            Clear
          </button>
        </div>
        <p style={{ color: "#687588", fontSize: "11px", lineHeight: 1.5, margin: "0 0 8px" }}>
          Short pointers for {sessionTitle ? `“${sessionTitle}”` : "this chat"} — full answers stay in the transcript, which the agent reads directly.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, padding: "8px", border: "1px solid #28374a", borderRadius: "5px", background: "#090d14", color: "#a6b2c2", font: "10px/1.5 'DM Mono', monospace" }}>
          {sessionMemory || "No session notes yet."}
        </pre>
      </div>
    </div>
  );
}

function App() {
  const {
    projects,
    activeProject,
    sessions,
    activeSession,
    providers,
    providerDefinitions,
    selectedProviderId,
    selectedModel,
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
    openFile,
    saveFile,
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
    handleProvidersChange,
    saveMemories,
    submit,
    stopAgent,
    setActiveFile,
    setOpenFiles,
  } = useAppController();

  const sortedSessions = useMemo(() => sortSessionsByUpdatedAt(sessions), [sessions]);

  const api = window.nexus || window.forgepilot;
  const home = useHomeController(area === "home");
  const notebook = useNotebookController(area === "notebook");
  const headerTitle = area === "notebook"
    ? (notebook.activeNotebook ? notebook.activeNotebook.name : "Notebook sessions")
    : area === "home"
    ? (home.activeSession?.title || "Home")
    : (activeSession?.title || "No session selected");
  const currentSessionUsage = getSessionUsage(activeSession);
  const [homePreviewPath, setHomePreviewPath] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<ChatAttachment | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  function startSessionRename(session: { id: string; title: string }) {
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  }
  function commitSessionRename() {
    if (editingSessionId && editingSessionTitle.trim()) {
      void renameSession(editingSessionId, editingSessionTitle);
    }
    setEditingSessionId(null);
    setEditingSessionTitle("");
  }
  function cancelSessionRename() {
    setEditingSessionId(null);
    setEditingSessionTitle("");
  }
  function openImagePreview(src: string) {
    const match = attachments.find((a) => a.url === src);
    if (match) setAttachmentPreview(match);
    else setAttachmentPreview({ url: src, name: src.split("/").pop() || "image", mimeType: "image/png", size: 0 });
  }
  const [showSettings, setShowSettings] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showProjectDropdown) return;
    function handleClickOutside(event: MouseEvent) {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(event.target as Node)) {
        setShowProjectDropdown(false);
      }
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setShowProjectDropdown(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showProjectDropdown]);

  const [homeSideTab, setHomeSideTab] = useState<"session" | "artifacts" | "browser" | "memory">("session");
  const [codeSideTab, setCodeSideTab] = useState<"session" | "files" | "browser" | "terminal" | "diff" | "memory">("session");
  const [updater, setUpdater] = useState<UpdaterState>({ status: "idle" });
  const [appVersion, setAppVersion] = useState("");
  const [approvalRequest, setApprovalRequest] = useState<{ id: string; runId?: string; command: string; cwd: string; reason: string; approvalKey?: string } | null>(null);
  const [userQuestion, setUserQuestion] = useState<{ id: string; sessionId: string; questions: Array<{ header: string; question: string; options: string[] }> } | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getAppVersion().then(setAppVersion).catch(() => {});
    // Pick up whatever the main process already knows (e.g. a download that
    // finished before this view subscribed) so the install button can't get
    // stuck hidden on "idle".
    void api.getUpdaterState?.().then((state) => {
      if (state && typeof state === "object" && "status" in state) setUpdater(state as UpdaterState);
    }).catch(() => {});
    return api.onUpdaterStatus((state) => setUpdater(state as UpdaterState));
  }, []);
  useEffect(() => api.onCommandApprovalRequest((request) => setApprovalRequest(request)), [api]);
  useEffect(() => {
    const off = (api as unknown as { onUserQuestionRequest?: (l: (r: { id: string; sessionId: string; questions: Array<{ header: string; question: string; options: string[] }> }) => void) => () => void }).onUserQuestionRequest?.((request) => {
      setQuestionAnswers({});
      setUserQuestion(request);
    });
    return off;
  }, [api]);

  useEffect(() => {
    const typed = api as unknown as { getAppSettings?: () => Promise<{ theme?: string }> };
    typed.getAppSettings?.().then((value) => {
      if (value && typeof value.theme === "string" && value.theme) {
        applyTheme(value.theme);
      }
    }).catch(() => {});
  }, [api]);

  async function answerApproval(decision: "once" | "session" | "deny") {
    const request = approvalRequest;
    if (!request) return;
    setApprovalRequest(null);
    await api.resolveCommandApproval(request.id, decision).catch(() => {});
  }
  const [contextWidth, setContextWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("nexus-context-width"));
      return saved >= 220 && saved <= 600 ? saved : 300;
    } catch {
      return 300;
    }
  });

  function startContextResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = contextWidth;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = Math.min(600, Math.max(220, startW + (startX - ev.clientX)));
      setContextWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("nexus-context-width", String(Math.round(latest)));
      } catch { /* private mode — width just won't persist */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function formatHomeSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="product-shell">
      <header className="product-topbar">
        <div className="product-left">
          <button className="icon-plain" onClick={() => setShowSessions((v) => !v)} title="Toggle project and session navigation">
            <Menu size={15} />
          </button>
          <div className="product-logo">
            <span className="nexus-title">nexus<span className="nexus-cursor">_</span></span>
          </div>
          <div className="top-separator" />
          <div className="area-tabs">
            <button className={area === "home" ? "active" : ""} onClick={() => void enterHome()} title="General assistant">
              <Home size={13} /> Home
            </button>
            <button className={area === "code" ? "active" : ""} onClick={() => void enterCode()} title="Coding agent">
              <Code2 size={13} /> Code
            </button>
            <button className={area === "notebook" ? "active" : ""} onClick={() => enterNotebook()} title="NotebookLM-style grounded Q&A over your documents">
              <BookOpen size={13} /> Notebook
            </button>
          </div>
          {area === "code" && (
            <>
              <div className="top-separator" />
              <div className="project-selector-wrap" ref={projectDropdownRef}>
                <button
                  className={`project-menu${showProjectDropdown ? " active" : ""}`}
                  onClick={() => setShowProjectDropdown((v) => !v)}
                  title="Select or switch project"
                >
                  <FolderOpen size={13} />
                  <strong>{activeProject?.name || "Projects"}</strong>
                  <ChevronDown
                    size={12}
                    style={{
                      transition: "transform 0.15s ease",
                      transform: showProjectDropdown ? "rotate(180deg)" : "none",
                    }}
                  />
                </button>
                {showProjectDropdown && (
                  <div className="project-dropdown-menu">
                    <div className="project-dropdown-head">
                      <span>PROJECTS</span>
                      <span className="notebook-head-count-pill">
                        {projects.length}
                      </span>
                    </div>
                    {projects
                      .map((p) => (
                        <button
                          key={p.id}
                          className={`project-dropdown-item${p.id === activeProject?.id ? " active" : ""}`}
                          onClick={() => {
                            setShowProjectDropdown(false);
                            void activateProject(p.id);
                          }}
                        >
                          <span
                            className="project-dot"
                            style={
                              p.id === activeProject?.id
                                ? { background: "var(--nexus-green)", boxShadow: "0 0 8px var(--nexus-green)" }
                                : undefined
                            }
                          />
                          <span className="project-dropdown-name">{p.name}</span>
                          <span className="project-dropdown-count">{p.sessions.length}</span>
                          {p.id === activeProject?.id && (
                            <Check size={12} style={{ color: "var(--nexus-bright)", flex: "none", marginLeft: "auto" }} />
                          )}
                        </button>
                      ))}
                    {!projects.length && (
                      <div className="empty-pane" style={{ padding: "8px 6px" }}>
                        No projects yet.
                      </div>
                    )}
                    <div className="project-dropdown-divider" />
                    <button
                      className="project-dropdown-add"
                      onClick={() => {
                        setShowProjectDropdown(false);
                        void openProjectFromDialog();
                      }}
                    >
                      <Plus size={12} />
                      <span>Open project folder…</span>
                    </button>
                  </div>
                )}
              </div>
              <span className="branch">
                <GitBranch size={11} /> {gitBranch}
              </span>
            </>
          )}
        </div>

        <div className="session-top-title">
          <span className="green-dot" />
          <span>{headerTitle}</span>
        </div>

        <div className="product-right">
          {area === "code" && (
            <button className="top-link" onClick={() => setShowDaemonsModal(true)} title="Manage long-running background processes and dev servers">
              <Terminal size={13} /> Services
            </button>
          )}
          <button className="icon-plain" onClick={() => setShowSettings(true)} title="Settings">
            <Settings2 size={15} />
          </button>
          {(updater.status === "available" || updater.status === "downloading") && (
            <span
              className="update-pill"
              title={updater.status === "downloading" ? `Downloading update… ${updater.percent}%` : `Version ${updater.version} is downloading in the background`}
            >
              <RefreshCw size={11} className={updater.status === "downloading" ? "spin" : ""} />
              {updater.status === "downloading" ? `${updater.percent}%` : `v${updater.version}`}
            </span>
          )}
          {updater.status === "downloaded" && (
            <button
              className="update-pill ready"
              onClick={() => void api.quitAndInstallUpdate()}
              title={`Restart to install version ${updater.version}`}
            >
              <Download size={11} /> Restart to update
            </button>
          )}
          {updater.status === "error" && (
            <button
              className="update-pill error"
              onClick={() => void api.checkForUpdates()}
              title={`Update check failed: ${updater.message} — click to retry`}
            >
              <TriangleAlert size={11} /> Update failed — retry
            </button>
          )}
          <span className="user-chip">ME</span>
          <div className="top-separator window-ctrl-sep" />
          <WindowControls />
        </div>
      </header>

      <div className="product-body">
        {showSessions && area === "home" && (
          <aside className="session-pane">
            <div className="pane-top">
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="context-kicker">CHATS</span>
                <span className="notebook-head-count-pill">{home.sessions.length}</span>
              </div>
              <button className="pane-action" onClick={() => void home.createChat()} title="New chat"><Plus size={14} /></button>
            </div>
            <div className="session-list">
              {home.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === home.activeSession?.id}
                  editing={session.id === home.editingSessionId}
                  draftTitle={home.editingSessionTitle}
                  onActivate={() => void home.selectChat(session.id)}
                  onStartEdit={() => home.startRename(session)}
                  onDraftChange={home.setEditingSessionTitle}
                  onCommit={home.commitRename}
                  onCancel={home.cancelRename}
                  onDelete={() => void home.deleteChat(session.id)}
                />
              ))}
              {!home.sessions.length && <div className="empty-pane">Start a new chat to begin.</div>}
            </div>
          </aside>
        )}
        {showSessions && area === "code" && (
          <aside className="session-pane">
            <div className="pane-top">
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="context-kicker">PROJECTS</span>
                <span className="notebook-head-count-pill">{projects.length}</span>
              </div>
              <button className="pane-action" onClick={() => void openProjectFromDialog()} title="New project"><Plus size={14} /></button>
            </div>
            <div className="project-list">
              {projects.map((project) => (
                <button
                  key={project.id}
                  className={`project-row ${project.id === activeProject?.id ? "active" : ""}`}
                  onClick={() => void activateProject(project.id)}
                >
                  <span className="project-dot" />
                  <span>{project.name}</span>
                  <small>{project.sessions.length}</small>
                  <i
                    className="row-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteProjectById(project.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </i>
                </button>
              ))}
              {!projects.length && <div className="empty-pane">Create a project to start.</div>}
            </div>
            {activeProject && (
              <>
                <div className="pane-top sessions-label" style={{ marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="context-kicker">SESSIONS</span>
                    <span className="notebook-head-count-pill">{sortedSessions.length}</span>
                  </div>
                  <button className="pane-action" onClick={() => void createSession()} title="New coding session (⌘ N)"><Plus size={14} /></button>
                </div>
                <div className="session-list">
                  {sortedSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === activeSession?.id}
                      editing={session.id === editingSessionId}
                      draftTitle={editingSessionTitle}
                      onActivate={() => void activateSession(session.id)}
                      onStartEdit={() => startSessionRename(session)}
                      onDraftChange={setEditingSessionTitle}
                      onCommit={commitSessionRename}
                      onCancel={cancelSessionRename}
                      onDelete={() => void deleteActiveSession(session.id)}
                    />
                  ))}
                </div>
              </>
            )}
          </aside>
        )}

        <main className="coding-workspace">
          {area === "code" && (
          <div className="workspace-bar">
            <div className="workspace-breadcrumb">
              <span>{activeProject?.name || "No project"}</span>
              <i>/</i>
              <strong>{view === "chat" ? "Agent session" : activeFile || "Editor"}</strong>
            </div>
            <div className="workspace-actions">
              <button
                onClick={() => void undoLatest()}
                disabled={!canUndo || running || undoing}
                title={
                  undoLevels > 0
                    ? `Undo latest run — ${undoLevels} undo level${undoLevels === 1 ? "" : "s"} (files + session-branch commits)`
                    : diff.length
                      ? "Undo latest changes — discard current uncommitted changes"
                      : "Nothing to undo — working tree is clean"
                }
              >
                <Undo2 size={13} /> {undoing ? "Undoing…" : undoLevels > 1 ? `Undo (${undoLevels})` : "Undo"}
                {undoLevels <= 1 && diff.length > 0 ? ` (${diff.length})` : ""}
              </button>
              <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
                <MessageSquare size={13} /> Agent
              </button>
              <button className={view === "files" ? "active" : ""} onClick={() => setView("files")}>
                <Code2 size={13} /> Editor
              </button>
            </div>
          </div>
          )}

          <div className="workspace-content">
            {area === "notebook" ? (
              <section className="center-pane">
                <NotebookView
                  notebooks={notebook.notebooks}
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
                  onGenerateQuiz={(topic, count, quizType) => void notebook.generateQuiz(topic, count, quizType, selectedProviderId, selectedModel)}
                  onDeleteQuiz={(id) => void notebook.removeQuiz(id)}
                  onGenerateFlashcards={(topic, count) => void notebook.generateFlashcards(topic, count, selectedProviderId, selectedModel)}
                  onDeleteFlashcards={(id) => void notebook.removeFlashcards(id)}
                  onGenerateMindmap={(topic) => void notebook.generateMindmap(topic, selectedProviderId, selectedModel)}
                  onDeleteMindmap={(id) => void notebook.removeMindmap(id)}
                  summaries={notebook.summaries}
                  generatingSummary={notebook.generatingSummary}
                  summarySteps={notebook.activeNotebook ? notebook.stepsByChat[`nbsum:${notebook.activeNotebook.id}`] || [] : []}
                  onGenerateSummary={(topic, length) => void notebook.generateSummary(topic, length, selectedProviderId, selectedModel)}
                  onDeleteSummary={(id) => void notebook.removeSummary(id)}
                  onDownloadDocument={(id) => void notebook.downloadDocument(id)}
                  onDeleteDocument={(id) => void notebook.removeDocument(id)}
                  onCreateNotebook={(name) => void notebook.createNotebook(name)}
                  onDeleteNotebook={(id) => void notebook.removeNotebook(id)}
                  onPickFiles={() => void notebook.uploadFromPicker()}
                  onImportYouTube={(url) => void notebook.importYouTube(url)}
                  onImportWebsite={(url) => void notebook.importWebsite(url)}
                  onBrowserFiles={(files) => void notebook.uploadBrowserFiles(files)}
                  importingLink={notebook.importingLink}
                  isUploading={notebook.isUploading}
                  onRefresh={() => {
                    if (notebook.activeNotebook) void notebook.refreshNotebookDetail(notebook.activeNotebook.id);
                  }}
                  onToggleScope={(id) => notebook.toggleScope(id)}
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
                    void notebook.ask(selectedProviderId, selectedModel, 8, `${prompts[action]}\n\nPassage from ${passage.sourceName} (${passage.headingPath.join(" › ")}):\n${passage.text}`);
                  }}
                  onSaveInstructions={(value) => void notebook.saveInstructions(value)}
                  onSaveNote={(note) => void notebook.saveNote(note)}
                  onDeleteNote={(id) => void notebook.removeNote(id)}
                  onRename={(name) => void notebook.renameCurrentNotebook(name)}
                  onReindexAll={() => void notebook.reindexAll()}
                  onDeleteSource={async (sourceId) => {
                    if (!notebook.activeNotebook) return;
                    try {
                      await (api as unknown as { notebookDeleteSource: (a: string, b: string) => Promise<unknown> }).notebookDeleteSource(notebook.activeNotebook.id, sourceId);
                      await notebook.refreshNotebookDetail(notebook.activeNotebook.id);
                    } catch (error) {
                      notebook.setNotice(error instanceof Error ? error.message : "Delete failed.");
                    }
                  }}
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
                  onAsk={() => void notebook.ask(selectedProviderId, selectedModel)}
                  onStop={() => void notebook.stopAsk()}
                  onExitToSessions={() => notebook.exitToSessions()}
                  selectedProviderId={selectedProviderId}
                  selectedModel={selectedModel}
                  providers={providers}
                  definitions={providerDefinitions}
                  switchModel={(providerId, model) => void switchModel(providerId, model)}
                  onOpenProviders={() => setShowProviders(true)}
                  hasProvider={providers.length > 0}
                  customCommands={customCommands.filter((c) => !c.scope || c.scope === "all" || c.scope === "notebook")}
                />
              </section>
            ) : area === "home" ? (
              <section className="center-pane">
              <HomeView
                messages={home.currentMessages}
                draft={home.draft}
                setDraft={home.setDraft}
                submit={(override) => void home.submit(override, { providerId: selectedProviderId, model: selectedModel })}
                running={home.running}
                onStop={() => void home.stopAgent()}
                streamingText={home.streamingText}
                liveEvents={home.liveEvents}
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                providers={providers}
                definitions={providerDefinitions}
                switchModel={(providerId, model) => void switchModel(providerId, model)}
                onOpenProviders={() => setShowProviders(true)}
                sessionUsage={home.sessionUsage}
                homeFiles={home.homeFiles}
                homeRoot={home.homeRoot}
                onRefreshFiles={() => void home.refreshFiles()}
                onDownloadFile={(relPath) => void api.downloadHomeFile(relPath)}
                onOpenFolder={() => void api.openHomeFolder()}
                onNewChat={() => void home.createChat()}
                attachedImages={home.attachedImages}
                setAttachedImages={home.setAttachedImages}
                attachments={home.attachments}
                setAttachments={home.setAttachments}
                hasProvider={providers.length > 0}
                onOpenImage={openImagePreview}
                onOpenAttachment={setAttachmentPreview}
                customCommands={customCommands.filter((c) => !c.scope || c.scope === "all" || c.scope === "home")}
              />
              </section>
            ) : (
            <section className="center-pane">
              {view === "chat" ? (
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
                  providers={providers}
                  definitions={providerDefinitions}
                  files={files}
                  checkpointId={activeSession?.checkpointId}
                  diffCount={diff.length}
                  undoLevels={undoLevels}
                  onUndoRun={(id) => void undoRun(id)}
                  onKeepChanges={() => void keepChanges()}
                  switchModel={(providerId, model) => void switchModel(providerId, model)}
                  onOpenProviders={() => setShowProviders(true)}
                  onAttachFile={() => {
                    setDraft((curr) => `${curr}${curr ? "\n" : ""}@${activeFile || "current-file"}`);
                  }}
                  onAttachDiff={() => {
                    setDraft((curr) => `${curr}${curr ? "\n" : ""}Review the current Git diff`);
                  }}
                  sessionUsage={currentSessionUsage}
                  activeSessionId={activeSession?.id}
                  worktreeStatus={worktreeStatus}
                  onOpenArtifact={(art) => setActiveArtifact(art)}
                  onOpenImage={openImagePreview}
                  onOpenAttachment={setAttachmentPreview}
                  onOpenDiff={() => {
                    setCodeSideTab("diff");
                    setShowContext(true);
                    void refreshDiff();
                  }}
                  onMergeSuccess={() => {
                    void refreshDiff();
                    void loadWorkspace();
                  }}
                  onDiscardSuccess={() => {
                    void refreshDiff();
                    void loadWorkspace();
                  }}
                  attachedImages={attachedImages}
                  setAttachedImages={setAttachedImages}
                  attachments={attachments}
                  setAttachments={setAttachments}
                  customCommands={customCommands.filter((c) => !c.scope || c.scope === "all" || c.scope === "code")}
                />
              ) : (
                <MonacoEditorView
                  activeFile={activeFile}
                  openFiles={openFiles}
                  setActiveFile={(file) => void openFile(file)}
                  setOpenFiles={setOpenFiles}
                  content={fileContent}
                  setContent={setFileContent}
                  dirty={dirty}
                  save={() => void saveFile()}
                />
              )}
            </section>
            )}
          </div>
        </main>

        {showContext && area !== "notebook" ? (
          area === "code" ? (
          <aside key="code-context" className="context-pane" style={{ width: contextWidth }}>
            <div className="context-resize" onPointerDown={startContextResize} title="Drag to resize the sidebar" />
            <div className="notebook-side-head">
              <div className="notebook-side-head-left">
                <span className="notebook-side-head-badge">
                  <Activity size={13} />
                </span>
                <div className="notebook-side-head-text">
                  <div className="notebook-side-head-top">
                    <span className="context-kicker">SESSION CONTEXT</span>
                    <span className="notebook-head-count-pill">{activeProject?.name || "No project"}</span>
                  </div>
                  <strong className="notebook-side-title">{headerTitle}</strong>
                </div>
              </div>
              <div className="notebook-side-head-actions">
                <button className="context-panel-icon" onClick={() => setShowContext(false)} title="Close context panel">
                  <PanelRight size={14} />
                </button>
              </div>
            </div>
            <div className="context-tabs" role="tablist" aria-label="Code sidebar">
              <button type="button" role="tab" aria-selected={codeSideTab === "session"} className={codeSideTab === "session" ? "active" : ""} onClick={() => setCodeSideTab("session")} title="Session status and tools">
                <Info size={12} /> Session
              </button>
              <button type="button" role="tab" aria-selected={codeSideTab === "files"} className={codeSideTab === "files" ? "active" : ""} onClick={() => setCodeSideTab("files")} title="Project files">
                <FolderOpen size={12} /> Files
              </button>
              <button type="button" role="tab" aria-selected={codeSideTab === "browser"} className={codeSideTab === "browser" ? "active" : ""} onClick={() => setCodeSideTab("browser")} title="Built-in browser">
                <Globe size={12} /> Browser
              </button>
              <button type="button" role="tab" aria-selected={codeSideTab === "terminal"} className={codeSideTab === "terminal" ? "active" : ""} onClick={() => setCodeSideTab("terminal")} title="Interactive terminal">
                <Terminal size={12} /> Term
              </button>
              <button type="button" role="tab" aria-selected={codeSideTab === "diff"} className={codeSideTab === "diff" ? "active" : ""} onClick={() => { setCodeSideTab("diff"); void refreshDiff(); }} title="Git diff">
                <GitBranch size={12} /> Diff{diff.length > 0 ? ` (${diff.length})` : ""}
              </button>
              <button type="button" role="tab" aria-selected={codeSideTab === "memory"} className={codeSideTab === "memory" ? "active" : ""} onClick={() => setCodeSideTab("memory")} title="Persistent memory">
                <Brain size={12} /> Memory
              </button>
            </div>
            <div className={`context-tab-panel${codeSideTab === "session" ? "" : " hidden"}`}>
              <div className="context-tab-body">
                <div className="context-summary">
                  <span className="status-ring">{running ? <Loader2 size={13} className="spin" /> : <Check size={13} />}</span>
                  <div>
                    <strong>{running ? "Agent is working" : "Ready to code"}</strong>
                    <small>{running ? "Inspecting and changing your project" : "Plan, implement, review"}</small>
                  </div>
                </div>
                <div className="context-section">
                  <div className="context-section-title">
                    <span>SESSION TOOLS</span>
                    <small>{running ? "ACTIVE" : "READY"}</small>
                  </div>
                  <ContextRow icon={<FileCode2 size={14} />} label="File inspection" detail="Read, search, edit" active={Boolean(activeProject)} />
                  <ContextRow icon={<Terminal size={14} />} label="Terminal" detail="Interactive live shell" active={Boolean(activeProject)} />
                  <ContextRow icon={<GitBranch size={14} />} label="Git diff" detail={diff.length ? `${diff.length} changes to review` : "Clean working tree"} active={Boolean(diff.length)} />
                </div>
                {currentSessionUsage && currentSessionUsage.totalTokens > 0 && (
                  <div className="context-section">
                    <div className="context-section-title">
                      <span>SESSION TOTAL TOKENS</span>
                      <small>CUMULATIVE</small>
                    </div>
                    <MemoryRow label="Total tokens" value={`${currentSessionUsage.totalTokens.toLocaleString()} tokens`} />
                    <MemoryRow label="In / Out" value={`${currentSessionUsage.inputTokens.toLocaleString()} in / ${currentSessionUsage.outputTokens.toLocaleString()} out`} />
                    <MemoryRow label="Est. cost" value={formatCost(currentSessionUsage.estimatedCost)} />
                  </div>
                )}
                {projectRules && projectRules.hasRules && (
                  <div className="context-section">
                    <div className="context-section-title">
                      <span>PROJECT RULES</span>
                      <button onClick={() => setShowRulesModal(true)}><ChevronRight size={13} /></button>
                    </div>
                    <MemoryRow label="Active rule files" value={`${projectRules.ruleFiles.length} file${projectRules.ruleFiles.length === 1 ? "" : "s"}`} />
                  </div>
                )}
                <div className="context-section">
                  <div className="context-section-title">
                    <span>MEMORY</span>
                    <button onClick={() => setCodeSideTab("memory")}><ChevronRight size={13} /></button>
                  </div>
                  <MemoryRow label="Project memory" value={activeProject?.memory ? "Updated" : "Empty"} />
                  <MemoryRow label="Session memory" value={activeSession?.memory ? "Updated" : "Empty"} />
                </div>
              </div>
            </div>
            <div className={`context-tab-panel${codeSideTab === "files" ? "" : " hidden"}`}>
              <div className="file-pane-header">
                <span>EXPLORER</span>
                <div>
                  <button className="pane-action" onClick={() => void loadWorkspace()}>
                    <RefreshCw size={13} />
                  </button>
                </div>
              </div>
              <div className="root-label">
                <ChevronDown size={13} /> {activeProject?.name?.toUpperCase() || "NO WORKSPACE"}
              </div>
              <div className="file-tree">
                {visibleFiles.map((entry) => (
                  <FileRow
                    key={entry.path}
                    entry={entry}
                    active={entry.path === activeFile}
                    expanded={expandedFolders.has(entry.path)}
                    onClick={() =>
                      entry.kind === "folder" ? toggleFolder(entry.path) : void openFile(entry.path)
                    }
                  />
                ))}
              </div>
              <div className="file-pane-footer">
                <span>{files.filter((entry) => entry.kind === "file").length} files</span>
                <span>LOCAL</span>
              </div>
            </div>
            <div className={`context-tab-panel${codeSideTab === "browser" ? "" : " hidden"}`}>
              <SidebarBrowser
                key="code-browser"
                sessionId={activeSession?.id}
                browserScope="code"
                projectRoot={activeProject?.root}
                files={files}
                onSendToAgent={(p) => {
                  setDraft(p);
                  setView("chat");
                }}
                onAgentNavigate={() => setCodeSideTab("browser")}
              />
            </div>
            <div className={`context-tab-panel${codeSideTab === "terminal" ? "" : " hidden"}`}>
              <XTermView projectRoot={activeProject?.root} files={files} />
            </div>
            <div className={`context-tab-panel${codeSideTab === "diff" ? "" : " hidden"}`}>
              <DiffView
                diff={diff}
                checkpointId={activeSession?.checkpointId}
                undoing={undoing}
                onUndoRun={(id) => void undoRun(id)}
                onRefresh={() => void refreshDiff()}
                onRevertFile={(f) => void revertSingleFile(f)}
                onRevertHunk={(f, h) => void revertSingleHunk(f, h)}
                onRevertAll={() => void revertAllChanges()}
                onInspectFile={(f) => setInspectDiffFile(f)}
              />
            </div>
            <div className={`context-tab-panel${codeSideTab === "memory" ? "" : " hidden"}`}>
              <MemoryView project={activeProject} session={activeSession} onSave={saveMemories} />
            </div>
          </aside>
          ) : (
            // Notebook owns its own 3-pane layout (sources / chat / artifacts)
            // inside NotebookView, so the app-level context pane stays hidden.
          <aside key="home-context" className="context-pane" style={{ width: contextWidth }}>
            <div className="context-resize" onPointerDown={startContextResize} title="Drag to resize the sidebar" />
            <div className="notebook-side-head">
              <div className="notebook-side-head-left">
                <span className="notebook-side-head-badge">
                  <Home size={13} />
                </span>
                <div className="notebook-side-head-text">
                  <div className="notebook-side-head-top">
                    <span className="context-kicker">CURRENT CHAT</span>
                    <span className="notebook-head-count-pill">Nexus Home</span>
                  </div>
                  <strong className="notebook-side-title">{headerTitle}</strong>
                </div>
              </div>
              <div className="notebook-side-head-actions">
                <button className="context-panel-icon" onClick={() => setShowContext(false)} title="Close context panel">
                  <PanelRight size={14} />
                </button>
              </div>
            </div>
            <div className="context-tabs" role="tablist" aria-label="Home sidebar">
              <button
                type="button"
                role="tab"
                aria-selected={homeSideTab === "session"}
                className={homeSideTab === "session" ? "active" : ""}
                onClick={() => setHomeSideTab("session")}
                title="Session status, usage and memory"
              >
                <Info size={12} /> Session
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={homeSideTab === "artifacts"}
                className={homeSideTab === "artifacts" ? "active" : ""}
                onClick={() => setHomeSideTab("artifacts")}
                title="Files generated in this chat"
              >
                <FileText size={12} /> Artifacts{home.homeSessionFiles.length > 0 ? ` (${home.homeSessionFiles.length})` : ""}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={homeSideTab === "browser"}
                className={homeSideTab === "browser" ? "active" : ""}
                onClick={() => setHomeSideTab("browser")}
                title="Built-in browser"
              >
                <Globe size={12} /> Browser
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={homeSideTab === "memory"}
                className={homeSideTab === "memory" ? "active" : ""}
                onClick={() => { setHomeSideTab("memory"); void home.refreshHomeMemory(); }}
                title="Long-term memory shared across all Home chats"
              >
                <Brain size={12} /> Memory
              </button>
            </div>
            {homeSideTab === "session" && (
            <div className="context-tab-body">
            <div className="context-summary">
              <span className="status-ring">{running ? <Loader2 size={13} className="spin" /> : <Check size={13} />}</span>
              <div>
                <strong>{running ? "Agent is working" : "Ready"}</strong>
                <small>{running ? "Researching, writing files…" : "Ask, research, create documents"}</small>
              </div>
            </div>
            {home.sessionUsage && (
              <div className="context-section">
                <div className="context-section-title">
                  <span>SESSION TOTAL TOKENS</span>
                  <small>CUMULATIVE</small>
                </div>
                <MemoryRow label="Total tokens" value={`${home.sessionUsage.totalTokens.toLocaleString()} tokens`} />
                <MemoryRow label="In / Out" value={`${home.sessionUsage.inputTokens.toLocaleString()} in / ${home.sessionUsage.outputTokens.toLocaleString()} out`} />
                <MemoryRow label="Est. cost" value={formatCost(home.sessionUsage.estimatedCost)} />
              </div>
            )}
            <div className="context-section">
              <div className="context-section-title">
                <span>MEMORY</span>
                <button onClick={() => { setHomeSideTab("memory"); void home.refreshHomeMemory(); }}><ChevronRight size={13} /></button>
              </div>
              <MemoryRow label="Remembered" value={String(home.homeStructure.profile.length + home.homeStructure.preferences.length + home.homeStructure.facts.length + home.homeStructure.context.length)} />
              <MemoryRow label="Session notes" value={home.activeSession?.memory ? "Updated" : "Empty"} />
            </div>
            <div className="context-section">
              <div className="context-section-title">
                <span>NEXUS FOLDER</span>
                <small>{home.homeFiles.length} TOTAL</small>
              </div>
              <MemoryRow label="Location" value={home.homeRoot ? home.homeRoot.split(/[\\/]/).pop() || "Nexus" : "Nexus"} />
            </div>
            </div>
            )}
            {homeSideTab === "artifacts" && (
            <div className="context-tab-body">
            <div className="context-section">
              <div className="context-section-title">
                <span>SESSION FILES</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <small>{home.homeSessionFiles.length} FILE{home.homeSessionFiles.length === 1 ? "" : "S"}</small>
                  <button
                    className="pane-action"
                    onClick={() => {
                      void home.refreshFiles();
                      if (home.activeSession?.id) void home.refreshSessionFiles(home.activeSession.id);
                    }}
                    title="Refresh session files"
                  >
                    <RefreshCw size={12} />
                  </button>
                </span>
              </div>
              {home.activeSession ? (
                home.homeSessionFiles.length ? (
                  <div className="home-files-list">
                    {home.homeSessionFiles.map((file) => (
                      <div
                        className="home-file-row clickable"
                        key={file.path}
                        title={`${file.path} — click to preview`}
                        onClick={() => setHomePreviewPath(file.path)}
                      >
                        <FileText size={13} />
                        <div className="home-file-info">
                          <span className="home-file-name">{file.name}</span>
                          <small>
                            {formatHomeSize(file.size)} · {timeLabel(file.modified)}
                          </small>
                        </div>
                        <button
                          className="pane-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            void api.downloadHomeFile(file.path);
                          }}
                          title={`Download ${file.name}`}
                        >
                          <Download size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-pane">No files yet in this chat. Ask for a document and it will appear here.</div>
                )
              ) : (
                <div className="empty-pane">Start a chat to generate files.</div>
              )}
            </div>
            </div>
            )}
            <div className={`context-tab-panel${homeSideTab === "browser" ? "" : " hidden"}`}>
              <SidebarBrowser key="home-browser" sessionId={home.activeSession?.id} browserScope="home" onAgentNavigate={() => setHomeSideTab("browser")} />
            </div>
            {homeSideTab === "memory" && (
              <HomeMemoryPanel
                structure={home.homeStructure}
                sessionMemory={home.activeSession?.memory || ""}
                sessionTitle={home.activeSession?.title}
                onRemoveFact={(category, fact) => void home.removeFact(category, fact)}
                onClearSession={() => void home.clearSessionMemory()}
                onOpenChat={(sessionId) => void home.selectChat(sessionId)}
              />
            )}
          </aside>
          )
        ) : area !== "notebook" ? (
          <button className="context-restore" onClick={() => setShowContext(true)} title="Open context panel">
            <PanelRight size={15} />
          </button>
        ) : null}
      </div>

      {showProviders && (
        <ProviderModal
          providers={providers}
          definitions={providerDefinitions}
          onProvidersChange={handleProvidersChange}
          onClose={() => setShowProviders(false)}
        />
      )}
      {showMcp && <McpModal onClose={() => setShowMcp(false)} />}
      {showSettings && (
        <SettingsModal
          area={area}
          hasProject={Boolean(activeProject)}
          skillsEnabled={skillsEnabled}
          onToggleSkills={async (enabled) => {
            setSkillsEnabled(enabled);
            await api.saveSkillsConfig({ enabled });
          }}
          providers={providers}
          providerDefinitions={providerDefinitions}
          onProvidersChange={handleProvidersChange}
          updater={updater}
          appVersion={appVersion}
          onCheckUpdates={() => void api.checkForUpdates()}
          onQuitAndInstall={() => void api.quitAndInstallUpdate()}
          onManageServices={() => {
            setShowSettings(false);
            setShowDaemonsModal(true);
          }}
          onClose={() => setShowSettings(false)}
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
          projectRoot={activeProject?.root}
          onClose={() => setShowDaemonsModal(false)}
        />
      )}
      {inspectDiffFile && (
        <MonacoDiffModal
          fileName={inspectDiffFile.name}
          filePath={inspectDiffFile.path}
          patch={inspectDiffFile.patch}
          additions={inspectDiffFile.additions}
          deletions={inspectDiffFile.deletions}
          onClose={() => setInspectDiffFile(null)}
          onRevertFile={(f) => {
            void revertSingleFile(f);
            setInspectDiffFile(null);
          }}
        />
      )}
      {showRulesModal && projectRules && (
        <ProjectRulesModal
          ruleFiles={projectRules.ruleFiles}
          onClose={() => setShowRulesModal(false)}
        />
      )}
      {activeArtifact && (
        <ArtifactViewer
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
          onApproveAndExecute={(plan) => {
            setMode("Auto");
            void submit(`Execute the approved implementation plan:\n\n${plan}`);
          }}
          onStatusChange={async (filename, status) => {
            if (activeSession) {
              const updated = await api.updateArtifactStatus(activeSession.id, filename, status);
              if (updated) setActiveArtifact(updated);
            }
          }}
        />
      )}
      {confirmDialog && (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          danger={confirmDialog.danger}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
      {approvalRequest && (
        <div className="modal-layer confirm-layer" onClick={() => void answerApproval("deny")}>
          <div className="modal-card confirm-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card-head" style={{ marginBottom: "10px" }}>
              <div>
                <span className="view-kicker" style={{ color: "var(--orange)" }}>COMMAND APPROVAL</span>
                <h2 style={{ fontSize: "16px", margin: "6px 0 4px" }}>Allow the agent to run this command?</h2>
              </div>
            </div>
            <p style={{ color: "#a6b2c2", fontSize: "11px", lineHeight: "1.5", margin: "0 0 10px" }}>{approvalRequest.reason}</p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "0 0 18px", padding: "10px", border: "1px solid #28374a", borderRadius: "5px", background: "#090d14", color: "#e5aa64", font: "10px/1.5 'DM Mono', monospace" }}>{approvalRequest.command}</pre>
            <small style={{ color: "#687588", display: "block", marginBottom: "14px" }}>Working directory: {approvalRequest.cwd}</small>
            <div className="modal-actions" style={{ marginTop: "0" }}>
              <button className="secondary" onClick={() => void answerApproval("deny")}>Deny</button>
              <button className="secondary" onClick={() => void answerApproval("session")}>Allow for run</button>
              <button className="primary" onClick={() => void answerApproval("once")}>Allow once</button>
            </div>
          </div>
        </div>
      )}
      {userQuestion && (
        <div className="modal-layer confirm-layer">
          <div className="modal-card confirm-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card-head" style={{ marginBottom: "10px" }}>
              <div>
                <span className="view-kicker" style={{ color: "var(--nexus-green)" }}>AGENT QUESTION</span>
                <h2 style={{ fontSize: "16px", margin: "6px 0 4px" }}>The agent needs your input</h2>
              </div>
            </div>
            {userQuestion.questions.map((q) => (
              <div key={q.header} style={{ marginBottom: "12px" }}>
                <strong style={{ fontSize: "12px" }}>{q.header}</strong>
                <p style={{ color: "#a6b2c2", fontSize: "11px", lineHeight: "1.5", margin: "4px 0 6px" }}>{q.question}</p>
                {q.options.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "6px" }}>
                    {q.options.map((opt) => (
                      <button
                        key={opt}
                        className={`secondary${questionAnswers[q.header] === opt ? " active" : ""}`}
                        onClick={() => setQuestionAnswers((curr) => ({ ...curr, [q.header]: opt }))}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  className="session-rename-input"
                  style={{ width: "100%" }}
                  placeholder={q.options.length ? "Or type a custom answer…" : "Type your answer…"}
                  value={questionAnswers[q.header] || ""}
                  onChange={(event) => setQuestionAnswers((curr) => ({ ...curr, [q.header]: event.target.value }))}
                />
              </div>
            ))}
            <div className="modal-actions" style={{ marginTop: "6px" }}>
              <button
                className="secondary"
                onClick={() => {
                  const id = userQuestion.id;
                  setUserQuestion(null);
                  void (api as unknown as { resolveUserQuestion: (id: string, a: null, c: boolean) => Promise<unknown> }).resolveUserQuestion(id, null, true);
                }}
              >
                Skip (best guess)
              </button>
              <button
                className="primary"
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
      {homePreviewPath && (
        <FilePreviewModal
          filePath={homePreviewPath}
          onClose={() => setHomePreviewPath(null)}
          onDownload={(p) => void api.downloadHomeFile(p)}
        />
      )}
      {attachmentPreview && <AttachmentPreviewModal attachment={attachmentPreview} onClose={() => setAttachmentPreview(null)} />}
      {/* Hidden executor for the agent's browsing — same session as the tabs. */}
      <AgentBrowserHost />
    </div>
  );
}

export default App;
