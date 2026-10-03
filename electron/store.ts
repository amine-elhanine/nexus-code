import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Lazy Electron access (plain-node safe for unit tests): under node,
// require("electron") resolves to the binary path string, so all property
// access falls back gracefully. Under Electron this returns the full API.
const electronRequire = createRequire(import.meta.url);
type ElectronShim = {
  app?: { getPath: (name: string) => string };
  safeStorage?: { isEncryptionAvailable?: () => boolean; encryptString: (value: string) => Buffer; decryptString: (buffer: Buffer) => string };
};
function electronMod(): ElectronShim {
  try {
    const mod = electronRequire("electron") as unknown;
    if (mod && typeof mod === "object") return mod as ElectronShim;
    return {};
  } catch {
    return {};
  }
}

import type { SubagentItem } from "./subagent-service.js";

export type ProviderConfig = { id: string; label: string; provider: string; apiKey: string; baseUrl?: string; models: string[]; modelEndpoints?: Partial<Record<string, ChatEndpointKind>>; /** Set at load when the stored ciphertext could not be decrypted on this machine. Never persisted. */ keyNeedsReentry?: boolean };
// Wire protocol a model speaks. Providers default to chat completions,
// except Anthropic-native which defaults to messages. A per-model entry
// overrides the default — e.g. gateways like OpenCode Zen serve different
// models on /chat/completions, /responses and /messages behind one key.
export type ChatEndpointKind = "chat" | "responses" | "messages";
// Standalone embedding endpoints for Notebook RAG, independent of chat
// providers: each has its own base URL, API key and embedding model list.
export type EmbeddingEndpointKind = "openai" | "ollama" | "gemini" | "cohere";
export type EmbeddingProviderConfig = { id: string; name: string; kind: EmbeddingEndpointKind; baseUrl?: string; apiKey: string; models: string[] };
export type McpTransport = "stdio" | "http" | "sse";
export type McpServerConfig = { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type SkillsConfig = { enabled: boolean };
export type HooksConfig = { enabled: boolean };
export type AppSettings = {
  browserHeadless?: boolean;
  /** Opt-in edit approval for Code runs: "ask" gates every file mutation behind the approval UI. */
  editPolicy?: "auto" | "ask";
  notebookRerankEnabled?: boolean;
  notebookRerankProviderId?: string;
  notebookRerankModel?: string;
  notebookVisionEnabled?: boolean;
  notebookVisionProviderId?: string;
  notebookVisionModel?: string;
  theme?: string;
};
export type NotebookParserConfig = {
  provider: "local" | "llamaparse";
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  tier: "fast" | "cost_effective" | "agentic" | "agentic_plus";
  version: string;
  timeoutSeconds: number;
};
export type ProjectRecord = { id: string; name: string; root: string; createdAt: string; updatedAt: string; memory: string; sessions: SessionRecord[] };
export type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number | null };
export type ChatAttachment = { url: string; name: string; mimeType: string; size: number };
export type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; memory: string; checkpointId?: string; checkpointIds?: string[]; usage?: AgentUsage; messages: Array<{ role: "user" | "assistant" | "event"; text: string; images?: string[]; attachments?: ChatAttachment[]; kind?: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact" | "stream-reset"; createdAt: string; plan?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; usage?: AgentUsage; subagent?: SubagentItem; artifact?: unknown; detail?: string }>; model?: { providerId: string; model: string } };
type PersistedState = { projects: ProjectRecord[]; providers: ProviderConfig[]; embeddingProviders?: EmbeddingProviderConfig[]; mcpServers?: McpServerConfig[]; skills?: SkillsConfig; hooks?: HooksConfig; appSettings?: AppSettings; notebookParser?: NotebookParserConfig; homeSessions?: SessionRecord[]; homeMemory?: string };

let cache: PersistedState | null = null;

function statePath() {
  const app = electronMod().app;
  const userData = app?.getPath ? app.getPath("userData") : path.join(process.env.APPDATA || process.cwd(), "nexus");
  return path.join(userData, "nexus-state.json");
}

function candidateStatePaths(): string[] {
  const app = electronMod().app;
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
// Values that could not be decrypted on this machine keep their original
// ciphertext on disk (keyed by track id) instead of being overwritten with ""
// by the next persist — the key stays recoverable on the machine that
// encrypted it, and the entry is replaced as soon as the user re-enters one.
const failedCiphertext = new Map<string, string>();
/** Drop preserved ciphertexts (called when the user re-enters a secret). */
function clearFailedSecrets(prefix: string) {
  for (const key of [...failedCiphertext.keys()]) {
    if (key.startsWith(prefix)) failedCiphertext.delete(key);
  }
}
const SECRET_MASK = "********";
/**
 * True when a secret coming from the renderer is the display mask rather than
 * a real value — i.e. "keep whatever is stored". The mask check is deliberately
 * loose: the UI round-trips the exact SECRET_MASK, but a stray keystroke in the
 * pre-filled password field ("********x", "*******") must never be stored as
 * if it were a freshly entered key, silently destroying the real one.
 */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("***");
}
function encryptSecret(value: string) {
  if (!value || value.startsWith(ENCRYPTED_PREFIX)) return value;
  try { const ss = electronMod().safeStorage; if (ss?.isEncryptionAvailable?.()) return ENCRYPTED_PREFIX + ss.encryptString(value).toString("base64"); } catch { /* fall through to plaintext */ }
  return value;
}
function decryptSecret(value: string, trackKey?: string) {
  if (!value) { lastDecryptFailed = false; return ""; }
  if (!value.startsWith(ENCRYPTED_PREFIX)) { lastDecryptFailed = false; return value; }
  lastDecryptFailed = false;
  try {
    const ss = electronMod().safeStorage;
    if (ss?.isEncryptionAvailable?.()) {
      return ss.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64"));
    }
  } catch {
    // Encrypted on a different machine/domain/user profile — the key is
    // unrecoverable here. Log loudly instead of failing silently so the user
    // knows to re-enter the key, and keep the ciphertext so a persist on this
    // machine cannot destroy it.
    if (trackKey) failedCiphertext.set(trackKey, value);
    lastDecryptFailed = true;
    console.warn("[nexus] An API key could not be decrypted on this machine (it was encrypted elsewhere). Re-enter it in the relevant settings.");
  }
  return "";
}
// Set by the most recent decryptSecret call: lets callers mark the record the
// failed key belonged to (single-threaded, read immediately after the call).
let lastDecryptFailed = false;

export function calculateSessionUsage(messages: SessionRecord["messages"]): AgentUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costKnown = true;
  let estimatedCost = 0;
  for (const message of messages || []) {
    if (message.usage && message.role === "assistant") {
      inputTokens += message.usage.inputTokens || 0;
      outputTokens += message.usage.outputTokens || 0;
      totalTokens += message.usage.totalTokens || 0;
      if (message.usage.estimatedCost == null) costKnown = false;
      else estimatedCost += message.usage.estimatedCost;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost: costKnown ? Number(estimatedCost.toFixed(4)) : null,
  };
}

export function sortSessionsInPlace(sessions: SessionRecord[]): SessionRecord[] {
  return sessions.sort((a, b) => {
    const tA = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tB = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tB - tA;
  });
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
    cache.embeddingProviders = cache.embeddingProviders || [];
    cache.homeSessions = cache.homeSessions || [];
    cache.providers.forEach((provider) => {
      delete provider.keyNeedsReentry;
      provider.apiKey = decryptSecret(provider.apiKey, `provider:${provider.id}`);
      if (lastDecryptFailed) provider.keyNeedsReentry = true;
    });
    cache.embeddingProviders.forEach((provider) => {
      provider.apiKey = decryptSecret(provider.apiKey, `emb:${provider.id}`);
    });
    if (cache.notebookParser) cache.notebookParser.apiKey = decryptSecret(cache.notebookParser.apiKey, "parser");
    // MCP credentials (env vars, auth headers) are encrypted at rest too —
    // headers routinely carry `Authorization: Bearer …`.
    (cache.mcpServers || []).forEach((server) => {
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          server.env[key] = decryptSecret(value, `mcp:${server.id}:env:${key}`);
        }
      }
      if (server.headers) {
        for (const [key, value] of Object.entries(server.headers)) {
          server.headers[key] = decryptSecret(value, `mcp:${server.id}:headers:${key}`);
        }
      }
    });
    cache.projects.forEach((project) => {
      project.sessions = project.sessions || [];
      sortSessionsInPlace(project.sessions);
      project.sessions.forEach((session) => {
        session.usage = calculateSessionUsage(session.messages);
      });
    });

    // Migrate any legacy pseudo-project "home" to isolated homeSessions
    const legacyHomeIdx = cache.projects.findIndex((project) => project.id === "home");
    if (legacyHomeIdx !== -1) {
      const legacyHome = cache.projects[legacyHomeIdx];
      if (legacyHome.sessions?.length) {
        const existingIds = new Set(cache.homeSessions.map((s) => s.id));
        for (const session of legacyHome.sessions) {
          if (!existingIds.has(session.id)) {
            cache.homeSessions.push(session);
          }
        }
      }
      cache.projects.splice(legacyHomeIdx, 1);
    }
    sortSessionsInPlace(cache.homeSessions);
    cache.homeSessions.forEach((session) => {
      session.usage = calculateSessionUsage(session.messages);
    });
  } else {
    cache = {
      projects: [],
      providers: [],
      embeddingProviders: [],
      homeSessions: [],
    };
  }

  return cache;
}

