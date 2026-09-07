import React, { useEffect, useState } from "react";
import {
  Brain, Check, ChevronDown, ChevronRight, Code2, Coins, Download, FileCode2, FileText,
  FolderOpen, GitBranch, Globe, Home, Info, KeyRound, Loader2, Menu,
  MessageSquare, PanelRight, Plus, RefreshCw,
  Server, Settings2, Sparkles, Terminal, Trash2
} from "lucide-react";
import { NexusLogo } from "./components/common/NexusLogo.js";
import { WindowControls } from "./components/common/WindowControls.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { ProviderModal } from "./modals/ProviderModal.js";
import { McpModal } from "./modals/McpModal.js";
import { SkillsModal } from "./modals/SkillsModal.js";
import { SettingsModal } from "./modals/SettingsModal.js";
import { ProjectPickerModal } from "./modals/ProjectPickerModal.js";
import { DaemonsModal } from "./components/daemons/DaemonsModal.js";
import { MonacoDiffModal } from "./components/diff/MonacoDiffModal.js";
import { ProjectRulesModal } from "./components/rules/ProjectRulesModal.js";
import { ArtifactViewer } from "./components/artifacts/ArtifactViewer.js";
import { FilePreviewModal } from "./components/home/FilePreviewModal.js";
import { SidebarBrowser } from "./components/browser/SidebarBrowser.js";
import { MonacoEditorView } from "./components/editor/MonacoEditorView.js";
import { XTermView } from "./components/terminal/XTermView.js";
import { AgentBrowserHost } from "./components/browser/AgentBrowserHost.js";
import { AgentView } from "./views/AgentView.js";
import { HomeView } from "./views/HomeView.js";
import { DiffView } from "./views/DiffView.js";
import { MemoryView, ContextRow, MemoryRow } from "./views/MemoryView.js";
import { useAppController } from "./state/useAppController.js";
import { getSessionUsage, fileIcon } from "./utils/format.js";
import { timeLabel } from "./utils/format.js";
import type { UpdaterState } from "./types.js";
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
    showCreateProject,
    setShowCreateProject,
    newProjectName,
    setNewProjectName,
    newProjectRoot,
    setNewProjectRoot,
    skillsEnabled,
    setSkillsEnabled,
    confirmDialog,
    setConfirmDialog,
    activeArtifact,
    setActiveArtifact,
    worktreeStatus,
    attachedImages,
    setAttachedImages,
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
    homeRoot,
    homeFiles,
    homeSessionFiles,
    refreshHomeFiles,
    refreshHomeSessionFiles,
    enterHome,
    enterCode,
    createHomeSession,
    activateProject,
    deleteProjectById,
    openProjectFromDialog,
    createProject,
    createSession,
    activateSession,
    deleteActiveSession,
    openFile,
    saveFile,
    toggleFolder,
    loadWorkspace,
    refreshDiff,
    revertSingleFile,
    revertAllChanges,
    undoRun,
    keepChanges,
    switchModel,
    handleProvidersChange,
    saveMemories,
    submit,
    stopAgent,
    setActiveFile,
    setOpenFiles,
  } = useAppController();

  const api = window.nexus || window.forgepilot;
  const headerTitle = activeSession?.title || "No session selected";
  const currentSessionUsage = getSessionUsage(activeSession);
  const [homePreviewPath, setHomePreviewPath] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [homeSideTab, setHomeSideTab] = useState<"session" | "artifacts" | "browser">("session");
  const [codeSideTab, setCodeSideTab] = useState<"session" | "files" | "browser" | "terminal" | "diff" | "memory">("session");
  const [updater, setUpdater] = useState<UpdaterState>({ status: "idle" });
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    void api.getAppVersion().then(setAppVersion).catch(() => {});
    return api.onUpdaterStatus((state) => setUpdater(state as UpdaterState));
  }, []);
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
            <NexusLogo size={20} />
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
          </div>
          <div className="top-separator" />
          {area === "code" && (
            <button className="project-menu" onClick={() => setShowSessions((v) => !v)}>
              <FolderOpen size={13} />
              <strong>{activeProject?.name || "Projects"}</strong>
              <ChevronDown size={12} />
            </button>
          )}
          <span className="branch">
            <GitBranch size={11} /> {gitBranch}
          </span>
        </div>

        <div className="session-top-title">
          <span className="green-dot" />
          <span>{headerTitle}</span>
        </div>

        <div className="product-right">
          <button className="top-link" onClick={() => setShowSkills(true)}>
            <Sparkles size={13} /> Skills
          </button>
          <button className="top-link" onClick={() => setShowMcp(true)}>
            <Server size={13} /> MCP
          </button>
          <button className="top-link" onClick={() => setShowDaemonsModal(true)} title="Manage long-running background processes and dev servers">
            <Terminal size={13} /> Services
          </button>
          <button className="top-link" onClick={() => setShowProviders(true)}>
            <KeyRound size={13} /> Providers
          </button>
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
          <span className="user-chip">ME</span>
          <div className="top-separator window-ctrl-sep" />
          <WindowControls />
        </div>
      </header>

      <div className="product-body">
        {showSessions && area === "home" && (
          <aside className="session-pane">
            <div className="pane-top">
              <span>HOME</span>
              <button className="pane-action" onClick={() => void createHomeSession()}><Plus size={15} /></button>
            </div>
            <button className="new-session-btn" onClick={() => void createHomeSession()}>
              <MessageSquare size={13} /> New chat
            </button>
            <div className="pane-top sessions-label">
              <span>CHATS</span>
            </div>
            <div className="session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-row ${session.id === activeSession?.id ? "active" : ""}`}
                  onClick={() => void activateSession(session.id)}
                >
                  <MessageSquare size={13} />
                  <span>{session.title}</span>
                  <small>{session.messages.length}</small>
                  <i
                    className="row-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteActiveSession(session.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </i>
                </button>
              ))}
              {!sessions.length && <div className="empty-pane">Start a new chat to begin.</div>}
            </div>
          </aside>
        )}
        {showSessions && area === "code" && (
          <aside className="session-pane">
            <div className="pane-top">
              <span>PROJECTS</span>
              <button className="pane-action" onClick={() => setShowCreateProject(true)}><Plus size={15} /></button>
            </div>
            <button className="create-project-btn" onClick={() => setShowCreateProject(true)}>
              <Plus size={14} /> New project
            </button>
            <div className="project-list">
              {projects.filter((project) => project.id !== "home").map((project) => (
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
                <div className="pane-top sessions-label">
                  <span>SESSIONS</span>
                  <button className="pane-action" onClick={() => void createSession()}><Plus size={15} /></button>
                </div>
                <button className="new-session-btn" onClick={() => void createSession()}>
                  <MessageSquare size={13} /> New coding session <kbd>⌘ N</kbd>
                </button>
                <div className="session-list">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      className={`session-row ${session.id === activeSession?.id ? "active" : ""}`}
                      onClick={() => void activateSession(session.id)}
                    >
                      <MessageSquare size={13} />
                      <span>{session.title}</span>
                      <small>{session.messages.length}</small>
                      <i
                        className="row-delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteActiveSession(session.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </i>
                    </button>
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
            {area === "home" ? (
              <section className="center-pane">
              <HomeView
                messages={currentMessages}
                draft={draft}
                setDraft={setDraft}
                submit={(override) => void submit(override)}
                running={running}
                onStop={() => void stopAgent()}
                streamingText={streamingText}
                liveEvents={liveEvents}
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                providers={providers}
                definitions={providerDefinitions}
                switchModel={(providerId, model) => void switchModel(providerId, model)}
                onOpenProviders={() => setShowProviders(true)}
                sessionUsage={currentSessionUsage}
                homeFiles={homeFiles}
                homeRoot={homeRoot}
                onRefreshFiles={() => void refreshHomeFiles()}
                onDownloadFile={(relPath) => void api.downloadHomeFile(relPath)}
                onOpenFolder={() => void api.openHomeFolder()}
                onNewChat={() => void createHomeSession()}
                attachedImages={attachedImages}
                setAttachedImages={setAttachedImages}
                hasProvider={providers.length > 0}
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
                  customCommands={customCommands}
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

        {showContext ? (
          area === "code" ? (
          <aside className="context-pane" style={{ width: contextWidth }}>
            <div className="context-resize" onPointerDown={startContextResize} title="Drag to resize the sidebar" />
            <div className="context-head">
              <div>
                <span className="context-kicker">CURRENT SESSION</span>
                <strong>{headerTitle}</strong>
                <small>{activeProject?.name || "No project"}</small>
              </div>
              <button className="context-panel-icon" onClick={() => setShowContext(false)} title="Close context panel">
                <PanelRight size={15} />
              </button>
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
                projectRoot={activeProject?.root}
                onSendToAgent={(p) => {
                  setDraft(p);
                  setView("chat");
                }}
                onAgentNavigate={() => setCodeSideTab("browser")}
              />
            </div>
            <div className={`context-tab-panel${codeSideTab === "terminal" ? "" : " hidden"}`}>
              <XTermView projectRoot={activeProject?.root} />
            </div>
            <div className={`context-tab-panel${codeSideTab === "diff" ? "" : " hidden"}`}>
              <DiffView
                diff={diff}
                onRefresh={() => void refreshDiff()}
                onRevertFile={(f) => void revertSingleFile(f)}
                onRevertAll={() => void revertAllChanges()}
                onInspectFile={(f) => setInspectDiffFile(f)}
              />
            </div>
            <div className={`context-tab-panel${codeSideTab === "memory" ? "" : " hidden"}`}>
              <MemoryView project={activeProject} session={activeSession} onSave={saveMemories} />
            </div>
          </aside>
          ) : (
          <aside className="context-pane" style={{ width: contextWidth }}>
            <div className="context-resize" onPointerDown={startContextResize} title="Drag to resize the sidebar" />
            <div className="context-head">
              <div>
                <span className="context-kicker">CURRENT CHAT</span>
                <strong>{headerTitle}</strong>
                <small>Nexus Home</small>
              </div>
              <button className="context-panel-icon" onClick={() => setShowContext(false)} title="Close context panel">
                <PanelRight size={15} />
              </button>
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
                <FileText size={12} /> Artifacts{homeSessionFiles.length > 0 ? ` (${homeSessionFiles.length})` : ""}
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
            <div className="context-section">
              <div className="context-section-title">
                <span>MEMORY</span>
              </div>
              <MemoryRow label="Project memory" value={activeProject?.memory ? "Updated" : "Empty"} />
              <MemoryRow label="Session memory" value={activeSession?.memory ? "Updated" : "Empty"} />
            </div>
            <div className="context-section">
              <div className="context-section-title">
                <span>NEXUS FOLDER</span>
                <small>{homeFiles.length} TOTAL</small>
              </div>
              <MemoryRow label="Location" value={homeRoot ? homeRoot.split(/[\\/]/).pop() || "Nexus" : "Nexus"} />
            </div>
            </div>
            )}
            {homeSideTab === "artifacts" && (
            <div className="context-tab-body">
            <div className="context-section">
              <div className="context-section-title">
                <span>SESSION FILES</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <small>{homeSessionFiles.length} FILE{homeSessionFiles.length === 1 ? "" : "S"}</small>
                  <button
                    className="pane-action"
                    onClick={() => {
                      void refreshHomeFiles();
                      if (activeSession?.id) void refreshHomeSessionFiles(activeSession.id);
                    }}
                    title="Refresh session files"
                  >
                    <RefreshCw size={12} />
                  </button>
                </span>
              </div>
              {activeSession ? (
                homeSessionFiles.length ? (
                  <div className="home-files-list">
                    {homeSessionFiles.map((file) => (
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
            {homeSideTab === "browser" && (
              <SidebarBrowser onAgentNavigate={() => setHomeSideTab("browser")} />
            )}
          </aside>
          )
        ) : (
          <button className="context-restore" onClick={() => setShowContext(true)} title="Open context panel">
            <PanelRight size={15} />
          </button>
        )}
      </div>

      {showCreateProject && (
        <ProjectPickerModal
          name={newProjectName}
          setName={setNewProjectName}
          root={newProjectRoot}
          setRoot={setNewProjectRoot}
          onChooseFolder={() => void openProjectFromDialog()}
          onCreate={() => void createProject()}
          onClose={() => setShowCreateProject(false)}
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
      {homePreviewPath && (
        <FilePreviewModal
          filePath={homePreviewPath}
          onClose={() => setHomePreviewPath(null)}
          onDownload={(p) => void api.downloadHomeFile(p)}
        />
      )}
      {/* Hidden executor for the agent's browsing — same session as the tabs. */}
      <AgentBrowserHost />
    </div>
  );
}

export default App;
