import React, { useRef, useState } from "react";
import { Bot, Coins, Terminal, Activity, X, Brain, Check, Copy, Loader2, ChevronDown, ChevronRight, FileText } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";
import { timeLabel } from "../../utils/format.js";
import { isImageAttachment, formatAttachmentSize } from "../../utils/attachments.js";
import { PlanCard } from "./PlanCard.js";
import { SubagentCardView } from "./SubagentCard.js";
import { ArtifactCard } from "./ArtifactCard.js";
import type { ChatAttachment, ChatItem, ArtifactItem } from "../../types.js";

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (permissions / non-secure context) — fallback.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  if (!text) return null;
  return (
    <button
      className="pane-action"
      style={{ display: "inline-flex", alignItems: "center" }}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={copied ? "Copied!" : "Copy response to clipboard"}
      aria-label={copied ? "Copied!" : "Copy response to clipboard"}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function ChatItemView({
  message,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
}: {
  message: ChatItem;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
}) {
  if (message.artifact) {
    return (
      <ArtifactCard
        artifact={message.artifact}
        onClick={() => onOpenArtifact?.(message.artifact!)}
      />
    );
  }
  if (message.role === "event" && message.kind === "subagent" && message.subagent) {
    return <SubagentCardView subagent={message.subagent} timestamp={message.createdAt} />;
  }
  if (message.role === "event" && message.kind === "plan" && message.plan?.length) {
    return <PlanCard plan={message.plan} createdAt={message.createdAt} />;
  }
  if (message.role === "event") {
    return (
      <div className={`chat-event-row ${message.kind}`}>
        <span>
          {message.kind === "tool" ? (
            <Terminal size={12} />
          ) : message.kind === "error" ? (
            <X size={12} />
          ) : (
            <Activity size={12} />
          )}
        </span>
        <div className="chat-event-body">
          <p>{message.text}</p>
          {message.detail && (
            <pre className="chat-event-detail">{message.detail}</pre>
          )}
        </div>
        <time>{timeLabel(message.createdAt)}</time>
      </div>
    );
  }
  return (
    <div className={`chat-message ${message.role}`}>
      <div className="chat-author">
        {message.role === "assistant" ? (
          <>
            <span className="agent-avatar">
              <Bot size={13} />
            </span>{" "}
            Nexus
          </>
        ) : (
          <>
            <span className="you-avatar">ME</span> You
          </>
        )}
        <time>{timeLabel(message.createdAt)}</time>
      </div>
      {message.images && message.images.length > 0 && (
        <div className="chat-message-images">
          {message.images.map((img, idx) => (
            <button key={idx} className="chat-attached-image-button" onClick={() => onOpenImage?.(img)} title="Open attached image">
              <img src={img} alt="Attached screenshot" className="chat-attached-img" />
            </button>
          ))}
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className="chat-message-images">
          {message.attachments
            .filter((attachment) => !isImageAttachment(attachment))
            .map((attachment, idx) => (
              <button
                key={`${attachment.name}-${idx}`}
                className="chat-attached-file-button"
                onClick={() => onOpenAttachment?.(attachment)}
                title={`${attachment.name} — click to preview`}
              >
                <FileText size={13} />
                <span className="chat-attached-file-name">{attachment.name}</span>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </button>
            ))}
        </div>
      )}
      <div
        className="chat-message-text md"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
      />
      {message.role === "assistant" && Boolean(message.text?.trim()) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <CopyTextButton text={message.text} />
        </div>
      )}
      {message.role === "assistant" && message.usage && message.usage.totalTokens > 0 && (
        <div
          className="message-usage-footer"
          title={`${message.usage.inputTokens.toLocaleString()} input tokens, ${message.usage.outputTokens.toLocaleString()} output tokens`}
        >
          <Coins size={11} />
          <span>
            <b>{message.usage.totalTokens.toLocaleString()}</b> tokens (
            {message.usage.inputTokens.toLocaleString()} in / {message.usage.outputTokens.toLocaleString()} out)
          </span>
          <span className="message-usage-cost">{message.usage.estimatedCost == null ? "—" : `~$${message.usage.estimatedCost.toFixed(4)}`}</span>
        </div>
      )}
    </div>
  );
}

