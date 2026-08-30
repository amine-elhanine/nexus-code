import React, { useState } from "react";
import { Bot, Coins, Terminal, Activity, X, Brain, Check, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";
import { timeLabel } from "../../utils/format.js";
import { PlanCard } from "./PlanCard.js";
import { SubagentCardView } from "./SubagentCard.js";
import { ArtifactCard } from "./ArtifactCard.js";
import type { ChatItem, ArtifactItem } from "../../types.js";

export function ChatItemView({
  message,
  onOpenArtifact,
}: {
  message: ChatItem;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
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
        <p>{message.text}</p>
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
            <img key={idx} src={img} alt="Attached screenshot" className="chat-attached-img" />
          ))}
        </div>
      )}
      <div
        className="chat-message-text md"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
      />
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
          <span className="message-usage-cost">~${message.usage.estimatedCost.toFixed(4)}</span>
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
}: {
  events: ChatItem[];
  running: boolean;
  currentText?: string;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
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
          {events.map((event, index) => (
            <details className="activity-step" key={`${event.createdAt}-${index}`} open={index === events.length - 1 && running}>
              <summary>
                <span className={`activity-step-dot ${event.kind || "status"}`}>
                  {event.kind === "tool" ? (
                    <Terminal size={11} />
                  ) : event.kind === "error" ? (
                    <X size={11} />
                  ) : event.kind === "plan" ? (
                    <Brain size={11} />
                  ) : event.kind === "subagent" ? (
                    <Bot size={11} />
                  ) : (
                    <Activity size={11} />
                  )}
                </span>
                <span>{event.text || event.kind || "Agent action"}</span>
                <time>{timeLabel(event.createdAt)}</time>
                <ChevronRight size={12} />
              </summary>
              <div className="activity-step-detail">
                <ChatItemView message={event} onOpenArtifact={onOpenArtifact} />
              </div>
            </details>
          ))}
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
