// Shared agent-streaming event pipeline.
//
// Extracted from useAppController and useHomeController, which duplicated the
// thinking-fold / token-route / pre-tool-clear / final-fold skeleton
// line-for-line and had begun to drift. Each controller owns its React state
// setters and its reconcile strategy; this module owns the shared skeleton.
//
// Behavior preserved exactly:
// - thinking deltas fold into ONE live step per session (tail-capped)
// - tokens only stream for the currently active session
// - tool/status/plan clears speculative pre-tool text and closes the
//   thinking burst
// - context events append to the active session transcript AND the live log
// - assistant/error drops the session's live log, folds the log + final item
//   into the transcript via `onFinal`, then reconciles with server truth via
//   `reconcile`

import { pushLiveEvent } from "../utils/format.js";
import type { ChatItem } from "../types.js";

export const THINKING_DISPLAY_CAP = 8000;

export type AgentEventSinkOptions = {
  liveEventsRef: { current: Record<string, ChatItem[]> };
  thinkingAccRef: { current: Record<string, string> };
  activeSessionRef: { current: { id: string } | null };
  setLiveEvents: (next: Record<string, ChatItem[]>) => void;
  appendStreamingToken: (delta: string) => void;
  clearStreamingText: () => void;
  /** Append a context event to the active session transcript (both controllers do the same thing). */
  onContextItem: (bucket: string, item: ChatItem) => void;
  /** Extra controller-specific handling (e.g. Code's artifact approval modal).
   *  Return true when the event is fully handled. */
  onCustomEvent?: (event: import("../types.js").AgentEvent) => boolean;
  /** Fold the final item + live log into the local transcript. */
  onFinal: (bucket: string, event: import("../types.js").AgentEvent, log: ChatItem[]) => void;
  /** Background reconcile with server truth after a final event. */
  reconcile: (bucket: string, event: import("../types.js").AgentEvent, log: ChatItem[]) => void;
  /** Remove the session from the "running" indicator set. */
  onRunEnded?: (bucket: string) => void;
};

export function createAgentEventSink(options: AgentEventSinkOptions) {
  const { liveEventsRef, thinkingAccRef, activeSessionRef } = options;
  return function handleEvent(event: import("../types.js").AgentEvent): void {
    const bucket = event.sessionId || "unknown";

    if (event.type === "thinking") {
      // Reasoning deltas fold into ONE live thinking step per session —
      // the block grows in place instead of flooding the feed with a row
      // per token. Capped to a tail so marathon reasoning stays renderable.
      const combined = (thinkingAccRef.current[bucket] || "") + event.text;
      thinkingAccRef.current[bucket] = combined.length > THINKING_DISPLAY_CAP
        ? combined.slice(combined.length - THINKING_DISPLAY_CAP)
        : combined;
      const text = thinkingAccRef.current[bucket];
      const log = liveEventsRef.current[bucket] || [];
      const last = log[log.length - 1];
      const nextLog = last?.kind === "thinking"
        ? [...log.slice(0, -1), { ...last, text, detail: text }]
        : [...log, { role: "event", kind: "thinking", text, detail: text, createdAt: event.timestamp } as ChatItem];
      liveEventsRef.current = { ...liveEventsRef.current, [bucket]: nextLog };
      options.setLiveEvents(liveEventsRef.current);
      return;
    }

    if (event.type === "token") {
      // This subscription intentionally runs once. Read the ref so tokens
      // follow the session selected after the initial render as well.
      if (activeSessionRef.current?.id && event.sessionId === activeSessionRef.current.id) {
        options.appendStreamingToken(event.text);
      }
      return;
    }

    // While tool actions or steps are running, clear any speculative pre-tool text
    if (event.type === "tool" || event.type === "status" || event.type === "plan") {
      if (activeSessionRef.current?.id && event.sessionId === activeSessionRef.current.id) {
        options.clearStreamingText();
      }
      // A tool call closes the current thinking burst — the next reasoning
      // delta starts a fresh thinking step instead of appending to the old one.
      delete thinkingAccRef.current[bucket];
    }

    const item: ChatItem = {
      role: event.type === "assistant" ? "assistant" : "event",
      text: event.text,
      kind: event.type,
      createdAt: event.timestamp,
      usage: event.usage,
      context: event.context,
      subagent: event.subagent,
      plan: event.items,
      artifact: event.artifact,
      detail: event.detail,
    };

    if (event.type === "context") {
      options.onContextItem(bucket, item);
      liveEventsRef.current = pushLiveEvent(liveEventsRef.current, bucket, item);
      options.setLiveEvents(liveEventsRef.current);
      return;
    }

    if (options.onCustomEvent?.(event)) return;

    if (event.type === "assistant" || event.type === "error") {
      const log = liveEventsRef.current[bucket] || [];
      const { [bucket]: _dropped, ...rest } = liveEventsRef.current;
      liveEventsRef.current = rest;
      delete thinkingAccRef.current[bucket];
      options.setLiveEvents(rest);
      options.clearStreamingText();
      options.onRunEnded?.(bucket);
      options.onFinal(bucket, event, log);
      options.reconcile(bucket, event, log);
      return;
    }

    liveEventsRef.current = pushLiveEvent(liveEventsRef.current, bucket, item);
    options.setLiveEvents(liveEventsRef.current);
  };
}