async function persist() {
  if (!cache) return;
  // Serialize writes: two concurrent mutations snapshot at different times,
  // and without a mutex the older snapshot could land last and lose data.
  const run = persistQueue.then(() => doPersist());
  persistQueue = run.then(() => undefined, () => undefined);
  await run;
}
let persistQueue: Promise<void> = Promise.resolve();

async function doPersist() {
  if (!cache) return;
  const target = statePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  cache.projects.forEach((p) => {
    if (p.sessions) sortSessionsInPlace(p.sessions);
  });
  if (cache.homeSessions) {
    sortSessionsInPlace(cache.homeSessions);
  }
  const keepOrEncrypt = (value: string, trackKey: string) => failedCiphertext.get(trackKey) ?? encryptSecret(value);
  const snapshot: PersistedState = {
    ...cache,
    providers: (cache.providers || []).map((provider) => ({ ...provider, apiKey: keepOrEncrypt(provider.apiKey, `provider:${provider.id}`), keyNeedsReentry: undefined })),
    embeddingProviders: (cache.embeddingProviders || []).map((provider) => ({ ...provider, apiKey: keepOrEncrypt(provider.apiKey, `emb:${provider.id}`) })),
    notebookParser: cache.notebookParser ? { ...cache.notebookParser, apiKey: keepOrEncrypt(cache.notebookParser.apiKey, "parser") } : undefined,
    mcpServers: (cache.mcpServers || []).map((server) => ({
      ...server,
      env: server.env
        ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, keepOrEncrypt(value, `mcp:${server.id}:env:${key}`)]))
        : undefined,
      headers: server.headers
        ? Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, keepOrEncrypt(value, `mcp:${server.id}:headers:${key}`)]))
        : undefined,
    })),
  };
  // Never overwrite the live state file in place. A process termination or
  // power loss during writeFile could otherwise leave valid-looking but
  // truncated JSON and discard every project/session on the next launch.
  const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    try { await fs.unlink(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

export async function listProjects() { return (await ensureLoaded()).projects; }
export async function getProject(projectId: string) {
  const project = (await ensureLoaded()).projects.find((project) => project.id === projectId) ?? null;
  if (project?.sessions) {
    sortSessionsInPlace(project.sessions);
  }
  return project;
}
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

// The Home area is a built-in project with a FIXED id so the renderer can
// tell home sessions apart from coding sessions. Created on demand pointing
// at the Home folder; never duplicated.
export async function ensureHomeProject(homeId: string, name: string, root: string) {
  const state = await ensureLoaded();
  const existing = state.projects.find((project) => project.id === homeId);
  if (existing) {
    existing.root = root;
    existing.updatedAt = new Date().toISOString();
    if (existing.sessions) sortSessionsInPlace(existing.sessions);
    await persist();
    return existing;
  }
  const project: ProjectRecord = { id: homeId, name, root, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), memory: "", sessions: [] };
  state.projects.unshift(project);
  await persist();
  return project;
}
export async function listSessions(projectId: string) {
  const project = await getProject(projectId);
  if (!project) return [];
  sortSessionsInPlace(project.sessions);
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
  sortSessionsInPlace(project.sessions);
  project.updatedAt = new Date().toISOString();
  await persist();
  return session;
}
export async function updateSession(projectId: string, sessionId: string, patch: Partial<Pick<SessionRecord, "title" | "memory" | "model" | "messages" | "usage" | "checkpointId" | "checkpointIds">>) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const session = project.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Session not found");
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  if (patch.messages || !session.usage) {
    session.usage = calculateSessionUsage(session.messages);
  }
  sortSessionsInPlace(project.sessions);
  project.updatedAt = new Date().toISOString();
  await persist();
  return session;
}
export async function appendSessionMessage(projectId: string, sessionId: string, message: SessionRecord["messages"][number]) {
  return appendSessionMessages(projectId, sessionId, [message]);
}
export async function appendSessionMessages(projectId: string, sessionId: string, messages: SessionRecord["messages"]): Promise<SessionRecord> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const session = project.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Session not found");
  session.messages.push(...messages);
  session.usage = calculateSessionUsage(session.messages);
  session.updatedAt = new Date().toISOString();
  sortSessionsInPlace(project.sessions);
  project.updatedAt = new Date().toISOString();
  await persist();
  return session;
}

