// Shared building blocks for the two agent run lanes (`agent:run` for Code,
// `home:run` for Home). The lanes were ~360-line twins whose private copies
// drifted independently — Home silently lost the image skip on attachments,
// inverted the persist/slot order, and bypassed edit approval, each a real
// bug. Anything owned by BOTH lanes lives here so drift is impossible by
// construction; the routes keep only their genuinely mode-specific parts.

import { resolveImageForModel, resolveAttachmentBytes } from "../attachment-utils.js";
import type { HistoryInput, PlanItem, AgentEvent, AgentUsage } from "../agent-service.js";
import type { SubagentItem } from "../subagent-service.js";
import type { ArtifactItem } from "../artifacts-service.js";

export type RunAttachment = { url: string; name: string; mimeType: string; size: number };

type TranscriptMessage = {
  role: string;
  text: string;
  kind?: string;
  detail?: string;
  plan?: PlanItem[];
  subagent?: { role: string; task: string; status: string } | null;
};

/** One persisted transcript row (an event row — the assistant row is written
 *  separately by each lane with its own usage/context payloads). */
export type RunTranscriptItem = {
  role: "event";
  text: string;
  kind: AgentEvent["type"];
  createdAt: string;
  plan?: PlanItem[];
  subagent?: SubagentItem;
  artifact?: ArtifactItem;
  usage?: AgentUsage;
  context?: AgentEvent["context"];
  detail?: string;
};

/**
 * Maps persisted transcript messages to the HistoryInput shape the agent
 * loop consumes. Event-role messages are preserved as events (NOT flattened
 * into assistant turns): flattening floods the conversation with fake
 * answers and teaches the model to repeat its previous output instead of
 * answering the current user message.
 * Caller passes the PRE-APPEND snapshot so this run's own request is not
 * duplicated into history.
 */
export function messagesToHistory(priorMessages: TranscriptMessage[] | undefined): HistoryInput[] {
  return (priorMessages || []).map((message) =>
    message.role === "event"
      ? {
          role: "event" as const,
          text: message.text,
          kind: message.kind,
          detail: message.detail,
          plan: message.plan,
          subagent: message.subagent
            ? { role: message.subagent.role, task: message.subagent.task, status: message.subagent.status }
            : undefined,
        }
      : { role: message.role as "user" | "assistant", text: message.text }
  );
}

/** Resolve pasted/attached images to model-visible data URLs. */
export async function resolveModelImages(images?: string[]): Promise<string[] | undefined> {
  return images?.length
    ? await Promise.all(images.map((img) => resolveImageForModel(img).catch(() => img)))
    : undefined;
}

const ATTACH_DOC_CHAR_CAP = 20_000;
export type AttachmentDoc = { name: string; mimeType: string; text: string; truncated: boolean };

/**
 * Document attachments (pdf/docx/xlsx/pptx/tex/…) are extracted to text here
 * so the model actually sees them; every attachment's raw bytes are ALSO
 * exposed as an importable data URL so the agent can materialize the file in
 * the workspace on request. Images are vision-only and skip doc extraction —
 * feeding them to parseToMarkdown produced "[Binary file …]" noise.
 * Each attachment's bytes are resolved exactly ONCE (the old two-loop shape
 * resolved every file twice and held ~3 copies live for the whole run).
 * Small text-ish files decode directly, no parser overhead; Office/PDF go
 * through the notebook parsers; each file is capped so one giant spreadsheet
 * can't eat the context.
 */
export async function processRunAttachments(
  attachments: RunAttachment[] | undefined,
  modelImages: string[] | undefined
): Promise<{ attachmentDocs: AttachmentDoc[]; importableAttachments: string[] }> {
  const attachmentDocs: AttachmentDoc[] = [];
  const importableAttachments: string[] = [];
  if (attachments?.length) {
    const { parseToMarkdown } = await import("../notebook-parse.js");
    for (const attachment of attachments) {
      try {
        const isImage = (attachment.mimeType || "").toLowerCase().startsWith("image/");
        const { buffer, fileName, mimeType } = await resolveAttachmentBytes(attachment.url);
        const name = attachment.name || fileName;
        const mime = attachment.mimeType || mimeType;
        importableAttachments.push(`data:${mime};base64,${buffer.toString("base64")}#${encodeURIComponent(attachment.name || name || "attachment")}`);
        if (isImage) continue;
        if (/^(text\/|application\/json|application\/xml)/.test(mime.toLowerCase()) || /\.(txt|tex|md|markdown|csv|tsv|json|yaml|yml|xml|html|htm|log|toml)$/i.test(name)) {
          const text = buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
          if (!text.trim()) continue;
          const truncated = text.length > ATTACH_DOC_CHAR_CAP;
          attachmentDocs.push({ name, mimeType: mime, text: truncated ? text.slice(0, ATTACH_DOC_CHAR_CAP) : text, truncated });
          continue;
        }
        try {
          const parsed = await parseToMarkdown(buffer, name);
          if (!parsed.markdown.trim()) continue;
          const truncated = parsed.markdown.length > ATTACH_DOC_CHAR_CAP || parsed.truncated;
          attachmentDocs.push({ name, mimeType: mime, text: parsed.markdown.slice(0, ATTACH_DOC_CHAR_CAP), truncated });
        } catch {
          // Unparseable binary (legacy .doc/.ppt/.xls, …): still tell the
          // model the file exists so it can ask for another format.
          attachmentDocs.push({ name, mimeType: mime, text: `[Binary file ${name} could not be text-extracted in-app. Ask the user for a .docx/.xlsx/.pptx/.pdf/.txt export if its contents are needed.]`, truncated: false });
        }
      } catch {
        // One bad attachment must never fail the whole run.
      }
    }
  }
  if (importableAttachments.length === 0 && modelImages?.length) {
    importableAttachments.push(...modelImages);
  }
  return { attachmentDocs, importableAttachments };
}

