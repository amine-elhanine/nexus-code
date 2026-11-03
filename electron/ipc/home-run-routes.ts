// Home-mode agent run IPC routes. Isolated from Code mode: runProjectAgent
// executes with taskKind "general" against the dedicated Home workspace.

import { ipcMain } from "electron";
import {
  appendHomeSessionMessages, getHomeMemory, getHomeSession, listProviders, mutateHomeMemory, updateHomeSession,
  type ChatAttachment,
} from "../store.js";
import { cleanupHomeGeneratorScripts, ensureHomeDir, recordHomeRunFiles } from "../home-service.js";
import {
  runProjectAgent, RunCancelledError, isContinueRequest, getLastRunCheckpoint, loadLastRunCheckpoint,
  summarizeCompletedSteps, appendEntryLog, SESSION_MEMORY_ENTRY_CAP, SESSION_MEMORY_CHAR_CAP,
  type AgentEvent, type AgentUsage, type HistoryInput, type PlanItem,
} from "../agent-service.js";
import { getAgentBackend, beginCommandRun, cancelCommandRun, endCommandRun, isCommandRunCancelled } from "../command-service.js";
import { getWorkspaceDiffFiles } from "../diff-service.js";
import { cancelCommandApprovals } from "../approval-service.js";
import { recordDeliverable, isSubstantiveHomeTask, parseHomeMemory, addMemoryFact } from "../home-memory-service.js";
import { resolveImageForModel, resolveAttachmentBytes } from "../attachment-utils.js";
import { assertPayload, HomeRunSchema, AgentCancelSchema } from "./schemas.js";
import { acquireRunSlot } from "./run-guard.js";
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

    // Persist the user request FIRST — before provider/model resolution,
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

    // Same guard as agent:run (shared acquireRunSlot) — a second submit
    // (e.g. Enter pressed while the first run is still in silent setup) must
    // not start a twin agent that interleaves transcripts and clobbers
    // checkpoints/memory.
    await acquireRunSlot(ctx.activeRunSessions, sessionId);
    beginCommandRun(sessionId);
    const transcript: { items: any[] } = { items: [] };

    const emit = (event: AgentEvent) => {
      ctx.emitFor(sessionId, event);
    };

    try {
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

      const history: HistoryInput[] = priorMessages.map((message) => {
        if (message.role === "event") {
          return {
            role: "assistant",
            text: message.text,
            kind: message.kind,
            createdAt: message.createdAt,
            plan: message.plan,
            detail: message.detail,
          };
        }
        return { role: message.role as "user" | "assistant", text: message.text };
      });

      const modelImages = payload.images?.length
        ? await Promise.all(payload.images.map((img) => resolveImageForModel(img).catch(() => img)))
        : undefined;

      const ATTACH_DOC_CHAR_CAP = 20_000;
      const attachmentDocs: Array<{ name: string; mimeType: string; text: string; truncated: boolean }> = [];
      if (payload.attachments?.length) {
        const { parseToMarkdown } = await import("../notebook-parse.js");
        for (const attachment of payload.attachments) {
          try {
            const { buffer, mimeType } = await resolveAttachmentBytes(attachment.url);
            const mime = attachment.mimeType || mimeType;
            const name = attachment.name || "attachment";
            try {
              const parsed = await parseToMarkdown(buffer, name);
              if (!parsed.markdown.trim()) continue;
              const truncated = parsed.markdown.length > ATTACH_DOC_CHAR_CAP || parsed.truncated;
              attachmentDocs.push({ name, mimeType: mime, text: parsed.markdown.slice(0, ATTACH_DOC_CHAR_CAP), truncated });
            } catch {
              attachmentDocs.push({ name, mimeType: mime, text: `[Binary file ${name} could not be text-extracted.]`, truncated: false });
            }
          } catch { /* best effort */ }
        }
      }

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

      // Continue-resume: a bare "continue" / affirmation after an interrupt/stop must pick
      // up the prior run's tool checkpoint, plan and diff — otherwise the
      // model restarts from scratch.
      const wantResume = isContinueRequest(payload.request || "");
      const stored = wantResume ? getLastRunCheckpoint(sessionId) ?? await loadLastRunCheckpoint(homeRoot, sessionId) : null;
      let resumeNote: string | null = null;
      let lastPlan: PlanItem[] | null = null;
      if (wantResume) {
        const planEvents = session.messages.filter((m) => m.role === "event" && m.kind === "plan" && m.plan?.length);
        lastPlan = planEvents.length ? planEvents[planEvents.length - 1].plan! : null;
        const errorEvents = session.messages.filter((m) => m.role === "event" && m.kind === "error");
        const lastError = errorEvents.length ? errorEvents[errorEvents.length - 1].text : null;
        const assistants = session.messages.filter((m) => m.role === "assistant");
        const lastAssistant = assistants.length ? assistants[assistants.length - 1].text.slice(-1500) : null;
        let diffSummary = "";
        try {
          const diffs = await getWorkspaceDiffFiles(homeRoot);
          if (diffs.length) diffSummary = `\nFiles already changed:\n${diffs.slice(0, 20).map((d) => `- ${d.path} (+${d.additions}/-${d.deletions})`).join("\n")}`;
        } catch { /* diff is best-effort */ }
        const planSummary = (stored?.planItems ?? lastPlan)?.length
          ? `\nWorking plan status:\n${(stored?.planItems ?? lastPlan)!.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
          : "";
        const ledger = stored?.messages?.length ? summarizeCompletedSteps(stored.messages) : [];
        const ledgerSummary = ledger.length
          ? `\nSteps already DONE (never repeat — results are in history):\n${ledger.map((s) => `- ${s}`).join("\n")}`
          : "";
        resumeNote = `[System Note: The user asked to continue the previous interrupted run. All preceding tool executions and results ${stored ? `(${stored.messages.length} checkpointed messages) ` : ""}are already complete.${planSummary}${ledgerSummary}${lastError ? `\nLast stop reason: ${lastError.slice(0, 500)}` : ""}${lastAssistant ? `\nLast assistant summary: ${lastAssistant}` : ""}${diffSummary}\n\nIMPORTANT: Do NOT restart from the beginning, do NOT re-create the todo list from scratch, and do NOT repeat completed tool actions or file reads. Proceed directly with the next unfinished step.]`;
      }

      const backendRecord = { id: "home", name: "Home", root: homeRoot, createdAt: "", updatedAt: "", memory: "", sessions: [] };
      ctx.emitFor(sessionId, { type: "status", text: "Starting Home Assistant…" });
      const { backend } = await getAgentBackend(backendRecord, { readOnly: false, runId: sessionId });
      // Shared cross-chat memory (ChatGPT-style). Loaded fresh per run so
      // concurrent chats never clobber each other on save (re-read below).
      const homeMemoryAtStart = await getHomeMemory().catch(() => "");

      const runStartMs = Date.now();
      // Seed the meter with the session's last reported context so a new
      // request doesn't drop the bar back to the text-only estimate.
      const previousContextTokens = [...(session.messages || [])]
        .reverse()
        .find((m) => m.context?.usedTokens && m.context.usedTokens > 0)
        ?.context?.usedTokens ?? null;
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
          agentBackend: backend,
          resumeMessages: stored?.messages ?? null,
          resumePlanItems: stored?.planItems ?? lastPlan ?? null,
          resumeNote,
          previousContextTokens,
          onEvent: (event) => {
            // Token and thinking chunks stay ephemeral; assistant/usage are
            // persisted once as the final message below (with usage attached)
            // — pushing them here too would store every answer twice and
            // double history size.
            if (event.type !== "token" && event.type !== "thinking" && event.type !== "assistant" && event.type !== "usage") {
              transcript.items.push({
                role: "event",
                text: event.text,
                kind: event.type,
                createdAt: event.timestamp,
                plan: event.items,
                subagent: event.subagent,
                artifact: event.artifact,
                usage: event.usage,
                context: event.context,
                detail: event.detail,
              });
            }
            emit(event);
          },
          onHomeMemoryUpdate: (mutate) => mutateHomeMemory((current) => mutate(current)),
          onUserQuestion: (questions) => ctx.askUserBlocking(sessionId, questions),
          isCancelled: () => isCommandRunCancelled(sessionId),
        });
      } catch (error) {
        const isCancel = error instanceof RunCancelledError || isCommandRunCancelled(sessionId) || (error as any)?.name === "AbortError";
        const failedUsage = (error as { usage?: AgentUsage })?.usage;
        const usageText = failedUsage
          ? `Token usage · ${failedUsage.totalTokens} tokens${failedUsage.estimatedCost == null ? "" : ` (~$${failedUsage.estimatedCost})`}`
          : null;
        if (isCancel) {
          const stopText = "⏹️ Run stopped by user. Progress has been saved.\n\nSay **continue** to pick up from where I stopped.";
          await appendHomeSessionMessages(sessionId, [
            ...transcript.items,
            { role: "assistant", text: stopText, createdAt: new Date().toISOString(), ...(failedUsage ? { usage: failedUsage } : {}) },
          ]);
          ctx.emitFor(sessionId, { type: "assistant", text: stopText, ...(failedUsage ? { usage: failedUsage } : {}) });
          if (failedUsage && usageText) ctx.emitFor(sessionId, { type: "usage", text: usageText, usage: failedUsage });
          ctx.emitFor(sessionId, { type: "status", text: "Stopped by user. Ready to continue." });
          return stopText;
        }
        const errorText = error instanceof Error ? error.message : String(error);
        const checkpoint = getLastRunCheckpoint(sessionId) ?? await loadLastRunCheckpoint(homeRoot, sessionId);
        const userError = checkpoint?.messages?.length
          ? `Home run paused after an error (${errorText}). Progress was checkpointed; say "continue" to resume without restarting completed work.`
          : errorText;
        await appendHomeSessionMessages(sessionId, [
          ...transcript.items,
          { role: "event", kind: "error", text: `Home run failed: ${userError}`, createdAt: new Date().toISOString(), ...(failedUsage ? { usage: failedUsage } : {}) },
        ]);
        ctx.emitFor(sessionId, { type: "error", text: `Home run failed: ${userError}` });
        if (failedUsage && usageText) ctx.emitFor(sessionId, { type: "usage", text: usageText, usage: failedUsage });
        throw error;
      }

      await appendHomeSessionMessages(sessionId, [
        ...transcript.items,
        { role: "assistant", text: result.response, createdAt: new Date().toISOString(), usage: result.usage, context: result.context },
      ]);

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

      const nextSessionMemory = appendEntryLog(session.memory, result.memoryEntry, {
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
        // Semantic memory auto-applies (ChatGPT-style "Memory updated"): the
        // extraction filter already drops transient data, candidates dedupe
        // against existing facts, and anything wrong can be forgotten in the
        // Memory tab. A review queue would silently strand identity facts.
        const candidates = (result as unknown as { memoryCandidates?: Array<{ category: string; fact: string }> }).memoryCandidates || [];
        if (candidates.length) {
          // The mutate returns the merged memory (persisted by mutateHomeMemory);
          // applied facts are collected through the closure for the notice below.
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
        }
      } catch { /* memory is best-effort */ }

      return result.response;
    } finally {
      ctx.activeRunSessions.delete(sessionId);
      endCommandRun(sessionId);
    }
  });

  ipcMain.handle("home:cancel", (_event, sessionId?: string) => {
    assertPayload(AgentCancelSchema, [sessionId], "home:cancel");
    cancelCommandRun(sessionId);
    cancelCommandApprovals(sessionId);
    return true;
  });
}
