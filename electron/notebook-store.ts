import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { validateUpload } from "./notebook-text.js";
import { writeFileAtomic, withFileLock } from "./atomic-write.js";

// Lazy Electron access: under plain node (unit tests) require("electron")
// resolves to the binary path string, so property access safely falls back
// to cwd-relative storage. Under Electron this returns the full API.
const electronRequire = createRequire(import.meta.url);
function electronApi(): { app?: { getPath: (name: string) => string }; dialog?: { showOpenDialog: (opts: unknown) => Promise<{ canceled: boolean; filePaths: string[] }> } } {
  try {
    const mod = electronRequire("electron") as unknown;
    if (mod && typeof mod === "object") return mod as never;
    return {};
  } catch {
    return {};
  }
}
function electronApp() {
  return electronApi().app;
}

export type NotebookMeta = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type NotebookSettings = {
  instructions: string;
  updatedAt: string;
};

export type NotebookNote = {
  id: string;
  notebookId: string;
  title: string;
  content: string;
  citations: NotebookSourceCitation[];
  createdAt: string;
  updatedAt: string;
};

/** Ingestion status machine: uploaded → parsing → chunking → indexing → ready | failed. */
export type NotebookSourceStatus = "uploaded" | "parsing" | "chunking" | "indexing" | "ready" | "failed";

export type NotebookSource = {
  id: string;
  notebookId: string;
  filename: string;
  size: number;
  chars: number;
  chunks: number;
  status: NotebookSourceStatus;
  parser?: string;
  fingerprint?: string;
  pageCount?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type NotebookSourceCitation = {
  index: number;
  sourceId: string;
  sourceName: string;
  chunkId: string;
  heading: string;
  excerpt: string;
  snippet: string;
  score: number;
  /** False only for position-based fallback links (generators), which may not
   *  actually support the claim. Real retrieval citations omit the flag. */
  verified?: boolean;
};

export type NotebookAgentStep = {
  id: string;
  name: string;
  title: string;
  detail?: string;
  status: "running" | "completed" | "failed";
};

export type NotebookChatMessage = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  citations?: NotebookSourceCitation[];
  evaluation?: { citationCoverage: number; verdict: "grounded" | "partial" | "ungrounded"; issues: string[] };
  retrieval?: Array<{ chunkId: string; sourceName: string; score: number; methods: string[] }>;
  metadata?: { routing?: string; topScore?: number; refused?: boolean; fallbackModel?: boolean };
  steps?: NotebookAgentStep[];
};

