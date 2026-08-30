import { promises as fs } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";

import type { SubagentItem } from "./subagent-service.js";

export type ProviderConfig = { id: string; label: string; provider: string; apiKey: string; baseUrl?: string; models: string[] };
export type SandboxConfig = { provider: "local"; enabled: boolean; requireApproval: boolean; allowNetwork: boolean; commandTimeoutSeconds: number };
export type McpTransport = "stdio" | "http" | "sse";
export type McpServerConfig = { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type SkillsConfig = { enabled: boolean };
export type ProjectSandboxState = { provider: "local"; mode: "workspace-permissions"; status: "ready" | "stopped" | "blocked"; path: string; lastSyncAt?: string };
export type ProjectRecord = { id: string; name: string; root: string; createdAt: string; updatedAt: string; memory: string; sessions: SessionRecord[]; sandbox?: ProjectSandboxState };
export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number };
export type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; memory: string; checkpointId?: string; usage?: AgentUsage; messages: Array<{ role: "user" | "assistant" | "event"; text: string; kind?: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent"; createdAt: string; plan?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; usage?: AgentUsage; subagent?: SubagentItem }>; model?: { providerId: string; model: string } };
type PersistedState = { projects: ProjectRecord[]; providers: ProviderConfig[]; sandbox?: SandboxConfig; mcpServers?: McpServerConfig[]; skills?: SkillsConfig };

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  provider: "local",
  enabled: true,
  requireApproval: false,
  allowNetwork: false,
  commandTimeoutSeconds: 120,
};

let cache: PersistedState | null = null;

function statePath() {
  const userData = app?.getPath ? app.getPath("userData") : path.join(process.env.APPDATA || process.cwd(), "nexus");
  return path.join(userData, "nexus-state.json");
}

function candidateStatePaths(): string[] {
  const userData = app?.getPath ? app.getPath("userData") : path.join(process.env.APPDATA || process.cwd(), "nexus");
  const parent = path.dirname(userData);
  return [
    path.join(userData, "nexus-state.json"),
    path.join(userData, "forgepilot-state.json"),
    path.join(parent, "nexus", "nexus-state.json"),
    path.join(parent, "nexus", "forgepilot-state.json"),
    path.join(parent, "forgepilot", "forgepilot-state.json"),
  ];
}

function uid(prefix: string) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

// API keys are encrypted at rest with the OS credential store (DPAPI on Windows,
// Keychain on macOS, libsecret/kwallet on Linux) and only ever decrypted in memory.
// Values without the prefix are legacy plaintext keys, transparently re-encrypted
// the next time anything is persisted.
const ENCRYPTED_PREFIX = "safeStorage:v1:";
function encryptSecret(value: string) {
  if (!value || value.startsWith(ENCRYPTED_PREFIX)) return value;
  try { if (safeStorage?.isEncryptionAvailable?.()) return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString("base64"); } catch { /* fall through to plaintext */ }
  return value;
}
function decryptSecret(value: string) {
  if (!value) return "";
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64"));
    }
  } catch {
    // If decryption fails across different machine/domain contexts, return empty or raw
  }
  return "";
}

export function calculateSessionUsage(messages: SessionRecord["messages"]): AgentUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  for (const message of messages || []) {
    if (message.usage) {
      inputTokens += message.usage.inputTokens || 0;
      outputTokens += message.usage.outputTokens || 0;
      totalTokens += message.usage.totalTokens || 0;
      estimatedCost += message.usage.estimatedCost || 0;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost: Number(estimatedCost.toFixed(4)),
  };
}

async function ensureLoaded(): Promise<PersistedState> {
  if (cache) return cache;

  const candidates = candidateStatePaths();
  let foundState: PersistedState | null = null;

  for (const target of candidates) {
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && (Array.isArray(parsed.projects) || Array.isArray(parsed.providers))) {
        foundState = parsed;
        break;
      }
    } catch {
      // try next
    }
  }

  if (foundState) {
    cache = foundState;
    cache.projects = cache.projects || [];
    cache.providers = cache.providers || [];
    cache.providers.forEach((provider) => {
      provider.apiKey = decryptSecret(provider.apiKey);
    });
    cache.projects.forEach((project) => {
      project.sessions = project.sessions || [];
      project.sessions.forEach((session) => {
        session.usage = calculateSessionUsage(session.messages);
      });
    });
  } else {
    cache = {
      projects: [],
      providers: [],
    };
  }

  // Always ensure sandbox is initialized and enabled by default
  if (!cache.sandbox || cache.sandbox.provider !== "local") {
    cache.sandbox = { ...DEFAULT_SANDBOX_CONFIG };
  }

  return cache;
}

