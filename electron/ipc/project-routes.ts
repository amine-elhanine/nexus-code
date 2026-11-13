// Project + session IPC routes — CRUD, activation state, memory, and manual
// context compaction. This module also owns mutations of the active
// project/session/root state (through the shared IPC context).

import { ipcMain, dialog, app, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession, deleteProject, deleteSession, getHomeSession, getProject, getSession,
  listProjects, listProviders, listSessions, updateHomeSession, updateProjectMemory, updateProjectFacts,
  updateSession, upsertProject,
} from "../store.js";
import { compactHistory, compactHistoryWithModel, estimateTokens } from "../context-service.js";
import { autoDiscoverModelContextWindow, autoDiscoverModelEfforts, computeCompactionThreshold, createChatModel, resolveModelContextWindow, resolveModelMaxOutput } from "../providers.js";
import { ensureGitRepo } from "../repo-service.js";
import { deleteSessionTelemetry } from "../artifacts-service.js";
import { discoverProjectRules } from "../rules-service.js";
import { discardSessionWorktree } from "../worktree-service.js";
import { removeMemoryFactWithCount } from "../home-memory-service.js";
import { clearLastRunCheckpoint } from "../agent-service.js";
import { assertPayload, SessionUpdateSchema } from "./schemas.js";
import type { MainIpcContext } from "./context.js";
import { invokeChatText } from "../agentcore/llm/invoke.js";

