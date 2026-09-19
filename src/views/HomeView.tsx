import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Coins, Sparkles, FolderOpen, Plus, Square, ArrowUp,
  Paperclip, FileText, Search, Presentation, Table2, Mic,
} from "lucide-react";
import { ModelSelect } from "./AgentView.js";
import { ChatItemView, ActivityGroupView } from "../components/chat/ChatMessageItem.js";
import { SlashCommandPopup, filterSlashCommands, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { formatCost } from "../types.js";
import { ATTACHMENT_ACCEPT, formatAttachmentSize, isImageAttachment } from "../utils/attachments.js";
import type { ChatItem, ProviderConfig, ProviderDefinition, AgentUsage, ChatAttachment } from "../types.js";

export type HomeFile = { path: string; name: string; size: number; modified: string };

const SUGGESTIONS = [
  {
    icon: <FileText size={16} className="file-icon-doc" />,
    label: "Write a Word report",
    desc: "Generate a formatted DOCX document with sections & tables",
    prompt: "Create a Word document (.docx) about ",
    tone: "doc",
  },
  {
    icon: <Presentation size={16} className="file-icon-ppt" />,
    label: "Build a presentation",
    desc: "Create a professional PowerPoint (.pptx) slide deck",
    prompt: "Create a PowerPoint presentation (.pptx) about ",
    tone: "ppt",
  },
  {
    icon: <Table2 size={16} className="file-icon-text" />,
    label: "Make a spreadsheet",
    desc: "Build calculation models and data sheets (.xlsx)",
    prompt: "Create an Excel spreadsheet (.xlsx) for ",
    tone: "table",
  },
  {
    icon: <Search size={16} className="file-icon-web" />,
    label: "Research the web",
    desc: "Find live sources, papers, summaries and facts",
    prompt: "Search the web for ",
    tone: "web",
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
  providers,
  definitions,
  switchModel,
  onOpenProviders,
  sessionUsage,
  homeFiles,
  homeRoot,
  onRefreshFiles,
  onDownloadFile,
  onOpenFolder,
  onNewChat,
  attachedImages,
  setAttachedImages,
  attachments,
  setAttachments,
  hasProvider,
  onOpenImage,
  onOpenAttachment,
  customCommands,
}: {
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
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  switchModel: (providerId: string, model: string) => void;
  onOpenProviders: () => void;
  sessionUsage?: AgentUsage | null;
  homeFiles: HomeFile[];
  homeRoot: string;
  onRefreshFiles: () => void;
  onDownloadFile: (path: string) => void;
  onOpenFolder: () => void;
  onNewChat: () => void;
  attachedImages: string[];
  setAttachedImages: (updater: (current: string[]) => string[]) => void;
  attachments: ChatAttachment[];
  setAttachments: (updater: (current: ChatAttachment[]) => ChatAttachment[]) => void;
  hasProvider: boolean;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
  customCommands?: SlashCommand[];
}) {
  const api = window.nexus || window.forgepilot;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, liveEvents, streamingText]);

  const transcriptNodes: ReactNode[] = [];
  let pendingActivity: ChatItem[] = [];
  const flushActivity = () => {
    if (pendingActivity.length) {
      transcriptNodes.push(
        <ActivityGroupView
          key={`activity-${pendingActivity[0].createdAt}-${transcriptNodes.length}`}
          events={pendingActivity}
          running={false}
          onOpenImage={onOpenImage}
          onOpenAttachment={onOpenAttachment}
        />
      );
      pendingActivity = [];
    }
  };
  messages.forEach((message, index) => {
    if (message.role === "event") pendingActivity.push(message);
    else {
      flushActivity();
      transcriptNodes.push(
        <ChatItemView key={`${message.createdAt}-${index}`} message={message} onOpenImage={onOpenImage} onOpenAttachment={onOpenAttachment} />
      );
    }
  });
  flushActivity();

  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  const matchingCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return filterSlashCommands(slashQuery, customCommands, []);
  }, [slashQuery, customCommands]);

  function updateCursorTriggers(value: string, cursorPosition: number) {
    const beforeCursor = value.slice(0, cursorPosition);
    const slashMatch = beforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setSlashIndex(0);
    } else {
      setSlashQuery(null);
    }
  }

  function handleDraftChange(value: string, cursorPosition: number) {
    setDraft(value);
    updateCursorTriggers(value, cursorPosition);
  }

  function handleSlashSelect(cmd: SlashCommand) {
    if (!textareaRef.current) return;
    const cursor = textareaRef.current.selectionStart || draft.length;
    const beforeCursor = draft.slice(0, cursor);
    const afterCursor = draft.slice(cursor);
    const updatedBefore = beforeCursor.replace(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/, (match) => {
      const leadingWhitespace = match.match(/^\s/)?.[0] || "";
      return `${leadingWhitespace}${cmd.command} `;
    });
    const nextDraft = `${updatedBefore}${afterCursor}`;
    setDraft(nextDraft);
    setSlashQuery(null);
    setSlashIndex(0);

    const newCursor = updatedBefore.length;
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCursor, newCursor);
      }
    }, 0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashQuery !== null && matchingCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((c) => (c + 1) % matchingCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((c) => (c - 1 + matchingCommands.length) % matchingCommands.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashQuery(null);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          const selected = matchingCommands[((slashIndex % matchingCommands.length) + matchingCommands.length) % matchingCommands.length];
          if (selected) {
            handleSlashSelect(selected);
          }
          return;
        }
      }
    }
    if (event.key === "Enter") {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      submit();
    }
  }

  function openAttachment(attachment: ChatAttachment) {
    if (onOpenAttachment) {
      onOpenAttachment(attachment);
      return;
    }
    // Back-compat: image-only preview callback.
    if (isImageAttachment(attachment)) onOpenImage?.(attachment.url);
  }

  function handleImageFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList) return;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.type || file.name) {
        const mimeType = file.type || "application/octet-stream";
        const isImage = mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
        const reader = new FileReader();
        reader.onload = async (loadEvt) => {
          const rawUrl = loadEvt.target?.result as string;
          if (rawUrl) {
            if (api?.saveAttachment) {
              try {
                const saved = await api.saveAttachment(rawUrl, file.name);
                setAttachments((current) => [...current, { url: saved.url, name: file.name, mimeType, size: file.size }]);
                if (isImage) setAttachedImages((current) => [...current, saved.url]);
                return;
              } catch { /* ignore fallback */ }
            }
            setAttachments((current) => [...current, { url: rawUrl, name: file.name, mimeType, size: file.size }]);
            if (isImage) setAttachedImages((current) => [...current, rawUrl]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
    event.target.value = "";
  }

  return (
    <div className="agent-view">
      <div className="agent-view-head">
        <div>
          <span className="view-kicker">NEXUS HOME</span>
          <h1>{running ? "Working on it" : "What can I do for you?"}</h1>
          <p>
            {running
              ? "Researching, writing files, running commands…"
              : "Chat, research the web, create Word, Excel, PowerPoint, LaTeX and Markdown files."}
          </p>
        </div>
        <div className="agent-view-meta">
          {sessionUsage && sessionUsage.totalTokens > 0 && (
            <span
              className="session-usage-pill"
              title={`${sessionUsage.inputTokens.toLocaleString()} in / ${sessionUsage.outputTokens.toLocaleString()} out`}
            >
              <Coins size={12} />
              <span>
                Session:{" "}
                <b>
                  {sessionUsage.totalTokens >= 1000
                    ? `${(sessionUsage.totalTokens / 1000).toFixed(1)}k`
                    : sessionUsage.totalTokens.toLocaleString()}
                </b>{" "}
                tokens
              </span>
              <span className="cost">{formatCost(sessionUsage.estimatedCost)}</span>
            </span>
          )}
          <button className="top-link" onClick={onOpenFolder} title={homeRoot || "Open the Nexus folder"}>
            <FolderOpen size={12} /> Files
          </button>
          <button className="top-link" onClick={onNewChat} title="Start a new home chat">
            <Plus size={12} /> New chat
          </button>
        </div>
      </div>

      <div className="home-body">
        <div
          className="agent-transcript home-transcript"
          ref={transcriptRef}
          onScroll={() => {
            const el = transcriptRef.current;
            if (!el) return;
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!messages.length && !running && (
            <div className="empty-agent">
              <div className="empty-agent-icon">
                <Sparkles size={20} />
              </div>
              <h2>Your everyday assistant</h2>
              <p>Ask anything, or pick a starting point. Created files land in your Nexus folder, ready to download.</p>
              <div className="home-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    className={`home-suggestion suggestion-${s.tone}`}
                    onClick={() => setDraft(s.prompt)}
                  >
                    <div className="home-suggestion-icon">{s.icon}</div>
                    <div className="home-suggestion-text">
                      <strong className="home-suggestion-title">{s.label}</strong>
                      <span className="home-suggestion-desc">{s.desc}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {transcriptNodes}
          {running && (
          <ActivityGroupView
            events={liveEvents}
            running
            onOpenImage={onOpenImage}
            onOpenAttachment={onOpenAttachment}
              currentText={streamingText || (liveEvents.length ? undefined : "Starting the agent… the first step can take a while.")}
            />
          )}
        </div>
      </div>

      <div className="agent-input-area">
        <input
          type="file"
          ref={imageInputRef}
          style={{ display: "none" }}
          accept={ATTACHMENT_ACCEPT}
          multiple
          onChange={handleImageFileSelect}
        />
        <div className="agent-input" style={{ position: "relative" }}>
          {attachments.length > 0 && (
            <div className="image-attachments-bar">
              {attachments.map((attachment, idx) => (
                <div className="image-preview-chip" key={`${attachment.url}-${idx}`}>
                  <button
                    className="attachment-chip-main"
                    onClick={() => openAttachment(attachment)}
                    title={`${attachment.name} — click to preview`}
                  >
                    {isImageAttachment(attachment)
                      ? <img src={attachment.url} alt={attachment.name} className="image-preview-thumb" />
                      : <FileText size={14} />}
                    <span className="attachment-file-chip">
                      <span className="attachment-file-name">{attachment.name}</span>
                      <small>{formatAttachmentSize(attachment.size)}</small>
                    </span>
                  </button>
                  <button
                    className="image-preview-remove"
                    onClick={() => { setAttachments((current) => current.filter((_, i) => i !== idx)); setAttachedImages((current) => current.filter((image) => image !== attachment.url)); }}
                    title={`Remove ${attachment.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {slashQuery !== null && matchingCommands.length > 0 && (
            <SlashCommandPopup
              filter={slashQuery}
              items={matchingCommands}
              customCommands={customCommands}
              defaults={[]}
              onSelect={handleSlashSelect}
              selectedIndex={slashIndex}
            />
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) =>
              handleDraftChange(
                event.target.value,
                event.target.selectionStart || event.target.value.length
              )
            }
            onSelect={(event) => {
              const target = event.currentTarget;
              updateCursorTriggers(target.value, target.selectionStart || target.value.length);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything, or request a document… (Enter to send)"
            rows={3}
          />
          <div className="input-footer">
            <div className="input-left">
              <button
                className="attach-button"
                onClick={() => imageInputRef.current?.click()}
                title="Attach files (images, PDF, Word, Excel, PowerPoint, TeX, text)"
              >
                <Paperclip size={14} />
              </button>
              <ModelSelect
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                providers={providers}
                definitions={definitions}
                switchModel={switchModel}
                onOpenProviders={onOpenProviders}
              />
            </div>
            <button
              className={`send-button${running ? " stop" : ""}`}
              disabled={(!running && !draft.trim() && attachments.length === 0) || (!hasProvider && !running)}
              onClick={running ? onStop : () => submit()}
              title={running ? "Stop" : hasProvider ? "Send" : "Configure a provider first"}
            >
              {running ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
        {!hasProvider && (
          <div className="input-note">
            <Mic size={12} /> Configure a provider (Providers button, top right) to start chatting
          </div>
        )}
      </div>
    </div>
  );
}
