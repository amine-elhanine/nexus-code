import { app, BrowserWindow, dialog, ipcMain, shell, session, protocol, net } from "electron";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { runProjectAgent, RunCancelledError, isContinueRequest, getLastRunCheckpoint, loadLastRunCheckpoint, summarizeCompletedSteps, type AgentMode, type AgentSettings, type AgentTurn, type AgentEvent } from "./agent-service.js";
import { PROVIDERS, fetchRemoteModels } from "./providers.js";
import {
  appendSessionMessages, createSession, deleteProject, deleteSession, ensureHomeProject, getProject, getSession,
  getSkillsConfig, listMcpServers, listProjects, listProviders, listSessions,
  removeMcpServer, removeProvider, saveSkillsConfig, updateProjectMemory,
  updateSession, upsertMcpServer, upsertProject, upsertProvider, type McpServerConfig,
  type ProviderConfig
} from "./store.js";
import { HOME_PROJECT_ID, cleanupHomeGeneratorScripts, downloadHomeFile, ensureHomeDir, listHomeFiles, listHomeSessionFiles, openHomeFolder, readHomeFile } from "./home-service.js";
import { testMcpServer } from "./mcp-service.js";
import { createSkill, deleteSkill, ensureSkillSourceDirs, importSkill, listSkills, openSkillsFolder, readSkillContent } from "./skills-service.js";
import { beginCommandRun, cancelCommandRun, isCommandRunCancelled, runProjectCommand, getAgentBackend } from "./command-service.js";
import { createWorkspaceCheckpoint, deleteWorkspaceCheckpoint, getWorkspaceDiffFiles, restoreWorkspaceCheckpoint, revertAllWorkspaceChanges, revertWorkspaceFile } from "./diff-service.js";
import { getWorkspaceGit, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./project-tools.js";
import {
  createSessionWorktree, getSessionWorktree, mergeWorktreeToMain, discardSessionWorktree,
  getSessionWorktreeDiff, isGitRepo
} from "./worktree-service.js";
import { listArtifacts, getArtifact, updateArtifactStatus, type ArtifactStatus } from "./artifacts-service.js";
import { readSessionTrajectory } from "./trajectory-service.js";
import { discoverProjectRules } from "./rules-service.js";
import { terminalService } from "./terminal-service.js";
import { discoverCustomCommands } from "./custom-commands-service.js";
import { daemonService } from "./daemon-service.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "nexus-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

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

// Agent events are tagged with the session they belong to, so the renderer can
// route them to the right transcript even while several runs are live.
function emit(event: AgentEvent) {
  mainWindow?.webContents.send("agent:event", event);
}
function emitFor(sessionId: string, event: Omit<AgentEvent, "sessionId" | "timestamp">) {
  emit({ ...event, sessionId, timestamp: new Date().toISOString() });
}
function requireRoot() { if (!activeProjectRoot) throw new Error("Select or create a project first."); return activeProjectRoot; }

// Checkpoints left over from deleted/kept runs would keep the Undo card
// clickable forever; this clears one when a run's changes are accepted.
async function clearCheckpoint(projectId: string, sessionId: string, root: string, checkpointId?: string) {
  if (!checkpointId) return;
  try { await deleteWorkspaceCheckpoint(root, checkpointId); } catch { /* best effort */ }
  await updateSession(projectId, sessionId, { checkpointId: undefined });
}

// The model APIs need a fetchable URL for images: nexus-attachment:// is a
// renderer-only scheme. Convert saved attachments back to inline base64
// data URLs before they go anywhere near a provider.
async function resolveImageForModel(imageUrl: string): Promise<string> {
  if (!imageUrl.startsWith("nexus-attachment://")) return imageUrl;
  const fileName = path.basename(new URL(imageUrl).pathname);
  const filePath = path.join(app.getPath("userData"), "attachments", fileName);
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

app.whenReady().then(async () => {
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

  // Configure dedicated browser webview partition
  const browserSession = session.fromPartition("persist:browser");
  browserSession.setUserAgent(CHROME_UA);
  browserSession.webRequest.onHeadersReceived((details, callback) => {
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

  protocol.handle("nexus-attachment", (request) => {
    const fileName = path.basename(new URL(request.url).pathname);
    const filePath = path.join(app.getPath("userData"), "attachments", fileName);
    return net.fetch(`file://${filePath}`);
  });

  // Home area bootstrap: fixed folder + built-in project (id "home") so
  // general-assistant sessions persist like coding sessions. Best-effort —
  // Home is created lazily by its IPC handlers if this fails.
  try {
    const homeRoot = await ensureHomeDir();
    await ensureHomeProject(HOME_PROJECT_ID, "Home", homeRoot);
  } catch { /* lazy fallback in home:get */ }

  ipcMain.handle("home:get", async () => {
    const homeRoot = await ensureHomeDir();
    const project = await ensureHomeProject(HOME_PROJECT_ID, "Home", homeRoot);
    return { project, root: homeRoot };
  });
  ipcMain.handle("home:files", () => listHomeFiles());
  ipcMain.handle("home:sessionFiles", async (_event, sessionId: string) => {
    const sessions = await listSessions(HOME_PROJECT_ID);
    return listHomeSessionFiles(sessionId, sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })));
  });
  ipcMain.handle("home:readFile", (_event, relativePath: string) => readHomeFile(relativePath));
  ipcMain.handle("home:download", (_event, relativePath: string) => downloadHomeFile(relativePath));
  ipcMain.handle("home:openFolder", () => openHomeFolder());

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
    await deleteProject(projectId);
    if (projectId === activeProjectId) { activeProjectId = null; activeSessionId = null; activeProjectRoot = null; }
    return listProjects();
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
    const root = project.root || activeProjectRoot;
    if (root) await discardSessionWorktree(root, sessionId);
    if (sessionId === activeSessionId) {
      const next = project.sessions[0] || await createSession(projectId);
      activeSessionId = next.id;
    }
    return project;
  });

  ipcMain.handle("memory:project:update", (_event, projectId: string, memory: string) => updateProjectMemory(projectId, memory));
  ipcMain.handle("memory:session:update", (_event, projectId: string, sessionId: string, memory: string) => updateSession(projectId, sessionId, { memory }));

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
  ipcMain.handle("skills:read", async (_event, skillPath: string) => readSkillContent(skillPath, activeProjectRoot));
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
  ipcMain.handle("skills:delete", async (_event, skillPath: string) => deleteSkill(skillPath, activeProjectRoot));
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
  ipcMain.handle("workspace:readHead", async (_event, file: string) => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    const targetRoot = wt?.worktreePath || root;
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    try {
      const { stdout } = await execFileAsync("git", ["show", `HEAD:${normalized}`], { cwd: targetRoot, maxBuffer: 4_000_000 });
      return stdout;
    } catch {
      return "";
    }
  });
  ipcMain.handle("attachments:save", async (_event, payload: { data: string; filename?: string }) => {
    const attachmentsDir = path.join(app.getPath("userData"), "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });

    let base64Data = payload.data;
    let ext = "png";
    const match = payload.data.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (match) {
      ext = match[1] === "jpeg" ? "jpg" : match[1];
      base64Data = match[2];
    }
    const hash = crypto.createHash("sha256").update(base64Data).digest("hex").slice(0, 16);
    const fileName = `${hash}.${ext}`;
    const filePath = path.join(attachmentsDir, fileName);
    await fs.writeFile(filePath, Buffer.from(base64Data, "base64"));
    return { fileName, filePath, url: `nexus-attachment://${fileName}` };
  });
  ipcMain.handle("workspace:write", (_event, file: string, content: string) => writeWorkspaceFile(requireRoot(), file, content));
  ipcMain.handle("workspace:diff", async () => {
    const root = requireRoot();
    const wt = activeSessionId ? await getSessionWorktree(root, activeSessionId) : null;
    return getWorkspaceDiffFiles(wt?.worktreePath || root);
  });
  ipcMain.handle("workspace:git", () => getWorkspaceGit(requireRoot()));
  ipcMain.handle("workspace:command", async (_event, command: string) => {
    const project = activeProjectId ? await getProject(activeProjectId) : null;
    if (!project) throw new Error("Active project not found.");
    const result = await runProjectCommand(project, command);
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

  ipcMain.handle("terminal:create", async (_event, { id, cwd, cols, rows }: { id: string; cwd?: string; cols?: number; rows?: number }) => {
    const root = cwd || activeProjectRoot || process.cwd();
    const session = await terminalService.createSession(id, root, (data) => {
      mainWindow?.webContents.send("terminal:data", { id, data });
    }, { cols, rows });
    // The live session holds an onData callback and a ChildProcess handle; both
    // are uncloneable over IPC, so only plain serializable fields cross back.
    return { id: session.id, mode: session.mode, cols: session.cols, rows: session.rows, alive: session.alive };
  });

  ipcMain.handle("terminal:write", (_event, { id, data }: { id: string; data: string }) => {
    return terminalService.write(id, data);
  });

  ipcMain.handle("terminal:kill", (_event, id: string) => {
    return terminalService.killSession(id);
  });

  ipcMain.handle("terminal:resize", (_event, { id, cols, rows }: { id: string; cols?: number; rows?: number }) => {
    return terminalService.resize(id, cols || 80, rows || 24);
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

  // Each run collects its own transcript events so they can be persisted to the
  // session in one batch — tool traces and plans survive an app restart now.
  type RunTranscript = { items: Array<{ role: "event"; text: string; kind: AgentEvent["type"]; createdAt: string; plan?: AgentEvent["items"]; subagent?: AgentEvent["subagent"]; artifact?: AgentEvent["artifact"]; usage?: AgentEvent["usage"] }> };

  ipcMain.handle("agent:run", async (_event, payload: { request: string; images?: string[]; providerId?: string; model?: string; mode?: string }) => {
    const root = requireRoot();
    if (!activeProjectId || !activeSessionId) throw new Error("Create a session first.");
    if (activeRunSessions.has(activeSessionId)) throw new Error("An agent run is already in progress in this session.");

    const sessionId = activeSessionId;
    const projectId = activeProjectId;
    activeRunSessions.add(sessionId);
    beginCommandRun();
    const transcript: RunTranscript = { items: [] };
    // Prelude heartbeat: if the run ever wedges before the agent emits,
    // the UI shows the last reached stage instead of a mystery spinner.
    emitFor(sessionId, { type: "status", text: "Opening session…" });
    try {
      const project = await getProject(projectId);
      const session = await getSession(projectId, sessionId);
      if (!project || !session) throw new Error("Active project/session not found.");

      const mode: AgentMode = payload.mode === "plan" || payload.mode === "auto" ? payload.mode : "ask";
      const configured = payload.providerId ? (await listProviders()).find((provider) => provider.id === payload.providerId) : undefined;
      const provider = configured || (await listProviders())[0];
      const runSettings: AgentSettings = provider ? { provider, model: payload.model || session.model?.model } : { ...settings };

      if (session.title === "New coding task" && payload.request) {
        await updateSession(projectId, sessionId, { title: payload.request.slice(0, 60) });
      }

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

      const history: AgentTurn[] = session.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-16)
        .map((message) => ({ role: message.role as AgentTurn["role"], text: message.text }));

      // Continue-resume: a bare "continue" after an interrupt/stop must pick
      // up the prior run's tool checkpoint, plan and diff — otherwise the
      // model restarts from scratch. The checkpoint cache covers same-process
      // resume; the transcript-derived note covers app restarts.
      const wantResume = isContinueRequest(payload.request || "");
      // Memory first, disk second: checkpoints are mirrored to
      // .nexus/run-checkpoints/ so "continue" survives an app restart.
      const stored = wantResume ? getLastRunCheckpoint(sessionId) ?? await loadLastRunCheckpoint(root, sessionId) : null;
      let resumeNote: string | null = null;
      if (wantResume) {
        const planEvents = session.messages.filter((m) => m.role === "event" && m.kind === "plan" && m.plan?.length);
        const lastPlan = planEvents.length ? planEvents[planEvents.length - 1].plan! : null;
        const errorEvents = session.messages.filter((m) => m.role === "event" && m.kind === "error");
        const lastError = errorEvents.length ? errorEvents[errorEvents.length - 1].text : null;
        const assistants = session.messages.filter((m) => m.role === "assistant");
        const lastAssistant = assistants.length ? assistants[assistants.length - 1].text.slice(-1500) : null;
        let diffSummary = "";
        try {
          const diffs = await getWorkspaceDiffFiles(executionRoot);
          if (diffs.length) diffSummary = `\nFiles already changed:\n${diffs.slice(0, 20).map((d) => `- ${d.path} (+${d.additions}/-${d.deletions})`).join("\n")}`;
        } catch { /* diff is best-effort */ }
        const planSummary = (stored?.planItems ?? lastPlan)?.length
          ? `\nWorking plan status:\n${(stored?.planItems ?? lastPlan)!.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
          : "";
        // Explicit done-list: weak models re-do finished steps from prose
        // instructions alone; a concrete ledger survives where they don't.
        const ledger = stored?.messages?.length ? summarizeCompletedSteps(stored.messages) : [];
        const ledgerSummary = ledger.length
          ? `\nSteps already DONE (never repeat — results are in history):\n${ledger.map((s) => `- ${s}`).join("\n")}`
          : "";
        resumeNote = `[System Note: The user asked to continue the previous interrupted run. All preceding tool executions and results ${stored ? `(${stored.messages.length} checkpointed messages) ` : ""}are already complete.${planSummary}${ledgerSummary}${lastError ? `\nLast stop reason: ${lastError.slice(0, 500)}` : ""}${lastAssistant ? `\nLast assistant summary: ${lastAssistant}` : ""}${diffSummary}\n\nIMPORTANT: Do NOT restart from the beginning, do NOT re-create the todo list from scratch, and do NOT repeat completed tool actions or file reads. Proceed directly with the next unfinished step.]`;
      }

      const backendRecord = { ...project, root: executionRoot };
      emitFor(sessionId, { type: "status", text: "Preparing workspace…" });
      const { backend } = await getAgentBackend(backendRecord, { readOnly: mode === "plan" });
      const checkpointId = `cp_${Date.now().toString(36)}`;
      await createWorkspaceCheckpoint(executionRoot, checkpointId);
      await appendSessionMessages(projectId, sessionId, [{ role: "user", text: payload.request, images: payload.images, createdAt: new Date().toISOString() }]);

      // Renderer-only attachment URLs become inline data URLs for the model.
      const modelImages = payload.images?.length
        ? await Promise.all(payload.images.map((img) => resolveImageForModel(img).catch(() => img)))
        : undefined;

      // Home sessions run the general assistant: same tool loop, but no
      // code-project verification and a Home-oriented system prompt.
      const isHomeRun = project.id === HOME_PROJECT_ID;
      const runStartMs = Date.now();
      let result: Awaited<ReturnType<typeof runProjectAgent>>;
      try {
        result = await runProjectAgent({
          projectRoot: executionRoot,
          telemetryRoot: root,
          taskKind: isHomeRun ? "general" : "code",
          sessionId,
          request: payload.request,
          images: modelImages,
          settings: runSettings,
          memory: { projectMemory: project.memory, sessionMemory: session.memory },
          history,
          mode,
          agentBackend: backend,
          resumeMessages: stored?.messages ?? null,
          resumePlanItems: stored?.planItems ?? null,
          resumeNote,
          onEvent: (event) => {
            // Token chunks stay ephemeral (streaming display only); everything
            // else is captured for the persisted transcript.
            if (event.type !== "token") {
              transcript.items.push({
                role: "event",
                text: event.text,
                kind: event.type,
                createdAt: event.timestamp,
                plan: event.items,
                subagent: event.subagent,
                artifact: event.artifact,
                usage: event.type === "usage" ? undefined : event.usage,
              });
            }
            emit(event);
          },
          isCancelled: isCommandRunCancelled,
        });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        // Failed runs leave a persistent error entry so the transcript tells
        // the truth after a reload, not just in the live view.
        await appendSessionMessages(projectId, sessionId, [
          ...transcript.items,
          { role: "event", kind: "error", text: `Agent run failed: ${errorText}`, createdAt: new Date().toISOString() },
        ]);
        emitFor(sessionId, { type: "error", text: `Agent run failed: ${errorText}` });
        if (error instanceof RunCancelledError) return "Run cancelled by user.";
        throw error;
      }

      await appendSessionMessages(projectId, sessionId, [
        ...transcript.items,
        { role: "assistant", text: result.response, createdAt: new Date().toISOString(), usage: result.usage },
      ]);
      // Home safety net: if the agent left its throwaway generator script
      // behind (e.g. generate_report.py next to report.docx), remove it so
      // only the requested deliverable(s) remain. Recorded in-transcript.
      if (isHomeRun) {
        try {
          const deleted = await cleanupHomeGeneratorScripts(runStartMs, payload.request || "");
          if (deleted.length) {
            await appendSessionMessages(projectId, sessionId, [
              { role: "event", kind: "tool", text: `Cleaned up generator script${deleted.length === 1 ? "" : "s"}: ${deleted.join(", ")}`, createdAt: new Date().toISOString() },
            ]);
          }
        } catch { /* best effort — deliverable already exists */ }
      }
      await clearCheckpoint(projectId, sessionId, root, session.checkpointId);
      // Memories are rolling windows, not append-only logs: entries are
      // individually capped upstream, and the totals are capped here so
      // hundreds of runs cannot bloat every future prompt.
      const nextSessionMemory = [session.memory, result.memoryEntry].filter(Boolean).join("\n\n");
      const nextProjectMemory = [project.memory, result.projectMemoryLogEntry].filter(Boolean).join("\n");
      await updateSession(projectId, sessionId, {
        checkpointId,
        memory: nextSessionMemory.slice(-4000),
      });
      // Keep the memory log bounded; agent-service returns a capped entry.
      await updateProjectMemory(projectId, nextProjectMemory.slice(-2000));
      return result.response;
    } finally {
      activeRunSessions.delete(sessionId);
    }
  });

  ipcMain.handle("agent:cancel", () => { cancelCommandRun(); return true; });

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => {
  daemonService.stopAllDaemons();
  terminalService.killAll();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
