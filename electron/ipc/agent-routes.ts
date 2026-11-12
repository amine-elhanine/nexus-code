// Code-mode agent run IPC routes: agent:run orchestrates session bookkeeping
// around runProjectAgent (user transcript persistence, resume checkpoints,
// dev-server preview auto-open, worktree auto-commit, Undo checkpoint stack,
// and memory roll-forward). agent:cancel stops runs + pending approvals.

import { ipcMain } from "electron";
import path from "node:path";
import {
  appendSessionMessages, getProject, getSession, listProviders, updateProjectMemory, updateProjectFacts, updateSession,
  getAppSettings, type AppSettings, truncateSessionFromMessage, forkSessionAtMessage,
} from "../store.js";
import {
  runProjectAgent, RunCancelledError, isContinueRequest, getLastRunCheckpoint, loadLastRunCheckpoint,
  summarizeCompletedSteps, appendEntryLog, PROJECT_MEMORY_RUN_LOG_CAP, SESSION_MEMORY_ENTRY_CAP, SESSION_MEMORY_CHAR_CAP,
  type AgentMode, type AgentEvent, type AgentSettings, type AgentUsage, type HistoryInput, type PlanItem,
} from "../agent-service.js";
import { getAgentBackend, beginCommandRun, cancelCommandRun, endCommandRun, isCommandRunCancelled } from "../command-service.js";
import { createWorkspaceCheckpoint, getWorkspaceDiffFiles } from "../diff-service.js";
import { commitSessionWork, getHeadCommit } from "../repo-service.js";
import { isGitRepo, getSessionWorktree } from "../worktree-service.js";
import { agentBrowserService } from "../browser-service.js";
import { isProjectRunRequest } from "../task-routing.js";
import { cancelCommandApprovals } from "../approval-service.js";
import { resolveImageForModel, resolveAttachmentBytes } from "../attachment-utils.js";
import { pushCheckpoint } from "../checkpoint-stack.js";
import { isLikelyDevServerCommand, extractLocalDevServerUrl, waitForLocalServer } from "../project-preview.js";
import { assertPayload, AgentRunSchema, AgentCancelSchema } from "./schemas.js";
import { buildResumeNote, collectResumeContext } from "../resume-note.js";
import { acquireRunSlot, releaseRunSlot } from "./run-guard.js";
import type { MainIpcContext } from "./context.js";

// Each run collects its own transcript events so they can be persisted to the
// session in one batch — tool traces and plans survive an app restart now.
type RunTranscript = {
  items: Array<{
    role: "event"; text: string; kind: AgentEvent["type"]; createdAt: string;
    plan?: AgentEvent["items"]; subagent?: AgentEvent["subagent"]; artifact?: AgentEvent["artifact"];
    usage?: AgentEvent["usage"]; context?: AgentEvent["context"]; detail?: string;
  }>;
};

