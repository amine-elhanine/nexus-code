import React, { useRef, useState, useEffect, useMemo, KeyboardEvent, type ReactNode } from "react";
import {
  Sparkles, Paperclip, ArrowUp, Square, Search, BarChart3, FileText,
  X, Presentation, Table2
} from "lucide-react";
import { ChatItemView, StreamingAssistantMessage, ActivityGroupView } from "../components/chat/ChatMessageItem.js";
import { SlashCommandPopup, filterSlashCommands, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { ATTACHMENT_ACCEPT } from "../utils/attachments.js";
import { insertAtCursor } from "../utils/textarea.js";
import type { ChatItem, ProviderConfig, ProviderDefinition, ChatAttachment, SkillInfo, AgentUsage, AgentContextUsageSnapshot } from "../types.js";
import { SlidingPlanDrawer, extractLatestPlan } from "../components/chat/SlidingPlanDrawer.js";
import { HomeCanvasDrawer } from "../components/home/HomeCanvasDrawer.js";
import { ModelSelect } from "./AgentView.js";

type RenderBlock =
  | { kind: "message"; message: ChatItem; index: number }
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
  { id: "search", label: "Search", icon: <Search size={13} />, prefix: "Search the web for " },
  { id: "visualize", label: "Visualize", icon: <BarChart3 size={13} />, prefix: "Create an interactive visual diagram or chart of " },
  { id: "document", label: "Document", icon: <FileText size={13} />, prefix: "Generate a polished report on " },
  { id: "research", label: "Deep Research", icon: <Sparkles size={13} />, prefix: "Conduct deep multi-source research with citations on " },
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
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  // Group messages & events into RenderBlocks so tool runs collapse cleanly into ActivityGroupView
  const renderBlocks = useMemo<RenderBlock[]>(() => {
    const blocks: RenderBlock[] = [];
    messages.forEach((message, index) => {
      if (message.role === "event") {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "events") {
          last.events.push(message);
        } else {
          blocks.push({ kind: "events", events: [message], startIndex: index });
        }
      } else {
        blocks.push({ kind: "message", message, index });
      }
    });
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
        submit();
        setActivePill(null);
        setSlashQuery(null);
      }
    }
  };

  const handleApplyToolPill = (pill: typeof TOOL_PILLS[0]) => {
    if (activePill === pill.id) {
      setActivePill(null);
      if (draft.startsWith(pill.prefix)) {
        setDraft(draft.slice(pill.prefix.length));
      }
    } else {
      setActivePill(pill.id);
      if (!draft.startsWith(pill.prefix)) {
        setDraft(pill.prefix + draft);
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
      {/* Main Chat Pane */}
      <div className="home-chat-pane">
        {/* Top Minimal Strip */}
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
                    onOpenArtifact={(art) => setSelectedCanvasFile(art.path || art.filename || art.name)}
                    onOpenImage={onOpenImage}
                  />
                ) : (
                  <ChatItemView
                    key={`msg-${block.index}`}
                    message={block.message}
                    index={block.index}
                    onOpenAttachment={onOpenAttachment}
                    onOpenImage={onOpenImage}
                    onOpenArtifact={(art) => setSelectedCanvasFile(art.path || art.filename || art.name)}
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
                  onOpenArtifact={(art) => setSelectedCanvasFile(art.path || art.filename || art.name)}
                  onOpenImage={onOpenImage}
                />
              )}

              {/* Live Streaming Assistant Message */}
              {(streamingText || (running && liveEvents.length === 0)) && (
                <StreamingAssistantMessage text={streamingText} />
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
              placeholder={isEmpty ? "Ask anything, or request a document..." : "Ask anything... (Enter to send)"}
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
                    onClick={() => submit()}
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

      {/* Side-by-Side Canvas Drawer if file is selected */}
      {selectedCanvasFile && (
        <HomeCanvasDrawer
          filePath={selectedCanvasFile}
          onClose={() => setSelectedCanvasFile(null)}
          onDownload={(path: string) => onDownloadFile?.(path)}
          onRefine={(prompt: string) => submit(prompt)}
        />
      )}
    </div>
  );
}

export default HomeView;
