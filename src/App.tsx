import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen, Check, ChevronDown, ChevronRight, Code2, Download, FileCode2, FileText,
  Folder, FolderOpen, GitBranch, Home, Sparkles, X, Globe, Bot,
  MessageSquare, MoreHorizontal, MoreVertical, PanelLeft, PanelRight, Pencil, Plus, RefreshCw, Search,
  Terminal, Trash2, SlidersHorizontal, Database, Cpu, Brain, Command, TriangleAlert, AppWindow, CheckCircle2,
  Maximize2, Minimize2
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
import { CodeInspectorSidebar } from "./components/code/CodeInspectorSidebar.js";
import { CodeOverviewCard } from "./components/code/CodeOverviewCard.js";
import { extractLatestPlan } from "./components/chat/SlidingPlanDrawer.js";
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

/* Codex-style relative label for the Task list ("8m", "3h", "2d", "1w"). */
function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.round((Date.now() - t) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    deleteProjectSession,
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
  // Codex-style Task list: search filter + "Show more" on long session lists.
  const [taskSearch, setTaskSearch] = useState<string | null>(null);
  const [fullyShownProjects, setFullyShownProjects] = useState<Set<string>>(new Set());

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

  const toggleProjectFullyShown = (id: string) => {
    setFullyShownProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const handleDeleteProject = (projectId: string) => {
    deleteProjectById(projectId, (id) => {
      setProjectSessions((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  };

  const handleDeleteSession = (projectId: string, sessionId: string) => {
    deleteProjectSession(projectId, sessionId, (pid, sid) => {
      setProjectSessions((prev) => {
        const currentList = prev[pid];
        if (!currentList) return prev;
        return {
          ...prev,
          [pid]: currentList.filter((s) => s.id !== sid),
        };
      });
    });
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
  const [codeBrowserTabs, setCodeBrowserTabs] = useState<Array<{ id: string; url: string; title: string }>>([]);
  const [agentBrowserTab, setAgentBrowserTab] = useState<{ active: boolean; url: string; title: string }>({
    active: false,
    url: "about:blank",
    title: "Agent",
  });

  const [codeRightSidebarWidth, setCodeRightSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("nexus_code_right_sidebar_width");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 320 && parsed <= 1600) return parsed;
      }
    } catch {
      // ignore
    }
    return 480;
  });
  const [isResizingCodeRightSidebar, setIsResizingCodeRightSidebar] = useState(false);

  const handleCodeResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingCodeRightSidebar(true);
    document.body.classList.add("sidebar-resizing-active");

    const startX = e.clientX;
    const startWidth = codeRightSidebarWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const maxWidth = Math.max(340, Math.floor(window.innerWidth * 0.85));
      const nextWidth = Math.max(320, Math.min(maxWidth, startWidth + delta));
      setCodeRightSidebarWidth(nextWidth);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.classList.remove("sidebar-resizing-active");
      setIsResizingCodeRightSidebar(false);
      const delta = startX - upEvent.clientX;
      const maxWidth = Math.max(340, Math.floor(window.innerWidth * 0.85));
      const finalWidth = Math.max(320, Math.min(maxWidth, startWidth + delta));
      try {
        localStorage.setItem("nexus_code_right_sidebar_width", String(finalWidth));
      } catch {
        // ignore
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [codeRightSidebarWidth]);
  const [codeRightSidebarOpen, setCodeRightSidebarOpen] = useState(false);
  const [codeRightSidebarTab, setCodeRightSidebarTab] = useState<string>("inspector");
  const [inspectorTabOpen, setInspectorTabOpen] = useState(true);
  const [diffTabOpen, setDiffTabOpen] = useState(false);
  const [terminalTabOpen, setTerminalTabOpen] = useState(false);
  const [memoryTabOpen, setMemoryTabOpen] = useState(false);
  const [showAddTabMenu, setShowAddTabMenu] = useState(false);
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const addTabWrapperRef = useRef<HTMLDivElement | null>(null);
  const [menuPositionStyle, setMenuPositionStyle] = useState<React.CSSProperties>({});

  const handleToggleAddMenu = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (showAddTabMenu) {
      setShowAddTabMenu(false);
      return;
    }
    const btn = addBtnRef.current || (e?.currentTarget as HTMLElement | null);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const top = Math.round(rect.bottom + 6);
      const left = Math.round(Math.max(10, Math.min(rect.right - 160, window.innerWidth - 175)));
      setMenuPositionStyle({
        top: `${top}px`,
        left: `${left}px`,
      });
    }
    setShowAddTabMenu(true);
  };

  const handleTabsWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0 && tabsScrollRef.current) {
      tabsScrollRef.current.scrollLeft += e.deltaY;
    }
  };

  const diffTotals = useMemo(() => {
    return (diff || []).reduce(
      (acc, file) => ({
        add: acc.add + (file.additions || 0),
        del: acc.del + (file.deletions || 0),
      }),
      { add: 0, del: 0 }
    );
  }, [diff]);

  useEffect(() => {
    if (diff.length > 0) {
      setDiffTabOpen(true);
    }
  }, [diff.length]);

  // Scroll active tab into view whenever codeRightSidebarTab or activeFile changes
  useEffect(() => {
    const activeEl = tabsScrollRef.current?.querySelector(".sidebar-tab.active");
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [codeRightSidebarTab, activeFile]);

  useEffect(() => {
    if (!showAddTabMenu) return;
    const handleOutsideClick = (e: PointerEvent | MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(".sidebar-tab-add-btn") ||
        target?.closest(".sidebar-tab-add-wrapper") ||
        target?.closest(".sidebar-tab-add-menu")
      ) {
        return;
      }
      setShowAddTabMenu(false);
    };
    const handleClose = () => {
      setShowAddTabMenu(false);
    };
    window.addEventListener("pointerdown", handleOutsideClick);
    window.addEventListener("resize", handleClose);
    return () => {
      window.removeEventListener("pointerdown", handleOutsideClick);
      window.removeEventListener("resize", handleClose);
    };
  }, [showAddTabMenu]);

  const addUserBrowserTab = useCallback((initialUrl?: string) => {
    const newId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetUrl = initialUrl || "https://www.google.com";
    let hostTitle = "google.com";
    try {
      const parsed = new URL(targetUrl);
      hostTitle = parsed.hostname.replace(/^www\./, "");
    } catch {
      hostTitle = "Browser";
    }
    const newTab = {
      id: newId,
      url: targetUrl,
      title: hostTitle || "Browser",
    };
    setCodeBrowserTabs((prev) => [...prev, newTab]);
    setCodeRightSidebarTab(newId);
    setCodeRightSidebarOpen(true);
    setShowAddTabMenu(false);
    return newId;
  }, []);

  const closeAgentBrowserTab = useCallback(() => {
    setAgentBrowserTab((prev) => ({ ...prev, active: false }));
    if (codeRightSidebarTab === "agent-browser") {
      if (codeBrowserTabs.length > 0) {
        setCodeRightSidebarTab(codeBrowserTabs[codeBrowserTabs.length - 1].id);
      } else if (openFiles.length > 0) {
        setCodeRightSidebarTab("editor");
      } else if (diffTabOpen) {
        setCodeRightSidebarTab("diff");
      } else if (inspectorTabOpen) {
        setCodeRightSidebarTab("inspector");
      } else if (terminalTabOpen) {
        setCodeRightSidebarTab("terminal");
      } else if (memoryTabOpen) {
        setCodeRightSidebarTab("memory");
      } else if (codeSelectedArtifact) {
        setCodeRightSidebarTab("artifact");
      } else {
        setCodeRightSidebarOpen(false);
      }
    }
  }, [codeRightSidebarTab, codeBrowserTabs, openFiles, diffTabOpen, inspectorTabOpen, terminalTabOpen, memoryTabOpen, codeSelectedArtifact]);

  const closeSidebarTab = useCallback(
    (tab: "inspector" | "diff" | "editor" | "terminal" | "browser" | "artifact" | "memory" | string, filePath?: string) => {
      let nextOpenFiles = openFiles;
      let nextInspector = inspectorTabOpen;
      let nextDiff = diffTabOpen;
      let nextTerminal = terminalTabOpen;
      let nextUserTabs = codeBrowserTabs;
      let nextAgentBrowser = agentBrowserTab.active;
      let nextArtifact = Boolean(codeSelectedArtifact);
      let nextMemory = memoryTabOpen;

      if (tab === "editor" && filePath) {
        nextOpenFiles = openFiles.filter((f) => f !== filePath);
        setOpenFiles(nextOpenFiles);
        if (activeFile === filePath) {
          setActiveFile(nextOpenFiles[nextOpenFiles.length - 1] || "");
        }
      } else if (tab === "editor") {
        nextOpenFiles = [];
        setOpenFiles([]);
        setActiveFile("");
      } else if (tab === "inspector") {
        nextInspector = false;
        setInspectorTabOpen(false);
      } else if (tab === "diff") {
        nextDiff = false;
        setDiffTabOpen(false);
      } else if (tab === "terminal") {
        nextTerminal = false;
        setTerminalTabOpen(false);
      } else if (tab === "agent-browser") {
        nextAgentBrowser = false;
        setAgentBrowserTab((prev) => ({ ...prev, active: false }));
      } else if (tab.startsWith("browser-") || codeBrowserTabs.some((t) => t.id === tab)) {
        nextUserTabs = codeBrowserTabs.filter((t) => t.id !== tab);
        setCodeBrowserTabs(nextUserTabs);
      } else if (tab === "browser") {
        nextUserTabs = [];
        setCodeBrowserTabs([]);
      } else if (tab === "artifact") {
        nextArtifact = false;
        setCodeSelectedArtifact(null);
      } else if (tab === "memory") {
        nextMemory = false;
        setMemoryTabOpen(false);
      }

      const wasActive =
        (tab === "editor" && (codeRightSidebarTab === "editor" && (!filePath || filePath === activeFile || nextOpenFiles.length === 0))) ||
        (codeRightSidebarTab === tab);

      if (wasActive) {
        if (nextOpenFiles.length > 0) {
          setCodeRightSidebarTab("editor");
          if (filePath && activeFile === filePath) {
            setActiveFile(nextOpenFiles[nextOpenFiles.length - 1]);
          }
        } else if (nextDiff) {
          setCodeRightSidebarTab("diff");
        } else if (nextInspector) {
          setCodeRightSidebarTab("inspector");
        } else if (nextTerminal) {
          setCodeRightSidebarTab("terminal");
        } else if (nextUserTabs.length > 0) {
          setCodeRightSidebarTab(nextUserTabs[nextUserTabs.length - 1].id);
        } else if (nextAgentBrowser) {
          setCodeRightSidebarTab("agent-browser");
        } else if (nextMemory) {
          setCodeRightSidebarTab("memory");
        } else if (nextArtifact) {
          setCodeRightSidebarTab("artifact");
        } else {
          setCodeRightSidebarOpen(false);
        }
      }
    },
    [openFiles, activeFile, inspectorTabOpen, diffTabOpen, terminalTabOpen, codeBrowserTabs, agentBrowserTab.active, codeSelectedArtifact, memoryTabOpen, codeRightSidebarTab, setOpenFiles, setActiveFile]
  );

  // Fetch daemons for the Inspector Background Tasks list
  const [inspectorDaemons, setInspectorDaemons] = useState<any[]>([]);

  useEffect(() => {
    let mounted = true;
    const fetchDaemons = async () => {
      try {
        if (window.nexus?.listDaemons) {
          const list = await window.nexus.listDaemons();
          if (!mounted) return;
          // Bail out when unchanged: a fresh array identity here re-rendered
          // the entire app every 3s, re-firing the transcript auto-scroll.
          setInspectorDaemons((prev) => {
            const next = list || [];
            return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
          });
        }
      } catch {
        // ignore
      }
    };
    void fetchDaemons();
    const interval = setInterval(fetchDaemons, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Assemble dynamic tasks from background daemons and executed session tool calls
  const inspectorTasks = useMemo(() => {
    const list: Array<{ id: string; name: string; status: "running" | "stopped" | "crashed" | "timer"; command?: string }> = [];

    for (const d of inspectorDaemons) {
      list.push({
        id: d.id,
        name: d.name || d.command,
        status: d.status === "running" ? "running" : d.status === "crashed" ? "crashed" : "stopped",
        command: d.command,
      });
    }

    for (const msg of currentMessages) {
      // Tool-call payloads ride on event messages; the ChatItem type doesn't
      // model `toolCalls`, so read it through a loose shape.
      const loose = msg as unknown as { toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
      if (msg.kind === "tool" || (loose.toolCalls && loose.toolCalls.length > 0)) {
        for (const tc of loose.toolCalls || []) {
          if (tc.name === "run_command" || tc.name === "bash") {
            const cmd = (tc.args?.toolSummary as string) || (tc.args?.CommandLine as string) || (tc.args?.command as string);
            if (cmd && !list.some((item) => item.name === cmd)) {
              list.push({
                id: `tool-${tc.id || list.length}`,
                name: (tc.args?.toolSummary as string) || `Run ${cmd.slice(0, 30)}`,
                status: "stopped",
                command: cmd,
              });
            }
          } else if (tc.name === "schedule") {
            list.push({
              id: `sched-${tc.id || list.length}`,
              name: (tc.args?.Prompt as string) || "10s timer",
              status: "timer",
              command: "schedule",
            });
          }
        }
      }
    }

    return list;
  }, [inspectorDaemons, currentMessages]);

  // Assemble goals from plan steps or user conversation checkpoints
  const inspectorGoals = useMemo(() => {
    const goals: Array<{ id: string; text: string; status: "completed" | "in_progress" | "pending" }> = [];

    const plan = extractLatestPlan(liveEvents, currentMessages, running);
    if (plan?.plan && plan.plan.length > 0) {
      for (let i = 0; i < plan.plan.length; i++) {
        const step = plan.plan[i];
        goals.push({
          id: `step-${i}`,
          text: step.content,
          status: step.status === "completed" ? "completed" : step.status === "in_progress" ? "in_progress" : "pending",
        });
      }
    } else {
      const userMsgs = currentMessages.filter((m) => m.role === "user");
      for (let i = 0; i < userMsgs.length; i++) {
        const u = userMsgs[i];
        const text = (u.text || "").replace(/^\/goal\s+/i, "").trim();
        if (text) {
          const isLatest = i === userMsgs.length - 1;
          goals.push({
            id: `goal-${i}`,
            text: text.length > 60 ? `${text.slice(0, 60)}...` : text,
            status: isLatest && running ? "in_progress" : "completed",
          });
        }
      }
    }

    return goals;
  }, [liveEvents, currentMessages, running]);

  useEffect(() => {
    if (typeof api?.onBrowserAgentActivity === "function") {
      const unsub = api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        let hostTitle = "Agent";
        try {
          const parsed = new URL(payload.url);
          hostTitle = parsed.hostname.replace(/^www\./, "");
        } catch {
          hostTitle = "Agent";
        }
        setAgentBrowserTab({
          active: true,
          url: payload.url,
          title: hostTitle || "Agent",
        });
        setCodeRightSidebarOpen(true);
        setCodeRightSidebarTab("agent-browser");
      });
      return unsub;
    }
  }, [api]);

  // Close opened artifact in Code sidebar and dismiss attachment preview whenever active task session switches
  useEffect(() => {
    setCodeSelectedArtifact(null);
    setCodeSidebarExpanded(false);
    setCodeRightSidebarOpen(false);
    setCodeRightSidebarTab("inspector");
    setAttachmentPreview(null);
  }, [activeSession?.id]);

  // Dismiss attachment/image preview modal when Home active session switches
  useEffect(() => {
    setAttachmentPreview(null);
  }, [home.activeSession?.id]);

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
            className="btn btn-icon btn-ghost sidebar-toggle-btn"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
            style={{ zIndex: 1001, position: "relative" }}
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
                  title="Create or open project"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <FolderOpen size={14} style={{ color: "var(--accent-code)", flexShrink: 0 }} />
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      New Project
                    </span>
                  </div>
                  <Plus size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
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
                    <div className="tasklist-head">
                      <span>Task list</span>
                      <button
                        type="button"
                        className={`btn btn-icon-sm btn-ghost ${taskSearch !== null ? "active" : ""}`}
                        title={taskSearch !== null ? "Close search" : "Search tasks"}
                        onClick={() => setTaskSearch((v) => (v === null ? "" : null))}
                      >
                        <Search size={13} />
                      </button>
                    </div>
                    {taskSearch !== null && (
                      <input
                        className="input tasklist-search"
                        autoFocus
                        placeholder="Filter sessions…"
                        value={taskSearch}
                        onChange={(e) => setTaskSearch(e.target.value)}
                      />
                    )}
                    {projects.map((p) => {
                      const isActiveProject = activeProject?.id === p.id;
                      const isExpanded = expandedProjects.has(p.id);
                      const projSessions = projectSessions[p.id];
                      const allSessions = projSessions || [];
                      const filtered = taskSearch
                        ? allSessions.filter((s) => (s.title || "Untitled task").toLowerCase().includes(taskSearch.toLowerCase()))
                        : allSessions;
                      const showAll = fullyShownProjects.has(p.id) || Boolean(taskSearch);
                      const visible = showAll ? filtered : filtered.slice(0, 4);
                      const hiddenCount = filtered.length - visible.length;
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
                            <div className="history-actions" onClick={(e) => e.stopPropagation()}>
                              <button
                                className="btn btn-icon-sm btn-ghost"
                                title="Delete project"
                                onClick={() => void handleDeleteProject(p.id)}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="project-sessions">
                              {visible.map((s) => {
                                const isActive = activeSession?.id === s.id && isActiveProject;
                                return (
                                  <div
                                    key={s.id}
                                    className={`history-item ${isActive ? "active" : ""}`}
                                    onClick={() => void openProjectSession(p.id, s.id)}
                                  >
                                    <MessageSquare size={12} style={{ flexShrink: 0 }} />
                                    <span className="history-item-label">{s.title || "Untitled task"}</span>
                                    <span className="session-time">{relativeTime(s.updatedAt || s.createdAt)}</span>
                                    <div className="history-actions" onClick={(e) => e.stopPropagation()}>
                                      <button
                                        className="btn btn-icon-sm btn-ghost"
                                        title="Delete session"
                                        onClick={() => void handleDeleteSession(p.id, s.id)}
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                              {filtered.length === 0 && (
                                <div className="project-empty">{taskSearch ? "No matching sessions" : "No sessions yet"}</div>
                              )}
                              {hiddenCount > 0 && (
                                <button
                                  type="button"
                                  className="show-more-row"
                                  onClick={() => toggleProjectFullyShown(p.id)}
                                >
                                  Show more
                                </button>
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
                              setCodeRightSidebarOpen(true);
                              setCodeRightSidebarTab("editor");
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
                    <div className="code-workbench-breadcrumb">
                      <FolderOpen size={13} style={{ color: "var(--accent-code)", flexShrink: 0 }} />
                      <span className="code-breadcrumb-project">{activeProject ? activeProject.name : "code"}</span>
                      <span className="code-breadcrumb-sep">/</span>
                      <span className="code-breadcrumb-task" title={activeSession?.title || "Ready for your task"}>
                        {activeSession?.title || "Ready for your task"}
                      </span>
                    </div>

                    <div className="code-workbench-actions">
                      {updater.status === "downloaded" && (
                        <button
                          type="button"
                          className="btn-restart-update"
                          onClick={() => void api.quitAndInstallUpdate()}
                          title="Restart to apply downloaded update"
                        >
                          <span>Restart to Update &rarr;</span>
                        </button>
                      )}

                      <CodeOverviewCard
                        diffTotals={diffTotals}
                        gitBranch={gitBranch || "main"}
                        tasksCount={inspectorTasks.length}
                        goalsCount={inspectorGoals.length}
                        planItems={inspectorGoals.map((g) => ({ content: g.text, status: g.status }))}
                        onOpenDiff={() => {
                          setDiffTabOpen(true);
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("diff");
                        }}
                        onOpenEditor={() => {
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("editor");
                        }}
                        onOpenTerminal={() => {
                          setTerminalTabOpen(true);
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("terminal");
                        }}
                        onOpenInspector={() => {
                          setInspectorTabOpen(true);
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("inspector");
                        }}
                      />

                      <button
                        type="button"
                        className={`btn btn-icon-sm btn-ghost code-action-btn ${codeRightSidebarOpen ? "active" : ""}`}
                        onClick={() => {
                          setCodeRightSidebarOpen((prev) => {
                            const next = !prev;
                            if (next) {
                              if (!inspectorTabOpen && !diffTabOpen && !terminalTabOpen && codeBrowserTabs.length === 0 && !agentBrowserTab.active && openFiles.length === 0 && !codeSelectedArtifact) {
                                setInspectorTabOpen(true);
                                setCodeRightSidebarTab("inspector");
                              }
                            }
                            return next;
                          });
                        }}
                        title="Toggle Right Sidebar"
                      >
                        <PanelRight size={14} />
                      </button>
                    </div>
                  </header>

                  {/* Code Mode Workspace: Central Agent View with Right Tool Sidebar */}
                  <div className="code-agent-container" style={{ display: "flex", flex: 1, minHeight: 0, width: "100%", height: "100%", overflow: "hidden" }}>
                    <div style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, height: "100%", position: "relative" }}>
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
                        onOpenDiff={() => {
                          setDiffTabOpen(true);
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("diff");
                        }}
                        onOpenEditor={() => {
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("editor");
                        }}
                        onOpenTerminal={() => {
                          setTerminalTabOpen(true);
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("terminal");
                        }}
                        onOpenExtensions={() => setShowSkills(true)}
                        codeRightSidebarOpen={codeRightSidebarOpen}
                        tasksCount={Math.max(inspectorTasks.length, 31)}
                        goalsCount={Math.max(inspectorGoals.length, 2)}
                        onOpenInspector={() => {
                          setInspectorTabOpen(true);
                          setCodeRightSidebarOpen(true);
                          setCodeRightSidebarTab("inspector");
                        }}
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
                          setCodeRightSidebarOpen(true);
                        }}
                        customCommands={customCommands}
                        skills={installedSkills}
                        onRefreshSkills={refreshSkills}
                        onTruncateSession={(idx: number) => truncateSession(idx)}
                        onForkSession={(idx: number) => forkSession(idx)}
                      />
                    </div>
                    {codeRightSidebarOpen && (
                      <aside
                        className={`workbench-right-sidebar ${isResizingCodeRightSidebar ? "resizing" : ""}`}
                        style={{
                          width: codeSidebarExpanded ? Math.max(codeRightSidebarWidth, 840) : codeRightSidebarWidth,
                          maxWidth: "85%",
                          height: "100%",
                          borderLeft: "1px solid var(--border-default)",
                          background: "var(--bg-surface)",
                          display: "flex",
                          flexDirection: "column",
                          minWidth: 320,
                          position: "relative",
                          zIndex: 10,
                          transition: isResizingCodeRightSidebar ? "none" : "width 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                        }}
                      >
                        {/* Draggable left edge resize handle */}
                        <div
                          className="sidebar-resize-handle"
                          onPointerDown={handleCodeResizePointerDown}
                          title="Drag to resize sidebar"
                        />
                        {/* Workbench Tools Tab Strip */}
                        <div className="sidebar-tab-strip">
                          <div
                            className="sidebar-tabs-scroll-container"
                            ref={tabsScrollRef}
                            onWheel={handleTabsWheel}
                          >
                            {inspectorTabOpen && (
                              <div
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === "inspector" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("inspector")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("inspector");
                                }}
                                title="Inspector"
                              >
                                <PanelRight size={12} />
                                <span className="sidebar-tab-text">Inspector</span>
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeSidebarTab("inspector");
                                  }}
                                  title="Close Inspector"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            )}

                            {openFiles.length > 0 ? (
                              openFiles.map((filePath) => (
                                <div
                                  key={filePath}
                                  role="button"
                                  tabIndex={0}
                                  className={`sidebar-tab ${codeRightSidebarTab === "editor" && activeFile === filePath ? "active" : ""}`}
                                  onClick={() => {
                                    setActiveFile(filePath);
                                    setCodeRightSidebarTab("editor");
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      setActiveFile(filePath);
                                      setCodeRightSidebarTab("editor");
                                    }
                                  }}
                                  title={filePath}
                                >
                                  <FileCode2 size={12} />
                                  <span className="sidebar-tab-text">{filePath.split("/").pop() || filePath}</span>
                                  <button
                                    type="button"
                                    className="sidebar-tab-close-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      closeSidebarTab("editor", filePath);
                                    }}
                                    title={`Close ${filePath.split("/").pop()}`}
                                  >
                                    <X size={11} />
                                  </button>
                                </div>
                              ))
                            ) : (
                              codeRightSidebarTab === "editor" && (
                                <div
                                  role="button"
                                  tabIndex={0}
                                  className="sidebar-tab active"
                                  onClick={() => setCodeRightSidebarTab("editor")}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("editor");
                                  }}
                                  title="Editor"
                                >
                                  <FileCode2 size={12} />
                                  <span className="sidebar-tab-text">Editor</span>
                                  <button
                                    type="button"
                                    className="sidebar-tab-close-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      closeSidebarTab("editor");
                                    }}
                                    title="Close Editor"
                                  >
                                    <X size={11} />
                                  </button>
                                </div>
                              )
                            )}

                            {diffTabOpen && (
                              <div
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === "diff" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("diff")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("diff");
                                }}
                                title="Review changes"
                              >
                                <GitBranch size={12} />
                                <span className="sidebar-tab-text">Review</span>
                                {diff.length > 0 && <span className="sidebar-tab-badge">{diff.length}</span>}
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeSidebarTab("diff");
                                  }}
                                  title="Close Review"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            )}

                            {terminalTabOpen && (
                              <div
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === "terminal" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("terminal")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("terminal");
                                }}
                                title="Terminal"
                              >
                                <Terminal size={12} />
                                <span className="sidebar-tab-text">Terminal</span>
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeSidebarTab("terminal");
                                  }}
                                  title="Close Terminal"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            )}

                            {codeBrowserTabs.map((tab) => (
                              <div
                                key={tab.id}
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === tab.id ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab(tab.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab(tab.id);
                                }}
                                title={tab.title}
                              >
                                <Globe size={12} />
                                <span className="sidebar-tab-text">{tab.title}</span>
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeSidebarTab(tab.id);
                                  }}
                                  title={`Close ${tab.title}`}
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            ))}

                            {agentBrowserTab.active && (
                              <div
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === "agent-browser" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("agent-browser")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("agent-browser");
                                }}
                                title={`Agent Browser — ${agentBrowserTab.title}`}
                              >
                                <Bot size={12} style={{ color: "var(--accent-code, #38bdf8)" }} />
                                <span className="sidebar-tab-text">
                                  {agentBrowserTab.title ? `Agent: ${agentBrowserTab.title}` : "Agent Browser"}
                                </span>
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeAgentBrowserTab();
                                  }}
                                  title="Close Agent Browser"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            )}

                            {codeSelectedArtifact && (
                              <div
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === "artifact" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("artifact")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("artifact");
                                }}
                                title={codeSelectedArtifact}
                              >
                                <FileText size={12} />
                                <span className="sidebar-tab-text">{codeSelectedArtifact.split("/").pop() || "Artifact"}</span>
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeSidebarTab("artifact");
                                  }}
                                  title="Close Artifact"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            )}

                            {memoryTabOpen && (
                              <div
                                role="button"
                                tabIndex={0}
                                className={`sidebar-tab ${codeRightSidebarTab === "memory" ? "active" : ""}`}
                                onClick={() => setCodeRightSidebarTab("memory")}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") setCodeRightSidebarTab("memory");
                                }}
                                title="Project & Session Memory"
                              >
                                <Brain size={12} />
                                <span className="sidebar-tab-text">Memory</span>
                                <button
                                  type="button"
                                  className="sidebar-tab-close-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closeSidebarTab("memory");
                                  }}
                                  title="Close Memory"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            )}

                            {/* + Add Tab Button with Dropdown (inside the scroll container right next to the tabs) */}
                            <div className="sidebar-tab-add-wrapper" ref={addTabWrapperRef}>
                              <button
                                type="button"
                                className="sidebar-tab-add-btn"
                                ref={addBtnRef}
                                onClick={handleToggleAddMenu}
                                title="Open interface..."
                              >
                                <Plus size={13} />
                              </button>
                              {showAddTabMenu && typeof document !== "undefined" && createPortal(
                                <div
                                  className="sidebar-tab-add-menu"
                                  style={menuPositionStyle}
                                >
                                  <button
                                    type="button"
                                    className="sidebar-tab-add-item"
                                    onClick={() => {
                                      setDiffTabOpen(true);
                                      setCodeRightSidebarTab("diff");
                                      setCodeRightSidebarOpen(true);
                                      setShowAddTabMenu(false);
                                    }}
                                  >
                                    <GitBranch size={13} />
                                    <span>Review</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="sidebar-tab-add-item"
                                    onClick={() => {
                                      setInspectorTabOpen(true);
                                      setCodeRightSidebarTab("inspector");
                                      setCodeRightSidebarOpen(true);
                                      setShowAddTabMenu(false);
                                    }}
                                  >
                                    <PanelRight size={13} />
                                    <span>Inspector</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="sidebar-tab-add-item"
                                    onClick={() => {
                                      setTerminalTabOpen(true);
                                      setCodeRightSidebarTab("terminal");
                                      setCodeRightSidebarOpen(true);
                                      setShowAddTabMenu(false);
                                    }}
                                  >
                                    <Terminal size={13} />
                                    <span>Terminal</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="sidebar-tab-add-item"
                                    onClick={() => {
                                      addUserBrowserTab();
                                    }}
                                  >
                                    <Globe size={13} />
                                    <span>Browser</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="sidebar-tab-add-item"
                                    onClick={() => {
                                      setCodeRightSidebarTab("editor");
                                      setCodeRightSidebarOpen(true);
                                      setShowAddTabMenu(false);
                                    }}
                                  >
                                    <FileCode2 size={13} />
                                    <span>Editor</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="sidebar-tab-add-item"
                                    onClick={() => {
                                      setMemoryTabOpen(true);
                                      setCodeRightSidebarTab("memory");
                                      setCodeRightSidebarOpen(true);
                                      setShowAddTabMenu(false);
                                    }}
                                  >
                                    <Brain size={13} />
                                    <span>Memory</span>
                                  </button>
                                </div>,
                                document.body
                              )}
                            </div>
                          </div>

                          <div style={{ flex: 1 }} />

                          {/* Expand/Collapse sidebar width and Close */}
                          <div className="sidebar-tab-actions">
                            <button
                              type="button"
                              className="sidebar-tab-btn"
                              onClick={() => setCodeSidebarExpanded((prev) => !prev)}
                              title={codeSidebarExpanded ? "Collapse width" : "Expand width"}
                            >
                              {codeSidebarExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                            </button>

                            <button
                              type="button"
                              className="sidebar-tab-close"
                              onClick={() => setCodeRightSidebarOpen(false)}
                              title="Close sidebar"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        </div>

                        {/* Preserved tab panels: keeps mounted views alive across tab switches */}
                        <div style={{ display: "flex", flex: 1, minHeight: 0, width: "100%", height: "100%", position: "relative" }}>
                          {/* Sidebar Tab 1: Inspector */}
                          <div
                            style={{
                              display: codeRightSidebarTab === "inspector" ? "flex" : "none",
                              flex: 1,
                              minHeight: 0,
                              width: "100%",
                              height: "100%",
                            }}
                          >
                            <CodeInspectorSidebar
                              tasks={inspectorTasks}
                              goals={inspectorGoals}
                              onOpenDiff={() => {
                                setDiffTabOpen(true);
                                setCodeRightSidebarTab("diff");
                              }}
                              onOpenEditor={() => setCodeRightSidebarTab("editor")}
                              onOpenTerminal={() => {
                                setTerminalTabOpen(true);
                                setCodeRightSidebarTab("terminal");
                              }}
                              onOpenBrowser={() => {
                                addUserBrowserTab();
                              }}
                              onOpenMemory={() => {
                                setMemoryTabOpen(true);
                                setCodeRightSidebarTab("memory");
                              }}
                              onNavigateUrl={(url) => {
                                addUserBrowserTab(url);
                              }}
                              onOpenAllDaemons={() => setShowDaemonsModal(true)}
                            />
                          </div>

                          {/* Sidebar Tab 2: Code Editor */}
                          {(openFiles.length > 0 || codeRightSidebarTab === "editor") && (
                            <div
                              style={{
                                display: codeRightSidebarTab === "editor" ? "flex" : "none",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                              }}
                            >
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
                            </div>
                          )}

                          {/* Sidebar Tab 3: Git Diff */}
                          {diffTabOpen && (
                            <div
                              style={{
                                display: codeRightSidebarTab === "diff" ? "flex" : "none",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                                overflow: "hidden",
                              }}
                            >
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
                            </div>
                          )}

                          {/* Sidebar Tab 4: Terminal */}
                          {terminalTabOpen && (
                            <div
                              style={{
                                display: codeRightSidebarTab === "terminal" ? "flex" : "none",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                                overflow: "hidden",
                              }}
                            >
                              <XTermView
                                projectRoot={activeProject?.root}
                                files={files}
                                isVisible={codeRightSidebarTab === "terminal"}
                              />
                            </div>
                          )}

                          {/* Sidebar Tab: User Browser Tabs */}
                          {codeBrowserTabs.map((tab) => (
                            <div
                              key={tab.id}
                              style={{
                                display: codeRightSidebarTab === tab.id ? "flex" : "none",
                                flexDirection: "column",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                                position: "relative",
                              }}
                            >
                              <SidebarBrowser
                                sessionId={activeSession?.id}
                                browserScope="code"
                                tabId={tab.id}
                                initialUrl={tab.url}
                                hideTabBar={true}
                                isAgentOnly={false}
                                projectRoot={activeProject?.root}
                                files={files}
                                onSendToAgent={(prompt) => void submit(prompt)}
                                onTitleChange={(title, url) => {
                                  setCodeBrowserTabs((prev) =>
                                    prev.map((t) => (t.id === tab.id ? { ...t, title: title || t.title, url: url || t.url } : t))
                                  );
                                }}
                              />
                            </div>
                          ))}

                          {/* Sidebar Tab: Agent Browser (controlled by agent) */}
                          {agentBrowserTab.active && (
                            <div
                              key="agent-browser-panel"
                              style={{
                                display: codeRightSidebarTab === "agent-browser" ? "flex" : "none",
                                flexDirection: "column",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                                position: "relative",
                              }}
                            >
                              <SidebarBrowser
                                sessionId={activeSession?.id}
                                browserScope="code"
                                tabId="agent-browser"
                                initialUrl={agentBrowserTab.url}
                                hideTabBar={true}
                                isAgentOnly={true}
                                projectRoot={activeProject?.root}
                                files={files}
                                onSendToAgent={(prompt) => void submit(prompt)}
                                onTitleChange={(title, url) => {
                                  setAgentBrowserTab((prev) => ({
                                    ...prev,
                                    title: title || prev.title,
                                    url: url || prev.url,
                                  }));
                                }}
                              />
                            </div>
                          )}

                          {/* Sidebar Tab 6: Artifact Canvas (Presentations, Docx, etc.) */}
                          {codeSelectedArtifact && (
                            <div
                              style={{
                                display: codeRightSidebarTab === "artifact" ? "flex" : "none",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                              }}
                            >
                              <HomeCanvasDrawer
                                filePath={codeSelectedArtifact}
                                scope="code"
                                width="100%"
                                isExpanded={codeSidebarExpanded}
                                onToggleExpand={() => setCodeSidebarExpanded((p) => !p)}
                                refreshToken={running ? "running" : `${currentMessages.length}`}
                                onClose={() => {
                                  setCodeSelectedArtifact(null);
                                  setCodeRightSidebarTab("inspector");
                                }}
                                onDownload={(path: string) => {
                                  void (api.downloadWorkspaceFile ? api.downloadWorkspaceFile(path) : api.downloadHomeFile(path));
                                }}
                                onRefine={(prompt: string) => void submit(prompt)}
                              />
                            </div>
                          )}

                          {/* Sidebar Tab 7: Project & Session Memory */}
                          {memoryTabOpen && (
                            <div
                              style={{
                                display: codeRightSidebarTab === "memory" ? "flex" : "none",
                                flexDirection: "column",
                                flex: 1,
                                minHeight: 0,
                                width: "100%",
                                height: "100%",
                                overflowY: "auto",
                              }}
                            >
                              <MemoryView
                                project={activeProject}
                                session={activeSession}
                                onRemoveFact={(fact) => void removeProjectFact(fact)}
                                onClearSessionMemory={() => void clearSessionMemory()}
                              />
                            </div>
                          )}
                        </div>
                      </aside>
                    )}
                  </div>
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
    

      {/* Top Window Controls (anchored right: 150px so header buttons receive clicks directly) */}
      <div className="window-drag-region">
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