/**
 * Seeds the context meter with the session's last reported context so a new
 * request doesn't drop the bar back to the text-only estimate.
 */
export function seedPreviousContextTokens(messages: Array<{ context?: { usedTokens?: number } }> | undefined): number | null {
  return [...(messages || [])]
    .reverse()
    .find((m) => m.context?.usedTokens && m.context.usedTokens > 0)
    ?.context?.usedTokens ?? null;
}

/**
 * Run transcript + thinking buffer. Thinking deltas accumulate into ONE
 * ephemeral transcript item and are flushed on the first tool/plan/status
 * event (the thinking burst is over) — both lanes had this identical machine,
 * byte for byte. Token/thinking deltas stay ephemeral; the assistant message
 * is persisted once at run end (pushing them here too would store every
 * answer twice and double history size).
 */
export function createRunTranscript() {
  const items: RunTranscriptItem[] = [];
  let accumulatedThinking = "";
  let thinkingStartTimestamp = "";
  const flushThinking = () => {
    if (accumulatedThinking.trim()) {
      items.push({
        role: "event",
        text: accumulatedThinking.trim(),
        kind: "thinking",
        createdAt: thinkingStartTimestamp || new Date().toISOString(),
        detail: accumulatedThinking.trim(),
      });
      accumulatedThinking = "";
      thinkingStartTimestamp = "";
    }
  };
  const handleEvent = (event: AgentEvent) => {
    if (event.type === "thinking") {
      if (!thinkingStartTimestamp) thinkingStartTimestamp = event.timestamp || new Date().toISOString();
      accumulatedThinking += event.text || "";
    } else if (event.type === "tool" || event.type === "plan" || event.type === "status") {
      flushThinking();
    }
    if (event.type !== "token" && event.type !== "thinking" && event.type !== "assistant") {
      items.push({
        role: "event",
        text: event.text,
        kind: event.type,
        createdAt: event.timestamp,
        plan: event.items,
        subagent: event.subagent,
        artifact: event.artifact,
        // The usage EVENT is transient display data; persisted usage lives on
        // the final assistant message (both lanes agreed on this for the
        // assistant row — Code additionally kept usage off the event row,
        // which is the cleaner contract and now the only one).
        usage: event.type === "usage" ? undefined : event.usage,
        context: event.context,
        detail: event.detail,
      });
    }
  };
  return { items, flushThinking, handleEvent };
}

// ── Physical lane merge (runAgentSession layer) ─────────────────────────────
// The slot lifecycle, resume collection, interruption tails, and success
// persist below were still private ~50-line copies in each route — already
// drifted once (Home's persist/slot inversion). They are THE shared run
// skeleton now; routes supply only their mode-specific pieces.

import { acquireRunSlot, releaseRunSlot } from "./run-guard.js";
import { beginCommandRun, endCommandRun, isCommandRunCancelled } from "../command-service.js";
import { RunCancelledError } from "../agent-service.js";
import type { MainIpcContext } from "./context.js";
import { getLastRunCheckpoint, loadLastRunCheckpoint } from "../run-checkpoint.js";
import { isContinueRequest } from "../agent-service.js";
import { collectResumeContext, buildResumeNote } from "../resume-note.js";

type RunResult = { response: string; usage?: AgentUsage; context?: unknown; memoryEntry?: string };

export type RunLaneIo<T extends RunResult = RunResult> = {
  ctx: MainIpcContext;
  sessionId: string;
  lane: ReturnType<typeof createRunTranscript>;
  /** Append transcript rows + any final row to the lane's store. */
  appendMessages: (items: Array<Record<string, unknown>>) => Promise<unknown>;
  /** Lane name for error lines ("Agent run failed: …" / "Home run failed: …"). */
  laneLabel: string;
  /** Extra context for the error line (Home adds a checkpoint hint). */
  buildErrorText?: (errorText: string) => Promise<string>;
};

