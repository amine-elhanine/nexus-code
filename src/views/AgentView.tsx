import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Coins, Sparkles, GitBranch, RotateCcw, Check, FileCode2,
  Image as ImageIcon, Plus, Square, ArrowUp, ShieldCheck, ChevronDown, X
} from "lucide-react";
import { WorktreeBar } from "../components/worktree/WorktreeBar.js";
import { SlashCommandPopup, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { VoiceDictationButton } from "../components/chat/VoiceDictationButton.js";
import { ChatItemView, ActivityGroupView } from "../components/chat/ChatMessageItem.js";
import { fileIcon } from "../utils/format.js";
import type {
  ChatItem, FileEntry, ProviderConfig, ProviderDefinition,
  AgentUsage, ArtifactItem
} from "../types.js";

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
  onUndoRun,
  onKeepChanges,
  switchModel,
  onOpenProviders,
  onAttachFile,
  onAttachDiff,
  showComposerMenu,
  setShowComposerMenu,
  sessionUsage,
  activeSessionId,
  worktreeStatus,
  onOpenArtifact,
  onOpenDiff,
  onMergeSuccess,
  onDiscardSuccess,
  attachedImages,
  setAttachedImages,
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
  onUndoRun: (id: string) => void;
  onKeepChanges: () => void;
  switchModel: (providerId: string, model: string) => void;
  onOpenProviders: () => void;
  onAttachFile: () => void;
  onAttachDiff: () => void;
  showComposerMenu: boolean;
  setShowComposerMenu: (value: boolean) => void;
  sessionUsage?: AgentUsage;
  activeSessionId?: string;
  worktreeStatus?: { isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenDiff?: () => void;
  onMergeSuccess?: () => void;
  onDiscardSuccess?: () => void;
  attachedImages: string[];
  setAttachedImages: React.Dispatch<React.SetStateAction<string[]>>;
  customCommands?: SlashCommand[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const api = window.nexus || window.forgepilot;

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages, liveEvents, streamingText]);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);

  const isSlash = draft.startsWith("/") && !draft.includes(" ");

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
        <ChatItemView
          key={`${message.createdAt}-${index}`}
          message={message}
          onOpenArtifact={onOpenArtifact}
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

  function handleDraftChange(value: string, cursorPosition: number) {
    setDraft(value);
    const beforeCursor = value.slice(0, cursorPosition);
    const match = beforeCursor.match(/@([a-zA-Z0-9_./-]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
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
    setDraft("");
    if (cmd.promptTemplate) {
      let template = cmd.promptTemplate;
      template = template.replace(/\{\{input\}\}/gi, "");
      template = template.replace(/\{\{activeFile\}\}/gi, activeFile || "workspace files");
      template = template.replace(
        /\{\{diffSummary\}\}/gi,
        diffCount ? `${diffCount} changed files` : "clean working tree"
      );
      submit(template.trim());
      return;
    }
    if (cmd.command === "/test") {
      submit("Run project verification and tests");
    } else if (cmd.command === "/diff") {
      onOpenDiff?.();
    } else if (cmd.command === "/checkpoint") {
      submit("Create checkpoint and review workspace state");
    } else if (cmd.command === "/help") {
      submit("What tools, commands, and skills are available in this project?");
    }
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
                  const saved = await api.saveAttachment(rawUrl);
                  setAttachedImages((current) => [...current, saved.url]);
                  return;
                } catch { /* ignore fallback */ }
              }
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
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = async (loadEvt) => {
          const rawUrl = loadEvt.target?.result as string;
          if (rawUrl) {
            if (api?.saveAttachment) {
              try {
                const saved = await api.saveAttachment(rawUrl);
                setAttachedImages((current) => [...current, saved.url]);
                return;
              } catch { /* ignore fallback */ }
            }
            setAttachedImages((current) => [...current, rawUrl]);
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

    if (isSlash) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((c) => c + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((c) => Math.max(0, c - 1));
        return;
      }
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      submit();
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
              <span className="cost">~${sessionUsage.estimatedCost.toFixed(4)}</span>
            </span>
          )}
          <span className="local-badge">
            <span /> Local
          </span>
          <span className="mode-badge">{mode} mode</span>
        </div>
      </div>
      <div className="agent-transcript" ref={transcriptRef}>
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
          </div>
        )}
        {transcriptNodes}
        {checkpointId && diffCount > 0 && !running && (
          <div className="rollback-card">
            <div className="rollback-info">
              <GitBranch size={14} />
              <span>
                Agent made changes in <strong>{diffCount} file{diffCount === 1 ? "" : "s"}</strong>
              </span>
            </div>
            <div className="rollback-actions">
              <button
                className="secondary"
                onClick={() => onUndoRun(checkpointId)}
                title="Discard all changes from this run"
              >
                <RotateCcw size={12} /> Undo run
              </button>
              <button className="primary" onClick={onKeepChanges} title="Accept and keep all changes">
                <Check size={12} /> Keep changes
              </button>
            </div>
          </div>
        )}
        {running && (
          <ActivityGroupView
            events={liveEvents}
            running
            currentText={streamingText}
            onOpenArtifact={onOpenArtifact}
          />
        )}
      </div>
      <div className="agent-input-area">
        <input
          type="file"
          ref={imageInputRef}
          style={{ display: "none" }}
          accept="image/*"
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
          {isSlash && (
            <SlashCommandPopup
              filter={draft}
              customCommands={customCommands}
              selectedIndex={slashIndex}
              onSelect={handleSlashSelect}
            />
          )}
          {attachedImages.length > 0 && (
            <div className="image-attachments-bar">
              {attachedImages.map((img, idx) => (
                <div className="image-preview-chip" key={idx}>
                  <img src={img} alt="Preview" className="image-preview-thumb" />
                  <button
                    className="image-preview-remove"
                    onClick={() =>
                      setAttachedImages((current) => current.filter((_, i) => i !== idx))
                    }
                    title="Remove image"
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
                      <ImageIcon size={13} /> Attach screenshot / image
                    </button>
                  </div>
                )}
              </div>
              <VoiceDictationButton
                onTranscript={(text) => setDraft(draft ? `${draft} ${text}` : text)}
                disabled={running}
              />
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
              disabled={!running && !draft.trim() && attachedImages.length === 0}
              onClick={running ? onStop : () => submit()}
              title={running ? "Stop the agent" : "Send"}
            >
              {running ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
        <div className="input-note">
          <ShieldCheck size={12} /> Nexus can edit files, inspect websites, and run safe commands inside this workspace
        </div>
      </div>
    </div>
  );
}
