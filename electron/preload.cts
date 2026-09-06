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
  deleteSession: (projectId: string, sessionId: string) => invoke("session:delete", projectId, sessionId),
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
  getSkillsConfig: () => invoke("skills:config:get"),
  pickSkillFile: () => invoke("skills:pick-file"),
  pickSkillFolder: () => invoke("skills:pick-folder"),
  importSkill: (sourcePath: string, scope: "global" | "project") => invoke("skills:import", { sourcePath, scope }),
  saveSkillsConfig: (config: unknown) => invoke("skills:config:save", config),
  listSkills: () => invoke("skills:list"),
  readSkillContent: (skillPath: string) => invoke("skills:read", skillPath),
  createSkill: (input: unknown) => invoke("skills:create", input),
  deleteSkill: (skillPath: string) => invoke("skills:delete", skillPath),
  openSkillsFolder: (scope: "global" | "project") => invoke("skills:open-folder", scope),
  getSettings: () => invoke("settings:get"),
  saveSettings: (settings: unknown) => invoke("settings:save", settings),
  listWorkspace: () => invoke("workspace:list"),
  readFile: (file: string) => invoke("workspace:read", file),
  readHead: (file: string) => invoke("workspace:readHead", file),
  writeFile: (file: string, content: string) => invoke("workspace:write", file, content),
  saveAttachment: (data: string, filename?: string) => invoke("attachments:save", { data, filename }),
  getDiff: () => invoke("workspace:diff"),
  revertFile: (file: string) => invoke("workspace:revert-file", file),
  revertAll: () => invoke("workspace:revert-all"),
  restoreCheckpoint: (checkpointId: string) => invoke("checkpoint:restore", checkpointId),
  getGit: () => invoke("workspace:git"),
  runCommand: (command: string) => invoke("workspace:command", command),

  // Worktrees
  createWorktree: (sessionId: string) => invoke("worktree:create", sessionId),
  getWorktreeStatus: (sessionId: string) => invoke("worktree:status", sessionId),
  mergeWorktree: (sessionId: string, commitMessage?: string) => invoke("worktree:merge", sessionId, commitMessage),
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
  getDaemonLogs: (id: string) => invoke("daemons:logs", id),
  onDaemonLog: (listener: (payload: { id: string; data: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { id: string; data: string }) => listener(payload);
    ipcRenderer.on("daemon:log", handler);
    return () => ipcRenderer.removeListener("daemon:log", handler);
  },

  // Browser External Navigation
  openExternal: (url: string) => invoke("browser:openExternal", url),

  // Interactive Terminal
  createTerminal: (id: string, cwd?: string, cols?: number, rows?: number) => invoke("terminal:create", { id, cwd, cols, rows }),
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

  // Home (general assistant)
  getHome: () => invoke("home:get"),
  listHomeFiles: () => invoke("home:files"),
  listHomeSessionFiles: (sessionId: string) => invoke("home:sessionFiles", sessionId),
  readHomeFile: (relativePath: string) => invoke("home:readFile", relativePath),
  downloadHomeFile: (relativePath: string) => invoke("home:download", relativePath),
  openHomeFolder: () => invoke("home:openFolder"),

  runAgent: (payload: { request: string; images?: string[]; providerId?: string; model?: string; mode?: string }) => invoke("agent:run", payload),
  cancelAgent: () => invoke("agent:cancel"),
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
};

contextBridge.exposeInMainWorld("nexus", nexusApi);
contextBridge.exposeInMainWorld("forgepilot", nexusApi);