/** Slot lifecycle wrapper: acquire → run → release, with run bookkeeping. */
export async function withRunSlot<T>(io: Pick<RunLaneIo, "ctx" | "sessionId">, fn: () => Promise<T>): Promise<T> {
  await acquireRunSlot(io.ctx.activeRunSessions, io.sessionId);
  beginCommandRun(io.sessionId);
  try {
    return await fn();
  } finally {
    releaseRunSlot(io.ctx.activeRunSessions, io.sessionId);
    endCommandRun(io.sessionId);
  }
}

/**
 * Continue-resume collection: a bare "continue"/affirmation after an
 * interrupt/stop must pick up the prior run's tool checkpoint, plan and diff
 * — otherwise the model restarts from scratch. Checkpoint cache covers
 * same-process resume; the disk mirror covers app restarts.
 */
export async function collectRunResume(options: {
  sessionId: string;
  root: string;
  request: string;
  sessionMessages: unknown;
  resumeNoteSuffix: string;
}): Promise<{ stored: ReturnType<typeof getLastRunCheckpoint>; resumeNote: string | null; lastPlan: PlanItem[] | null }> {
  const wantResume = isContinueRequest(options.request || "");
  const stored = wantResume ? getLastRunCheckpoint(options.sessionId) ?? await loadLastRunCheckpoint(options.root, options.sessionId) : null;
  let resumeNote: string | null = null;
  let lastPlan: PlanItem[] | null = null;
  if (wantResume) {
    const context = await collectResumeContext(options.sessionMessages as never, options.root);
    lastPlan = context.lastPlan;
    resumeNote = buildResumeNote(options.sessionMessages as never, context, stored, options.resumeNoteSuffix);
  }
  return { stored, resumeNote, lastPlan };
}

/**
 * Interruption tail — THE single implementation of the cancel/error endings
 * for both lanes. Cancel: persist the transcript + a stop line, emit, and
 * return the stop text (a clean end, not an error). Failure: persist the
 * transcript + an error event row, emit, and rethrow (the IPC boundary
 * surfaces it). Tokens burned before the interruption ride on the thrown
 * error's `usage` and are still reported.
 */
export async function handleRunInterruption(io: RunLaneIo, error: unknown): Promise<never | string> {
  io.lane.flushThinking();
  const isCancel = error instanceof RunCancelledError || isCommandRunCancelled(io.sessionId) || (error as { name?: string })?.name === "AbortError";
  const failedUsage = (error as { usage?: AgentUsage })?.usage;
  const usageText = failedUsage
    ? `Token usage · ${failedUsage.totalTokens} tokens${failedUsage.estimatedCost == null ? "" : ` (~$${failedUsage.estimatedCost})`}`
    : null;
  if (isCancel) {
    const stopText = "⏹️ Run stopped by user. Progress has been saved.\n\nSay **continue** to pick up from where I stopped.";
    await io.appendMessages([
      ...io.lane.items,
      { role: "assistant", text: stopText, createdAt: new Date().toISOString(), ...(failedUsage ? { usage: failedUsage } : {}) },
    ]);
    io.ctx.emitFor(io.sessionId, { type: "assistant", text: stopText, ...(failedUsage ? { usage: failedUsage } : {}) } as AgentEvent);
    if (failedUsage && usageText) io.ctx.emitFor(io.sessionId, { type: "usage", text: usageText, usage: failedUsage } as AgentEvent);
    io.ctx.emitFor(io.sessionId, { type: "status", text: "Stopped by user. Ready to continue." } as AgentEvent);
    return stopText;
  }
  const errorText = error instanceof Error ? error.message : String(error);
  const userError = io.buildErrorText ? await io.buildErrorText(errorText) : errorText;
  await io.appendMessages([
    ...io.lane.items,
    { role: "event", kind: "error", text: `${io.laneLabel} failed: ${userError}`, createdAt: new Date().toISOString(), ...(failedUsage ? { usage: failedUsage } : {}) },
  ]);
  io.ctx.emitFor(io.sessionId, { type: "error", text: `${io.laneLabel} failed: ${userError}` } as AgentEvent);
  if (failedUsage && usageText) io.ctx.emitFor(io.sessionId, { type: "usage", text: usageText, usage: failedUsage } as AgentEvent);
  throw error;
}

/**
 * Success tail: flush any open thinking burst, persist the transcript rows +
 * the final assistant row (usage/context attached exactly once), and return
 * the response text.
 */
export async function persistRunSuccess<T extends RunResult>(io: RunLaneIo, result: T): Promise<string> {
  io.lane.flushThinking();
  await io.appendMessages([
    ...io.lane.items,
    { role: "assistant", text: result.response, createdAt: new Date().toISOString(), usage: result.usage, context: result.context },
  ]);
  return result.response;
}