// ---------------------------------------------------------------------------
// Dedicated Home Mode Session Storage (Isolated from Code projects)
// ---------------------------------------------------------------------------
export async function listHomeSessions(): Promise<SessionRecord[]> {
  const state = await ensureLoaded();
  state.homeSessions = state.homeSessions || [];
  sortSessionsInPlace(state.homeSessions);
  state.homeSessions.forEach((session) => {
    session.usage = calculateSessionUsage(session.messages);
  });
  return state.homeSessions;
}

export async function getHomeSession(sessionId: string): Promise<SessionRecord | null> {
  const state = await ensureLoaded();
  const session = (state.homeSessions || []).find((s) => s.id === sessionId) ?? null;
  if (session) {
    session.usage = calculateSessionUsage(session.messages);
  }
  return session;
}

export async function createHomeSession(title = "New chat"): Promise<SessionRecord> {
  const state = await ensureLoaded();
  state.homeSessions = state.homeSessions || [];
  const session: SessionRecord = {
    id: uid("homesess"),
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    memory: "",
    messages: [],
  };
  state.homeSessions.unshift(session);
  sortSessionsInPlace(state.homeSessions);
  await persist();
  return session;
}

export async function updateHomeSession(
  sessionId: string,
  patch: Partial<Pick<SessionRecord, "title" | "memory" | "model" | "messages" | "usage" | "checkpointId" | "checkpointIds">>
): Promise<SessionRecord> {
  const state = await ensureLoaded();
  state.homeSessions = state.homeSessions || [];
  const session = state.homeSessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Home session not found");
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  if (patch.messages || !session.usage) {
    session.usage = calculateSessionUsage(session.messages);
  }
  sortSessionsInPlace(state.homeSessions);
  await persist();
  return session;
}