async function persist() {
  if (!cache) return;
  const target = statePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const snapshot: PersistedState = {
    ...cache,
    sandbox: cache.sandbox && cache.sandbox.provider === "local" ? cache.sandbox : { ...DEFAULT_SANDBOX_CONFIG },
    providers: (cache.providers || []).map((provider) => ({ ...provider, apiKey: encryptSecret(provider.apiKey) })),
  };
  await fs.writeFile(target, JSON.stringify(snapshot, null, 2), "utf8");
}

export async function listProjects() { return (await ensureLoaded()).projects; }
export async function getProject(projectId: string) { return (await ensureLoaded()).projects.find((project) => project.id === projectId) ?? null; }
export async function upsertProject(input: { id?: string; name: string; root: string }) {
  const state = await ensureLoaded();
  const existing = input.id ? state.projects.find((project) => project.id === input.id) : state.projects.find((project) => path.resolve(project.root) === path.resolve(input.root));
  if (existing) {
    existing.name = input.name;
    existing.root = input.root;
    existing.updatedAt = new Date().toISOString();
    await persist();
    return existing;
  }
  const project: ProjectRecord = { id: uid("project"), name: input.name, root: input.root, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), memory: "", sessions: [] };
  state.projects.unshift(project);
  await persist();
  return project;
}
export async function updateProjectMemory(projectId: string, memory: string) { const project = await getProject(projectId); if (!project) throw new Error("Project not found"); project.memory = memory; project.updatedAt = new Date().toISOString(); await persist(); return project; }
export async function listSessions(projectId: string) {
  const project = await getProject(projectId);
  if (!project) return [];
  project.sessions.forEach((session) => {
    session.usage = calculateSessionUsage(session.messages);
  });
  return project.sessions;
}
export async function getSession(projectId: string, sessionId: string) {
  const session = (await getProject(projectId))?.sessions.find((s) => s.id === sessionId) ?? null;
  if (session) {
    session.usage = calculateSessionUsage(session.messages);
  }
  return session;
}
export async function createSession(projectId: string, title = "New coding task") {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const session: SessionRecord = { id: uid("session"), title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), memory: "", messages: [] };
  project.sessions.unshift(session);
  project.updatedAt = new Date().toISOString();
  await persist();
  return session;
}
export async function updateSession(projectId: string, sessionId: string, patch: Partial<Pick<SessionRecord, "title" | "memory" | "model" | "messages" | "usage" | "checkpointId">>) {
  const session = await getSession(projectId, sessionId);
  if (!session) throw new Error("Session not found");
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  if (patch.messages || !session.usage) {
    session.usage = calculateSessionUsage(session.messages);
  }
  await persist();
  return session;
}
export async function appendSessionMessage(projectId: string, sessionId: string, message: SessionRecord["messages"][number]) {
  const session = await getSession(projectId, sessionId);
  if (!session) throw new Error("Session not found");
  session.messages.push(message);
  session.usage = calculateSessionUsage(session.messages);
  session.updatedAt = new Date().toISOString();
  await persist();
  return session;
}
export async function listProviders() { return (await ensureLoaded()).providers; }
export async function upsertProvider(input: Omit<ProviderConfig, "id"> & { id?: string }) {
  const state = await ensureLoaded();
  const existing = input.id ? state.providers.find((provider) => provider.id === input.id) : undefined;
  if (existing) Object.assign(existing, input);
  else state.providers.push({ ...input, id: uid("provider") });
  await persist();
  return state.providers;
}
export async function removeProvider(providerId: string) {
  const state = await ensureLoaded();
  state.providers = state.providers.filter((provider) => provider.id !== providerId);
  for (const project of state.projects) {
    for (const session of project.sessions) {
      if (session.model?.providerId === providerId) delete session.model;
    }
  }
  await persist();
  return state.providers;
}
export async function deleteSession(projectId: string, sessionId: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  project.sessions = project.sessions.filter((session) => session.id !== sessionId);
  project.updatedAt = new Date().toISOString();
  await persist();
  return project;
}
export async function deleteProject(projectId: string) {
  const state = await ensureLoaded();
  state.projects = state.projects.filter((project) => project.id !== projectId);
  await persist();
  return state.projects;
}