export function ActivityGroupView({
  events,
  running,
  currentText,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
}: {
  events: ChatItem[];
  running: boolean;
  currentText?: string;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
}) {
  const [expanded, setExpanded] = useState(running);
  const latest =
    currentText ||
    events[events.length - 1]?.text ||
    (running ? "Inspecting the workspace…" : "Completed agent activity");
  const hasError = events.some((event) => event.kind === "error");

  return (
    <div className={`activity-group ${running ? "running" : hasError ? "error" : "completed"}`}>
      <button className="activity-group-summary" onClick={() => setExpanded((value) => !value)}>
        <span className="activity-group-icon">
          {running ? <Loader2 size={13} className="spin" /> : hasError ? <X size={13} /> : <Check size={13} />}
        </span>
        <span className="activity-group-title">{latest}</span>
        <span className="activity-group-count">
          {events.length ? `${events.length} step${events.length === 1 ? "" : "s"}` : "Working"}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="activity-group-body">
          {events.map((event, index) => {
            const hasDetail = Boolean(
              (event.detail && event.detail.trim().length > 0) ||
              event.artifact ||
              event.subagent ||
              (event.plan && event.plan.length > 0)
            );

            const icon =
              event.kind === "tool" ? (
                <Terminal size={11} />
              ) : event.kind === "error" ? (
                <X size={11} />
              ) : event.kind === "plan" ? (
                <Brain size={11} />
              ) : event.kind === "subagent" ? (
                <Bot size={11} />
              ) : (
                <Activity size={11} />
              );

            if (!hasDetail) {
              return (
                <div className="activity-step static" key={`${event.createdAt}-${index}`}>
                  <div className="activity-step-row">
                    <span className={`activity-step-dot ${event.kind || "status"}`}>{icon}</span>
                    <span title={event.text || event.kind || "Agent action"}>
                      {event.text || event.kind || "Agent action"}
                    </span>
                    <time>{timeLabel(event.createdAt)}</time>
                  </div>
                </div>
              );
            }

            return (
              <details className="activity-step" key={`${event.createdAt}-${index}`} open={index === events.length - 1 && running}>
                <summary>
                  <span className={`activity-step-dot ${event.kind || "status"}`}>{icon}</span>
                  <span title={event.text || event.kind || "Agent action"}>
                    {event.text || event.kind || "Agent action"}
                  </span>
                  <time>{timeLabel(event.createdAt)}</time>
                  <ChevronRight size={12} />
                </summary>
                <div className="activity-step-detail">
                  {event.artifact && (
                    <ArtifactCard
                      artifact={event.artifact}
                      onClick={() => onOpenArtifact?.(event.artifact!)}
                    />
                  )}
                  {event.subagent && (
                    <SubagentCardView subagent={event.subagent} timestamp={event.createdAt} />
                  )}
                  {event.plan && event.plan.length > 0 && (
                    <PlanCard plan={event.plan} createdAt={event.createdAt} />
                  )}
                  {event.detail && (
                    <pre className="chat-event-detail">{event.detail}</pre>
                  )}
                </div>
              </details>
            );
          })}
          {running && currentText && (
            <div className="activity-current">
              <Loader2 size={11} className="spin" />
              {currentText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StreamingAssistantMessage({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="chat-message assistant streaming">
      <div className="chat-author">
        <span className="agent-avatar">
          <Bot size={13} />
        </span>{" "}
        Nexus
        <time>{timeLabel(new Date().toISOString())}</time>
      </div>
      <div
        className="chat-message-text md"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
    </div>
  );
}
