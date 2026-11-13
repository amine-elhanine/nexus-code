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
import { pushCheckpoint } from "../checkpoint-stack.js";
import { isLikelyDevServerCommand, extractLocalDevServerUrl, waitForLocalServer } from "../project-preview.js";
import { assertPayload, AgentRunSchema, AgentCancelSchema } from "./schemas.js";
import { buildResumeNote, collectResumeContext } from "../resume-note.js";
import { acquireRunSlot, releaseRunSlot } from "./run-guard.js";
import { messagesToHistory, resolveModelImages, processRunAttachments, seedPreviousContextTokens, createRunTranscript, withRunSlot, collectRunResume, handleRunInterruption, persistRunSuccess, type RunLaneIo } from "./run-lane.js";
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
    // Slot lifecycle handled by withRunSlot (shared with home:run).
    return await withRunSlot({ ctx, sessionId }, async () => {
    const transcript: RunTranscript = { items: [] };
    // Prelude heartbeat: if the run ever wedges before the agent emits,
    // the UI shows the last reached stage instead of a mystery spinner.
    ctx.emitFor(sessionId, { type: "status", text: "Opening session…" });
    {
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

      // Same-session memory: last user/assistant turns plus recent tool
      // activity (with truncated results) so the run reuses prior reads
      // instead of re-reading the project from scratch every request.
      // Built from the PRE-APPEND snapshot so this run's own request
      // (already persisted above) is not duplicated into history.
      // Shared mapping (run-lane.ts) — identical in both lanes by contract.
      const history: HistoryInput[] = messagesToHistory(priorMessages);

      // Continue-resume: a bare "continue" after an interrupt/stop must pick
      // up the prior run's tool checkpoint, plan and diff — otherwise the
      // model restarts from scratch. The checkpoint cache covers same-process
      // resume; the transcript-derived note covers app restarts.
      const { stored, resumeNote, lastPlan } = await collectRunResume({
        sessionId,
        root,
        request: payload.request || "",
        sessionMessages: session.messages,
        resumeNoteSuffix: "IMPORTANT INSTRUCTIONS FOR RESUME:\n1. Do NOT restart from the beginning or re-create todos from scratch.\n2. Do NOT re-read or inspect files already in history.\n3. If code changes and build/tests were already completed, do NOT run more checks or tools. Update your todo list to completed using write_todos immediately and provide your final response to the user.\n4. If unfinished work remains, proceed directly with that next step.",
      });

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

      // Shared lane helpers (run-lane.ts): attachment/image processing is
      // owned by BOTH lanes — the private copies here and in home:run drifted
      // (Home lost the image skip entirely) and are gone.
      const modelImages = await resolveModelImages(payload.images);
      const { attachmentDocs, importableAttachments } = await processRunAttachments(
        payload.attachments,
        modelImages
      );

      const runStartMs = Date.now();
      const previousContextTokens = seedPreviousContextTokens(session.messages);
      // Shared lane transcript + thinking buffer (run-lane.ts) — owned by
      // both lanes so they can never drift again.
      const lane = createRunTranscript();
      const transcript = { items: lane.items };
      const laneIo: RunLaneIo = {
        ctx,
        sessionId,
        lane,
        appendMessages: (items) => appendSessionMessages(projectId, sessionId, items as never),
        laneLabel: "Agent run",
        // Code reports the raw error (no checkpoint hint — the workspace
        // checkpoint card already surfaces recoverable state in the UI).
        buildErrorText: undefined,
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
            lane.handleEvent(event);
            // Tag with the session id: the renderer buckets live events by
            // event.sessionId — bare events all landed in an "unknown" bucket
            // and Code mode never showed the agent's steps while running.
            ctx.emitFor(sessionId, event);
          },
          isCancelled: () => isCommandRunCancelled(sessionId),
        });
      } catch (error) {
        // Shared interruption tail (run-lane.ts) — one implementation for both
        // lanes. Tokens burned before the interruption still count (usage rides
        // on the thrown error — see agent-service).
        return await handleRunInterruption(laneIo, error);
      }

      // Shared success tail: flush thinking + persist transcript + final row.
      const responseText = await persistRunSuccess(laneIo, result);
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
      return responseText;
    }
    });
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
