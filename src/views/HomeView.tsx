import React, { useRef, useState, useEffect, useMemo, useCallback, KeyboardEvent, type ReactNode } from "react";
import {
  Sparkles, Paperclip, ArrowUp, Square, Search, BarChart3, FileText,
  X, Presentation, Table2, Globe
} from "lucide-react";
import { ChatItemView, StreamingAssistantMessage, ActivityGroupView } from "../components/chat/ChatMessageItem.js";
import { SlashCommandPopup, filterSlashCommands, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { ATTACHMENT_ACCEPT } from "../utils/attachments.js";
import { insertAtCursor } from "../utils/textarea.js";
import type { ChatItem, ProviderConfig, ProviderDefinition, ChatAttachment, SkillInfo, AgentUsage, AgentContextUsageSnapshot, ArtifactItem } from "../types.js";
import { SlidingPlanDrawer, extractLatestPlan } from "../components/chat/SlidingPlanDrawer.js";
import { HomeCanvasDrawer } from "../components/home/HomeCanvasDrawer.js";
import { SidebarBrowser } from "../components/browser/SidebarBrowser.js";
import { ModelSelect } from "./AgentView.js";

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
}: HomeViewProps) {
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activePill, setActivePill] = useState<string | null>(null);
  const [selectedCanvasFile, setSelectedCanvasFile] = useState<string | null>(null);
  const [browserActive, setBrowserActive] = useState(false);
  const [browserLatestUrl, setBrowserLatestUrl] = useState<string | null>(null);
  const [rightSidebarTab, setRightSidebarTab] = useState<"artifact" | "browser">("artifact");
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
    setRightSidebarTab("browser");
  }, [activeSessionId]);

  // Automatically follow browser agent activity in Watching mode (autoFollow === true)
  useEffect(() => {
    const api = window.nexus;
    if (typeof api?.onBrowserAgentActivity === "function") {
      const unsub = api.onBrowserAgentActivity((payload) => {
        if (!payload?.url) return;
        if (payload.autoFollow) {
          setBrowserLatestUrl(payload.url);
          setBrowserActive(true);
          setRightSidebarTab("browser");
        }
      });
      return unsub;
    }
  }, []);

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

  // Auto-scroll when new messages arrive or streaming updates
  useEffect(() => {
    if (messagesViewportRef.current) {
      messagesViewportRef.current.scrollTop = messagesViewportRef.current.scrollHeight;
    }
  }, [messages, streamingText, liveEvents]);

  // Clean auto-resize textarea from min 26px up to 160px
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 26), 160);
    el.style.height = `${nextHeight}px`;
  }, [draft]);

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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        setAttachments((prev) => [
          ...prev,
          { name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", url },
        ]);
        if (file.type.startsWith("image/")) {
          setAttachedImages((prev) => [...prev, url]);
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = "";
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
        </div>
      </header>

      {/* Main Content Area: Chat Pane + Right Sidebar */}
      <div className="home-content-row">
        {/* Main Chat Pane */}
        <div className="home-chat-pane">

        {/* Messages Scroll Area */}
        <div className="home-messages-viewport" ref={messagesViewportRef}>
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
              {running && liveEvents.length > 0 && (
                <ActivityGroupView
                  events={liveEvents}
                  running={true}
                  currentText={streamingText}
                  onOpenArtifact={(art) => {
                    setSelectedCanvasFile(art.path || art.filename || art.name);
                    setRightSidebarTab("artifact");
                  }}
                  onOpenImage={onOpenImage}
                />
              )}

              {/* Live Streaming Assistant Message */}
              {(streamingText || (running && liveEvents.length === 0)) && (
                <StreamingAssistantMessage
                  text={streamingText}
                  onOpenArtifact={(art) => {
                    setSelectedCanvasFile(art.path || art.filename || art.name);
                    setRightSidebarTab("artifact");
                  }}
                />
              )}
            </div>
          )}
        </div>

        {/* Sliding Plan Drawer if an agent task is active */}
        {latestPlan && (
          <SlidingPlanDrawer
            plan={latestPlan.plan}
            running={running}
            isInterrupted={latestPlan.isInterrupted}
            onContinue={() => submit("continue")}
          />
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
                      onClick={() => setAttachments((p) => p.filter((_, i) => i !== idx))}
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

      {/* Right Sidebar: Artifact Canvas and/or Live Browser */}
      {(selectedCanvasFile || browserActive) && (
        <aside
          className={`workbench-right-sidebar ${isResizingRightSidebar ? "resizing" : ""}`}
          style={{
            width: isSidebarExpanded ? Math.max(rightSidebarWidth, 780) : rightSidebarWidth,
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
          {/* Top tab switcher when both artifact & browser are open */}
          {selectedCanvasFile && browserActive && (
            <div className="sidebar-tab-strip">
              <button
                type="button"
                className={`sidebar-tab ${rightSidebarTab === "artifact" ? "active" : ""}`}
                onClick={() => setRightSidebarTab("artifact")}
                title={selectedCanvasFile}
              >
                <FileText size={12} />
                <span className="sidebar-tab-text">{selectedCanvasFile.split("/").pop() || "Artifact"}</span>
              </button>
              <button
                type="button"
                className={`sidebar-tab ${rightSidebarTab === "browser" ? "active" : ""}`}
                onClick={() => setRightSidebarTab("browser")}
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
                  if (rightSidebarTab === "artifact") {
                    setSelectedCanvasFile(null);
                    setRightSidebarTab("browser");
                  } else {
                    setBrowserActive(false);
                    setRightSidebarTab("artifact");
                  }
                }}
                title="Close active tab"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* Artifact Preview */}
          {rightSidebarTab === "artifact" && selectedCanvasFile && (
            <div style={{ display: "flex", flex: 1, minHeight: 0, width: "100%", height: "100%" }}>
              <HomeCanvasDrawer
                filePath={selectedCanvasFile}
                scope="home"
                width="100%"
                isExpanded={isSidebarExpanded}
                onToggleExpand={() => setIsSidebarExpanded((prev) => !prev)}
                refreshToken={running ? "running" : `${messages.length}`}
                onClose={() => {
                  setSelectedCanvasFile(null);
                  if (browserActive) setRightSidebarTab("browser");
                }}
                onDownload={(path: string) => onDownloadFile?.(path)}
                onRefine={(prompt: string) => submit(prompt)}
              />
            </div>
          )}

          {/* Live Browser Pane */}
          {rightSidebarTab === "browser" && browserActive && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, width: "100%", height: "100%", position: "relative" }}>
              {!selectedCanvasFile && (
                <div className="sidebar-single-header">
                  <div className="sidebar-single-title">
                    <Globe size={13} style={{ color: "#38bdf8" }} />
                    <span>Agent Browser</span>
                  </div>
                  <button
                    type="button"
                    className="icon-plain"
                    onClick={() => setBrowserActive(false)}
                    title="Close Browser Sidebar"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <SidebarBrowser
                  sessionId={activeSessionId || null}
                  browserScope="home"
                  initialUrl={browserLatestUrl || undefined}
                  onSendToAgent={(prompt) => submit(prompt)}
                />
              </div>
            </div>
          )}
        </aside>
      )}
      </div>
    </div>
  );
}

export default HomeView;