export async function appendHomeSessionMessages(
  sessionId: string,
  messages: SessionRecord["messages"]
): Promise<SessionRecord> {
  const state = await ensureLoaded();
  state.homeSessions = state.homeSessions || [];
  const session = state.homeSessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Home session not found");
  session.messages.push(...messages);
  session.usage = calculateSessionUsage(session.messages);
  session.updatedAt = new Date().toISOString();
  sortSessionsInPlace(state.homeSessions);
  await persist();
  return session;
}

export async function deleteHomeSession(sessionId: string): Promise<boolean> {
  const state = await ensureLoaded();
  state.homeSessions = (state.homeSessions || []).filter((s) => s.id !== sessionId);
  await persist();
  return true;
}
// Shared Home memory: ChatGPT-style long-term memory across all Home chats.
// Session memory stays per-chat; this is the cross-chat layer injected as
// "Project memory" into the Home system prompt.
export async function getHomeMemory(): Promise<string> {
  const state = await ensureLoaded();
  return state.homeMemory || "";
}
export async function updateHomeMemory(memory: string): Promise<string> {
  const state = await ensureLoaded();
  state.homeMemory = memory;
  await persist();
  return state.homeMemory;
}
// Home memory is shared by every Home chat, and chats can run in parallel.
// Every mutation therefore goes through one serialized queue AND re-reads the
// current memory inside it — a run-start snapshot wholesale-replaced here
// would silently erase the facts a parallel chat just saved. The callback
// returns the full new memory, which is persisted before the queue moves on;
// without the save below, tool-driven "remember"/"forget" and deliverable
// recording only mutated a throwaway string.
let homeMemoryQueue: Promise<unknown> = Promise.resolve();
export function mutateHomeMemory(mutate: (current: string) => string): Promise<string> {
  const run = homeMemoryQueue.then(async () => {
    const current = await getHomeMemory();
    const next = mutate(current);
    if (next !== current) await updateHomeMemory(next);
    return next;
  });
  homeMemoryQueue = run.then(() => undefined, () => undefined);
  return run;
}
export async function listProviders() { return (await ensureLoaded()).providers; }
export async function upsertProvider(input: Omit<ProviderConfig, "id"> & { id?: string }) {
  const state = await ensureLoaded();
  const existing = input.id ? state.providers.find((provider) => provider.id === input.id) : undefined;
  let id: string;
  if (existing) {
    Object.assign(existing, input);
    id = existing.id;
  } else {
    const created = { ...input, id: uid("provider") };
    state.providers.push(created);
    id = created.id;
  }
  if (input.apiKey && input.apiKey !== SECRET_MASK) clearFailedSecrets(`provider:${id}`);
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

const EMBEDDING_KINDS: EmbeddingEndpointKind[] = ["openai", "ollama", "gemini", "cohere"];

export async function listEmbeddingProviders() { return (await ensureLoaded()).embeddingProviders ?? []; }
export async function upsertEmbeddingProvider(input: Omit<EmbeddingProviderConfig, "id"> & { id?: string }) {
  const state = await ensureLoaded();
  const kind: EmbeddingEndpointKind = EMBEDDING_KINDS.includes(input.kind) ? input.kind : "openai";
  const name = input.name.trim() || "Embedding endpoint";
  if (!name) throw new Error("Embedding providers need a name.");
  const models = Array.from(new Set((input.models || []).map((m) => m.trim()).filter(Boolean)));
  const existing = input.id ? (state.embeddingProviders ?? []).find((p) => p.id === input.id) : undefined;
  if (existing) {
    existing.name = name;
    existing.kind = kind;
    existing.baseUrl = input.baseUrl?.trim() || undefined;
    existing.apiKey = input.apiKey || "";
    existing.models = models;
  } else {
    state.embeddingProviders = state.embeddingProviders ?? [];
    state.embeddingProviders.push({ id: uid("embprovider"), name, kind, baseUrl: input.baseUrl?.trim() || undefined, apiKey: input.apiKey || "", models });
  }
  await persist();
  return state.embeddingProviders ?? [];
}
export async function removeEmbeddingProvider(providerId: string) {
  const state = await ensureLoaded();
  state.embeddingProviders = (state.embeddingProviders ?? []).filter((provider) => provider.id !== providerId);
  await persist();
  return state.embeddingProviders ?? [];
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

export async function listMcpServers() { return (await ensureLoaded()).mcpServers ?? []; }
/** Renderer-facing view: env/header secrets are masked like provider keys. */
export async function listMcpServersMasked() {
  return (await ensureLoaded()).mcpServers?.map((server) => ({
    ...server,
    env: server.env ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, value ? SECRET_MASK : ""])) : undefined,
    headers: server.headers ? Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, value ? SECRET_MASK : ""])) : undefined,
  })) ?? [];
}
export async function upsertMcpServer(input: Omit<McpServerConfig, "id"> & { id?: string }) {
  const state = await ensureLoaded();
  const existing = input.id ? (state.mcpServers ?? []).find((server) => server.id === input.id) : undefined;
  // The settings UI round-trips masked values; a mask means "keep what is
  // stored" for that env var / header, exactly like provider API keys.
  const resolveMasked = (value: string, oldValue?: string) => (value === SECRET_MASK && oldValue !== undefined ? oldValue : value);
  const config: McpServerConfig = {
    id: input.id || uid("mcp"),
    name: input.name.trim() || "MCP server",
    enabled: input.enabled !== false,
    transport: input.transport === "http" || input.transport === "sse" ? input.transport : "stdio",
    command: input.transport === "stdio" ? input.command?.trim() || "" : undefined,
    args: input.transport === "stdio" ? (input.args ?? []).map((arg) => arg.trim()).filter(Boolean) : undefined,
    env: input.transport === "stdio"
      ? Object.fromEntries(Object.entries(input.env ?? {}).filter(([key, value]) => key.trim() && value.trim()).map(([key, value]) => [key.trim(), resolveMasked(value.trim(), existing?.env?.[key.trim()])]))
      : undefined,
    url: input.transport !== "stdio" ? input.url?.trim() || "" : undefined,
    headers: input.transport !== "stdio"
      ? Object.fromEntries(Object.entries(input.headers ?? {}).filter(([key, value]) => key.trim() && value.trim()).map(([key, value]) => [key.trim(), resolveMasked(value.trim(), existing?.headers?.[key.trim()])]))
      : undefined,
  };
  if (config.transport === "stdio" && !config.command) throw new Error("Stdio MCP servers need a command to launch.");
  if (config.transport !== "stdio" && !/^https?:\/\//i.test(config.url || "")) throw new Error("Remote MCP servers need a valid http(s) URL.");
  state.mcpServers = (state.mcpServers ?? []).filter((server) => server.id !== config.id);
  state.mcpServers.push(config);
  clearFailedSecrets(`mcp:${config.id}:`);
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
export async function getHooksConfig(): Promise<HooksConfig> { return { enabled: (await ensureLoaded()).hooks?.enabled !== false }; }
export async function saveHooksConfig(input: HooksConfig) { const state = await ensureLoaded(); state.hooks = { enabled: input.enabled !== false }; await persist(); return state.hooks; }
export async function getAppSettings(): Promise<AppSettings> { return { ...(await ensureLoaded()).appSettings }; }
export async function saveAppSettings(input: AppSettings) { const state = await ensureLoaded(); state.appSettings = { ...state.appSettings, ...input }; await persist(); return state.appSettings; }
export async function getNotebookParserConfig(): Promise<NotebookParserConfig> {
  const configured = (await ensureLoaded()).notebookParser;
  return {
    provider: configured?.provider === "llamaparse" ? "llamaparse" : "local",
    enabled: configured?.enabled === true,
    apiKey: configured?.apiKey || "",
    baseUrl: configured?.baseUrl || "https://api.cloud.llamaindex.ai",
    tier: configured?.tier || "cost_effective",
    version: configured?.version || "latest",
    timeoutSeconds: Math.max(30, configured?.timeoutSeconds || 600),
  };
}
export async function saveNotebookParserConfig(input: Partial<NotebookParserConfig>) {
  const state = await ensureLoaded();
  const current = await getNotebookParserConfig();
  state.notebookParser = {
    ...current,
    ...input,
    provider: input.provider === "llamaparse" ? "llamaparse" : input.provider === "local" ? "local" : current.provider,
    tier: input.tier || current.tier,
    baseUrl: (input.baseUrl || current.baseUrl).trim().replace(/\/+$/, ""),
    version: (input.version || current.version).trim() || "latest",
    timeoutSeconds: Math.max(30, Math.min(3600, Number(input.timeoutSeconds || current.timeoutSeconds) || 600)),
    apiKey: input.apiKey ?? current.apiKey,
  };
  if (state.notebookParser.apiKey && state.notebookParser.apiKey !== SECRET_MASK) clearFailedSecrets("parser");
  await persist();
  return state.notebookParser;
}

// Declared here so store mutations can drop the cached MCP client when server
// config changes; the implementation lives in mcp-service.ts to avoid a cycle.
let mcpCacheInvalidator: (() => void) | null = null;
export function onMcpConfigChanged(invalidate: () => void) { mcpCacheInvalidator = invalidate; }
function invalidateMcpClientCache() { mcpCacheInvalidator?.(); }
