// Tiered run-transcript compaction (parity with OpenCode's shrink ladder and
// ZCode's microcompaction).
//
// Nexus previously had ONE condensation move (drop oldest whole message
// groups + digest). Long tasks need graduated degradation so a run keeps as
// much working context as possible before anything is truly lost:
//
//   L0  microcompact — old tool RESULTS are cleared in place (stub + size
//       note); the newest user turns keep verbatim results. Cheap, zero
//       information loss for anything recent, huge savings on long runs
//       (tool outputs are the bulk of context).
//   L1  microcompact + boundary trim — plus group-boundary dropping with a
//       structured digest (existing trimRunMessages).
//   L2  clip tool outputs — every surviving tool result capped to 2,000 chars
//       (head+tail kept; results end with the most relevant tail).
//   L3  drop tool outputs — surviving tool results become one-line omissions.
//   L4  last resort — trim with a tiny budget and force-clip every message.
//
// Invariants at every level: the FIRST group (the original request) survives
// verbatim; AI tool_calls are never separated from their ToolMessages; the
// newest exchange is never degraded. Pure and synchronous — every function
// returns new message lists and never mutates its input.

import { ToolMessage, HumanMessage } from "@langchain/core/messages";
import { estimateMessageTokens, estimateMessagesTokens, trimRunMessages } from "../context-service.js";

export type CompactionLevel = "none" | "microcompact" | "trim" | "clip-outputs" | "drop-outputs" | "last-resort";

export type CompactionResult = {
  messages: any[];
  level: CompactionLevel;
  tokensBefore: number;
  tokensAfter: number;
  /** How many tool results were cleared/clipped/dropped — telemetry only. */
  touched: number;
};

const kindOf = (message: any): string => (
  typeof message?._getType === "function" ? message._getType()
    : typeof message?.type === "string" ? message.type
      : message?.role || ""
);

function textOf(message: any): string {
  const content = message?.content ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === "string" ? part : String(part?.text ?? ""))).join("\n");
  }
  return "";
}

function replacedToolMessage(original: any, content: string): ToolMessage {
  const next = new ToolMessage({
    content,
    tool_call_id: original.tool_call_id,
    ...(original.name ? { name: original.name } : {}),
  });
  for (const [key, value] of Object.entries(original)) {
    if (!(key in next) && key !== "content" && value !== undefined) {
      try { (next as any)[key] = value; } catch { /* read-only field */ }
    }
  }
  return next;
}

/**
 * Index where the last `keepUserTurns` user turns begin. Everything earlier
 * is fair game for microcompaction. Returns messages.length when there are
 * fewer user turns than requested (nothing gets cleared).
 */
function microcompactBoundary(messages: any[], keepUserTurns: number): number {
  const userStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (kindOf(messages[i]) === "human") userStarts.push(i);
  }
  // Boundary = start of the keep window: tool results at or after it stay
  // verbatim. Fewer user turns than the window → nothing is stale.
  if (userStarts.length <= keepUserTurns) return 0;
  return userStarts[userStarts.length - keepUserTurns];
}

export type MicrocompactResult = { messages: any[]; cleared: number; charsFreed: number };

/**
 * L0 — clear stale tool RESULTS in place. Results older than the last
 * `keepUserTurns` user turns are replaced by a bounded stub that preserves
 * the tool name and a preview, so the model keeps the shape of what happened
 * without paying for the full payload on every later request. Pairing
 * (tool_call_id) is preserved; the newest user turns keep verbatim results.
 */
export function microcompactToolResults(messages: any[], opts: { keepUserTurns?: number; stubPreviewChars?: number; maxResultChars?: number } = {}): MicrocompactResult {
  const keepUserTurns = opts.keepUserTurns ?? 2;
  const previewChars = opts.stubPreviewChars ?? 160;
  const maxResultChars = opts.maxResultChars ?? 0; // 0 = clear unconditionally beyond the boundary
  const list = (messages || []).filter(Boolean);
  const boundary = microcompactBoundary(list, keepUserTurns);
  let cleared = 0;
  let charsFreed = 0;
  const out = list.map((message, index) => {
    if (index >= boundary || kindOf(message) !== "tool") return message;
    const text = textOf(message);
    if (!text || text.length <= previewChars + 80) return message; // already small — keep
    if (maxResultChars > 0 && text.length <= maxResultChars) return message;
    const preview = text.slice(0, previewChars).replace(/\s+/g, " ").trim();
    const stub = `[Tool result cleared to preserve context · was ${text.length} chars · ${message.name || "tool"} · preview: ${preview}…]`;
    if (stub.length >= text.length) return message;
    cleared++;
    charsFreed += text.length - stub.length;
    return replacedToolMessage(message, stub);
  });
  return { messages: out, cleared, charsFreed };
}

function clipToolOutputs(messages: any[], capChars: number): { messages: any[]; touched: number } {
  let touched = 0;
  const out = messages.map((message, index) => {
    if (index < messages.length - 2 && kindOf(message) === "tool") {
      const text = textOf(message);
      if (text.length > capChars) {
        touched++;
        const head = text.slice(0, Math.floor(capChars * 0.6));
        const tailPart = text.slice(-Math.floor(capChars * 0.4));
        return replacedToolMessage(message, `${head}\n…[clipped ${text.length - capChars} chars for context]…\n${tailPart}`);
      }
    }
    return message;
  });
  return { messages: out, touched };
}

