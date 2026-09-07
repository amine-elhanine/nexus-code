/// <reference types="vite/client" />

type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number | null };
type SubagentRole = "researcher" | "tester" | "coder";
type SubagentStep = { toolName: string; summary?: string; timestamp: string };
type SubagentItem = { id: string; role: SubagentRole; task: string; status: "running" | "completed" | "failed"; steps: SubagentStep[]; output?: string; usage?: AgentUsage };
type ArtifactStatus = "draft" | "pending_approval" | "approved" | "completed" | "rejected";
type ArtifactItem = { id: string; sessionId: string; name: string; filename: string; path: string; content: string; status: ArtifactStatus; userFacing: boolean; requestFeedback: boolean; createdAt: string; updatedAt: string };
type AgentEvent = { type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact"; sessionId: string; text: string; timestamp: string; items?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem; detail?: string };
type ProviderDefinition = { id: string; label: string; packageName: string; envKey: string; defaultBaseUrl?: string; models: string[] };
type ProviderConfig = { id: string; label: string; provider: string; apiKey: string; baseUrl?: string; models: string[] };
type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; memory: string; checkpointId?: string; usage?: AgentUsage; messages: Array<{ role: "user" | "assistant" | "event"; text: string; images?: string[]; kind?: AgentEvent["type"]; createdAt: string; plan?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem }>; model?: { providerId: string; model: string } };
type ProjectRecord = { id: string; name: string; root: string; createdAt: string; updatedAt: string; memory: string; sessions: SessionRecord[] };
type ActiveContext = { project: ProjectRecord; session: SessionRecord | null } | null;
type WorkspaceDiffFile = { path: string; directory: string; name: string; additions: number; deletions: number; status: string; patch: string };
type McpTransport = "stdio" | "http" | "sse";
type McpServerConfig = { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
type McpTestResult = { ok: boolean; tools: string[]; error?: string };
type SkillInfo = { name: string; description: string; path: string; source: "global" | "project" };
type TrajectoryStep = { step_index: number; timestamp: string; source: string; type: string; content: string; thinking?: string; tool_calls?: Array<{ name: string; args: any }>; usage?: AgentUsage };

type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

export interface NexusApi {
  listProjects: () => Promise<ProjectRecord[]>;
  selectProject: () => Promise<{ project: ProjectRecord; session: SessionRecord } | null>;
  createProject: (name: string, root: string) => Promise<{ project: ProjectRecord; session: SessionRecord }>;
  activateProject: (id: string) => Promise<{ project: ProjectRecord; session: SessionRecord }>;
  deleteProject: (id: string) => Promise<ProjectRecord[]>;
  getActive: () => Promise<ActiveContext>;
  listSessions: (projectId: string) => Promise<SessionRecord[]>;
  createSession: (projectId: string, title?: string) => Promise<SessionRecord>;
  activateSession: (projectId: string, sessionId: string) => Promise<SessionRecord>;
  deleteSession: (projectId: string, sessionId: string) => Promise<ProjectRecord>;
  updateSession: (projectId: string, sessionId: string, patch: unknown) => Promise<SessionRecord>;
  updateProjectMemory: (projectId: string, memory: string) => Promise<ProjectRecord>;
  updateSessionMemory: (projectId: string, sessionId: string, memory: string) => Promise<SessionRecord>;
  listProviderDefinitions: () => Promise<ProviderDefinition[]>;
  listProviders: () => Promise<ProviderConfig[]>;
  saveProvider: (provider: unknown) => Promise<ProviderConfig[]>;
  removeProvider: (providerId: string) => Promise<ProviderConfig[]>;
  fetchProviderModels: (baseUrl: string, apiKey?: string) => Promise<string[]>;
  listMcpServers: () => Promise<McpServerConfig[]>;
  saveMcpServer: (server: Partial<McpServerConfig> & { name: string; transport: McpTransport }) => Promise<McpServerConfig[]>;
  removeMcpServer: (serverId: string) => Promise<McpServerConfig[]>;
  testMcpServer: (server: Partial<McpServerConfig>) => Promise<McpTestResult>;
  getSkillsConfig: () => Promise<{ enabled: boolean }>;
  pickSkillFile: () => Promise<string[]>;
  pickSkillFolder: () => Promise<string[]>;
  importSkill: (sourcePath: string, scope: "global" | "project") => Promise<SkillInfo | null>;
  saveSkillsConfig: (config: { enabled: boolean }) => Promise<{ enabled: boolean }>;
  listSkills: () => Promise<SkillInfo[]>;
  readSkillContent: (skillPath: string) => Promise<string>;
  createSkill: (input: { name: string; description?: string; scope: "global" | "project"; content?: string }) => Promise<SkillInfo>;
  deleteSkill: (skillPath: string) => Promise<void>;
  openSkillsFolder: (scope: "global" | "project") => Promise<boolean>;
  getSettings: () => Promise<Record<string, unknown>>;
  saveSettings: (settings: unknown) => Promise<unknown>;
  listWorkspace: () => Promise<string[]>;
  readFile: (file: string) => Promise<{ file: string; content: string; lines: number }>;
  readHead: (file: string) => Promise<string>;
  writeFile: (file: string, content: string) => Promise<{ file: string; content: string; lines: number }>;
  saveAttachment: (data: string, filename?: string) => Promise<{ fileName: string; filePath: string; url: string }>;
  getDiff: () => Promise<WorkspaceDiffFile[]>;
  revertFile: (file: string) => Promise<boolean>;
  revertAll: () => Promise<boolean>;
  restoreCheckpoint: (checkpointId: string) => Promise<boolean>;
  getGit: () => Promise<{ isRepository: boolean; branch: string; status: string[]; aheadBehind: string }>;
  runCommand: (command: string) => Promise<string>;

  // Worktrees
  createWorktree: (sessionId: string) => Promise<{ worktreePath: string; branch: string; isNew: boolean }>;
  getWorktreeStatus: (sessionId: string) => Promise<{ isGit: boolean; worktree: { worktreePath: string; branch: string } | null }>;
  mergeWorktree: (sessionId: string, commitMessage?: string) => Promise<{ success: boolean; mergedBranch: string; error?: string }>;
  discardWorktree: (sessionId: string) => Promise<boolean>;
  getWorktreeDiff: (sessionId: string) => Promise<WorkspaceDiffFile[]>;

  // Artifacts
  listArtifacts: (sessionId: string) => Promise<ArtifactItem[]>;
  getArtifact: (sessionId: string, filename: string) => Promise<ArtifactItem | null>;
  updateArtifactStatus: (sessionId: string, filename: string, status: ArtifactStatus) => Promise<ArtifactItem | null>;

  // Project Rules
  getProjectRules: (projectId: string) => Promise<{ hasRules: boolean; ruleFiles: Array<{ filename: string; relativePath: string; content: string; source: string }>; combinedPromptSection: string }>;

  // Custom Slash Commands
  listCustomCommands: () => Promise<Array<{ command: string; name: string; description: string; mode?: "plan" | "auto" | "ask"; promptTemplate: string; source: "builtin" | "project"; filePath?: string }>>;

  // Background Daemons & Services
  listDaemons: () => Promise<Array<{ id: string; name: string; command: string; cwd: string; status: "running" | "stopped" | "crashed"; pid?: number; port?: number; startTime: string; logsCount: number }>>;
  startDaemon: (name: string, command: string, cwd?: string) => Promise<{ id: string; name: string; command: string; cwd: string; status: "running" | "stopped" | "crashed"; pid?: number; port?: number; startTime: string; logsCount: number }>;
  stopDaemon: (id: string) => Promise<boolean>;
  restartDaemon: (id: string) => Promise<boolean>;
  getDaemonLogs: (id: string) => Promise<string[]>;
  onDaemonLog: (listener: (payload: { id: string; data: string }) => void) => () => void;

  // Browser External Navigation
  openExternal: (url: string) => Promise<boolean>;

  // Agent browser (headless toggle + activity from the agent's window)
  getBrowserHeadless: () => Promise<boolean>;
  setBrowserHeadless: (value: boolean) => Promise<boolean>;
  onBrowserAgentActivity: (listener: (payload: { url: string; timestamp: string; autoFollow?: boolean }) => void) => () => void;
  // Agent browser bridge: main asks the hidden in-app webview to act.
  onAgentBrowserRequest: (
    handler: (request: { id: string; kind: string; url?: string; js?: string; keyCode?: string }) => Promise<unknown>
  ) => () => void;

  // Interactive Terminal
  createTerminal: (id: string, cwd?: string, cols?: number, rows?: number) => Promise<boolean>;
  // In-app updates
  checkForUpdates: () => Promise<UpdaterState>;
  quitAndInstallUpdate: () => Promise<boolean>;
  getAppVersion: () => Promise<string>;
  onUpdaterStatus: (listener: (state: UpdaterState) => void) => () => void;
  writeTerminal: (id: string, data: string) => Promise<boolean>;
  killTerminal: (id: string) => Promise<boolean>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<boolean>;
  onTerminalData: (listener: (payload: { id: string; data: string }) => void) => () => void;

  // Trajectories
  getTrajectory: (sessionId: string) => Promise<TrajectoryStep[]>;

  // Window Controls
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;

  // Home (general assistant)
  getHome: () => Promise<{ project: ProjectRecord; root: string }>;
  listHomeFiles: () => Promise<Array<{ path: string; name: string; size: number; modified: string }>>;
  listHomeSessionFiles: (sessionId: string) => Promise<Array<{ path: string; name: string; size: number; modified: string }>>;
  readHomeFile: (relativePath: string) => Promise<{ name: string; path: string; size: number; base64: string }>;
  downloadHomeFile: (relativePath: string) => Promise<string | null>;
  openHomeFolder: () => Promise<void>;

  runAgent: (payload: { request: string; images?: string[]; providerId?: string; model?: string; mode?: string }) => Promise<string>;
  cancelAgent: (sessionId?: string) => Promise<boolean>;
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: any;
    }
  }
  interface Window {
    nexus: NexusApi;
    forgepilot: NexusApi;
  }
}
export {};
