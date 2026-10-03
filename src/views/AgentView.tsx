import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Coins, Sparkles, GitBranch, RotateCcw, Check, FileCode2, FileDown,
  Paperclip, FileText, Plus, Square, ArrowUp, ShieldCheck, ChevronDown, X,
  Bug, Code2, CheckCircle2,
} from "lucide-react";
import { WorktreeBar } from "../components/worktree/WorktreeBar.js";
import { SlashCommandPopup, filterSlashCommands, DEFAULT_SLASH_COMMANDS, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { ChatItemView, ActivityGroupView, StreamingAssistantMessage } from "../components/chat/ChatMessageItem.js";
import { fileIcon } from "../utils/format.js";
import { ATTACHMENT_ACCEPT, formatAttachmentSize, isImageAttachment } from "../utils/attachments.js";
import { formatCost } from "../types.js";
import type { ChatItem, FileEntry, ProviderConfig, ProviderDefinition, AgentUsage, ArtifactItem, ChatAttachment } from "../types.js";

const AGENT_STARTERS = [
  { icon: <Sparkles size={13} className="file-icon-text" />, label: "Add feature", prompt: "Add a feature to " },
  { icon: <Bug size={13} className="file-icon-video" />, label: "Fix bug", prompt: "Debug and fix the issue where " },
  { icon: <Code2 size={13} className="file-icon-doc" />, label: "Refactor", prompt: "Refactor and clean up " },
  { icon: <CheckCircle2 size={13} className="file-icon-ppt" />, label: "Write tests", prompt: "Write comprehensive unit tests for " },
];

export function ModelSelect({
  selectedProviderId,
  selectedModel,
  providers,
  definitions,
  switchModel,
  onOpenProviders,
}: {
  selectedProviderId: string;
  selectedModel: string;
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  switchModel: (providerId: string, model: string) => void;
  onOpenProviders: () => void;
}) {
  const provider = providers.find((item) => item.id === selectedProviderId);
  const modelExists = provider?.models.includes(selectedModel);
  const selectValue = provider && modelExists ? `${selectedProviderId}::${selectedModel}` : "";

  return (
    <div className="model-select">
      <select
        value={selectValue}
        onChange={(event) => {
          const val = event.target.value;
          if (!val) {
            onOpenProviders();
            return;
          }
          const [id, ...rest] = val.split("::");
          switchModel(id, rest.join("::"));
        }}
      >
        <option value="">{providers.length ? "Select model…" : "Configure provider…"}</option>
        {providers.map((item) => (
          <optgroup key={item.id} label={item.label}>
            {item.models.map((model) => (
              <option key={`${item.id}-${model}`} value={`${item.id}::${model}`}>
                {model}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {provider && (
        <span className="provider-dot" style={{ pointerEvents: "none" }}>
          {provider.label.slice(0, 1)}
        </span>
      )}
      <ChevronDown size={12} style={{ pointerEvents: "none" }} />
    </div>
  );
}

export function AgentView({
  hasProject,
  activeFile,
  messages,
  draft,
  setDraft,
  submit,
  running,
  onStop,
  streamingText,
  liveEvents,
  mode,
  setMode,
  selectedProviderId,
  selectedModel,
  providers,
  definitions,
  files,
  checkpointId,
  diffCount,
  undoLevels,
  onUndoRun,
  onKeepChanges,
  switchModel,
  onOpenProviders,
  onAttachFile,
  onAttachDiff,
  sessionUsage,
  activeSessionId,
  worktreeStatus,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
  onOpenDiff,
  onMergeSuccess,
  onDiscardSuccess,
  attachedImages,
  setAttachedImages,
  attachments,
  setAttachments,
  customCommands,
}: {
  hasProject: boolean;
  activeFile: string;
  messages: ChatItem[];
  draft: string;
  setDraft: (value: string) => void;
  submit: (override?: string) => void;
  running: boolean;
  onStop: () => void;
  streamingText: string;
  liveEvents: ChatItem[];
  mode: string;
  setMode: (value: string) => void;
  selectedProviderId: string;
  selectedModel: string;
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  files: FileEntry[];
  checkpointId?: string;
  diffCount: number;
  undoLevels?: number;
  onUndoRun: (id: string) => void;
  onKeepChanges: () => void;
  switchModel: (providerId: string, model: string) => void;
  onOpenProviders: () => void;
  onAttachFile: () => void;
  onAttachDiff: () => void;
  sessionUsage?: AgentUsage;
  activeSessionId?: string;
  worktreeStatus?: { isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
  onOpenDiff?: () => void;
  onMergeSuccess?: () => void;
  onDiscardSuccess?: () => void;
  attachedImages: string[];
  setAttachedImages: React.Dispatch<React.SetStateAction<string[]>>;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  customCommands?: SlashCommand[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // Stick to the bottom only while the user is already there; reading history
  // mid-run must not be yanked around by every streamed token.
  const stickToBottomRef = useRef(true);

  const api = window.nexus || window.forgepilot;
  const [showComposerMenu, setShowComposerMenu] = useState(false);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, liveEvents, streamingText]);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  const matchingCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return filterSlashCommands(slashQuery, customCommands, DEFAULT_SLASH_COMMANDS);
  }, [slashQuery, customCommands]);

  const transcriptNodes: ReactNode[] = [];
  let pendingActivity: ChatItem[] = [];
  const flushActivity = () => {
    if (pendingActivity.length) {
      transcriptNodes.push(
        <ActivityGroupView
          key={`activity-${pendingActivity[0].createdAt}-${transcriptNodes.length}`}
          events={pendingActivity}
          running={false}
          onOpenArtifact={onOpenArtifact}
          onOpenImage={onOpenImage}
          onOpenAttachment={onOpenAttachment}
        />
      );
      pendingActivity = [];
    }
  };
  function openAttachment(attachment: ChatAttachment) {
    if (onOpenAttachment) {
      onOpenAttachment(attachment);
      return;
    }
    if (isImageAttachment(attachment)) onOpenImage?.(attachment.url);
  }
  messages.forEach((message, index) => {
    if (message.role === "event") pendingActivity.push(message);
    else {
      flushActivity();
      transcriptNodes.push(
        <ChatItemView
          key={`${message.createdAt}-${index}`}
          message={message}
          onOpenArtifact={onOpenArtifact}
          onOpenImage={onOpenImage}
          onOpenAttachment={onOpenAttachment}
        />
      );
    }
  });
  flushActivity();

  const matchingFiles = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return files
      .filter((f) => f.kind === "file" && f.path.toLowerCase().includes(query))
      .slice(0, 8);
  }, [mentionQuery, files]);

  function updateCursorTriggers(value: string, cursorPosition: number) {
    const beforeCursor = value.slice(0, cursorPosition);
    const mentionMatch = beforeCursor.match(/@([a-zA-Z0-9_./-]*)$/);
    if (mentionMatch) {
      setMentionQuery(mentionMatch[1]);
      setMentionIndex(0);
      setSlashQuery(null);
      return;
    } else {
      setMentionQuery(null);
    }

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

  function insertMention(filePath: string) {
    if (!textareaRef.current) return;
    const cursor = textareaRef.current.selectionStart || draft.length;
    const beforeCursor = draft.slice(0, cursor);
    const afterCursor = draft.slice(cursor);
    const updatedBefore = beforeCursor.replace(/@([a-zA-Z0-9_./-]*)$/, `@${filePath} `);
    setDraft(`${updatedBefore}${afterCursor}`);
    setMentionQuery(null);
    setTimeout(() => textareaRef.current?.focus(), 10);
  }

  function handleSlashSelect(cmd: SlashCommand) {
    if (cmd.mode) {
      setMode(cmd.mode === "plan" ? "Plan" : cmd.mode === "auto" ? "Auto" : "Ask");
    }
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

  function handleSendMessage(overrideText?: string) {
    const text = (overrideText ?? draft).trim();
    if (text === "/diff") {
      setDraft("");
      onOpenDiff?.();
      return;
    }
    if (text === "/help") {
      setDraft("");
      submit("What tools, commands, and skills are available in this project?");
      return;
    }
    if (text === "/checkpoint") {
      setDraft("");
      submit("Create checkpoint and review workspace state");
      return;
    }
    if (text === "/test") {
      setDraft("");
      submit("Run project verification and tests");
      return;
    }
    submit(overrideText);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = async (loadEvt) => {
            const rawUrl = loadEvt.target?.result as string;
            if (rawUrl) {
              if (api?.saveAttachment) {
                try {
                  const saved = await api.saveAttachment(rawUrl, file.name || "pasted-image.png");
                  setAttachments((current) => [...current, { url: saved.url, name: file.name || "pasted-image.png", mimeType: file.type || "image/png", size: file.size }]);
                  setAttachedImages((current) => [...current, saved.url]);
                  return;
                } catch { /* ignore fallback */ }
              }
              setAttachments((current) => [...current, { url: rawUrl, name: file.name || "pasted-image.png", mimeType: file.type || "image/png", size: file.size }]);
              setAttachedImages((current) => [...current, rawUrl]);
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }
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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && matchingFiles.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % matchingFiles.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current - 1 + matchingFiles.length) % matchingFiles.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(matchingFiles[mentionIndex].path);
        return;
      }
      if (event.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }

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
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const target = event.currentTarget;
          const start = target.selectionStart || 0;
          const end = target.selectionEnd || 0;
          const val = draft;
          const nextVal = val.substring(0, start) + "\n" + val.substring(end);
          setDraft(nextVal);
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 1;
            }
          }, 0);
        }
        return;
      }
      event.preventDefault();
      handleSendMessage();
    }
  }

  return (
    <div className="agent-view">
      {activeSessionId && worktreeStatus?.isGit && worktreeStatus.worktree && (
        <WorktreeBar
          sessionId={activeSessionId}
          isGit={worktreeStatus.isGit}
          worktree={worktreeStatus.worktree}
          onMergeSuccess={onMergeSuccess}
          onDiscardSuccess={onDiscardSuccess}
        />
      )}
      <div className="agent-view-head">
        <div>
          <span className="view-kicker">CODING AGENT</span>
          <h1>
            {running
              ? "Working on your task"
              : hasProject
              ? "Ready for your task"
              : "Open a project to begin"}
          </h1>
          <p>
            {running
              ? "The agent is using the selected project context."
              : hasProject
              ? "Describe the outcome. Nexus will inspect, plan, implement and validate."
              : "Create or open a local project. Nothing is preloaded."}
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
          {activeSessionId && typeof (api as unknown as { exportSession?: unknown })?.exportSession === "function" && (
            <button
              type="button"
              className="session-usage-pill"
              title="Export this session as a standalone HTML file"
              onClick={() => {
                void ((api as unknown as { exportSession: (id: string) => Promise<string> }).exportSession(activeSessionId)).catch(() => undefined);
              }}
            >
              <FileDown size={12} />
              <span>Export</span>
            </button>
          )}
          <span className="local-badge">
            <span /> Local
          </span>
          <span className="mode-badge">{mode} mode</span>
        </div>
      </div>
      <div
        className="agent-transcript"
        ref={transcriptRef}
        onScroll={() => {
          const el = transcriptRef.current;
          if (!el) return;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!messages.length && (
          <div className="empty-agent">
            <div className="empty-agent-icon">
              <Sparkles size={20} />
            </div>
            <h2>Start a coding session</h2>
            <p>
              Ask for a feature, a bug fix, a refactor, or a code review. Type @ to reference files,
              or / for slash shortcuts.
            </p>
            <div className="starter-prompts">
              {AGENT_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  onClick={() => {
                    setDraft(starter.prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  {starter.icon}
                  <span>{starter.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {transcriptNodes}
        {checkpointId && !running && (diffCount > 0 || (undoLevels || 0) > 0) && (
          <div className="rollback-card">
            <div className="rollback-info">
              <GitBranch size={14} />
              <span>
                {diffCount > 0 ? (
                  <>Agent made changes in <strong>{diffCount} file{diffCount === 1 ? "" : "s"}</strong></>
                ) : (
                  <>Session has committed work ready to undo</>
                )}
                {(undoLevels || 0) > 1 && <> · <strong>{undoLevels} levels</strong></>}
              </span>
            </div>
            <div className="rollback-actions">
              <button
                className="secondary"
                onClick={() => onUndoRun(checkpointId)}
                title="Restore pre-run files and roll back Nexus-only session commits"
              >
                <RotateCcw size={12} /> {(undoLevels || 0) > 1 ? `Undo (${undoLevels})` : "Undo run"}
              </button>
              <button className="primary" onClick={onKeepChanges} title="Accept and clear all undo history for this session">
                <Check size={12} /> Keep changes
              </button>
            </div>
          </div>
        )}
        {running && liveEvents.length > 0 && (
          <ActivityGroupView
            events={liveEvents}
            running
            currentText={streamingText ? "Writing response…" : undefined}
            onOpenArtifact={onOpenArtifact}
            onOpenImage={onOpenImage}
            onOpenAttachment={onOpenAttachment}
          />
        )}
        {running && !liveEvents.length && !streamingText && (
          <ActivityGroupView
            events={[]}
            running
            currentText="Starting the agent… the first step can take a while."
            onOpenArtifact={onOpenArtifact}
            onOpenImage={onOpenImage}
            onOpenAttachment={onOpenAttachment}
          />
        )}
        {running && streamingText && (
          <StreamingAssistantMessage text={streamingText} />
        )}
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
          {mentionQuery !== null && matchingFiles.length > 0 && (
            <div className="mention-dropdown">
              {matchingFiles.map((file, idx) => (
                <button
                  key={file.path}
                  className={`mention-item ${idx === mentionIndex ? "active" : ""}`}
                  onClick={() => insertMention(file.path)}
                >
                  {fileIcon(file.path)}
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          )}
          {slashQuery !== null && matchingCommands.length > 0 && (
            <SlashCommandPopup
              filter={slashQuery}
              items={matchingCommands}
              customCommands={customCommands}
              selectedIndex={slashIndex}
              onSelect={handleSlashSelect}
            />
          )}
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
                    onClick={() => {
                      setAttachments((current) => current.filter((_, i) => i !== idx));
                      setAttachedImages((current) => current.filter((image) => image !== attachment.url));
                    }}
                    title={`Remove ${attachment.name}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
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
            onPaste={handlePaste}
            placeholder="Ask the agent to inspect, change, test, or review your project… (paste images with Ctrl+V, type @ for files, / for commands)"
            rows={3}
          />
          <div className="input-footer">
            <div className="input-left">
              <div className="composer-more-wrap">
                <button
                  className="attach-button"
                  onClick={() => setShowComposerMenu(!showComposerMenu)}
                  title="Attach context"
                >
                  <Plus size={14} />
                </button>
                {showComposerMenu && (
                  <div className="composer-menu">
                    <button disabled={!activeFile} onClick={onAttachFile}>
                      <FileCode2 size={13} /> Attach current file
                    </button>
                    <button onClick={onAttachDiff}>
                      <GitBranch size={13} /> Attach Git diff
                    </button>
                    <button
                      onClick={() => {
                        imageInputRef.current?.click();
                        setShowComposerMenu(false);
                      }}
                    >
                      <Paperclip size={13} /> Attach file (image, PDF, Word, Excel, …)
                    </button>
                  </div>
                )}
              </div>
              <div className="mode-select">
                {["Plan", "Ask", "Auto"].map((item) => (
                  <button
                    key={item}
                    className={mode === item ? "active" : ""}
                    onClick={() => setMode(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
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
              disabled={!running && !draft.trim() && attachments.length === 0}
              onClick={running ? onStop : () => handleSendMessage()}
              title={running ? "Stop the agent" : "Send"}
            >
              {running ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
        <div className="input-note">
          <ShieldCheck size={12} /> Nexus runs real commands and edits files in this workspace — review the Diff tab before keeping changes
        </div>
      </div>
    </div>
  );
}