export async function getSandboxConfig(): Promise<SandboxConfig> {
  const state = await ensureLoaded();
  if (!state.sandbox || state.sandbox.provider !== "local") {
    state.sandbox = { ...DEFAULT_SANDBOX_CONFIG };
    await persist();
  }
  return state.sandbox;
}

export async function saveSandboxConfig(input: Partial<SandboxConfig>): Promise<SandboxConfig> {
  const state = await ensureLoaded();
  state.sandbox = {
    provider: "local",
    enabled: input.enabled !== false,
    requireApproval: Boolean(input.requireApproval),
    allowNetwork: Boolean(input.allowNetwork),
    commandTimeoutSeconds: Math.max(10, input.commandTimeoutSeconds || 120),
  };
  await persist();
  return state.sandbox;
}

export async function updateProjectSandbox(projectId: string, sandbox: ProjectSandboxState | undefined) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  project.sandbox = sandbox;
  project.updatedAt = new Date().toISOString();
  await persist();
  return project;
}

export async function listMcpServers() { return (await ensureLoaded()).mcpServers ?? []; }
export async function upsertMcpServer(input: Omit<McpServerConfig, "id"> & { id?: string }) {
  const state = await ensureLoaded();
  const config: McpServerConfig = {
    id: input.id || uid("mcp"),
    name: input.name.trim() || "MCP server",
    enabled: input.enabled !== false,
    transport: input.transport === "http" || input.transport === "sse" ? input.transport : "stdio",
    command: input.transport === "stdio" ? input.command?.trim() || "" : undefined,
    args: input.transport === "stdio" ? (input.args ?? []).map((arg) => arg.trim()).filter(Boolean) : undefined,
    env: input.transport === "stdio" ? Object.fromEntries(Object.entries(input.env ?? {}).filter(([key, value]) => key.trim() && value.trim()).map(([key, value]) => [key.trim(), value.trim()])) : undefined,
    url: input.transport !== "stdio" ? input.url?.trim() || "" : undefined,
    headers: input.transport !== "stdio" ? Object.fromEntries(Object.entries(input.headers ?? {}).filter(([key, value]) => key.trim() && value.trim()).map(([key, value]) => [key.trim(), value.trim()])) : undefined,
  };
  if (config.transport === "stdio" && !config.command) throw new Error("Stdio MCP servers need a command to launch.");
  if (config.transport !== "stdio" && !/^https?:\/\//i.test(config.url || "")) throw new Error("Remote MCP servers need a valid http(s) URL.");
  state.mcpServers = (state.mcpServers ?? []).filter((server) => server.id !== config.id);
  state.mcpServers.push(config);
  await persist();
  invalidateMcpClientCache();
  return state.mcpServers;
}
export async function removeMcpServer(serverId: string) {
  const state = await ensureLoaded();
  state.mcpServers = (state.mcpServers ?? []).filter((server) => server.id !== serverId);
  await persist();
  invalidateMcpClientCache();
  return state.mcpServers;
}
export async function getSkillsConfig(): Promise<SkillsConfig> { return { enabled: (await ensureLoaded()).skills?.enabled !== false }; }
export async function saveSkillsConfig(input: SkillsConfig) { const state = await ensureLoaded(); state.skills = { enabled: input.enabled !== false }; await persist(); return state.skills; }

// Declared here so store mutations can drop the cached MCP client when server
// config changes; the implementation lives in mcp-service.ts to avoid a cycle.
let mcpCacheInvalidator: (() => void) | null = null;
export function onMcpConfigChanged(invalidate: () => void) { mcpCacheInvalidator = invalidate; }
function invalidateMcpClientCache() { mcpCacheInvalidator?.(); }
