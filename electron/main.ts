import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runProjectAgent, RunCancelledError, type AgentMode, type AgentSettings, type AgentTurn } from "./agent-service.js";
import { PROVIDERS, fetchRemoteModels } from "./providers.js";
import {
  appendSessionMessage, createSession, deleteProject, deleteSession, getProject, getSandboxConfig,
  getSkillsConfig, getSession, listMcpServers, listProjects, listProviders, listSessions,
  removeMcpServer, removeProvider, saveSandboxConfig, saveSkillsConfig, updateProjectMemory,
  updateSession, upsertMcpServer, upsertProject, upsertProvider, type AgentUsage, type McpServerConfig,
  type ProviderConfig, type SandboxConfig
} from "./store.js";
import { testMcpServer } from "./mcp-service.js";
import { createSkill, deleteSkill, ensureSkillSourceDirs, importSkill, listSkills, openSkillsFolder, readSkillContent } from "./skills-service.js";
import { beginSandboxRun, cancelSandboxRun, deleteProjectSandbox, getSandboxAgentBackend, getSandboxStatus, isSandboxRunCancelled, runSandboxCommand, stopProjectSandbox, syncSandboxToProject } from "./sandbox-service.js";
import { createWorkspaceCheckpoint, getWorkspaceDiffFiles, restoreWorkspaceCheckpoint, revertAllWorkspaceChanges, revertWorkspaceFile } from "./diff-service.js";
import { getWorkspaceGit, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./project-tools.js";
import {
  createSessionWorktree, getSessionWorktree, mergeWorktreeToMain, discardSessionWorktree,
  getSessionWorktreeDiff, listSessionWorktrees, isGitRepo
} from "./worktree-service.js";
import { listArtifacts, getArtifact, updateArtifactStatus, type ArtifactStatus } from "./artifacts-service.js";
import { readSessionTrajectory } from "./trajectory-service.js";
import { discoverProjectRules } from "./rules-service.js";
import { terminalService } from "./terminal-service.js";
import { discoverCustomCommands, substituteCommandPlaceholders } from "./custom-commands-service.js";
import { daemonService } from "./daemon-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let activeProjectId: string | null = null;
let activeSessionId: string | null = null;
let activeProjectRoot: string | null = null;
let settings: AgentSettings = { model: process.env.OPENAI_MODEL || "gpt-4.1-mini", baseUrl: process.env.OPENAI_BASE_URL || "" };
const activeRunSessions = new Set<string>();

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function getAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, "../public/icon.png"),
    path.join(__dirname, "../build/icon.png"),
    path.join(process.cwd(), "public/icon.png"),
    path.join(process.cwd(), "build/icon.png"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#080a0f",
    title: "Nexus",
    frame: false,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  const devMode = process.argv.includes("--dev") || Boolean(process.env.VITE_DEV_SERVER_URL);
  if (devMode) void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173");
  else void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function emit(event: unknown) { mainWindow?.webContents.send("agent:event", event); }
function requireRoot() { if (!activeProjectRoot) throw new Error("Select or create a project first."); return activeProjectRoot; }

app.whenReady().then(() => {
  // Set standard Chrome desktop User-Agent to avoid webview blocks
  session.defaultSession.setUserAgent(CHROME_UA);

  // Window control IPC handlers
  ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    } else {
      mainWindow?.maximize();
      return true;
    }
  });
  ipcMain.handle("window:close", () => { mainWindow?.close(); });
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);

  // Allow embedded live browser to display any web page without frame-ancestor / X-Frame-Options restrictions
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    delete responseHeaders["x-frame-options"];
    delete responseHeaders["X-Frame-Options"];
    if (responseHeaders["content-security-policy"]) {
      responseHeaders["content-security-policy"] = responseHeaders["content-security-policy"].map((csp) =>
        csp.replace(/frame-ancestors[^;]+;?/gi, "")
      );
    }
    if (responseHeaders["Content-Security-Policy"]) {
      responseHeaders["Content-Security-Policy"] = responseHeaders["Content-Security-Policy"].map((csp) =>
        csp.replace(/frame-ancestors[^;]+;?/gi, "")
      );
    }
    callback({ responseHeaders });
  });

  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("project:select", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    const project = await upsertProject({ name: path.basename(root), root });
    activeProjectId = project.id; activeProjectRoot = project.root;
    const sessions = await listSessions(project.id);
    const session = sessions[0] || await createSession(project.id);
    activeSessionId = session.id;
    return { project, session };
  });
  ipcMain.handle("project:create", async (_event, input: { name: string; root: string }) => {
    const project = await upsertProject(input); activeProjectId = project.id; activeProjectRoot = project.root;
    const session = (await listSessions(project.id))[0] || await createSession(project.id);
    activeSessionId = session.id; return { project, session };
  });
  ipcMain.handle("project:activate", async (_event, projectId: string) => {
    const project = await getProject(projectId); if (!project) throw new Error("Project not found.");
    activeProjectId = project.id; activeProjectRoot = project.root; const session = project.sessions[0] || await createSession(project.id); activeSessionId = session.id; return { project, session };
  });
  ipcMain.handle("project:get-active", async () => activeProjectId ? { project: await getProject(activeProjectId), session: activeSessionId ? await getSession(activeProjectId, activeSessionId) : null } : null);
  ipcMain.handle("project:delete", async (_event, projectId: string) => {
    const project = await getProject(projectId);
    const sandboxConfig = await getSandboxConfig();
    if (project) await deleteProjectSandbox(project, sandboxConfig);
    const projects = await deleteProject(projectId);
    if (projectId === activeProjectId) { activeProjectId = null; activeSessionId = null; activeProjectRoot = null; }
    return projects;
  });

  ipcMain.handle("sessions:list", (_event, projectId: string) => listSessions(projectId));
  ipcMain.handle("session:create", async (_event, projectId: string, title?: string) => {
    const session = await createSession(projectId, title);
    activeProjectId = projectId; activeSessionId = session.id;
    const project = await getProject(projectId);
    activeProjectRoot = project?.root || null;
    return session;
  });
  ipcMain.handle("session:activate", async (_event, projectId: string, sessionId: string) => {
    const session = await getSession(projectId, sessionId); if (!session) throw new Error("Session not found.");
    const project = await getProject(projectId);
    activeProjectId = projectId; activeSessionId = sessionId; activeProjectRoot = project?.root || null;
    return session;
  });
  ipcMain.handle("session:update", (_event, projectId: string, sessionId: string, patch: Parameters<typeof updateSession>[2]) => updateSession(projectId, sessionId, patch));
  ipcMain.handle("session:delete", async (_event, projectId: string, sessionId: string) => {
    const project = await deleteSession(projectId, sessionId);
    if (activeProjectRoot) await discardSessionWorktree(activeProjectRoot, sessionId);
    if (sessionId === activeSessionId) {
      const next = project.sessions[0] || await createSession(projectId);
      activeSessionId = next.id;
    }
    return project;
  });

  ipcMain.handle("memory:project:update", (_event, projectId: string, memory: string) => updateProjectMemory(projectId, memory));
  ipcMain.handle("memory:session:update", (_event, projectId: string, sessionId: string, memory: string) => updateSession(projectId, sessionId, { memory }));
  ipcMain.handle("sandbox:config:get", () => getSandboxConfig());
  ipcMain.handle("sandbox:config:save", (_event, config: SandboxConfig) => saveSandboxConfig(config));
  ipcMain.handle("sandbox:status", async () => {
    const project = activeProjectId ? await getProject(activeProjectId) : null;
    return project ? getSandboxStatus(project, await getSandboxConfig()) : { configured: Boolean(await getSandboxConfig()), status: "no_project", sandbox: null };
  });
  ipcMain.handle("sandbox:stop", async () => {
    if (activeProjectId) {
      const project = await getProject(activeProjectId);
      if (project) await stopProjectSandbox(project, await getSandboxConfig());
    }
    return true;
  });

  ipcMain.handle("providers:definitions", () => PROVIDERS);
  ipcMain.handle("providers:list", async () => (await listProviders()).map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" })));
  ipcMain.handle("provider:save", async (_event, input: Omit<ProviderConfig, "id"> & { id?: string }) => {
    const existing = input.id ? (await listProviders()).find((provider) => provider.id === input.id) : undefined;
    const payload = { ...input, apiKey: input.apiKey === "********" ? existing?.apiKey || "" : input.apiKey };
    return (await upsertProvider(payload)).map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" }));
  });
  ipcMain.handle("provider:remove", async (_event, providerId: string) => (await removeProvider(providerId)).map((provider) => ({ ...provider, apiKey: provider.apiKey ? "********" : "" })));
  ipcMain.handle("providers:fetch-models", async (_event, input: { baseUrl?: string; apiKey?: string }) => fetchRemoteModels(input?.baseUrl || "", input?.apiKey));

  ipcMain.handle("mcp:list", () => listMcpServers());
  ipcMain.handle("mcp:save", (_event, input: Omit<McpServerConfig, "id"> & { id?: string }) => upsertMcpServer(input));
  ipcMain.handle("mcp:remove", (_event, serverId: string) => removeMcpServer(serverId));
  ipcMain.handle("mcp:test", (_event, input: Omit<McpServerConfig, "id" | "enabled">) => testMcpServer(input));

  ipcMain.handle("skills:config:get", () => getSkillsConfig());
  ipcMain.handle("skills:config:save", (_event, config: { enabled: boolean }) => saveSkillsConfig(config));
  ipcMain.handle("skills:list", async () => {
    await ensureSkillSourceDirs(activeProjectRoot);
    return listSkills(activeProjectRoot);
  });
  ipcMain.handle("skills:read", async (_event, skillPath: string) => readSkillContent(skillPath));
  ipcMain.handle("skills:pick-file", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: [{ name: "Skill definition", extensions: ["md"] }] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("skills:pick-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "multiSelections"] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("skills:import", async (_event, input: { sourcePath: string; scope: "global" | "project" }) => {
    const root = input.scope === "project" ? requireRoot() : (activeProjectRoot || "");
    return importSkill(root, input.sourcePath, input.scope);
  });
  ipcMain.handle("skills:create", async (_event, input: { name: string; description?: string; scope: "global" | "project"; content?: string }) => {
    const root = input.scope === "project" ? requireRoot() : (activeProjectRoot || "");
    return createSkill(root, input);
  });
  ipcMain.handle("skills:delete", async (_event, skillPath: string) => deleteSkill(skillPath));
  ipcMain.handle("skills:open-folder", async (_event, scope: "global" | "project") => {
    const root = scope === "project" ? requireRoot() : (activeProjectRoot || "");
    return openSkillsFolder(scope, root);
  });

  ipcMain.handle("settings:get", () => ({ ...settings, apiKey: settings.apiKey ? "********" : "" }));
  ipcMain.handle("settings:save", (_event, next: AgentSettings) => {
    settings = { ...settings, ...next };
    if (next.apiKey === "********") delete settings.apiKey;
    return { ...settings, apiKey: settings.apiKey ? "********" : "" };
  });

  ipcMain.handle("workspace:list", () => listWorkspaceFiles(requireRoot()));
  ipcMain.handle("workspace:read", (_event, file: string) => readWorkspaceFile(requireRoot(), file));
  ipcMain.handle("workspace:write", (_event, file: string, content: string) => writeWorkspaceFile(requireRoot(), file, content));
  ipcMain.handle("workspace:diff", async () => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return getWorkspaceDiffFiles(wt?.worktreePath || root);
  });
  ipcMain.handle("workspace:git", () => getWorkspaceGit(requireRoot()));
  ipcMain.handle("workspace:command", async (_event, command: string) => {
    const project = activeProjectId ? await getProject(activeProjectId) : null;
    let config = await getSandboxConfig();
    if (!config?.enabled || config.provider !== "local") {
      config = await saveSandboxConfig({ enabled: true, provider: "local", requireApproval: true, allowNetwork: false, commandTimeoutSeconds: 120 });
    }
    if (!project) throw new Error("Active project not found.");
    const result = await runSandboxCommand(project, config, command);
    return result.output || "Command completed successfully.";
  });

  ipcMain.handle("workspace:revert-file", async (_event, file: string) => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertWorkspaceFile(wt?.worktreePath || root, file);
  });
  ipcMain.handle("workspace:revert-all", async () => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return revertAllWorkspaceChanges(wt?.worktreePath || root);
  });
  ipcMain.handle("checkpoint:restore", async (_event, checkpointId: string) => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return restoreWorkspaceCheckpoint(wt?.worktreePath || root, checkpointId);
  });

  // Worktree IPC handlers
  ipcMain.handle("worktree:create", async (_event, sessionId: string) => {
    const root = requireRoot();
    return createSessionWorktree(root, sessionId);
  });
  ipcMain.handle("worktree:status", async (_event, sessionId: string) => {
    const root = requireRoot();
    const wt = await getSessionWorktree(root, sessionId);
    const isGit = await isGitRepo(root);
    return { isGit, worktree: wt };
  });
  ipcMain.handle("worktree:merge", async (_event, sessionId: string, commitMessage?: string) => {
    const root = requireRoot();
    return mergeWorktreeToMain(root, sessionId, commitMessage);
  });
  ipcMain.handle("worktree:discard", async (_event, sessionId: string) => {
    const root = requireRoot();
    return discardSessionWorktree(root, sessionId);
  });
  ipcMain.handle("worktree:diff", async (_event, sessionId: string) => {
    const root = requireRoot();
    return getSessionWorktreeDiff(root, sessionId);
  });

  // Artifacts IPC handlers
  ipcMain.handle("artifacts:list", async (_event, sessionId: string) => {
    const root = requireRoot();
    return listArtifacts(root, sessionId);
  });
  ipcMain.handle("artifacts:get", async (_event, sessionId: string, filename: string) => {
    const root = requireRoot();
    return getArtifact(root, sessionId, filename);
  });
  ipcMain.handle("artifacts:update-status", async (_event, sessionId: string, filename: string, status: ArtifactStatus) => {
    const root = requireRoot();
    return updateArtifactStatus(root, sessionId, filename, status);
  });

  // Trajectory IPC handler
  ipcMain.handle("trajectory:get", async (_event, sessionId: string) => {
    const root = requireRoot();
    return readSessionTrajectory(root, sessionId);
  });

  ipcMain.handle("project:getRules", async (_event, projectId: string) => {
    const project = await getProject(projectId);
    if (!project) return { hasRules: false, ruleFiles: [], combinedPromptSection: "" };
    return await discoverProjectRules(project.root);
  });

  ipcMain.handle("terminal:create", (_event, { id, cwd }: { id: string; cwd?: string }) => {
    const root = cwd || activeProjectRoot || process.cwd();
    terminalService.createSession(id, root, (data) => {
      mainWindow?.webContents.send("terminal:data", { id, data });
    });
    return true;
  });

  ipcMain.handle("terminal:write", (_event, { id, data }: { id: string; data: string }) => {
    return terminalService.write(id, data);
  });

  ipcMain.handle("terminal:kill", (_event, id: string) => {
    return terminalService.killSession(id);
  });

  // Custom Slash Commands
  ipcMain.handle("commands:listCustom", async () => {
    return await discoverCustomCommands(activeProjectRoot || undefined);
  });

  // Background Daemons & Services
  ipcMain.handle("daemons:list", () => {
    return daemonService.listDaemons();
  });

  ipcMain.handle("daemons:start", (_event, { name, command, cwd }: { name: string; command: string; cwd?: string }) => {
    const root = cwd || activeProjectRoot || process.cwd();
    return daemonService.startDaemon(name, command, root, (data) => {
      mainWindow?.webContents.send("daemon:log", { id: name, data });
    });
  });

  ipcMain.handle("daemons:stop", (_event, id: string) => {
    return daemonService.stopDaemon(id);
  });

  ipcMain.handle("daemons:restart", (_event, id: string) => {
    return daemonService.restartDaemon(id);
  });

  ipcMain.handle("daemons:logs", (_event, id: string) => {
    return daemonService.getDaemonLogs(id);
  });

  // Browser External Navigation
  ipcMain.handle("browser:openExternal", async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle("agent:run", async (_event, payload: { request: string; images?: string[]; providerId?: string; model?: string; mode?: string }) => {
    const root = requireRoot();
    if (!activeProjectId || !activeSessionId) throw new Error("Create a session first.");
    if (activeRunSessions.has(activeSessionId)) throw new Error("An agent run is already in progress in this session.");

    activeRunSessions.add(activeSessionId);
    beginSandboxRun();
    try {
      const project = await getProject(activeProjectId);
      const session = await getSession(activeProjectId, activeSessionId);
      if (!project || !session) throw new Error("Active project/session not found.");

      const mode: AgentMode = payload.mode === "plan" || payload.mode === "auto" ? payload.mode : "ask";
      const configured = payload.providerId ? (await listProviders()).find((provider) => provider.id === payload.providerId) : undefined;
      const provider = configured || (await listProviders())[0];
      const runSettings: AgentSettings = provider ? { provider, model: payload.model || session.model?.model } : settings;
      let sandboxConfig = await getSandboxConfig();
      if (!sandboxConfig || !sandboxConfig.enabled || sandboxConfig.provider !== "local") {
        sandboxConfig = await saveSandboxConfig({ enabled: true, provider: "local", requireApproval: true, allowNetwork: false, commandTimeoutSeconds: 120 });
      }

      if (session.title === "New coding task" && payload.request) {
        await updateSession(activeProjectId, activeSessionId, { title: payload.request.slice(0, 60) });
      }

      // Check if session has an explicit active worktree
      let executionRoot = root;
      if (await isGitRepo(root)) {
        try {
          const wt = await getSessionWorktree(root, activeSessionId);
          if (wt) executionRoot = wt.worktreePath;
        } catch {
          executionRoot = root;
        }
      }

      const history: AgentTurn[] = session.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-16)
        .map((message) => ({ role: message.role as AgentTurn["role"], text: message.text }));

      const sandboxProject = { ...project, root: executionRoot };
      const sandboxSession = await getSandboxAgentBackend(sandboxProject, sandboxConfig, { readOnly: mode === "plan" });
      const checkpointId = `cp_${Date.now().toString(36)}`;
      await createWorkspaceCheckpoint(executionRoot, checkpointId);
      await appendSessionMessage(activeProjectId, activeSessionId, { role: "user", text: payload.request, createdAt: new Date().toISOString() });

      let result: Awaited<ReturnType<typeof runProjectAgent>>;
      try {
        result = await runProjectAgent({
          projectRoot: executionRoot,
          telemetryRoot: root,
          sessionId: activeSessionId,
          request: payload.request,
          images: payload.images,
          settings: runSettings,
          memory: { projectMemory: project.memory, sessionMemory: session.memory },
          history,
          mode,
          sandboxBackend: sandboxSession.backend,
          onEvent: emit,
          isCancelled: isSandboxRunCancelled,
        });
      } catch (error) {
        if (error instanceof RunCancelledError) {
          emit({ type: "error", text: "Run cancelled by user.", timestamp: new Date().toISOString() });
          await appendSessionMessage(activeProjectId, activeSessionId, { role: "event", text: "Run cancelled by user.", createdAt: new Date().toISOString() });
          return "Run cancelled by user.";
        }
        throw error;
      }

      await syncSandboxToProject(sandboxSession.workspace, executionRoot);
      await appendSessionMessage(activeProjectId, activeSessionId, { role: "assistant", text: result.response, createdAt: new Date().toISOString(), usage: result.usage });

      const prevUsage = session.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
      const cumulativeUsage: AgentUsage = {
        inputTokens: (prevUsage.inputTokens || 0) + (result.usage?.inputTokens || 0),
        outputTokens: (prevUsage.outputTokens || 0) + (result.usage?.outputTokens || 0),
        totalTokens: (prevUsage.totalTokens || 0) + (result.usage?.totalTokens || 0),
        estimatedCost: Number(((prevUsage.estimatedCost || 0) + (result.usage?.estimatedCost || 0)).toFixed(4)),
      };
      await updateSession(activeProjectId, activeSessionId, {
        checkpointId,
        usage: cumulativeUsage,
        memory: [session.memory, result.memoryEntry].filter(Boolean).join("\n\n"),
      });
      await updateProjectMemory(activeProjectId, [project.memory, `Recent work in ${session.title}: ${payload.request}`].filter(Boolean).join("\n"));
      return result.response;
    } finally {
      if (activeSessionId) activeRunSessions.delete(activeSessionId);
    }
  });

  ipcMain.handle("agent:cancel", () => { cancelSandboxRun(); return true; });

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
