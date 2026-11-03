// Per-session run checkpoints: full LangChain message history + working plan,
// in memory and mirrored to .nexus/run-checkpoints/ so "continue" survives an
// app restart. Extracted from agent-service.ts.
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describeToolCall } from "./tool-describe.js";
import { sanitizeResumeCheckpoint } from "./rate-limit.js";
import { writeFileAtomic } from "./atomic-write.js";
import type { PlanItem } from "./agent-types.js";

// Checkpoint of the last run per session: full LangChain message history
// (tool calls + results) plus the working plan. This is what lets a
// follow-up "continue" resume instead of restarting — text history alone
// (user/assistant turns) cannot reconstruct tool state. Kept in memory for
// speed and mirrored to disk (.nexus/run-checkpoints/) so "continue" also
// survives an app restart, when the in-memory map is empty.
export type TaskLedger = {
  updatedAt: string;
  planItems: PlanItem[] | null;
  completedSteps: string[];
  lastDiagnostics: string[];
  changedFiles: string[];
  verification: "none" | "passed" | "failed" | "interrupted";
};
export type RunCheckpoint = { messages: any[]; planItems: PlanItem[] | null; ledger?: TaskLedger };
const lastRunStore = new Map<string, RunCheckpoint>();

export function getLastRunCheckpoint(sessionId: string | undefined): RunCheckpoint | null {
  if (!sessionId) return null;
  return lastRunStore.get(sessionId) ?? null;
}

function countToolCalls(messages: any[]): number {
  let count = 0;
  for (const m of messages || []) {
    if (Array.isArray(m?.tool_calls)) count += m.tool_calls.length;
  }
  return count;
}

function sliceAlignedMessages(messages: any[], maxCount: number): any[] {
  const all = messages || [];
  if (all.length <= maxCount) return all;
  let startIdx = all.length - maxCount;
  while (startIdx < all.length) {
    const m = all[startIdx];
    const isTool = (m as any)?.type === "tool" || (m as any)?._getType?.() === "tool" || (m as any)?.constructor?.name === "ToolMessage";
    if (isTool) startIdx++;
    else break;
  }
  return all.slice(startIdx);
}


export function saveLastRunCheckpoint(sessionId: string | undefined, checkpoint: RunCheckpoint, telemetryRoot?: string): void {
  if (!sessionId) return;

  const messages = sliceAlignedMessages(checkpoint.messages, 100);
  const ledger = checkpoint.ledger ?? {
    updatedAt: new Date().toISOString(),
    planItems: checkpoint.planItems ?? null,
    completedSteps: summarizeCompletedSteps(messages),
    lastDiagnostics: messages
      .filter((message: any) => message?.type === "tool" || message?.type === "human")
      .map((message: any) => String(message?.content ?? ""))
      .filter((text: string) => /error|failed|diagnostic|verification/i.test(text))
      .slice(-8)
      .map((text: string) => text.slice(-600)),
    changedFiles: [],
    verification: "none",
  };
  const next = { messages, planItems: checkpoint.planItems ?? null, ledger };
  // A run that did no tool work (pure Q&A) must not clobber the checkpoint
  // of the previous working run — otherwise a later "continue" would resume
  // from the small talk instead of the interrupted task.
  const existing = lastRunStore.get(sessionId);
  if (existing && countToolCalls(messages) === 0 && countToolCalls(existing.messages) > 0) return;
  lastRunStore.set(sessionId, next);
  if (telemetryRoot) {
    void persistLastRunCheckpoint(telemetryRoot, sessionId).catch(() => { /* best effort */ });
  }
}

function runCheckpointPath(telemetryRoot: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(telemetryRoot, ".nexus", "run-checkpoints", `${safe}.json`);
}

