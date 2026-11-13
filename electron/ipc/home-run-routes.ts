// Home-mode agent run IPC routes. Isolated from Code mode: runProjectAgent
// executes with taskKind "general" against the dedicated Home workspace.

import { ipcMain } from "electron";
import {
  appendHomeSessionMessages, getAppSettings, getHomeMemory, getHomeSession, listProviders, mutateHomeMemory, updateHomeSession,
  type AppSettings, type ChatAttachment,
} from "../store.js";
import { cleanupHomeGeneratorScripts, ensureHomeDir, recordHomeRunFiles } from "../home-service.js";
import {
  runProjectAgent, RunCancelledError, isContinueRequest, getLastRunCheckpoint, loadLastRunCheckpoint,
  appendEntryLog, SESSION_MEMORY_ENTRY_CAP, SESSION_MEMORY_CHAR_CAP,
  type AgentEvent, type AgentUsage, type HistoryInput, type PlanItem,
} from "../agent-service.js";
import { getAgentBackend, beginCommandRun, cancelCommandRun, endCommandRun, isCommandRunCancelled } from "../command-service.js";
import { buildResumeNote, collectResumeContext } from "../resume-note.js";
import { cancelCommandApprovals } from "../approval-service.js";
import { recordDeliverable, isSubstantiveHomeTask, parseHomeMemory, addMemoryFact } from "../home-memory-service.js";
import { assertPayload, HomeRunSchema, AgentCancelSchema } from "./schemas.js";
import { acquireRunSlot, releaseRunSlot } from "./run-guard.js";
import { messagesToHistory, resolveModelImages, processRunAttachments, seedPreviousContextTokens, createRunTranscript, withRunSlot, collectRunResume, handleRunInterruption, persistRunSuccess, type RunLaneIo } from "./run-lane.js";
import type { MainIpcContext } from "./context.js";