export type NotebookChat = {
  id: string;
  notebookId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: NotebookChatMessage[];
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function notebooksRoot(): string {
  const app = electronApp();
  const base = app?.getPath ? app.getPath("userData") : path.join(process.cwd(), ".nexus-data");
  return path.join(base, "notebooks");
}

function metaPath() {
  return path.join(notebooksRoot(), "notebooks.json");
}
function nbDir(notebookId: string) {
  return path.join(notebooksRoot(), notebookId);
}
function sourcesPath(notebookId: string) {
  return path.join(nbDir(notebookId), "sources.json");
}
function chatsPath(notebookId: string) {
  return path.join(nbDir(notebookId), "chats.json");
}
function settingsPath(notebookId: string) {
  return path.join(nbDir(notebookId), "settings.json");
}
function notesPath(notebookId: string) {
  return path.join(nbDir(notebookId), "notes.json");
}
function rawDir(notebookId: string) {
  return path.join(nbDir(notebookId), "sources");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function writeJson(file: string, value: unknown) {
  // Atomic (temp + rename) and serialized per file: a crash mid-write must
  // not truncate the store, and concurrent read-modify-write cycles must not
  // lose updates to a stale snapshot.
  await withFileLock(file, () => writeFileAtomic(file, JSON.stringify(value, null, 2)));
}
/** Locked read-modify-write: the mutation runs while holding the file lock. */
async function mutateJson<T>(file: string, fallback: T, mutate: (current: T) => T): Promise<T> {
  return withFileLock(file, async () => {
    const next = mutate(await readJson<T>(file, fallback));
    await writeFileAtomic(file, JSON.stringify(next, null, 2));
    return next;
  });
}

// ---- Notebooks CRUD (isolated per notebook id) ----

export async function listNotebooks(): Promise<NotebookMeta[]> {
  const all = await readJson<NotebookMeta[]>(metaPath(), []);
  return [...all].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createNotebook(name: string, description = ""): Promise<NotebookMeta> {
  const all = await readJson<NotebookMeta[]>(metaPath(), []);
  const now = new Date().toISOString();
  const id = uid("notebook");
  const nb: NotebookMeta = { id, name: name.trim() || id, description, createdAt: now, updatedAt: now };
  all.unshift(nb);
  await writeJson(metaPath(), all);
  await fs.mkdir(rawDir(nb.id), { recursive: true });
  await writeJson(sourcesPath(nb.id), []);
  await writeJson(chatsPath(nb.id), []);
  await writeJson(settingsPath(nb.id), { instructions: "", updatedAt: now } satisfies NotebookSettings);
  await writeJson(notesPath(nb.id), []);
  return nb;
}

export async function getNotebookSettings(notebookId: string): Promise<NotebookSettings> {
  return readJson<NotebookSettings>(settingsPath(notebookId), { instructions: "", updatedAt: "" });
}

export async function saveNotebookSettings(notebookId: string, instructions: string): Promise<NotebookSettings> {
  const settings: NotebookSettings = { instructions: instructions.trim().slice(0, 4000), updatedAt: new Date().toISOString() };
  await writeJson(settingsPath(notebookId), settings);
  await touchNotebook(notebookId);
  return settings;
}

export async function listNotebookNotes(notebookId: string): Promise<NotebookNote[]> {
  const notes = await readJson<NotebookNote[]>(notesPath(notebookId), []);
  return [...notes].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function saveNotebookNote(input: Omit<NotebookNote, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<NotebookNote> {
  const now = new Date().toISOString();
  const note: NotebookNote = {
    id: input.id || uid("note"),
    notebookId: input.notebookId,
    title: input.title.trim().slice(0, 160) || "Untitled note",
    content: input.content.slice(0, 100_000),
    citations: input.citations.slice(0, 100),
    createdAt: now,
    updatedAt: now,
  };
  await mutateJson<NotebookNote[]>(notesPath(input.notebookId), [], (notes) => {
    const existing = notes.find((item) => item.id === note.id);
    if (existing) {
      note.createdAt = existing.createdAt;
      note.updatedAt = now;
    }
    return existing ? notes.map((item) => (item.id === note.id ? note : item)) : [note, ...notes];
  });
  await touchNotebook(input.notebookId);
  return note;
}

export async function deleteNotebookNote(notebookId: string, noteId: string): Promise<NotebookNote[]> {
  const next = await mutateJson<NotebookNote[]>(notesPath(notebookId), [], (notes) => notes.filter((note) => note.id !== noteId));
  await touchNotebook(notebookId);
  return next;
}

export async function renameNotebook(notebookId: string, name: string, description?: string): Promise<NotebookMeta> {
  const all = await readJson<NotebookMeta[]>(metaPath(), []);
  const nb = all.find((n) => n.id === notebookId);
  if (!nb) throw new Error("Notebook not found.");
  nb.name = name.trim() || nb.name;
  if (description !== undefined) nb.description = description;
  nb.updatedAt = new Date().toISOString();
  await writeJson(metaPath(), all);
  return nb;
}

export async function deleteNotebook(notebookId: string): Promise<NotebookMeta[]> {
  const all = (await readJson<NotebookMeta[]>(metaPath(), [])).filter((n) => n.id !== notebookId);
  await writeJson(metaPath(), all);
  try {
    await fs.rm(nbDir(notebookId), { recursive: true, force: true });
  } catch { /* best effort */ }
  return all;
}

// ---- Session directories ----

/** Session working dir: sources/, library.json, vectors.json, digest.json. */
export function notebookSessionDir(notebookId: string): string {
  return nbDir(notebookId);
}

// ---- Sources ----

export async function listNotebookSources(notebookId: string): Promise<NotebookSource[]> {
  return readJson<NotebookSource[]>(sourcesPath(notebookId), []);
}

export async function getNotebookSource(notebookId: string, sourceId: string): Promise<NotebookSource | null> {
  return (await listNotebookSources(notebookId)).find((s) => s.id === sourceId) || null;
}

export async function pickAndImportSourceFiles(notebookId: string): Promise<{ sources: NotebookSource[]; failures: string[] }> {
  const dialog = electronApi().dialog;
  if (!dialog) throw new Error("File picker is only available in the desktop app.");
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Documents and images", extensions: ["txt", "md", "markdown", "json", "csv", "tsv", "log", "tex", "html", "htm", "pdf", "docx", "pptx", "png", "jpg", "jpeg", "webp"] }],
  });
  if (result.canceled || !result.filePaths.length) return { sources: await listNotebookSources(notebookId), failures: [] };
  const failures: string[] = [];
  for (const filePath of result.filePaths.slice(0, 20)) {
    try {
      const buffer = await fs.readFile(filePath);
      await importSourceBuffer(notebookId, path.basename(filePath), buffer);
    } catch (error) {
      failures.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Partial failures are reported to the caller (shown in the UI notice)
  // instead of being swallowed whenever at least one file imported.
  return { sources: await listNotebookSources(notebookId), failures };
}

/**
 * Upload edge: validate (extension + size), store raw bytes, create the
 * record as `uploaded` and return immediately. A background job (see
 * notebook-jobs.ts) picks it up for parse → chunk → index.
 */
export async function importSourceBuffer(notebookId: string, filename: string, buffer: Buffer): Promise<NotebookSource> {
  const safe = path.basename(filename).slice(0, 120) || "upload.txt";
  const check = validateUpload(safe, buffer.length);
  if (!check.ok) throw new Error(check.error);
  const now = new Date().toISOString();
  const record: NotebookSource = {
    id: uid("source"),
    notebookId,
    filename: safe,
    size: buffer.length,
    chars: 0,
    chunks: 0,
    status: "uploaded",
    createdAt: now,
    updatedAt: now,
  };
  await mutateJson<NotebookSource[]>(sourcesPath(notebookId), [], (sources) => [record, ...sources]);
  await fs.mkdir(rawDir(notebookId), { recursive: true });
  await fs.writeFile(path.join(rawDir(notebookId), `${record.id}.orig`), buffer);
  await touchNotebook(notebookId);
  return record;
}

export async function readSourceBytes(notebookId: string, sourceId: string): Promise<{ buffer: Buffer; filename: string }> {
  const source = await getNotebookSource(notebookId, sourceId);
  if (!source) throw new Error("Source not found.");
  const buffer = await fs.readFile(path.join(rawDir(notebookId), `${sourceId}.orig`));
  return { buffer, filename: source.filename };
}

/** Parsed markdown is a first-class artifact (retries, re-indexing). */
export async function writeParsedMarkdown(notebookId: string, sourceId: string, markdown: string): Promise<void> {
  await fs.mkdir(rawDir(notebookId), { recursive: true });
  await fs.writeFile(path.join(rawDir(notebookId), `${sourceId}.md`), markdown, "utf8");
}

export async function readParsedMarkdown(notebookId: string, sourceId: string): Promise<string> {
  return fs.readFile(path.join(rawDir(notebookId), `${sourceId}.md`), "utf8");
}

export async function updateSourceStatus(notebookId: string, sourceId: string, patch: Partial<NotebookSource>): Promise<void> {
  await mutateJson<NotebookSource[]>(sourcesPath(notebookId), [], (sources) => {
    const s = sources.find((x) => x.id === sourceId);
    if (s) Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    return sources;
  });
}

/** Bump session activity so the list stays ordered by last activity. */
export async function touchNotebook(notebookId: string): Promise<void> {
  await mutateJson<NotebookMeta[]>(metaPath(), [], (all) => {
    const nb = all.find((n) => n.id === notebookId);
    if (nb) nb.updatedAt = new Date().toISOString();
    return all;
  });
}

export async function deleteNotebookSource(notebookId: string, sourceId: string): Promise<{ sources: NotebookSource[] }> {
  const sources = await mutateJson<NotebookSource[]>(
    sourcesPath(notebookId),
    [],
    (list) => list.filter((s) => s.id !== sourceId)
  );
  // Raw bytes + parsed markdown + relational + vector data: everything derived
  // from this file goes; remaining files are untouched.
  for (const suffix of [".orig", ".md", ".txt"]) {
    try {
      await fs.unlink(path.join(rawDir(notebookId), `${sourceId}${suffix}`));
    } catch { /* gone */ }
  }
  const { wipeFileDerivedData } = await import("./notebook-library.js");
  await wipeFileDerivedData(nbDir(notebookId), notebookId, sourceId);
  await touchNotebook(notebookId);
  return { sources };
}

// ---- Session digest (flag-gated post-ingestion build) ----

export type SessionDigest = { outline: string[]; topics: string[]; updatedAt: string };

export async function writeSessionDigest(notebookId: string, digest: Omit<SessionDigest, "updatedAt">): Promise<SessionDigest> {
  const full: SessionDigest = { ...digest, updatedAt: new Date().toISOString() };
  await fs.mkdir(nbDir(notebookId), { recursive: true });
  await writeJson(path.join(nbDir(notebookId), "digest.json"), full);
  return full;
}

export async function readSessionDigest(notebookId: string): Promise<SessionDigest | null> {
  return readJson<SessionDigest | null>(path.join(nbDir(notebookId), "digest.json"), null);
}

// ---- Chats (each conversation isolated; retrieval scoped to its notebook) ----

export async function listNotebookChats(notebookId: string): Promise<NotebookChat[]> {
  const chats = await readJson<NotebookChat[]>(chatsPath(notebookId), []);
  return [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createNotebookChat(notebookId: string, title = "New conversation"): Promise<NotebookChat> {
  const now = new Date().toISOString();
  const chat: NotebookChat = { id: uid("nbchat"), notebookId, title, createdAt: now, updatedAt: now, messages: [] };
  await mutateJson<NotebookChat[]>(chatsPath(notebookId), [], (chats) => [chat, ...chats]);
  return chat;
}

export async function deleteNotebookChat(notebookId: string, chatId: string): Promise<NotebookChat[]> {
  return mutateJson<NotebookChat[]>(chatsPath(notebookId), [], (chats) => chats.filter((c) => c.id !== chatId));
}

export async function appendNotebookMessage(notebookId: string, chatId: string, message: NotebookChatMessage): Promise<NotebookChat> {
  return appendNotebookMessages(notebookId, chatId, [message]);
}

export async function appendNotebookMessages(notebookId: string, chatId: string, messages: NotebookChatMessage[]): Promise<NotebookChat> {
  const chat = await withFileLock(chatsPath(notebookId), async () => {
    const chats = await readJson<NotebookChat[]>(chatsPath(notebookId), []);
    const target = chats.find((c) => c.id === chatId);
    if (!target) throw new Error("Conversation not found.");
    for (const message of messages) {
      if (!message.id) message.id = uid("msg");
      target.messages.push(message);
    }
    target.updatedAt = new Date().toISOString();
    const firstUser = target.messages.find((m) => m.role === "user");
    if (firstUser && (target.title === "New conversation" || !target.title)) {
      target.title = firstUser.text.slice(0, 60) || "Conversation";
    }
    await writeFileAtomic(chatsPath(notebookId), JSON.stringify(chats, null, 2));
    return target;
  });
  await touchNotebook(notebookId);
  return chat;
}

/** Recent history capped at ~20 turns (40 messages) for the chat pipeline. */
export async function recentChatHistory(notebookId: string, chatId: string, maxMessages = 40): Promise<NotebookChatMessage[]> {
  const chats = await readJson<NotebookChat[]>(chatsPath(notebookId), []);
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return [];
  return chat.messages.slice(-maxMessages);
}

// ---- Session stats (relational store + vector partition) ----

export async function notebookIndexStats(notebookId: string) {
  const { loadLibrary, loadVectors } = await import("./notebook-library.js");
  const root = nbDir(notebookId);
  const [sources, lib, vectors, chats, digest] = await Promise.all([
    listNotebookSources(notebookId),
    loadLibrary(root, notebookId),
    loadVectors(root, notebookId),
    listNotebookChats(notebookId),
    readSessionDigest(notebookId),
  ]);
  const chunkCount = Object.keys(lib.chunks).length;
  const sectionCount = Object.keys(lib.sections).length;
  return {
    sources: sources.length,
    readySources: sources.filter((s) => s.status === "ready").length,
    chunks: chunkCount,
    sections: sectionCount,
    embeddingModel: vectors.embeddingModel || null,
    dims: vectors.dims || 0,
    entities: 0,
    conversations: chats.length,
    digest: digest ? { topics: digest.topics, updatedAt: digest.updatedAt } : null,
    updatedAt: lib.updatedAt || null,
  };
}
