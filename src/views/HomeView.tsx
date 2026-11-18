import React, { lazy, Suspense, useRef, useState, useEffect, useMemo, useCallback, KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, Paperclip, ArrowUp, Square, Search, BarChart3, FileText,
  X, Presentation, Table2, Globe, Code2, PanelRight, Plus, Terminal, Brain, Bot,
  Maximize2, Minimize2
} from "lucide-react";
import { suggestsCodeMode } from "../utils/modeSuggestion.js";
import { ChatItemView, StreamingAssistantMessage, ActivityGroupView } from "../components/chat/ChatMessageItem.js";
import { SlashCommandPopup, filterSlashCommands, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { ATTACHMENT_ACCEPT } from "../utils/attachments.js";
import { insertAtCursor } from "../utils/textarea.js";
import { useAutosizeTextarea } from "../state/useComposer.js";
import { ChatShell } from "../components/chat/ChatShell.js";
import type { ChatItem, ProviderConfig, ProviderDefinition, ChatAttachment, SkillInfo, AgentUsage, AgentContextUsageSnapshot, ArtifactItem, SessionRecord } from "../types.js";
import type { HomeMemoryStructureView } from "../state/useHomeController.js";
import { SlidingPlanDrawer, extractLatestPlan } from "../components/chat/SlidingPlanDrawer.js";
import { HomeCanvasDrawer } from "../components/home/HomeCanvasDrawer.js";
import { SidebarBrowser } from "../components/browser/SidebarBrowser.js";
import { CodeInspectorSidebar } from "../components/code/CodeInspectorSidebar.js";
import { MemoryView } from "./MemoryView.js";
import { buildInspectorGoals, buildInspectorTasks } from "../utils/inspector.js";
import { ModelSelect } from "./AgentView.js";

const XTermView = lazy(() => import("../components/terminal/XTermView.js").then((module) => ({ default: module.XTermView })));

type RenderBlock =
  | { kind: "message"; message: ChatItem; index: number; artifacts?: ArtifactItem[] }
  | { kind: "events"; events: ChatItem[]; startIndex: number };

export type HomeFile = { path: string; name: string; size: number; modified: string };

export interface HomeViewProps {
  messages: ChatItem[];
  draft: string;
  setDraft: (value: string) => void;
  submit: (override?: string) => void;
  running: boolean;
  onStop: () => void;
  streamingText: string;
  liveEvents: ChatItem[];
  selectedProviderId: string;
  selectedModel: string;
  selectedEffort?: string;
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  switchModel: (providerId: string, model: string, effort?: string) => void;
  switchEffort?: (effort: string) => void;
  onOpenProviders: () => void;
  sessionUsage?: AgentUsage | null;
  contextUsage?: AgentContextUsageSnapshot | null;
  activeSessionId?: string;
  sessionTitle?: string;
  panelMenu?: ReactNode;
  topbarLeading?: ReactNode;
  onDownloadFile?: (path: string) => void;
  attachedImages: string[];
  setAttachedImages: (updater: (current: string[]) => string[]) => void;
  attachments: ChatAttachment[];
  setAttachments: (updater: (current: ChatAttachment[]) => ChatAttachment[]) => void;
  hasProvider: boolean;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
  customCommands?: SlashCommand[];
  skills?: SkillInfo[];
  onRefreshSkills?: () => void;
  onTruncateSession?: (fromIndex: number) => Promise<any>;
  onForkSession?: (fromIndex: number) => Promise<any>;
  /** Phase 5 mode routing: hands the current draft to Code mode (App switches
   *  the area and seeds the Code composer). */
  onHandoffToCode?: (draft: string) => void;
  daemons?: Array<{ id: string; name?: string; command: string; status: string }>;
  onOpenAllDaemons?: () => void;
  homeMemory?: string;
  homeStructure?: HomeMemoryStructureView | null;
  activeSession?: SessionRecord | null;
  onRemoveHomeFact?: (category: string, fact: string) => void;
  onClearSessionMemory?: () => void;
}

const TOOL_PILLS = [
  { id: "search", label: "Search", icon: <Search size={13} />, prefix: "Search the web for: ", placeholder: "Search the web for current facts, news, or sources..." },
  { id: "visualize", label: "Visualize", icon: <BarChart3 size={13} />, prefix: "Create an interactive visual diagram or chart for: ", placeholder: "Describe the chart, graph, or interactive widget to build..." },
  { id: "document", label: "Document", icon: <FileText size={13} />, prefix: "Create a polished document deliverable for: ", placeholder: "Describe the report (.docx/.pdf), slide deck (.pptx), or sheet (.xlsx)..." },
  { id: "research", label: "Deep Research", icon: <Sparkles size={13} />, prefix: "Conduct deep multi-source research with citations on: ", placeholder: "Ask a complex topic for deep multi-source web research..." },
];

const STARTER_PROMPTS = [
  {
    icon: <FileText size={16} />,
    title: "Write a comprehensive report",
    desc: "Generate a formatted document with clear sections & data tables",
    prompt: "Write a comprehensive research report on ",
  },
  {
    icon: <Presentation size={16} />,
    title: "Build a slide presentation",
    desc: "Create an outline and slides for a deck (.pptx)",
    prompt: "Create a detailed presentation outline with slide notes on ",
  },
  {
    icon: <Table2 size={16} />,
    title: "Create data tables & analysis",
    desc: "Structured data tables, metrics, and comparisons",
    prompt: "Create a structured comparison spreadsheet (.xlsx) analyzing ",
  },
  {
    icon: <Search size={16} />,
    title: "Deep multi-source web research",
    desc: "Gather facts, live sources, benchmarks, and citations",
    prompt: "Conduct in-depth web research with sources and citations on ",
  },
];

export function HomeView({
  messages,
  draft,
  setDraft,
  submit,
  running,
  onStop,
  streamingText,
  liveEvents,
  selectedProviderId,
  selectedModel,
  selectedEffort,
  providers,
  definitions,
  switchModel,
  switchEffort,
  onOpenProviders,
  sessionUsage,
  contextUsage,
  activeSessionId,
  sessionTitle,
  panelMenu,
  topbarLeading,
  onDownloadFile,
  attachedImages,
  setAttachedImages,
  attachments,
  setAttachments,
  hasProvider,
  onOpenImage,
  onOpenAttachment,
  customCommands = [],
  onTruncateSession,
  onForkSession,
  onHandoffToCode,
  daemons = [],
  onOpenAllDaemons,
  homeMemory = "",
  homeStructure,
  activeSession = null,
  onRemoveHomeFact,
  onClearSessionMemory,
}: HomeViewProps) {
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activePill, setActivePill] = useState<string | null>(null);
  const [selectedCanvasFile, setSelectedCanvasFile] = useState<string | null>(null);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [rightSidebarTab, setRightSidebarTab] = useState<string>("inspector");
  const [inspectorTabOpen, setInspectorTabOpen] = useState(true);
  const [terminalTabOpen, setTerminalTabOpen] = useState(false);
  const [memoryTabOpen, setMemoryTabOpen] = useState(false);
  const [browserTabs, setBrowserTabs] = useState<Array<{ id: string; url: string; title: string }>>([]);
  const [agentBrowserTab, setAgentBrowserTab] = useState<{ active: boolean; url: string; title: string }>({
    active: false,
    url: "",
    title: "",
  });
  const [showAddTabMenu, setShowAddTabMenu] = useState(false);
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const addTabWrapperRef = useRef<HTMLDivElement | null>(null);
  const [menuPositionStyle, setMenuPositionStyle] = useState<React.CSSProperties>({});
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(false);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("nexus_home_right_sidebar_width");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 320 && parsed <= 1600) return parsed;
      }
    } catch {
      // ignore
    }
    return 480;
  });
  const [isResizingRightSidebar, setIsResizingRightSidebar] = useState(false);

  const handleResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingRightSidebar(true);
    document.body.classList.add("sidebar-resizing-active");

    const startX = e.clientX;
    const startWidth = rightSidebarWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const maxWidth = Math.max(340, Math.floor(window.innerWidth * 0.85));
      const nextWidth = Math.max(320, Math.min(maxWidth, startWidth + delta));
      setRightSidebarWidth(nextWidth);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.classList.remove("sidebar-resizing-active");
      setIsResizingRightSidebar(false);
      const delta = startX - upEvent.clientX;
      const maxWidth = Math.max(340, Math.floor(window.innerWidth * 0.85));
      const finalWidth = Math.max(320, Math.min(maxWidth, startWidth + delta));
      try {
        localStorage.setItem("nexus_home_right_sidebar_width", String(finalWidth));
      } catch {
        // ignore
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [rightSidebarWidth]);

  // Close opened artifact/file in sidebar whenever active session switches
  useEffect(() => {
    setSelectedCanvasFile(null);
    setIsSidebarExpanded(false);
    setRightSidebarOpen(false);
    setRightSidebarTab("inspector");
  }, [activeSessionId]);

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

  useEffect(() => {
    const activeEl = tabsScrollRef.current?.querySelector(".sidebar-tab.active");
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [rightSidebarTab]);

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
    setBrowserTabs((prev) => [...prev, { id: newId, url: targetUrl, title: hostTitle || "Browser" }]);
    setRightSidebarTab(newId);
    setRightSidebarOpen(true);
    setShowAddTabMenu(false);
    return newId;
  }, []);

  const closeAgentBrowserTab = useCallback(() => {
    setAgentBrowserTab((prev) => ({ ...prev, active: false }));
    if (rightSidebarTab === "agent-browser") {
      if (browserTabs.length > 0) {
        setRightSidebarTab(browserTabs[browserTabs.length - 1].id);
      } else if (inspectorTabOpen) {
        setRightSidebarTab("inspector");
      } else if (terminalTabOpen) {
        setRightSidebarTab("terminal");
      } else if (memoryTabOpen) {
        setRightSidebarTab("memory");
      } else if (selectedCanvasFile) {
        setRightSidebarTab("artifact");
      } else {
        setRightSidebarOpen(false);
      }
    }
  }, [rightSidebarTab, browserTabs, inspectorTabOpen, terminalTabOpen, memoryTabOpen, selectedCanvasFile]);

  const closeSidebarTab = useCallback(
    (tab: string) => {
      let nextInspector = inspectorTabOpen;
      let nextTerminal = terminalTabOpen;
      let nextUserTabs = browserTabs;
      let nextAgentBrowser = agentBrowserTab.active;
      let nextArtifact = Boolean(selectedCanvasFile);
      let nextMemory = memoryTabOpen;

      if (tab === "inspector") {
        nextInspector = false;
        setInspectorTabOpen(false);
      } else if (tab === "terminal") {
        nextTerminal = false;
        setTerminalTabOpen(false);
      } else if (tab === "agent-browser") {
        nextAgentBrowser = false;
        setAgentBrowserTab((prev) => ({ ...prev, active: false }));
      } else if (tab.startsWith("browser-") || browserTabs.some((t) => t.id === tab)) {
        nextUserTabs = browserTabs.filter((t) => t.id !== tab);
        setBrowserTabs(nextUserTabs);
      } else if (tab === "artifact") {
        nextArtifact = false;
        setSelectedCanvasFile(null);
      } else if (tab === "memory") {
        nextMemory = false;
        setMemoryTabOpen(false);
      }

      if (rightSidebarTab === tab) {
        if (nextInspector) {
          setRightSidebarTab("inspector");
        } else if (nextTerminal) {
          setRightSidebarTab("terminal");
        } else if (nextUserTabs.length > 0) {
          setRightSidebarTab(nextUserTabs[nextUserTabs.length - 1].id);
        } else if (nextAgentBrowser) {
          setRightSidebarTab("agent-browser");
        } else if (nextMemory) {
          setRightSidebarTab("memory");
        } else if (nextArtifact) {
          setRightSidebarTab("artifact");
        } else {
          setRightSidebarOpen(false);
        }
      }
    },
    [inspectorTabOpen, terminalTabOpen, browserTabs, agentBrowserTab.active, selectedCanvasFile, memoryTabOpen, rightSidebarTab]
  );

  // Automatically follow browser agent activity in Watching mode
  useEffect(() => {
    const api = window.nexus;
    if (typeof api?.onBrowserAgentActivity === "function") {
      const unsub = api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        if (payload.autoFollow !== false) {
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
          setRightSidebarOpen(true);
          setRightSidebarTab("agent-browser");
        }
      });
      return unsub;
    }
  }, []);

  const inspectorTasks = useMemo(
    () => buildInspectorTasks(daemons, messages),
    [daemons, messages]
  );

  const inspectorGoals = useMemo(
    () => buildInspectorGoals(liveEvents, messages, running),
    [liveEvents, messages, running]
  );

  const handleRemoveHomeFact = useCallback(
    (fact: string) => {
      if (!onRemoveHomeFact) return;
      let category = "Remembered Facts";
      if (homeStructure) {
        if (homeStructure.profile.includes(fact)) category = "User Profile";
        else if (homeStructure.preferences.includes(fact)) category = "Preferences";
        else if (homeStructure.lessons?.includes(fact)) category = "Learned Patterns & Lessons";
        else if (homeStructure.context.includes(fact)) category = "Project Context";
        else if (homeStructure.facts.includes(fact)) category = "Remembered Facts";
      }
      onRemoveHomeFact(category, fact);
    },
    [onRemoveHomeFact, homeStructure]
  );

  // Group messages & events into RenderBlocks so tool runs collapse cleanly into ActivityGroupView
  const renderBlocks = useMemo<RenderBlock[]>(() => {
    const blocks: RenderBlock[] = [];
    let pendingEvents: ChatItem[] = [];
    let pendingArtifacts: ArtifactItem[] = [];

    messages.forEach((message, index) => {
      if (message.role === "event") {
        pendingEvents.push(message);
        if (message.artifact) {
          pendingArtifacts.push(message.artifact);
        }
      } else {
        if (pendingEvents.length > 0) {
          blocks.push({
            kind: "events",
            events: pendingEvents,
            startIndex: index - pendingEvents.length,
          });
          pendingEvents = [];
        }
        blocks.push({
          kind: "message",
          message,
          index,
          artifacts: message.role === "assistant" && pendingArtifacts.length > 0 ? [...pendingArtifacts] : undefined,
        });
        if (message.role === "assistant") {
          pendingArtifacts = [];
        }
      }
    });

    if (pendingEvents.length > 0) {
      blocks.push({
        kind: "events",
        events: pendingEvents,
        startIndex: messages.length - pendingEvents.length,
      });
    }

    return blocks;
  }, [messages]);

  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useCallback((smooth = false) => {
    if (bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
    } else if (messagesViewportRef.current) {
      messagesViewportRef.current.scrollTop = messagesViewportRef.current.scrollHeight;
    }
  }, []);

  // Scroll contract (stick flag, autoscroll, lazy-visual re-pin) is owned by
  // ChatShell; the stick ref stays here because slash-command submits
  // force-pin before sending.
  const stickToBottomRef = useRef(true);

  // Clean auto-resize textarea (shared composer hook, Home-tuned 26-160px)
  useAutosizeTextarea(textareaRef, draft, { min: 26, max: 160 });

  const isEmpty = messages.length === 0 && !streamingText && liveEvents.length === 0;
  const matchingCommands = slashQuery !== null ? filterSlashCommands(slashQuery, customCommands) : [];

  const handleSlashSelect = (cmd: SlashCommand) => {
    const result = insertAtCursor(textareaRef.current, draft, /(?:^|\s)\/([a-zA-Z0-9_-]*)$/, (match) => {
      const leadingWhitespace = match.match(/^\s/)?.[0] || "";
      return `${leadingWhitespace}${cmd.command} `;
    });
    if (!result) return;
    setDraft(result.nextDraft);
    setSlashQuery(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQuery !== null && matchingCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % matchingCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + matchingCommands.length) % matchingCommands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handleSlashSelect(matchingCommands[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        setSlashQuery(null);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!running && (draft.trim() || attachments.length > 0)) {

        let submitOverride: string | undefined;
        const pillObj = TOOL_PILLS.find((p) => p.id === activePill);
        if (pillObj && draft.trim() && !draft.startsWith(pillObj.prefix)) {
          submitOverride = `${pillObj.prefix}${draft.trim()}`;
        }
        stickToBottomRef.current = true;
        scrollToBottom(true);
        submit(submitOverride);
        setActivePill(null);
        setSlashQuery(null);
      }
    }
  };

  const handleApplyToolPill = (pill: typeof TOOL_PILLS[0]) => {
    if (activePill === pill.id) {
      setActivePill(null);
      if (draft.startsWith(pill.prefix)) {
        // Keep user draft clean without mutating text
      }
    } else {
      setActivePill(pill.id);
      if (!draft.startsWith(pill.prefix)) {
        // Mode guidance is applied cleanly on submit
      }
    }
    textareaRef.current?.focus();
  };

  const saveAndAttachFile = (file: File, fallbackName?: string) => {
    const fileName = file.name || fallbackName || "attachment";
    const mimeType = file.type || "application/octet-stream";
    const isImage = mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(fileName);
    const api = typeof window !== "undefined" ? window.nexus : undefined;
    const reader = new FileReader();
    reader.onload = async () => {
      const rawUrl = reader.result as string;
      if (!rawUrl) return;
      let url = rawUrl;
      if (api?.saveAttachment) {
        try {
          const saved = await api.saveAttachment(rawUrl, fileName);
          url = saved.url;
        } catch { /* fallback to rawUrl if saveAttachment fails */ }
      }
      setAttachments((prev) => [
        ...prev,
        { name: fileName, size: file.size, mimeType, url },
      ]);
      if (isImage) {
        setAttachedImages((prev) => [...prev, url]);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      saveAndAttachFile(files[i]);
    }
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) saveAndAttachFile(file, "pasted-image.png");
      }
    }
  };

  const latestPlan = extractLatestPlan(liveEvents);

  return (
    <div className="home-container">
      {/* Top Minimal Strip spanning full width */}
      <header className="home-topbar">
        <div className="home-topbar-left">
          {topbarLeading}
          {sessionTitle && (
            <span className="home-session-title">{sessionTitle}</span>
          )}
        </div>

        <div className="home-topbar-right">
          {panelMenu}
          <button
            type="button"
            className={`btn btn-icon-sm btn-ghost code-action-btn ${rightSidebarOpen ? "active" : ""}`}
            onClick={() => {
              setRightSidebarOpen((prev) => {
                const next = !prev;
                if (next) {
                  if (!inspectorTabOpen && !terminalTabOpen && browserTabs.length === 0 && !agentBrowserTab.active && !selectedCanvasFile && !memoryTabOpen) {
                    setInspectorTabOpen(true);
                    setRightSidebarTab("inspector");
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

      {/* Main Content Area: Chat Pane + Right Sidebar */}
      <div className="home-content-row">
        {/* Main Chat Pane */}
        <div className="home-chat-pane">

        {/* Messages Scroll Area — scroll contract owned by ChatShell */}
        <ChatShell
          className="home-messages-viewport"
          transcriptRef={messagesViewportRef}
          stickRef={stickToBottomRef}
          scrollKey={`${messages.length}:${liveEvents.length}:${streamingText}:${running}`}
        >
          {isEmpty ? (
            <div className="home-empty-state">
              <div className="home-empty-icon">
                <Sparkles size={24} />
              </div>
              <h1 className="home-empty-title">What can I help with?</h1>
              <p className="home-empty-desc">
                Ask questions, research live sources, build presentations, and create formatted documents.
              </p>
              <div className="home-prompts-grid">
                {STARTER_PROMPTS.map((card) => (
                  <div
                    key={card.title}
                    className="home-prompt-card"
                    onClick={() => {
                      setDraft(card.prompt);
                      textareaRef.current?.focus();
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ color: "var(--accent-home)" }}>{card.icon}</span>
                      <span className="home-prompt-card-title">{card.title}</span>
                    </div>
                    <div className="home-prompt-card-desc">{card.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="home-chat-content">
              {renderBlocks.map((block) =>
                block.kind === "events" ? (
                  <ActivityGroupView
                    key={`events-${block.startIndex}`}
                    events={block.events}
                    running={false}
                    onOpenArtifact={(art) => {
                      setSelectedCanvasFile(art.path || art.filename || art.name);
                      setRightSidebarTab("artifact");
                      setRightSidebarOpen(true);
                    }}
                    onOpenImage={onOpenImage}
                  />
                ) : (
                  <ChatItemView
                    key={`msg-${block.index}`}
                    message={block.message}
                    index={block.index}
                    artifacts={block.artifacts}
                    onOpenAttachment={onOpenAttachment}
                    onOpenImage={onOpenImage}
                    onOpenArtifact={(art) => {
                      setSelectedCanvasFile(art.path || art.filename || art.name);
                      setRightSidebarTab("artifact");
                      setRightSidebarOpen(true);
                    }}
                    onEditMessage={
                      onTruncateSession && block.message.role === "user" && !running
                        ? async (idx, newText) => {
                            await onTruncateSession(idx);
                            submit(newText);
                          }
                        : undefined
                    }
                    onForkChat={
                      onForkSession && !running
                        ? (idx) => {
                            void onForkSession(idx);
                          }
                        : undefined
                    }
                    onRegenerate={
                      onTruncateSession && block.message.role === "assistant" && !running
                        ? async (idx) => {
                            let userIdx = idx - 1;
                            while (userIdx >= 0 && messages[userIdx]?.role !== "user") userIdx--;
                            if (userIdx >= 0 && messages[userIdx]?.role === "user") {
                              const promptText = messages[userIdx].text || "";
                              await onTruncateSession(userIdx);
                              submit(promptText);
                            }
                          }
                        : undefined
                    }
                  />
                ),
              )}

              {/* Live Tool Activity during execution */}
              {running && (
                <ActivityGroupView
                  events={liveEvents}
                  running={true}
                  currentText={streamingText ? "Writing response…" : undefined}
                  onOpenArtifact={(art) => {
                    setSelectedCanvasFile(art.path || art.filename || art.name);
                    setRightSidebarTab("artifact");
                    setRightSidebarOpen(true);
                  }}
                  onOpenImage={onOpenImage}
                />
              )}

              {/* Live Streaming Assistant Message */}
              {running && Boolean(streamingText) && (
                <StreamingAssistantMessage
                  text={streamingText}
                  onOpenArtifact={(art) => {
                    setSelectedCanvasFile(art.path || art.filename || art.name);
                    setRightSidebarTab("artifact");
                    setRightSidebarOpen(true);
                  }}
                />
              )}
              <div ref={bottomAnchorRef} style={{ height: 1, minHeight: 1, flexShrink: 0 }} />
            </div>
          )}
        </ChatShell>

        {/* Phase 5 mode routing: repo-work drafts get a one-click handoff to
            Code mode (workspace + LSP + verification tools) instead of Home
            answering without the project context. Conservative heuristic;
            the chip is a suggestion, never an auto-route. */}
        {onHandoffToCode && !running && suggestsCodeMode(draft) && (
          <button
            type="button"
            className="mode-suggestion-chip"
            onClick={() => onHandoffToCode(draft)}
            title="Hand this request to Code mode: it runs with your project workspace, language tools, and build verification."
            style={{
              alignSelf: "center",
              marginBottom: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 999,
              border: "1px solid var(--border, rgba(255,255,255,0.14))",
              background: "var(--surface-2, rgba(255,255,255,0.04))",
              color: "var(--text-secondary, inherit)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            <Code2 size={12} /> This looks like repo work — open in Code mode
          </button>
        )}

        {/* Sleek Floating Composer (Directly fixes the textarea UI bug) */}
        <div className="home-composer-wrapper">
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            accept={ATTACHMENT_ACCEPT}
            multiple
            onChange={handleFileSelect}
          />

          {slashQuery !== null && matchingCommands.length > 0 && (
            <SlashCommandPopup
              filter={slashQuery}
              items={matchingCommands}
              customCommands={customCommands}
              selectedIndex={slashIndex}
              onSelect={handleSlashSelect}
            />
          )}

          {/* Sliding Plan Drawer aligned identically with the composer box */}
          {latestPlan && (
            <SlidingPlanDrawer
              plan={latestPlan.plan}
              running={running}
              isInterrupted={latestPlan.isInterrupted}
              onContinue={() => submit("continue")}
            />
          )}

          <div className="home-composer-box">
            {/* Attachment preview strip */}
            {attachments.length > 0 && (
              <div className="home-composer-attachments">
                {attachments.map((att, idx) => (
                  <div key={idx} className="home-attachment-pill">
                    <FileText size={12} />
                    <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {att.name}
                    </span>
                    <button
                      className="btn-icon-sm"
                      onClick={() => {
                        setAttachments((p) => p.filter((_, i) => i !== idx));
                        setAttachedImages((imgs) => imgs.filter((u) => u !== att.url));
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              className="home-composer-textarea"
              placeholder={TOOL_PILLS.find((p) => p.id === activePill)?.placeholder || (isEmpty ? "Ask anything, or request a document..." : "Ask anything... (Enter to send)")}
              value={draft}
              onChange={(e) => {
                const val = e.target.value;
                setDraft(val);
                const slashMatch = val.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
                if (slashMatch) {
                  setSlashQuery(slashMatch[1]);
                } else {
                  setSlashQuery(null);
                }
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
            />

            {/* Model / effort / context selector — lives inside the composer,
                ChatGPT-style, instead of crowding the top bar. */}
            <div className="home-composer-modelrow">
              <ModelSelect
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                selectedEffort={selectedEffort}
                providers={providers}
                definitions={definitions}
                switchModel={switchModel}
                switchEffort={switchEffort}
                onOpenProviders={onOpenProviders}
                sessionUsage={sessionUsage}
                contextUsage={contextUsage}
                activeSessionId={activeSessionId}
              />
            </div>

            {/* Bottom Toolbar: Tools on Left, Send on Right */}
            <div className="home-composer-toolbar">
              <div className="home-composer-tools-group">
                <button
                  type="button"
                  className="composer-tool-btn"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach file or image"
                >
                  <Paperclip size={13} />
                </button>
                {TOOL_PILLS.map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    className={`composer-tool-btn ${activePill === pill.id ? "active" : ""}`}
                    onClick={() => handleApplyToolPill(pill)}
                    title={pill.prefix}
                  >
                    {pill.icon}
                    <span>{pill.label}</span>
                  </button>
                ))}
              </div>

              <div className="home-composer-send-group">
                {running ? (
                  <button
                    type="button"
                    className="composer-stop-btn"
                    onClick={onStop}
                    title="Stop generation"
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="composer-send-btn"
                    disabled={!draft.trim() && attachments.length === 0}
                    onClick={() => {
                      const pillObj = TOOL_PILLS.find((p) => p.id === activePill);
                      if (pillObj && draft.trim() && !draft.startsWith(pillObj.prefix)) {
                        submit(`${pillObj.prefix}${draft.trim()}`);
                      } else {
                        submit();
                      }
                      setActivePill(null);
                    }}
                    title="Send message (Enter)"
                  >
                    <ArrowUp size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Sidebar: Inspector, Terminal, Browser, Artifact Canvas, Memory */}
      {rightSidebarOpen && (
        <aside
          className={`workbench-right-sidebar ${isResizingRightSidebar ? "resizing" : ""}`}
          style={{
            width: isSidebarExpanded ? Math.max(rightSidebarWidth, 840) : rightSidebarWidth,
            maxWidth: "85%",
            height: "100%",
            borderLeft: "1px solid var(--border-default)",
            background: "var(--bg-surface)",
            display: "flex",
            flexDirection: "column",
            minWidth: 320,
            position: "relative",
            zIndex: 10,
            transition: isResizingRightSidebar ? "none" : "width 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          {/* Draggable left edge resize handle */}
          <div
            className="sidebar-resize-handle"
            onPointerDown={handleResizePointerDown}
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
                  className={`sidebar-tab ${rightSidebarTab === "inspector" ? "active" : ""}`}
                  onClick={() => setRightSidebarTab("inspector")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setRightSidebarTab("inspector");
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

              {terminalTabOpen && (
                <div
                  role="button"
                  tabIndex={0}
                  className={`sidebar-tab ${rightSidebarTab === "terminal" ? "active" : ""}`}
                  onClick={() => setRightSidebarTab("terminal")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setRightSidebarTab("terminal");
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

              {browserTabs.map((tab) => (
                <div
                  key={tab.id}
                  role="button"
                  tabIndex={0}
                  className={`sidebar-tab ${rightSidebarTab === tab.id ? "active" : ""}`}
                  onClick={() => setRightSidebarTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setRightSidebarTab(tab.id);
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
                  className={`sidebar-tab ${rightSidebarTab === "agent-browser" ? "active" : ""}`}
                  onClick={() => setRightSidebarTab("agent-browser")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setRightSidebarTab("agent-browser");
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

              {selectedCanvasFile && (
                <div
                  role="button"
                  tabIndex={0}
                  className={`sidebar-tab ${rightSidebarTab === "artifact" ? "active" : ""}`}
                  onClick={() => setRightSidebarTab("artifact")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setRightSidebarTab("artifact");
                  }}
                  title={selectedCanvasFile}
                >
                  <FileText size={12} />
                  <span className="sidebar-tab-text">{selectedCanvasFile.split("/").pop() || "Artifact"}</span>
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
                  className={`sidebar-tab ${rightSidebarTab === "memory" ? "active" : ""}`}
                  onClick={() => setRightSidebarTab("memory")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setRightSidebarTab("memory");
                  }}
                  title="Home & Session Memory"
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

              {/* + Add Tab Button with Dropdown */}
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
                        setInspectorTabOpen(true);
                        setRightSidebarTab("inspector");
                        setRightSidebarOpen(true);
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
                        setRightSidebarTab("terminal");
                        setRightSidebarOpen(true);
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
                        setMemoryTabOpen(true);
                        setRightSidebarTab("memory");
                        setRightSidebarOpen(true);
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
                onClick={() => setIsSidebarExpanded((prev) => !prev)}
                title={isSidebarExpanded ? "Collapse width" : "Expand width"}
              >
                {isSidebarExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>

              <button
                type="button"
                className="sidebar-tab-close"
                onClick={() => setRightSidebarOpen(false)}
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
                display: rightSidebarTab === "inspector" ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                width: "100%",
                height: "100%",
              }}
            >
              <CodeInspectorSidebar
                tasks={inspectorTasks}
                goals={inspectorGoals}
                onOpenTerminal={() => {
                  setTerminalTabOpen(true);
                  setRightSidebarTab("terminal");
                }}
                onOpenBrowser={() => {
                  addUserBrowserTab();
                }}
                onOpenMemory={() => {
                  setMemoryTabOpen(true);
                  setRightSidebarTab("memory");
                }}
                onNavigateUrl={(url) => {
                  addUserBrowserTab(url);
                }}
                onOpenAllDaemons={() => onOpenAllDaemons?.()}
              />
            </div>

            {/* Sidebar Tab 2: Terminal */}
            {terminalTabOpen && (
              <div
                style={{
                  display: rightSidebarTab === "terminal" ? "flex" : "none",
                  flex: 1,
                  minHeight: 0,
                  width: "100%",
                  height: "100%",
                  overflow: "hidden",
                }}
              >
                <Suspense fallback={<div className="empty-pane">Loading terminal…</div>}>
                  <XTermView isVisible={rightSidebarTab === "terminal"} />
                </Suspense>
              </div>
            )}

            {/* Sidebar Tab: User Browser Tabs */}
            {browserTabs.map((tab) => (
              <div
                key={tab.id}
                style={{
                  display: rightSidebarTab === tab.id ? "flex" : "none",
                  flexDirection: "column",
                  flex: 1,
                  minHeight: 0,
                  width: "100%",
                  height: "100%",
                  position: "relative",
                }}
              >
                <SidebarBrowser
                  sessionId={activeSessionId || null}
                  browserScope="home"
                  tabId={tab.id}
                  initialUrl={tab.url}
                  hideTabBar={true}
                  isAgentOnly={false}
                  onSendToAgent={(prompt) => submit(prompt)}
                  onTitleChange={(title, url) => {
                    setBrowserTabs((prev) =>
                      prev.map((t) => (t.id === tab.id ? { ...t, title: title || t.title, url: url || t.url } : t))
                    );
                  }}
                />
              </div>
            ))}

            {/* Sidebar Tab: Agent Browser (controlled by agent) */}
            {agentBrowserTab.active && (
              <div
                key="home-agent-browser-panel"
                style={{
                  display: rightSidebarTab === "agent-browser" ? "flex" : "none",
                  flexDirection: "column",
                  flex: 1,
                  minHeight: 0,
                  width: "100%",
                  height: "100%",
                  position: "relative",
                }}
              >
                <SidebarBrowser
                  sessionId={activeSessionId || null}
                  browserScope="home"
                  tabId="agent-browser"
                  initialUrl={agentBrowserTab.url}
                  hideTabBar={true}
                  isAgentOnly={true}
                  onSendToAgent={(prompt) => submit(prompt)}
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

            {/* Sidebar Tab: Artifact Preview */}
            {selectedCanvasFile && (
              <div
                style={{
                  display: rightSidebarTab === "artifact" ? "flex" : "none",
                  flex: 1,
                  minHeight: 0,
                  width: "100%",
                  height: "100%",
                }}
              >
                <HomeCanvasDrawer
                  filePath={selectedCanvasFile}
                  scope="home"
                  width="100%"
                  isExpanded={isSidebarExpanded}
                  onToggleExpand={() => setIsSidebarExpanded((prev) => !prev)}
                  refreshToken={running ? "running" : `${messages.length}`}
                  onClose={() => {
                    closeSidebarTab("artifact");
                  }}
                  onDownload={(path: string) => onDownloadFile?.(path)}
                  onRefine={(prompt: string) => submit(prompt)}
                />
              </div>
            )}

            {/* Sidebar Tab: Memory */}
            {memoryTabOpen && (
              <div
                style={{
                  display: rightSidebarTab === "memory" ? "flex" : "none",
                  flexDirection: "column",
                  flex: 1,
                  minHeight: 0,
                  width: "100%",
                  height: "100%",
                  overflowY: "auto",
                }}
              >
                <MemoryView
                  project={{
                    id: "home",
                    name: "Home",
                    root: "",
                    facts: homeMemory,
                    memory: homeMemory,
                    createdAt: "",
                    updatedAt: "",
                    sessions: [],
                  }}
                  session={activeSession}
                  onRemoveFact={handleRemoveHomeFact}
                  onClearSessionMemory={() => onClearSessionMemory?.()}
                />
              </div>
            )}
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}

export default HomeView;