export function registerHomeRunRoutes(ctx: MainIpcContext): void {
  // Dedicated Home Agent Runner (Isolated from Code Mode)
  ipcMain.handle("home:run", async (_event, payload: {
    sessionId: string;
    request: string;
    images?: string[];
    attachments?: ChatAttachment[];
    providerId?: string;
    model?: string;
    effort?: string;
    contextWindow?: number;
    maxOutput?: number;
  }) => {
    // Trust boundary: the renderer is untrusted — reject malformed/oversized
    // payloads before any store or service sees them (validate-and-throw).
    assertPayload(HomeRunSchema, payload, "home:run");
    const { sessionId } = payload;    const session = await getHomeSession(sessionId);
    if (!session) throw new Error("Home session not found.");
    const homeRoot = await ensureHomeDir();
    // Snapshot before the run closure (the closure can't see the null-narrowing).
    const sessionMemoryAtStart = session.memory;

    // Run-slot guard FIRST (same guard as agent:run, shared acquireRunSlot) —
    // a second submit (e.g. Enter pressed while the first run is still in
    // silent setup) must not start a twin agent that interleaves transcripts
    // and clobbers checkpoints/memory. Acquiring before the persist below
    // matters: a rejected duplicate submit must not leave an orphaned user
    // message in the transcript for the next run to re-ingest as history.
    // (Slot lifecycle handled by withRunSlot below — shared by both lanes.)

    // Persist the user request next — before provider/model resolution,
    // backend construction or anything else fallible. If the chosen model
    // fails (auth error, rate limit, "No provider/model selected"), the
    // request still reaches the transcript, so switching models and
    // continuing picks up exactly what was asked instead of the message
    // vanishing. Content snapshot (not the array reference): the store's
    // session object is mutated in place by the append, and history below
    // must exclude this run's own request.
    const priorMessages = [...(session.messages || [])];
    await appendHomeSessionMessages(sessionId, [
      { role: "user", text: payload.request, images: payload.images, attachments: payload.attachments, createdAt: new Date().toISOString() }
    ]);

    const emit = (event: AgentEvent) => {
      ctx.emitFor(sessionId, event);
    };

    return await withRunSlot({ ctx, sessionId }, async () => {
      const providers = await listProviders();
      const providerId = payload.providerId || session.model?.providerId;
      const provider = providers.find((p) => p.id === providerId) || providers[0];
      const modelName = payload.model || session.model?.model || provider?.models[0] || "";
      const effort = payload.effort !== undefined ? payload.effort : session.model?.effort;

      if (!provider || !modelName) {
        throw new Error("No provider/model selected for Home Assistant. Configure Providers first.");
      }

      await updateHomeSession(sessionId, { model: { providerId: provider.id, model: modelName, effort: effort || undefined } });

      // Code parity (agent:run): name the chat after the first sent message
      // while it still has the default title — later user renames stick.
      if (session.title === "New chat" && payload.request?.trim()) {
        await updateHomeSession(sessionId, { title: payload.request.trim().slice(0, 60) });
      }

      // Shared lane helpers (run-lane.ts) — the history mapping and
      // attachment processing are owned by BOTH lanes now; the private
      // copies here drifted before (missing image skip, inverted persist
      // order) and are gone.
      const history: HistoryInput[] = messagesToHistory(priorMessages);

      const modelImages = await resolveModelImages(payload.images);
      const { attachmentDocs, importableAttachments } = await processRunAttachments(
        payload.attachments,
        modelImages
      );

      // Continue-resume: a bare "continue" / affirmation after an interrupt/stop must pick
      // up the prior run's tool checkpoint, plan and diff — otherwise the
      // model restarts from scratch.
      const { stored, resumeNote, lastPlan } = await collectRunResume({
        sessionId,
        root: homeRoot,
        request: payload.request || "",
        sessionMessages: session.messages,
        resumeNoteSuffix: "IMPORTANT: Do NOT restart from the beginning, do NOT re-create the todo list from scratch, and do NOT repeat completed tool actions or file reads. Proceed directly with the next unfinished step.",
      });

      const backendRecord = { id: "home", name: "Home", root: homeRoot, createdAt: "", updatedAt: "", memory: "", sessions: [] };
      ctx.emitFor(sessionId, { type: "status", text: "Starting Home Assistant…" });
      // Code parity (agent-routes): honor Settings → edit policy "ask" so Home
      // file mutations wait for approval too. Previously the Home lane never
      // passed editPolicy, so the setting was silently ignored for Home runs.
      const editPolicy = (await getAppSettings().catch(() => ({}) as AppSettings)).editPolicy === "ask" ? "ask" : "auto";
      const { backend } = await getAgentBackend(backendRecord, { readOnly: false, runId: sessionId, editPolicy });
      // Shared cross-chat memory (ChatGPT-style). Loaded fresh per run so
      // concurrent chats never clobber each other on save (re-read below).
      const homeMemoryAtStart = await getHomeMemory().catch(() => "");

      const runStartMs = Date.now();
      const previousContextTokens = seedPreviousContextTokens(session.messages);
      // Shared lane transcript + thinking buffer (run-lane.ts): owned by both
      // lanes; the private copy here drifted before.
      const lane = createRunTranscript();
      const transcript = { items: lane.items };
      const laneIo: RunLaneIo = {
        ctx,
        sessionId,
        lane,
        appendMessages: (items) => appendHomeSessionMessages(sessionId, items as never),
        laneLabel: "Home run",
        buildErrorText: async (errorText) => {
          const checkpoint = getLastRunCheckpoint(sessionId) ?? await loadLastRunCheckpoint(homeRoot, sessionId);
          return checkpoint?.messages?.length
            ? `Home run paused after an error (${errorText}). Progress was checkpointed; say "continue" to resume without restarting completed work.`
            : errorText;
        },
      };
      let result: Awaited<ReturnType<typeof runProjectAgent>>;

      try {
        result = await runProjectAgent({
          projectRoot: homeRoot,
          telemetryRoot: homeRoot,
          taskKind: "general",
          skillsMode: "home",
          sessionId,
          request: payload.request,
          images: modelImages,
          attachments: modelImages,
          attachmentDocs,
          importableAttachments: importableAttachments.length ? importableAttachments : undefined,
          settings: {
            provider,
            model: modelName,
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            effort,
            contextWindow: payload.contextWindow,
            maxOutput: payload.maxOutput,
          },
          memory: { projectMemory: homeMemoryAtStart, sessionMemory: session.memory },
          history,
          mode: "auto",
          editPolicy,
          agentBackend: backend,
          resumeMessages: stored?.messages ?? null,
          resumePlanItems: stored?.planItems ?? lastPlan ?? null,
          resumeNote,
          previousContextTokens,
          onEvent: (event) => {
            lane.handleEvent(event);
            emit(event);
          },
          onHomeMemoryUpdate: (mutate) => mutateHomeMemory((current) => mutate(current)),
          onUserQuestion: (questions) => ctx.askUserBlocking(sessionId, questions),
          // Semantic memory extraction runs detached inside the agent (up to
          // ~20s on slow providers); applying the candidates happens here,
          // in the background, with the same "Memory updated" notice.
          onMemoryCandidates: async (candidates) => {
            // Semantic memory auto-applies (ChatGPT-style "Memory updated"): the
            // extraction filter already drops transient data, candidates dedupe
            // against existing facts, and anything wrong can be forgotten in the
            // Memory tab. A review queue would silently strand identity facts.
            if (!candidates.length) return;
            let applied: string[] = [];
            await mutateHomeMemory((latest) => {
              const current = parseHomeMemory(latest);
              const known = new Set(
                [...current.profile, ...current.preferences, ...current.facts, ...current.context].map((f) => f.toLowerCase())
              );
              const validCats = ["profile", "preference", "fact", "context"];
              let merged = latest;
              applied = [];
              for (const cand of candidates.slice(0, 3)) {
                const fact = String(cand.fact || "").trim().slice(0, 200);
                if (!fact || known.has(fact.toLowerCase())) continue;
                const cat = validCats.includes(cand.category) ? cand.category : "fact";
                merged = addMemoryFact(merged, cat as "profile" | "preference" | "fact" | "context", fact);
                known.add(fact.toLowerCase());
                applied.push(fact);
              }
              return merged;
            });
            if (applied.length) {
              const shown = applied.join("; ").slice(0, 220);
              ctx.emitFor(sessionId, { type: "status", text: `Saved to memory: ${shown} — manage it in the Memory tab.` });
            }
          },
          isCancelled: () => isCommandRunCancelled(sessionId),
        });
      } catch (error) {
        // Shared interruption tail (run-lane.ts): one implementation for both
        // lanes — the private copies had already drifted once.
        return await handleRunInterruption(laneIo, error);
      }

      // Shared success tail: flush thinking + persist transcript + final row.
      return await persistRunSuccess(laneIo, result);

      let deletedScripts: string[] = [];
      try {
        deletedScripts = await cleanupHomeGeneratorScripts(runStartMs, payload.request || "");
        if (deletedScripts.length) {
          await appendHomeSessionMessages(sessionId, [
            { role: "event", kind: "tool", text: `Cleaned up generator script${deletedScripts.length === 1 ? "" : "s"}: ${deletedScripts.join(", ")}`, createdAt: new Date().toISOString() },
          ]);
        }
        await recordHomeRunFiles(sessionId, runStartMs, result.response);
      } catch { /* best effort */ }

      const nextSessionMemory = appendEntryLog(sessionMemoryAtStart, result.memoryEntry, {
        maxEntries: SESSION_MEMORY_ENTRY_CAP,
        maxChars: SESSION_MEMORY_CHAR_CAP,
        separator: "\n\n",
      });
      await updateHomeSession(sessionId, {
        memory: nextSessionMemory,
      });
      // Roll the shared Home memory forward only for substantive deliverables (capped at 5).
      // Session memory stays a compact pointer — the transcript is the source of truth.
      // All writes go through the serialized mutate queue so a parallel chat's
      // facts are merged, not overwritten.
      try {
        const hasFiles = deletedScripts.length > 0 || (result.artifact != null);
        if (isSubstantiveHomeTask(payload.request || "", result.response || "", hasFiles)) {
          await mutateHomeMemory((current) => recordDeliverable(current, payload.request || "", result.response || "", sessionId));
        }
      } catch { /* memory is best-effort */ }

      return result.response;
    });
  });

  ipcMain.handle("home:cancel", (_event, sessionId?: string) => {
    assertPayload(AgentCancelSchema, [sessionId], "home:cancel");
    cancelCommandRun(sessionId);
    cancelCommandApprovals(sessionId);
    return true;
  });
}