function dropToolOutputs(messages: any[]): { messages: any[]; touched: number } {
  let touched = 0;
  const out = messages.map((message, index) => {
    if (index < messages.length - 2 && kindOf(message) === "tool") {
      const name = message.name || "tool";
      touched++;
      return replacedToolMessage(message, `[${name} result omitted for context — the completed-steps ledger and journal carry what matters]`);
    }
    return message;
  });
  return { messages: out, touched };
}

function forceClipAll(messages: any[], capChars: number): { messages: any[]; touched: number } {
  let touched = 0;
  const out = messages.map((message, index) => {
    if (index === 0 || index >= messages.length - 2) return message;
    const text = textOf(message);
    if (text.length > capChars) {
      touched++;
      return replacedToolMessage(message, `${text.slice(0, capChars)}…[clipped]`);
    }
    return message;
  });
  return { messages: out, touched };
}

/**
 * The full ladder. Runs levels in order and returns the FIRST result whose
 * estimated token count fits `budgetTokens`; if nothing fits, returns the
 * most aggressive level's result. `level: "none"` means the input already
 * fit and was returned unchanged (same array contents, untouched references).
 */
export function shrinkToBudget(messages: any[], budgetTokens: number, opts: { keepUserTurns?: number } = {}): CompactionResult {
  const list = (messages || []).filter(Boolean);
  const tokensBefore = estimateMessagesTokens(list);
  if (tokensBefore <= budgetTokens) {
    // Nothing to do: return the caller's own array (identity preserved).
    return { messages: list.length === (messages || []).length ? messages : list, level: "none", tokensBefore, tokensAfter: tokensBefore, touched: 0 };
  }

  // L0: microcompact — cheapest, zero recent-loss.
  const micro = microcompactToolResults(list, opts);
  const microTokens = estimateMessagesTokens(micro.messages);
  if (microTokens <= budgetTokens) {
    return { messages: micro.messages, level: "microcompact", tokensBefore, tokensAfter: microTokens, touched: micro.cleared };
  }

  // L1: + boundary trim (keeps the original request + structured digest).
  const trimmed = trimRunMessages(micro.messages, budgetTokens);
  const trimmedTokens = estimateMessagesTokens(trimmed);
  if (trimmedTokens <= budgetTokens) {
    return { messages: trimmed, level: "trim", tokensBefore, tokensAfter: trimmedTokens, touched: micro.cleared };
  }

  // L2: clip surviving tool outputs to 2,000 chars.
  const clipped = clipToolOutputs(trimmed, 2_000);
  const clippedTokens = estimateMessagesTokens(clipped.messages);
  if (clippedTokens <= budgetTokens) {
    return { messages: clipped.messages, level: "clip-outputs", tokensBefore, tokensAfter: clippedTokens, touched: micro.cleared + clipped.touched };
  }

  // L3: drop surviving tool outputs entirely.
  const dropped = dropToolOutputs(clipped.messages);
  const droppedTokens = estimateMessagesTokens(dropped.messages);
  if (droppedTokens <= budgetTokens) {
    return { messages: dropped.messages, level: "drop-outputs", tokensBefore, tokensAfter: droppedTokens, touched: micro.cleared + clipped.touched + dropped.touched };
  }

  // L4: last resort — force-clip everything but the first and last exchanges.
  const last = forceClipAll(dropped.messages, 1_000);
  const lastTokens = estimateMessagesTokens(last.messages);
  return {
    messages: last.messages,
    level: "last-resort",
    tokensBefore,
    tokensAfter: lastTokens,
    touched: micro.cleared + clipped.touched + dropped.touched + last.touched,
  };
}

/**
 * Structured compaction digest for the messages dropped by trimRunMessages.
 * Fixed template (Objective carried verbatim by group 0; this covers work
 * state) so downstream prompts can rely on the shape. Kept deterministic —
 * no model call, so compaction never costs tokens or fails.
 */
export function buildDroppedWorkDigest(droppedMessages: any[], maxEntries = 12): string {
  const lines: string[] = [];
  for (const message of droppedMessages || []) {
    const kind = kindOf(message);
    // AI messages that only carry tool calls have no text — record the calls
    // themselves before the empty-text guard skips the message entirely.
    if (kind === "ai" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls) {
        lines.push(`- called ${call?.name || "tool"}`);
      }
      continue;
    }
    const text = textOf(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (kind === "tool") {
      lines.push(`- ${message.name || "tool"} → ${text.slice(0, 120)}`);
    } else if (kind === "human") {
      lines.push(`- said: ${text.slice(0, 160)}`);
    }
  }
  const body = lines.slice(0, maxEntries).join("\n");
  const more = lines.length > maxEntries ? `\n…[${lines.length - maxEntries} more actions condensed]` : "";
  return `[Condensed earlier work — the original request is below in context]\nWork performed:\n${body}${more}`;
}

/** Compact with a durable task brief attached, via the ladder. */
export function shrinkWithBrief(messages: any[], budgetTokens: number, brief: string, opts: { keepUserTurns?: number } = {}): CompactionResult {
  const trimmedBrief = String(brief || "").trim();
  if (!trimmedBrief) return shrinkToBudget(messages, budgetTokens, opts);
  const withBrief = [...(messages || []).filter(Boolean), new HumanMessage(trimmedBrief)];
  const result = shrinkToBudget(withBrief, budgetTokens, opts);
  // If the brief itself was trimmed away by group-dropping, re-attach it —
  // the journal brief is the one thing a resumed run must always see.
  if (!result.messages.some((m) => textOf(m) === trimmedBrief)) {
    result.messages = [new HumanMessage(trimmedBrief), ...result.messages];
  }
  result.tokensAfter = estimateMessagesTokens(result.messages);
  return result;
}

export { estimateMessageTokens };
