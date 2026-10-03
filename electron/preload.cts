import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
type AgentEvent = { type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact"; text: string; timestamp: string; items?: PlanItem[]; artifact?: any };
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const nexusApi = {
  listProjects: () => invoke("projects:list"),
  selectProject: () => invoke("project:select"),
  createProject: (name: string, root: string) => invoke("project:create", { name, root }),
  activateProject: (id: string) => invoke("project:activate", id),
  deleteProject: (id: string) => invoke("project:delete", id),
  getActive: () => invoke("project:get-active"),
  listSessions: (projectId: string) => invoke("sessions:list", projectId),
  createSession: (projectId: string, title?: string) => invoke("session:create", projectId, title),
  activateSession: (projectId: string, sessionId: string) => invoke("session:activate", projectId, sessionId),
  deleteSession: (projectId: string, sessionId: string, options?: { deleteFiles?: boolean }) => invoke("session:delete", projectId, sessionId, options),
  updateSession: (projectId: string, sessionId: string, patch: unknown) => invoke("session:update", projectId, sessionId, patch),
  updateProjectMemory: (projectId: string, memory: string) => invoke("memory:project:update", projectId, memory),
  updateSessionMemory: (projectId: string, sessionId: string, memory: string) => invoke("memory:session:update", projectId, sessionId, memory),
  listProviderDefinitions: () => invoke("providers:definitions"),
  listProviders: () => invoke("providers:list"),
  saveProvider: (provider: unknown) => invoke("provider:save", provider),
  removeProvider: (providerId: string) => invoke("provider:remove", providerId),
  fetchProviderModels: (baseUrl: string, apiKey?: string) => invoke("providers:fetch-models", { baseUrl, apiKey }),
  listMcpServers: () => invoke("mcp:list"),
  saveMcpServer: (server: unknown) => invoke("mcp:save", server),
  removeMcpServer: (serverId: string) => invoke("mcp:remove", serverId),
  testMcpServer: (server: unknown) => invoke("mcp:test", server),
  exportSession: (sessionId: string) => invoke("sessions:export", sessionId),
  getHooksConfig: () => invoke("hooks:config:get"),
  saveHooksConfig: (config: unknown) => invoke("hooks:config:save", config),
  getSkillsConfig: () => invoke("skills:config:get"),
  pickSkillFile: () => invoke("skills:pick-file"),
  pickSkillFolder: () => invoke("skills:pick-folder"),
  importSkill: (sourcePath: string, scope: "global" | "project") => invoke("skills:import", { sourcePath, scope }),
  saveSkillsConfig: (config: unknown) => invoke("skills:config:save", config),
  listSkills: () => invoke("skills:list"),
  readSkillContent: (skillPath: string) => invoke("skills:read", skillPath),
  createSkill: (input: unknown) => invoke("skills:create", input),
  deleteSkill: (skillPath: string) => invoke("skills:delete", skillPath),
  setSkillModes: (skillPath: string, modes: string[]) => invoke("skills:set-modes", { skillPath, modes }),
  openSkillsFolder: (scope: "global" | "project") => invoke("skills:open-folder", scope),
  getSettings: () => invoke("settings:get"),
  saveSettings: (settings: unknown) => invoke("settings:save", settings),
  getAppSettings: () => invoke("app-settings:get"),
  saveAppSettings: (settings: unknown) => invoke("app-settings:save", settings),
  getNotebookParser: () => invoke("notebook:parser:get"),
  saveNotebookParser: (config: unknown) => invoke("notebook:parser:save", config),
  listWorkspace: () => invoke("workspace:list"),
  readFile: (file: string) => invoke("workspace:read", file),
  readHead: (file: string) => invoke("workspace:readHead", file),
  writeFile: (file: string, content: string) => invoke("workspace:write", file, content),
  saveAttachment: (data: string, filename?: string) => invoke("attachments:save", { data, filename }),
  readAttachment: (url: string) => invoke("attachments:read", url),
  getDiff: () => invoke("workspace:diff"),
  revertFile: (file: string) => invoke("workspace:revert-file", file),
  revertHunk: (file: string, hunkHeader: string) => invoke("workspace:revert-hunk", file, hunkHeader),
  revertAll: () => invoke("workspace:revert-all"),
  restoreCheckpoint: (checkpointId: string) => invoke("checkpoint:restore", checkpointId),
  clearCheckpoints: () => invoke("checkpoint:clear"),
  ensureRepo: () => invoke("project:ensure-repo"),
  getGit: () => invoke("workspace:git"),
  runCommand: (command: string) => invoke("workspace:command", command),

  // Worktrees
  createWorktree: (sessionId: string) => invoke("worktree:create", sessionId),
  getWorktreeStatus: (sessionId: string) => invoke("worktree:status", sessionId),
  mergeWorktree: (sessionId: string, commitMessage?: string) => invoke("worktree:merge", sessionId, commitMessage),
  abortWorktreeMerge: (sessionId?: string) => invoke("worktree:abort-merge", sessionId),
  discardWorktree: (sessionId: string) => invoke("worktree:discard", sessionId),
  getWorktreeDiff: (sessionId: string) => invoke("worktree:diff", sessionId),

  // Artifacts
  listArtifacts: (sessionId: string) => invoke("artifacts:list", sessionId),
  getArtifact: (sessionId: string, filename: string) => invoke("artifacts:get", sessionId, filename),
  updateArtifactStatus: (sessionId: string, filename: string, status: string) => invoke("artifacts:update-status", sessionId, filename, status),

  // Project Rules
  getProjectRules: (projectId: string) => invoke("project:getRules", projectId),

  // Custom Slash Commands
  listCustomCommands: () => invoke("commands:listCustom"),

  // Background Daemons & Services
  listDaemons: () => invoke("daemons:list"),
  startDaemon: (name: string, command: string, cwd?: string) => invoke("daemons:start", { name, command, cwd }),
  stopDaemon: (id: string) => invoke("daemons:stop", id),
  restartDaemon: (id: string) => invoke("daemons:restart", id),
  removeDaemon: (id: string) => invoke("daemons:remove", id),
  getDaemonLogs: (id: string) => invoke("daemons:logs", id),
  onDaemonLog: (listener: (payload: { id: string; data: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { id: string; data: string }) => listener(payload);
    ipcRenderer.on("daemon:log", handler);
    return () => ipcRenderer.removeListener("daemon:log", handler);
  },

  // Browser External Navigation
  openExternal: (url: string) => invoke("browser:openExternal", url),

  // Agent browser (headless toggle + activity from the agent's window)
  getBrowserHeadless: () => invoke("browser:headless:get"),
  setBrowserHeadless: (value: boolean) => invoke("browser:headless:set", value),
  onBrowserAgentActivity: (listener: (payload: { url: string; timestamp: string; autoFollow?: boolean; sessionId?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { url: string; timestamp: string; autoFollow?: boolean; sessionId?: string }) => listener(payload);
    ipcRenderer.on("browser:agent-activity", handler);
    return () => ipcRenderer.removeListener("browser:agent-activity", handler);
  },

  // Agent browser bridge: the main process asks the hidden in-app webview to
  // load pages / run scripts / press keys / screenshot, and awaits the reply.
  // The agent never owns a window — it drives the built-in browser session.
  onAgentBrowserRequest: (handler: (request: { id: string; scope?: string; kind: string; url?: string; js?: string; keyCode?: string }) => Promise<unknown>) => {
    const listener = (_event: IpcRendererEvent, request: { id: string; scope?: string; kind: string; url?: string; js?: string; keyCode?: string }) => {
      void Promise.resolve()
        .then(() => handler(request))
        .then(
          (reply) => ipcRenderer.send("browser:agent-reply", { id: request.id, reply }),
          (error) => ipcRenderer.send("browser:agent-reply", { id: request.id, reply: { ok: false, error: error instanceof Error ? error.message : String(error) } })
        );
    };
    ipcRenderer.on("browser:agent-request", listener);
    return () => ipcRenderer.removeListener("browser:agent-request", listener);
  },

  // Interactive Terminal
  createTerminal: (id: string, cwd?: string, cols?: number, rows?: number) => invoke("terminal:create", { id, cwd, cols, rows }),
  // In-app updates
  getUpdaterState: () => invoke("updater:getState"),
  checkForUpdates: () => invoke("updater:check"),
  quitAndInstallUpdate: () => invoke("updater:quit-and-install"),
  getAppVersion: () => invoke("app:getVersion"),
  onUpdaterStatus: (listener: (state: { status: string; version?: string; percent?: number; message?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, state: { status: string; version?: string; percent?: number; message?: string }) => listener(state);
    ipcRenderer.on("updater:status", handler);
    return () => ipcRenderer.removeListener("updater:status", handler);
  },
  writeTerminal: (id: string, data: string) => invoke("terminal:write", { id, data }),
  killTerminal: (id: string) => invoke("terminal:kill", id),
  resizeTerminal: (id: string, cols: number, rows: number) => invoke("terminal:resize", { id, cols, rows }),
  onTerminalData: (listener: (payload: { id: string; data: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { id: string; data: string }) => listener(payload);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },

  // Trajectories
  getTrajectory: (sessionId: string) => invoke("trajectory:get", sessionId),

  // Window controls
  minimizeWindow: () => invoke("window:minimize"),
  maximizeWindow: () => invoke("window:maximize"),
  closeWindow: () => invoke("window:close"),
  isWindowMaximized: () => invoke("window:isMaximized"),

  // Home (isolated general assistant)
  getHome: () => invoke("home:get"),
  listHomeSessions: () => invoke("home:sessions:list"),
  createHomeSession: (title?: string) => invoke("home:sessions:create", title),
  activateHomeSession: (sessionId: string) => invoke("home:sessions:activate", sessionId),
  deleteHomeSession: (sessionId: string, options?: { deleteFiles?: boolean }) => invoke("home:sessions:delete", sessionId, options),
  updateHomeSession: (sessionId: string, patch: unknown) => invoke("home:sessions:update", sessionId, patch),
  runHomeAgent: (payload: { sessionId: string; request: string; images?: string[]; attachments?: any[]; providerId?: string; model?: string }) => invoke("home:run", payload),
  cancelHomeAgent: (sessionId?: string) => invoke("home:cancel", sessionId),
  listHomeFiles: () => invoke("home:files"),
  listHomeSessionFiles: (sessionId: string) => invoke("home:sessionFiles", sessionId),
  listHomeSessionFilesForDeletion: (sessionId: string) => invoke("home:sessionFiles:forDeletion", sessionId),
  getHomeMemory: () => invoke("home:memory:get"),
  updateHomeMemory: (memory: string) => invoke("home:memory:update", memory),
  getHomeMemoryStructured: () => invoke("home:memory:structured"),
  removeHomeMemoryFact: (category: string, fact: string) => invoke("home:memory:fact:remove", { category, fact }),
  readHomeFile: (relativePath: string) => invoke("home:readFile", relativePath),
  downloadHomeFile: (relativePath: string) => invoke("home:download", relativePath),
  openHomeFolder: () => invoke("home:openFolder"),

  // Notebook (isolated agentic RAG per notebook)
  listNotebooks: () => invoke("notebook:list"),
  createNotebook: (name: string, description?: string) => invoke("notebook:create", name, description),
  renameNotebook: (notebookId: string, name: string, description?: string) => invoke("notebook:rename", notebookId, name, description),
  deleteNotebook: (notebookId: string) => invoke("notebook:delete", notebookId),
  notebookStats: (notebookId: string) => invoke("notebook:stats", notebookId),
  notebookSources: (notebookId: string) => invoke("notebook:sources", notebookId),
  notebookPickFiles: (notebookId: string) => invoke("notebook:pickFiles", notebookId),
  notebookUploadContent: (notebookId: string, filename: string, content: string) => invoke("notebook:uploadContent", notebookId, filename, content),
  notebookUploadBase64: (notebookId: string, filename: string, base64: string) => invoke("notebook:uploadBase64", notebookId, filename, base64),
  notebookImportYouTube: (notebookId: string, url: string) => invoke("notebook:importYouTube", notebookId, url),
  notebookImportWebsite: (notebookId: string, url: string) => invoke("notebook:importWebsite", notebookId, url),
  notebookDeleteSource: (notebookId: string, sourceId: string) => invoke("notebook:deleteSource", notebookId, sourceId),
  notebookReindexSource: (notebookId: string, sourceId: string) => invoke("notebook:reindexSource", notebookId, sourceId),
  notebookReindexAll: (notebookId: string) => invoke("notebook:reindexAll", notebookId),
  notebookOutline: (notebookId: string) => invoke("notebook:outline", notebookId),
  notebookDigest: (notebookId: string) => invoke("notebook:digest", notebookId),
  notebookSettings: (notebookId: string) => invoke("notebook:settings:get", notebookId),
  saveNotebookSettings: (notebookId: string, instructions: string) => invoke("notebook:settings:save", notebookId, instructions),
  notebookNotes: (notebookId: string) => invoke("notebook:notes:list", notebookId),
  saveNotebookNote: (input: unknown) => invoke("notebook:notes:save", input),
  deleteNotebookNote: (notebookId: string, noteId: string) => invoke("notebook:notes:delete", notebookId, noteId),
  notebookPassage: (notebookId: string, chunkId: string) => invoke("notebook:passage", notebookId, chunkId),
  notebookDocuments: (notebookId: string) => invoke("notebook:documents:list", notebookId),
  notebookGenerateDocument: (payload: { notebookId: string; kind: "report" | "slides"; format: "docx" | "pdf" | "pptx"; prompt?: string; fileIds?: string[]; providerId?: string; model?: string }) => invoke("notebook:document:generate", payload),
  notebookDeleteDocument: (notebookId: string, docId: string) => invoke("notebook:document:delete", notebookId, docId),
  notebookDownloadDocument: (notebookId: string, docId: string) => invoke("notebook:document:download", notebookId, docId),
  notebookReadDocument: (notebookId: string, docId: string) => invoke("notebook:document:read", notebookId, docId),
  notebookQuizzes: (notebookId: string) => invoke("notebook:quizzes:list", notebookId),
  notebookGenerateQuiz: (payload: { notebookId: string; topic?: string; count?: number; quizType?: "mcq" | "truefalse" | "mixed"; fileIds?: string[]; providerId?: string; model?: string }) => invoke("notebook:quiz:generate", payload),
  notebookDeleteQuiz: (notebookId: string, quizId: string) => invoke("notebook:quiz:delete", notebookId, quizId),
  notebookFlashcards: (notebookId: string) => invoke("notebook:flashcards:list", notebookId),
  notebookGenerateFlashcards: (payload: { notebookId: string; topic?: string; count?: number; fileIds?: string[]; providerId?: string; model?: string }) => invoke("notebook:flashcards:generate", payload),
  notebookDeleteFlashcards: (notebookId: string, setId: string) => invoke("notebook:flashcards:delete", notebookId, setId),
  notebookMindmaps: (notebookId: string) => invoke("notebook:mindmaps:list", notebookId),
  notebookGenerateMindmap: (payload: { notebookId: string; topic?: string; maxNodes?: number; fileIds?: string[]; providerId?: string; model?: string }) => invoke("notebook:mindmaps:generate", payload),
  notebookDeleteMindmap: (notebookId: string, mapId: string) => invoke("notebook:mindmaps:delete", notebookId, mapId),
  notebookSummaries: (notebookId: string) => invoke("notebook:summaries:list", notebookId),
  notebookGenerateSummary: (payload: { notebookId: string; topic?: string; length?: "brief" | "standard" | "detailed"; fileIds?: string[]; providerId?: string; model?: string }) => invoke("notebook:summaries:generate", payload),
  notebookDeleteSummary: (notebookId: string, summaryId: string) => invoke("notebook:summaries:delete", notebookId, summaryId),
  notebookChats: (notebookId: string) => invoke("notebook:chats", notebookId),
  notebookCreateChat: (notebookId: string, title?: string) => invoke("notebook:createChat", notebookId, title),
  notebookDeleteChat: (notebookId: string, chatId: string) => invoke("notebook:deleteChat", notebookId, chatId),
  notebookRetrieve: (notebookId: string, query: string, topK?: number) => invoke("notebook:retrieve", notebookId, query, topK),
  notebookAsk: (payload: { notebookId: string; chatId: string; question: string; providerId?: string; model?: string; topK?: number }) => invoke("notebook:ask", payload),
  getNotebookEmbedding: () => invoke("notebook:embedding:get"),
  saveNotebookEmbedding: (config: { providerId: string; model: string }) => invoke("notebook:embedding:save", config),
  listEmbeddingProviders: () => invoke("notebook:embedding-providers:list"),
  saveEmbeddingProvider: (provider: unknown) => invoke("notebook:embedding-provider:save", provider),
  removeEmbeddingProvider: (providerId: string) => invoke("notebook:embedding-provider:remove", providerId),
  testEmbeddingProvider: (input: { id?: string; kind: string; baseUrl?: string; apiKey?: string; model: string }) => invoke("notebook:embedding-provider:test", input),

  runAgent: (payload: { request: string; images?: string[]; attachments?: Array<{ url: string; name: string; mimeType: string; size: number }>; providerId?: string; model?: string; mode?: string; sessionId?: string; projectId?: string }) => invoke("agent:run", payload),
  cancelAgent: (sessionId?: string) => invoke("agent:cancel", sessionId),
  resolveCommandApproval: (id: string, decision: "once" | "session" | "deny") => invoke("command:approval", { id, decision }),
  resolveUserQuestion: (id: string, answers?: Record<string, string> | null, cancelled?: boolean) => invoke("question:resolve", { id, answers, cancelled }),
  onUserQuestionRequest: (listener: (request: { id: string; sessionId: string; questions: Array<{ header: string; question: string; options: string[] }> }) => void) => {
    const handler = (_event: IpcRendererEvent, request: { id: string; sessionId: string; questions: Array<{ header: string; question: string; options: string[] }> }) => listener(request);
    ipcRenderer.on("question:request", handler);
    return () => ipcRenderer.removeListener("question:request", handler);
  },
  onCommandApprovalRequest: (listener: (request: { id: string; runId?: string; command: string; cwd: string; reason: string; approvalKey?: string; createdAt: string }) => void) => {
    const handler = (_event: IpcRendererEvent, request: { id: string; runId?: string; command: string; cwd: string; reason: string; approvalKey?: string; createdAt: string }) => listener(request);
    ipcRenderer.on("command:approval-request", handler);
    return () => ipcRenderer.removeListener("command:approval-request", handler);
  },
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  onNotebookJobProgress: (listener: (progress: { notebookId: string; sourceId: string; status: string; chunks?: number; error?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { notebookId: string; sourceId: string; status: string; chunks?: number; error?: string }) => listener(payload);
    ipcRenderer.on("notebook:progress", handler);
    return () => ipcRenderer.removeListener("notebook:progress", handler);
  },
};

contextBridge.exposeInMainWorld("nexus", nexusApi);
contextBridge.exposeInMainWorld("forgepilot", nexusApi);