export function registerAgentRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("agent:run", async (_event, payload: { request: string; images?: string[]; attachments?: Array<{ url: string; name: string; mimeType: string; size: number }>; providerId?: string; model?: string; effort?: string; contextWindow?: number; maxOutput?: number; mode?: string; sessionId?: string; projectId?: string }) => {
    // Trust boundary: the renderer is untrusted — reject malformed/oversized
    // payloads before any store or service sees them (validate-and-throw; the
    // original payload is still what gets forwarded on success).
    assertPayload(AgentRunSchema, payload, "agent:run");
    const root = ctx.requireRoot();
    const sessionId = payload.sessionId || ctx.active().sessionId;
    const projectId = payload.projectId || ctx.active().projectId;
    if (!projectId || !sessionId) throw new Error("Create a session first.");
    ctx.setActive({ sessionId, projectId });
    await acquireRunSlot(ctx.activeRunSessions, sessionId);
    beginCommandRun(sessionId);
    const transcript: RunTranscript = { items: [] };
    // Prelude heartbeat: if the run ever wedges before the agent emits,
    // the UI shows the last reached stage instead of a mystery spinner.
    ctx.emitFor(sessionId, { type: "status", text: "Opening session…" });
    try {
      const project = await getProject(projectId);
      const session = await getSession(projectId, sessionId);
      if (!project || !session) throw new Error("Active project/session not found.");

      const mode: AgentMode = payload.mode === "plan" || payload.mode === "auto" || payload.mode === "full" ? payload.mode : "ask";
      const configured = payload.providerId ? (await listProviders()).find((provider) => provider.id === payload.providerId) : undefined;
      const provider = configured || (await listProviders())[0];
      const modelName = payload.model || session.model?.model;
      const effort = payload.effort !== undefined ? payload.effort : session.model?.effort;
      // Manual context-window overrides ride the payload; without one the
      // provider's stored/resolved per-model values are used inside the run.
      const runSettings: AgentSettings = provider
        ? { provider, model: modelName, effort, contextWindow: payload.contextWindow, maxOutput: payload.maxOutput }
        : { ...ctx.settings.get(), effort, contextWindow: payload.contextWindow, maxOutput: payload.maxOutput };

      if (provider && modelName) {
        await updateSession(projectId, sessionId, { model: { providerId: provider.id, model: modelName, effort: effort || undefined } });
      }

      if (session.title === "New coding task" && payload.request) {
        await updateSession(projectId, sessionId, { title: payload.request.slice(0, 60) });
      }

      // Persist the user request FIRST — before any fallible setup (backend
      // construction, workspace checkpoint, model resolution). If the run dies
      // early (bad model, auth error, context window too small), the request
      // still reaches the transcript, so switching models and continuing picks
      // up exactly what was asked instead of the message vanishing.
      // Content snapshot (not the array reference): appendSessionMessages
      // mutates the store's array in place, and history below must exclude
      // this run's own request.
      const priorMessages = [...session.messages];
      await appendSessionMessages(projectId, sessionId, [{ role: "user", text: payload.request, images: payload.images, attachments: payload.attachments, createdAt: new Date().toISOString() }]);

      // Check if session has an explicit active worktree
      let executionRoot = root;
      if (await isGitRepo(root)) {
        try {
          const wt = await getSessionWorktree(root, sessionId);
          if (wt) executionRoot = wt.worktreePath;
        } catch {
          executionRoot = root;
        }
      }

      const history: HistoryInput[] = (() => {
        // Same-session memory: last user/assistant turns plus recent tool
        // activity (with truncated results) so the run reuses prior reads
        // instead of re-reading the project from scratch every request.
        // Built from the PRE-APPEND snapshot so this run's own request
        // (already persisted above) is not duplicated into history.
        const recent = priorMessages;
        return recent.map((message) =>
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
      })();

      // Continue-resume: a bare "continue" after an interrupt/stop must pick
      // up the prior run's tool checkpoint, plan and diff — otherwise the
      // model restarts from scratch. The checkpoint cache covers same-process
      // resume; the transcript-derived note covers app restarts.
      const wantResume = isContinueRequest(payload.request || "");
      // Memory first, disk second: checkpoints are mirrored to
      // .nexus/run-checkpoints/ so "continue" survives an app restart.
      const stored = wantResume ? getLastRunCheckpoint(sessionId) ?? await loadLastRunCheckpoint(root, sessionId) : null;
      let resumeNote: string | null = null;
      let lastPlan: PlanItem[] | null = null;
      if (wantResume) {
        const context = await collectResumeContext(session.messages, executionRoot);
        lastPlan = context.lastPlan;
        resumeNote = buildResumeNote(session.messages, context, stored, "IMPORTANT INSTRUCTIONS FOR RESUME:\n1. Do NOT restart from the beginning or re-create todos from scratch.\n2. Do NOT re-read or inspect files already in history.\n3. If code changes and build/tests were already completed, do NOT run more checks or tools. Update your todo list to completed using write_todos immediately and provide your final response to the user.\n4. If unfinished work remains, proceed directly with that next step.");
      }

      const backendRecord = { ...project, root: executionRoot };
      if (mode === "full") {
        ctx.emitFor(sessionId, { type: "status", text: "FULL ACCESS mode: commands run without approval prompts — only the destructive guardrails stay enforced." });
      }
      ctx.emitFor(sessionId, { type: "status", text: "Preparing workspace…" });
      const editPolicy = mode !== "full" && (await getAppSettings().catch(() => ({}) as AppSettings)).editPolicy === "ask" ? "ask" : "auto";
      const shouldAutoOpenPreview = mode !== "plan" && isProjectRunRequest(payload.request);
      let previewOpeningStarted = false;
      let recentCommandOutput = "";
      const onCommandOutput = shouldAutoOpenPreview
        ? (_command: string, chunk: string) => {
            if (previewOpeningStarted || !isLikelyDevServerCommand(_command)) return;
            recentCommandOutput = `${recentCommandOutput}${chunk}`.slice(-6000);
            const url = extractLocalDevServerUrl(recentCommandOutput);
            if (!url) return;
            previewOpeningStarted = true;
            void (async () => {
              ctx.emitFor(sessionId, { type: "status", text: `Local app detected at ${url}; waiting for it to respond before opening the built-in Browser…` });
              const ready = await waitForLocalServer(url);
              if (!ready) {
                ctx.emitFor(sessionId, { type: "status", text: `The local app at ${url} did not respond, so it could not be opened in the built-in Browser.` });
                return;
              }
              if (isCommandRunCancelled(sessionId)) return;
              await agentBrowserService.act(
                { action: "navigate", url, openInBrowser: true },
                executionRoot,
                { sessionId, scope: "code", openInBrowser: true },
              );
              ctx.emitFor(sessionId, { type: "status", text: `Opened the running project in the built-in Browser at ${url}.` });
            })().catch((error) => {
              ctx.emitFor(sessionId, { type: "status", text: `Could not open the local app in the built-in Browser: ${error instanceof Error ? error.message : String(error)}` });
            });
          }
        : undefined;
      const { backend } = await getAgentBackend(backendRecord, { readOnly: mode === "plan", runId: sessionId, editPolicy, fullAccess: mode === "full", onCommandOutput });
      // Undo-ready baseline: HEAD before the run + file snapshot. Best-effort
      // so non-git projects still run (their Undo simply no-ops) — and so a
      // checkpoint failure never kills the run after the request is persisted.
      let preRunHead: string | null = null;
      try { preRunHead = await getHeadCommit(executionRoot); } catch { preRunHead = null; }
      const checkpointId = `cp_${Date.now().toString(36)}`;
      try {
        await createWorkspaceCheckpoint(executionRoot, checkpointId, { headCommit: preRunHead });
      } catch (error) {
        ctx.emitFor(sessionId, { type: "status", text: `Undo checkpoint unavailable: ${error instanceof Error ? error.message : String(error)}` });
      }

      // Renderer-only attachment URLs become inline data URLs for the model.
      const modelImages = payload.images?.length
        ? await Promise.all(payload.images.map((img) => resolveImageForModel(img).catch(() => img)))
        : undefined;

      // Document attachments (pdf/docx/xlsx/pptx/tex/…) are extracted to text
      // here so the model actually sees them. Images stay vision-only; text
      // files are decoded inline; Office/PDF go through the notebook parsers.
      // Each file is capped so one giant spreadsheet can't eat the context.
      const ATTACH_DOC_CHAR_CAP = 20_000;
      const attachmentDocs: Array<{ name: string; mimeType: string; text: string; truncated: boolean }> = [];
      if (payload.attachments?.length) {
        const { parseToMarkdown } = await import("../notebook-parse.js");
        for (const attachment of payload.attachments) {
          try {
            const isImage = (attachment.mimeType || "").toLowerCase().startsWith("image/");
            if (isImage) continue;
            const { buffer, fileName, mimeType } = await resolveAttachmentBytes(attachment.url);
            const name = attachment.name || fileName;
            const mime = attachment.mimeType || mimeType;
            // Small text-ish files: decode directly, no parser overhead.
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
      // Import tool needs the raw bytes for every attachment (images + docs)
      // so the agent can materialize them in the project on request.
      const importableAttachments: string[] = [];
      if (payload.attachments?.length) {
        for (const attachment of payload.attachments) {
          try {
            const { buffer, mimeType } = await resolveAttachmentBytes(attachment.url);
            const mime = attachment.mimeType || mimeType;
            importableAttachments.push(`data:${mime};base64,${buffer.toString("base64")}#${encodeURIComponent(attachment.name || "attachment")}`);
          } catch { /* skip unreadable */ }
        }
      } else if (modelImages?.length) {
        importableAttachments.push(...modelImages);
      }

      const runStartMs = Date.now();
      // Seed the meter with the session's last reported context so a new
      // request doesn't drop the bar back to the text-only estimate.
      const previousContextTokens = [...(session.messages || [])]
        .reverse()
        .find((m) => m.context?.usedTokens && m.context.usedTokens > 0)
        ?.context?.usedTokens ?? null;
      let accumulatedThinking = "";
      let thinkingStartTimestamp = "";
      const flushThinking = () => {
        if (accumulatedThinking.trim()) {
          transcript.items.push({
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
      let result: Awaited<ReturnType<typeof runProjectAgent>>;
      try {
        result = await runProjectAgent({
          projectRoot: executionRoot,
          telemetryRoot: root,
          taskKind: "code",
          skillsMode: "code",
          sessionId,
          request: payload.request,
          images: modelImages,
          attachments: modelImages,
          attachmentDocs,
          importableAttachments: importableAttachments.length ? importableAttachments : undefined,
          settings: runSettings,
          memory: { projectMemory: project.memory, sessionMemory: session.memory, facts: project.facts ?? "" },
          history,
          mode,
          agentBackend: backend,
          editPolicy,
          resumeMessages: stored?.messages ?? null,
          resumePlanItems: stored?.planItems ?? lastPlan ?? null,
          resumeNote,
          previousContextTokens,
          onProjectMemoryUpdate: (mutate) => updateProjectFacts(projectId, mutate),
          onUserQuestion: (questions) => ctx.askUserBlocking(sessionId, questions),
          onEvent: (event) => {
            if (event.type === "thinking") {
              if (!thinkingStartTimestamp) thinkingStartTimestamp = event.timestamp || new Date().toISOString();
              accumulatedThinking += event.text || "";
            } else if (event.type === "tool" || event.type === "plan" || event.type === "status") {
              flushThinking();
            }
            // Token chunks and thinking deltas stay ephemeral (streaming
            // display only); assistant message is appended explicitly at the end.
            if (event.type !== "token" && event.type !== "thinking" && event.type !== "assistant") {
              transcript.items.push({
                role: "event",
                text: event.text,
                kind: event.type,
                createdAt: event.timestamp,
                plan: event.items,
                subagent: event.subagent,
                artifact: event.artifact,
                usage: event.type === "usage" ? undefined : event.usage,
                context: event.context,
                detail: event.detail,
              });
            }
            // Tag with the session id: the renderer buckets live events by
            // event.sessionId — bare events all landed in an "unknown" bucket
            // and Code mode never showed the agent's steps while running.
            ctx.emitFor(sessionId, event);
          },
          isCancelled: () => isCommandRunCancelled(sessionId),
        });
      } catch (error) {
        flushThinking();
        const isCancel = error instanceof RunCancelledError || isCommandRunCancelled(sessionId) || (error as any)?.name === "AbortError";
        // Tokens burned before a cancel/failure still count: the run helper
        // stashes finalized usage on the thrown error (see agent-service).
        const failedUsage = (error as { usage?: AgentUsage })?.usage;
        const usageText = failedUsage
          ? `Token usage · ${failedUsage.totalTokens} tokens${failedUsage.estimatedCost == null ? "" : ` (~$${failedUsage.estimatedCost})`}`
          : null;
        if (isCancel) {
          const stopText = "⏹️ Run stopped by user. Progress has been saved.\n\nSay **continue** to pick up from where I stopped.";
          await appendSessionMessages(projectId, sessionId, [
            ...transcript.items,
            { role: "assistant", text: stopText, createdAt: new Date().toISOString(), ...(failedUsage ? { usage: failedUsage } : {}) },
          ]);
          ctx.emitFor(sessionId, { type: "assistant", text: stopText, ...(failedUsage ? { usage: failedUsage } : {}) });
          if (failedUsage && usageText) ctx.emitFor(sessionId, { type: "usage", text: usageText, usage: failedUsage });
          ctx.emitFor(sessionId, { type: "status", text: "Stopped by user. Ready to continue." });
          return stopText;
        }
        const errorText = error instanceof Error ? error.message : String(error);
        // Failed runs leave a persistent error entry so the transcript tells
        // the truth after a reload, not just in the live view.
        await appendSessionMessages(projectId, sessionId, [
          ...transcript.items,
          { role: "event", kind: "error", text: `Agent run failed: ${errorText}`, createdAt: new Date().toISOString(), ...(failedUsage ? { usage: failedUsage } : {}) },
        ]);
        ctx.emitFor(sessionId, { type: "error", text: `Agent run failed: ${errorText}` });
        if (failedUsage && usageText) ctx.emitFor(sessionId, { type: "usage", text: usageText, usage: failedUsage });
        throw error;
      }

      flushThinking();
      await appendSessionMessages(projectId, sessionId, [
        ...transcript.items,
        { role: "assistant", text: result.response, createdAt: new Date().toISOString(), usage: result.usage, context: result.context },
      ]);
      // Worktree-scoped auto-commit: isolated session branches get a durable
      // per-task commit (undo resets it); the user's main branch is never
      // auto-committed. Best-effort — a commit failure never fails the run.
      if (mode !== "plan") {
        try {
          const wt = await getSessionWorktree(root, sessionId).catch(() => null);
          if (wt && path.resolve(executionRoot) === path.resolve(wt.worktreePath)) {
            const shortRequest = (payload.request || "agent task").replace(/\s+/g, " ").slice(0, 80);
            const newHead = await commitSessionWork(executionRoot, `nexus(session-${sessionId}): ${shortRequest}`);
            if (newHead && newHead !== preRunHead) {
              transcript.items.push({
                role: "event",
                text: `Auto-committed session work (${newHead.slice(0, 7)}) — Undo restores files and rolls back Nexus-only commits.`,
                kind: "tool",
                createdAt: new Date().toISOString(),
              });
            }
          }
        } catch { /* best effort */ }
      }
      // Multi-level Undo: push (never clear) so each click steps one run back.
      await pushCheckpoint(projectId, sessionId, executionRoot, checkpointId);
      // Memories are rolling windows of WHOLE entries, not append-only logs:
      // the newest entries that fit the caps survive, and a cap never cuts an
      // entry mid-sentence (appendEntryLog drops the oldest whole entries).
      const nextSessionMemory = appendEntryLog(session.memory, result.memoryEntry, {
        maxEntries: SESSION_MEMORY_ENTRY_CAP,
        maxChars: SESSION_MEMORY_CHAR_CAP,
        separator: "\n\n",
      });
      const nextProjectMemory = appendEntryLog(project.memory, result.projectMemoryLogEntry, {
        maxEntries: PROJECT_MEMORY_RUN_LOG_CAP,
        maxChars: 2000,
        separator: "\n",
      });
      // pushCheckpoint already updated the stack; only memory remains here.
      await updateSession(projectId, sessionId, {
        memory: nextSessionMemory,
      });
      await updateProjectMemory(projectId, nextProjectMemory);
      return result.response;
    } finally {
      releaseRunSlot(ctx.activeRunSessions, sessionId);
      endCommandRun(sessionId);
    }
  });

  ipcMain.handle("agent:cancel", (_event, sessionId?: string) => {
    assertPayload(AgentCancelSchema, [sessionId], "agent:cancel");
    cancelCommandRun(sessionId);
    cancelCommandApprovals(sessionId);
    return true;
  });

  // ── Conversation Branching & Truncation IPC (ChatGPT / Claude Parity) ──
  ipcMain.handle("agent:session:truncate", async (_event, projectId: string, sessionId: string, fromIndex: number) => {
    return truncateSessionFromMessage(projectId, sessionId, fromIndex);
  });
  ipcMain.handle("agent:session:fork", async (_event, projectId: string, sessionId: string, messageIndex: number, newTitle?: string) => {
    return forkSessionAtMessage(projectId, sessionId, messageIndex, newTitle);
  });
}