export function registerProjectRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("project:select", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    const project = await upsertProject({ name: path.basename(root), root });
    ctx.setActive({ projectId: project.id, projectRoot: project.root });
    // Every project must be undo-capable: init git when missing (best-effort).
    try { await ensureGitRepo(root); } catch { /* non-git projects simply lose Undo */ }
    const sessions = await listSessions(project.id);
    const session = sessions[0] || await createSession(project.id);
    ctx.setActive({ sessionId: session.id });
    return { project, session };
  });
  ipcMain.handle("project:create", async (_event, input: { name: string; root: string }) => {
    // The renderer supplies the root, so it must be validated like every
    // other renderer-controlled path: once registered, `activeProjectRoot`
    // scopes ALL workspace read/write containment. Refuse system-critical
    // roots (drive roots, Windows/Program Files, the user profile itself,
    // app data) and require an absolute path with an existing parent.
    const rootCandidate = path.resolve(String(input?.root || ""));
    const blockedRoots = [
      process.env.WINDIR && path.resolve(process.env.WINDIR),
      process.env.ProgramFiles && path.resolve(process.env.ProgramFiles),
      process.env["ProgramFiles(x86)"] && path.resolve(String(process.env["ProgramFiles(x86)"])),
      os.homedir(),
      app.getPath("userData"),
    ].filter(Boolean) as string[];
    const rootOk = path.isAbsolute(rootCandidate)
      && rootCandidate !== path.parse(rootCandidate).root
      && !blockedRoots.some((blocked) => rootCandidate === blocked)
      && (existsSync(rootCandidate) ? statSync(rootCandidate).isDirectory() : existsSync(path.dirname(rootCandidate)));
    if (!rootOk) {
      throw new Error(`Refusing to register "${input?.root}" as a project root. Pick a regular folder (an existing directory, or a new folder inside an existing one) via the Open Project dialog.`);
    }
    const project = await upsertProject({ name: input.name, root: rootCandidate });
    ctx.setActive({ projectId: project.id, projectRoot: project.root });
    try { await ensureGitRepo(rootCandidate); } catch { /* best effort */ }
    const session = (await listSessions(project.id))[0] || await createSession(project.id);
    ctx.setActive({ sessionId: session.id });
    return { project, session };
  });
  ipcMain.handle("project:activate", async (_event, projectId: string) => {
    const project = await getProject(projectId); if (!project) throw new Error("Project not found.");
    const session = project.sessions[0] || await createSession(project.id);
    ctx.setActive({ projectId: project.id, projectRoot: project.root, sessionId: session.id });
    try { await ensureGitRepo(project.root); } catch { /* best effort */ }
    return { project, session };
  });
  ipcMain.handle("project:get-active", async () => ctx.active().projectId
    ? { project: await getProject(ctx.active().projectId!), session: ctx.active().sessionId ? await getSession(ctx.active().projectId!, ctx.active().sessionId!) : null }
    : null);
  ipcMain.handle("project:delete", async (_event, projectId: string) => {
    const project = await getProject(projectId);
    const root = project?.root || (projectId === ctx.active().projectId ? ctx.active().projectRoot : null);
    if (project && root) {
      for (const session of project.sessions) {
        try {
          await discardSessionWorktree(root, session.id);
          await deleteSessionTelemetry(root, session.id);
          clearLastRunCheckpoint(session.id);
        } catch { /* best effort */ }
      }
    }
    await deleteProject(projectId);
    if (projectId === ctx.active().projectId) ctx.setActive({ projectId: null, sessionId: null, projectRoot: null });
    return listProjects();
  });

  ipcMain.handle("sessions:list", (_event, projectId: string) => listSessions(projectId));
  ipcMain.handle("sessions:export", async (_event, sessionId: string) => {
    if (!sessionId) throw new Error("No active session.");
    for (const project of await listProjects()) {
      const session = project.sessions.find((s) => s.id === sessionId);
      if (!session) continue;
      const { exportSessionHtml } = await import("../session-export.js");
      const file = await exportSessionHtml(session, project.name, path.join(app.getPath("userData"), "exports"));
      shell.showItemInFolder(file);
      return file;
    }
    throw new Error("Session not found.");
  });
  ipcMain.handle("session:create", async (_event, projectId: string, title?: string) => {
    const session = await createSession(projectId, title);
    const project = await getProject(projectId);
    ctx.setActive({ projectId, sessionId: session.id, projectRoot: project?.root || null });
    return session;
  });
  ipcMain.handle("session:activate", async (_event, projectId: string, sessionId: string) => {
    const session = await getSession(projectId, sessionId); if (!session) throw new Error("Session not found.");
    const project = await getProject(projectId);
    ctx.setActive({ projectId, sessionId, projectRoot: project?.root || null });
    return session;
  });
  ipcMain.handle("session:update", (_event, projectId: string, sessionId: string, patch: Parameters<typeof updateSession>[2]) => {
    // Renderer is untrusted: strict field allowlist so a compromised renderer
    // cannot overwrite main-owned state (messages/usage/checkpointIds) through
    // this channel. See SessionUpdateSchema in schemas.ts.
    assertPayload(SessionUpdateSchema, patch ?? {}, "session update");
    return updateSession(projectId, sessionId, patch);
  });
  ipcMain.handle("session:delete", async (_event, projectId: string, sessionId: string) => {
    const project = await getProject(projectId);
    const root = project?.root || ctx.active().projectRoot;
    const updated = await deleteSession(projectId, sessionId);
    if (root) {
      await discardSessionWorktree(root, sessionId);
      await deleteSessionTelemetry(root, sessionId);
    }
    clearLastRunCheckpoint(sessionId);
    if (sessionId === ctx.active().sessionId) {
      const next = updated.sessions[0] || await createSession(projectId);
      ctx.setActive({ sessionId: next.id });
    }
    return updated;
  });

  ipcMain.handle("memory:project:update", (_event, projectId: string, memory: string) => updateProjectMemory(projectId, memory));
  ipcMain.handle("memory:project:facts:update", (_event, projectId: string, facts: string) => updateProjectFacts(projectId, () => facts));
  ipcMain.handle("memory:project:fact:remove", (_event, projectId: string, fact: string) => updateProjectFacts(projectId, (current) => removeMemoryFactWithCount(current, fact || "").memory));
  ipcMain.handle("memory:session:update", (_event, projectId: string, sessionId: string, memory: string) => updateSession(projectId, sessionId, { memory }));

  ipcMain.handle("session:compact", async (_event, payload?: { sessionId?: string; projectId?: string }) => {
    const sessionId = payload?.sessionId || ctx.active().sessionId;
    const requestedProjectId = payload?.projectId || ctx.active().projectId;
    if (!sessionId) throw new Error("No active session.");
    if (ctx.activeRunSessions.has(sessionId)) {
      throw new Error("Wait for the active run to finish before compacting context.");
    }

    let isHomeSession = false;
    let resolvedProjectId = requestedProjectId;
    let session = resolvedProjectId
      ? (await getProject(resolvedProjectId))?.sessions.find((s) => s.id === sessionId)
      : undefined;

    if (!session) {
      const homeSession = await getHomeSession(sessionId);
      if (homeSession) {
        session = homeSession;
        isHomeSession = true;
      }
    }

    if (!session && payload?.sessionId) {
      const allProjects = await listProjects();
      for (const proj of allProjects) {
        const found = proj.sessions.find((s) => s.id === sessionId);
        if (found) {
          session = found;
          resolvedProjectId = proj.id;
          break;
        }
      }
    }

    if (!session) throw new Error("Session not found.");

    const rawProviders = await listProviders();
    const provider = rawProviders.find((p) => p.id === session.model?.providerId) || rawProviders[0];
    const modelName = session.model?.model || provider?.models[0] || "default";

    const modelBasename = modelName.includes("/") ? modelName.split("/").pop() || modelName : modelName;
    const contextWindow = provider?.modelContextWindows?.[modelName] || provider?.modelContextWindows?.[modelBasename] || resolveModelContextWindow(provider?.id || "", modelName, provider);
    const maxOutput = provider?.modelMaxOutputs?.[modelName] || provider?.modelMaxOutputs?.[modelBasename] || resolveModelMaxOutput(provider?.id || "", modelName, provider);
    const threshold = computeCompactionThreshold(contextWindow, maxOutput);
    const outputReserve = Math.min(Math.max(maxOutput || 8192, 2048), 32_000);
    const targetBudget = Math.max(1500, Math.floor(threshold * 0.55));

    const history = (session.messages || []).map((m) => ({
      role: m.role as "user" | "assistant" | "event",
      text: m.text,
      kind: m.kind,
    }));

    const latestContext = [...(session.messages || [])].reverse().find((message) => message.context)?.context;
    const originalTokens = latestContext?.usedTokens ?? (history.reduce((sum, t) => sum + estimateTokens(t.text), 0) + outputReserve);
    if (originalTokens < 1000) {
      return { originalTokens, compactedTokens: originalTokens, freedTokens: 0, notice: "Session context is already minimal." };
    }

    let compacted;
    try {
      const llm = await createChatModel(provider, modelName);
      compacted = await compactHistoryWithModel(
        history,
        async (prompt) => {
          return await invokeChatText(llm, prompt);
        },
        targetBudget
      );
    } catch {
      compacted = compactHistory(history, targetBudget);
    }

    const compactedTokens = compacted.reduce((sum, t) => sum + estimateTokens(t.text), 0);
    const freedTokens = Math.max(0, originalTokens - compactedTokens);

    const newMessages = compacted.map((turn) => ({
      role: turn.role,
      text: turn.text,
      createdAt: new Date().toISOString(),
    }));

    const compactedPatch = {
      messages: newMessages,
      usage: {
        inputTokens: compactedTokens,
        outputTokens: session.usage?.outputTokens || 0,
        totalTokens: compactedTokens + (session.usage?.outputTokens || 0),
        estimatedCost: session.usage?.estimatedCost ?? null,
      },
    };
    if (isHomeSession) {
      await updateHomeSession(sessionId, compactedPatch);
    } else {
      await updateSession(resolvedProjectId!, sessionId, compactedPatch);
    }

    return { originalTokens, compactedTokens, freedTokens, contextWindow, threshold };
  });
}

// Re-exported convenience: project rules are read through the same routes
// file (renderer calls project:getRules) — registration happens inside
// registerProjectRoutes so module wiring stays single-entrypoint.
export function registerProjectExtraRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("project:getRules", async (_event, projectId: string) => {
    const project = await getProject(projectId);
    if (!project) return { hasRules: false, ruleFiles: [], combinedPromptSection: "" };
    return await discoverProjectRules(project.root);
  });
}