function truncateForDisk(value: unknown, cap = 1500): unknown {
  if (typeof value === "string") {
    return value.length > cap ? `${value.slice(0, cap)}\n…[truncated for checkpoint storage]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateForDisk(v, cap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === "content" ? truncateForDisk(v, cap) : v;
    return out;
  }
  return value;
}

// Disk checkpoints used to truncate EVERY string to 1,500 chars, so a
// post-restart "continue" replayed stubbed read results and the model
// re-read files it had already inspected — pure wasted steps and tokens.
// Tool results (the read/search outputs that matter on resume) keep up to
// 6,000 chars; everything else keeps the tight cap.
const DISK_CAP_DEFAULT = 1500;
const DISK_CAP_TOOL_RESULT = 6000;

const CHECKPOINT_TYPE_BY_CLASS: Record<string, string> = {
  HumanMessage: "human",
  AIMessage: "ai",
  ToolMessage: "tool",
  SystemMessage: "system",
};

function serializeCheckpointMessage(message: any): unknown {
  try {
    const json = typeof message?.toJSON === "function" ? message.toJSON() : message;
    if (!json || typeof json !== "object") return null;
    const data = json as { type?: string; id?: unknown; kwargs?: unknown };
    // LangChain toJSON uses { type: "constructor", id: [..., "AIMessage"] } —
    // the message kind lives in the trailing id segment, not in `type`.
    const className = Array.isArray(data.id) ? String(data.id[data.id.length - 1]) : "";
    const type = CHECKPOINT_TYPE_BY_CLASS[className] ?? (typeof data.type === "string" && ["human", "ai", "tool", "system"].includes(data.type) ? data.type : null);
    if (!type) return null;
    return { type, kwargs: truncateForDisk(data.kwargs ?? {}, type === "tool" ? DISK_CAP_TOOL_RESULT : DISK_CAP_DEFAULT) };
  } catch {
    return null;
  }
}

export async function persistLastRunCheckpoint(telemetryRoot: string, sessionId: string): Promise<void> {
  const checkpoint = lastRunStore.get(sessionId);
  if (!checkpoint || !telemetryRoot) return;
  const filePath = runCheckpointPath(telemetryRoot, sessionId);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    planItems: checkpoint.planItems,
    ledger: checkpoint.ledger ?? {
      updatedAt: new Date().toISOString(),
      planItems: checkpoint.planItems,
      completedSteps: summarizeCompletedSteps(checkpoint.messages),
      lastDiagnostics: [],
      changedFiles: [],
      verification: "none",
    },
    messages: sliceAlignedMessages(checkpoint.messages, 80).map(serializeCheckpointMessage).filter(Boolean),
  };
  // Atomic write: a crash mid-write must not leave a truncated checkpoint —
  // loadLastRunCheckpoint would silently return null and "continue" would
  // lose the whole run instead of resuming.
  await writeFileAtomic(filePath, JSON.stringify(payload));
}

function reviveCheckpointMessage(stored: any): any | null {
  try {
    if (!stored || typeof stored !== "object" || !stored.type) return null;
    const kwargs = (stored.kwargs ?? {}) as any;
    switch (stored.type) {
      case "human": return new HumanMessage(kwargs);
      case "ai": return new AIMessage(kwargs);
      case "tool": return new ToolMessage(kwargs);
      case "system": return new SystemMessage(kwargs);
      default: return null;
    }
  } catch {
    return null;
  }
}

export async function loadLastRunCheckpoint(telemetryRoot: string, sessionId: string | undefined): Promise<RunCheckpoint | null> {
  if (!sessionId) return null;
  const inMemory = lastRunStore.get(sessionId);
  if (inMemory) return inMemory;
  try {
    const raw = await fsPromises.readFile(runCheckpointPath(telemetryRoot, sessionId), "utf8");
    const parsed = JSON.parse(raw) as { planItems?: PlanItem[] | null; messages?: any[]; ledger?: TaskLedger };
    const messages = (parsed.messages || []).map(reviveCheckpointMessage).filter(Boolean);
    if (!messages.length) return null;
    const checkpoint = { messages: sanitizeResumeCheckpoint(messages), planItems: parsed.planItems ?? null, ledger: parsed.ledger };
    lastRunStore.set(sessionId, checkpoint);
    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * Deterministic record of finished tool work, derived from message history:
 * every model tool call that has a matching tool result. Weak models often
 * ignore "do not repeat completed steps" after a retry/continue because the
 * raw history is long — an explicit ledger ("- read_file src/App.tsx")
 * survives where prose instructions don't.
 */
export function summarizeCompletedSteps(messages: any[], max = 25): string[] {
  type Step = { id: string | null; desc: string; done: boolean };
  const steps: Step[] = [];
  const byId = new Map<string, Step>();
  for (const message of messages || []) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      const desc = describeToolCall(call?.name || "tool", call?.args) || (call?.name || "tool");
      const label = `${call?.name || "tool"} · ${desc}`;
      const step: Step = { id: typeof call?.id === "string" ? call.id : null, desc: label, done: false };
      steps.push(step);
      if (step.id) byId.set(step.id, step);
      else step.done = true; // result-less shape: can't match, count as seen
    }
    const resultId = (message as any)?.tool_call_id;
    if (typeof resultId === "string" && byId.has(resultId)) {
      byId.get(resultId)!.done = true;
    }
  }
  return steps.filter((s) => s.done).map((s) => s.desc).slice(-max);
}

export function clearLastRunCheckpoint(sessionId: string | undefined): void {
  if (!sessionId) return;
  lastRunStore.delete(sessionId);
}
