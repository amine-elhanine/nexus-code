import React from "react";
import {
  Brain, Check, ChevronDown, ChevronRight, Code2, Coins, FileCode2,
  FolderOpen, GitBranch, Globe, KeyRound, Loader2, Menu,
  MessageSquare, PanelLeft, PanelRight, Plus, RefreshCw,
  Server, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, Square
} from "lucide-react";
import { NexusLogo } from "./components/common/NexusLogo.js";
import { WindowControls } from "./components/common/WindowControls.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { ProviderModal } from "./modals/ProviderModal.js";
import { SandboxModal } from "./modals/SandboxModal.js";
import { McpModal } from "./modals/McpModal.js";
import { SkillsModal } from "./modals/SkillsModal.js";
import { ProjectPickerModal } from "./modals/ProjectPickerModal.js";
import { DaemonsModal } from "./components/daemons/DaemonsModal.js";
import { MonacoDiffModal } from "./components/diff/MonacoDiffModal.js";
import { ProjectRulesModal } from "./components/rules/ProjectRulesModal.js";
import { ArtifactViewer } from "./components/artifacts/ArtifactViewer.js";
import { MonacoEditorView } from "./components/editor/MonacoEditorView.js";
import { XTermView } from "./components/terminal/XTermView.js";
import { IntegratedBrowserView } from "./components/browser/IntegratedBrowserView.js";
import { AgentView } from "./views/AgentView.js";
import { DiffView } from "./views/DiffView.js";
import { MemoryView, ContextRow, MemoryRow } from "./views/MemoryView.js";
import { useAppController } from "./state/useAppController.js";
import { getSessionUsage, fileIcon } from "./utils/format.js";
import type { FileEntry } from "./types.js";

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
    sandboxConfig,
    sandboxStatus,
    sandboxRequireApproval,
    setSandboxRequireApproval,
    sandboxAllowNetwork,
    setSandboxAllowNetwork,
    sandboxTimeout,
    setSandboxTimeout,
    sandboxEnabled,
    setSandboxEnabled,
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
    showFiles,
    setShowFiles,
    showContext,
    setShowContext,
    showProviders,
    setShowProviders,
    showSandbox,
    setShowSandbox,
    showMcp,
    setShowMcp,
    showSkills,
    setShowSkills,
    showComposerMenu,
    setShowComposerMenu,
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
    saveSandbox,
    stopSandbox,
    saveMemories,
    submit,
    stopAgent,
    setActiveFile,
    setOpenFiles,
  } = useAppController();

  const api = window.nexus || window.forgepilot;
  const headerTitle = activeSession?.title || "No session selected";
  const currentSessionUsage = getSessionUsage(activeSession);

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
          <button className="project-menu" onClick={() => setShowSessions((v) => !v)}>
            <FolderOpen size={13} />
            <strong>{activeProject?.name || "Projects"}</strong>
            <ChevronDown size={12} />
          </button>
          <span className="branch">
            <GitBranch size={11} /> {gitBranch}
          </span>
        </div>

        <div className="session-top-title">
          <span className="green-dot" />
          <span>{headerTitle}</span>
        </div>

        <div className="product-right">
          <button className="top-link" onClick={() => setShowSandbox(true)}>
            <ShieldCheck size={13} /> Sandbox
          </button>
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
          <button className="icon-plain" onClick={() => setShowProviders(true)} title="Settings">
            <Settings2 size={15} />
          </button>
          <span className="user-chip">ME</span>
          <div className="top-separator window-ctrl-sep" />
          <WindowControls />
        </div>
      </header>

      <div className="product-body">
        {showSessions && (
          <aside className="session-pane">
            <div className="pane-top">
              <span>PROJECTS</span>
              <button className="pane-action" onClick={() => setShowCreateProject(true)}><Plus size={15} /></button>
            </div>
            <button className="create-project-btn" onClick={() => setShowCreateProject(true)}>
              <Plus size={14} /> New project
            </button>
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
          <div className="workspace-bar">
            <div className="workspace-breadcrumb">
              <button className="bar-toggle" onClick={() => setShowFiles((v) => !v)}>
                <PanelLeft size={14} />
              </button>
              <span>{activeProject?.name || "No project"}</span>
              <i>/</i>
              <strong>
                {view === "chat"
                  ? "Agent session"
                  : view === "memory"
                  ? "Memory"
                  : view === "diff"
                  ? "Git diff"
                  : view === "terminal"
                  ? "Terminal"
                  : view === "browser"
                  ? "Live Browser"
                  : activeFile}
              </strong>
            </div>
            <div className="workspace-actions">
              <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
                <MessageSquare size={13} /> Agent
              </button>
              <button className={view === "files" ? "active" : ""} onClick={() => setView("files")}>
                <Code2 size={13} /> Files
              </button>
              <button
                className={view === "diff" ? "active" : ""}
                onClick={() => {
                  setView("diff");
                  void refreshDiff();
                }}
              >
                <GitBranch size={13} /> Diff
              </button>
              <button className={view === "terminal" ? "active" : ""} onClick={() => setView("terminal")}>
                <Terminal size={13} /> Terminal
              </button>
              <button className={view === "browser" ? "active" : ""} onClick={() => setView("browser")}>
                <Globe size={13} /> Browser
              </button>
              <button className={view === "memory" ? "active" : ""} onClick={() => setView("memory")}>
                <Brain size={13} /> Memory
              </button>
            </div>
          </div>

          <div className="workspace-content">
            {showFiles && (
              <aside className="file-pane">
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
              </aside>
            )}

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
                    setShowComposerMenu(false);
                  }}
                  onAttachDiff={() => {
                    setDraft((curr) => `${curr}${curr ? "\n" : ""}Review the current Git diff`);
                    setShowComposerMenu(false);
                  }}
                  showComposerMenu={showComposerMenu}
                  setShowComposerMenu={setShowComposerMenu}
                  sessionUsage={currentSessionUsage}
                  activeSessionId={activeSession?.id}
                  worktreeStatus={worktreeStatus}
                  onOpenArtifact={(art) => setActiveArtifact(art)}
                  onOpenDiff={() => {
                    setView("diff");
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
              ) : view === "memory" ? (
                <MemoryView project={activeProject} session={activeSession} onSave={saveMemories} />
              ) : view === "diff" ? (
                <DiffView
                  diff={diff}
                  onRefresh={() => void refreshDiff()}
                  onRevertFile={(f) => void revertSingleFile(f)}
                  onRevertAll={() => void revertAllChanges()}
                  onInspectFile={(f) => setInspectDiffFile(f)}
                />
              ) : view === "terminal" ? (
                <XTermView projectRoot={activeProject?.root} />
              ) : view === "browser" ? (
                <IntegratedBrowserView
                  projectRoot={activeProject?.root}
                  onSendToAgent={(p) => {
                    setDraft(p);
                    setView("chat");
                  }}
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
          </div>
        </main>

        {showContext ? (
          <aside className="context-pane">
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
                <MemoryRow label="Est. cost" value={`~$${currentSessionUsage.estimatedCost.toFixed(4)}`} />
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
                <button onClick={() => setView("memory")}><ChevronRight size={13} /></button>
              </div>
              <MemoryRow label="Project memory" value={activeProject?.memory ? "Updated" : "Empty"} />
              <MemoryRow label="Session memory" value={activeSession?.memory ? "Updated" : "Empty"} />
            </div>
            <div className="context-section">
              <div className="context-section-title">
                <span>MODEL</span>
                <button onClick={() => setShowProviders(true)}><Settings2 size={13} /></button>
              </div>
              <div className="active-model" onClick={() => setShowProviders(true)} style={{ cursor: "pointer" }}>
                <span className="model-orb"><Sparkles size={13} /></span>
                <div>
                  <strong>{selectedModel || "No model selected"}</strong>
                  <small>{selectedProvider?.label || "Add a provider"}</small>
                </div>
                <ChevronDown size={13} />
              </div>
            </div>
            <div className="context-bottom">
              <ShieldCheck size={13} />
              <span>
                {sandboxStatus.status === "ready"
                  ? "Sandbox ready · isolated execution"
                  : sandboxStatus.configured
                  ? `Sandbox · ${sandboxStatus.status}`
                  : "Sandbox not configured"}
              </span>
              <button
                className="sandbox-stop"
                onClick={() => void stopSandbox()}
                disabled={sandboxStatus.status !== "ready"}
              >
                <Square size={11} />
              </button>
            </div>
          </aside>
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
      {showSandbox && (
        <SandboxModal
          config={sandboxConfig}
          requireApproval={sandboxRequireApproval}
          setRequireApproval={setSandboxRequireApproval}
          allowNetwork={sandboxAllowNetwork}
          setAllowNetwork={setSandboxAllowNetwork}
          timeout={sandboxTimeout}
          setTimeout={setSandboxTimeout}
          enabled={sandboxEnabled}
          setEnabled={setSandboxEnabled}
          status={sandboxStatus}
          onSave={() => void saveSandbox()}
          onClose={() => setShowSandbox(false)}
        />
      )}
      {showMcp && <McpModal onClose={() => setShowMcp(false)} />}
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
    </div>
  );
}

export default App;
