import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex, uuid5 } from "./notebook-text.js";
import * as sqliteStore from "./notebook-vectors-sqlite.js";

// Relational store for Notebook Mode: documents, sections and chunks as JSON
// (the vector partition holds similarity vectors only). All functions take an
// explicit session directory — no Electron dependency, plain-node testable.
//
// The relational store is the source of truth for filtering, neighbor
// expansion and delete-by-file; the vector partition is derived data.

// ---- Types ----

export type LibraryDocument = {
  id: string; // == fileId
  sessionId: string;
  filename: string;
  fingerprint: string;
  parser: string;
  sectionIds: string[];
  chunkCount: number;
  updatedAt: string;
};

export type LibrarySection = {
  id: string;
  sessionId: string;
  fileId: string;
  heading: string;
  level: number;
  headingPath: string[];
  text: string;
  summary: string;
  keyTerms: string[];
  tableCount: number;
  codeBlockCount: number;
  chunkIds: string[];
};

export type LibraryChunk = {
  id: string; // stable uuid5(session|file|section|index|contentHash)
  sessionId: string;
  fileId: string;
  sectionId: string;
  headingPath: string[];
  ordinalInSection: number;
  docIndex: number;
  text: string;
  tokenCount: number;
  structured: boolean;
  prevId: string | null;
  nextId: string | null;
  synthQuestions?: string[];
};

export type SessionLibrary = {
  sessionId: string;
  updatedAt: string;
  documents: Record<string, LibraryDocument>;
  sections: Record<string, LibrarySection>;
  chunks: Record<string, LibraryChunk>;
  order: string[]; // chunk ids in document order
};

export type VectorPartition = {
  sessionId: string;
  embeddingModel: string;
  dims: number;
  updatedAt: string;
  vectors: Record<string, number[]>;
};

// ---- Deterministic IDs ----

export function sectionIdFor(sessionId: string, fileId: string, headingPath: string[], index: number): string {
  return uuid5([sessionId, fileId, headingPath.join(" › "), String(index)].join("|"));
}

// ---- Persistence ----

function libraryPath(root: string) {
  return path.join(root, "library.json");
}
function vectorsPath(root: string) {
  return path.join(root, "vectors.json");
}

export function emptyLibrary(sessionId: string): SessionLibrary {
  return { sessionId, updatedAt: new Date().toISOString(), documents: {}, sections: {}, chunks: {}, order: [] };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic replacement prevents readers from observing a half-written JSON
  // file when multiple ingestion jobs finish close together.
  const temp = `${file}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), "utf8");
  await fs.rename(temp, file);
}

const mutationLocks = new Map<string, Promise<void>>();
async function withMutationLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = mutationLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutationLocks.set(key, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (mutationLocks.get(key) === current) mutationLocks.delete(key);
  }
}

// ---- Parse caches ----
// Every retrieval call (multi-query variants, agent tool calls, evidence
// packs) reads the library and the vector partition; JSON.parse of all chunk
// text dominates large-notebook chat latency. The caches turn repeat reads
// into a stat() + Map lookup. Conventions:
// - Library (JSON): validated by mtime, so external writers are picked up.
// - Vectors: invalidated on in-process writes only (the SQLite backend's WAL
//   makes mtime unreliable; the app is single-instance).
// - Callers treat loaded objects as read-only; the only mutators
//   (replaceFileEntries / deleteFileEntries / vector upserts) save afterwards,
//   which refreshes the cache entry.

const libraryCache = new Map<string, { mtimeMs: number; lib: SessionLibrary }>();
const vectorCache = new Map<string, VectorPartition>();

export async function loadLibrary(root: string, sessionId: string): Promise<SessionLibrary> {
  const file = libraryPath(root);
  try {
    const stat = await fs.stat(file);
    const cached = libraryCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lib;
    const lib = await readJson<SessionLibrary | null>(file, null);
    if (!lib || lib.sessionId !== sessionId) return emptyLibrary(sessionId);
    lib.documents = lib.documents || {};
    lib.sections = lib.sections || {};
    lib.chunks = lib.chunks || {};
    lib.order = lib.order || [];
    libraryCache.set(file, { mtimeMs: stat.mtimeMs, lib });
    return lib;
  } catch {
    libraryCache.delete(file);
    return emptyLibrary(sessionId);
  }
}

export async function saveLibrary(root: string, lib: SessionLibrary): Promise<void> {
  lib.updatedAt = new Date().toISOString();
  const file = libraryPath(root);
  await writeJson(file, lib);
  try {
    const stat = await fs.stat(file);
    libraryCache.set(file, { mtimeMs: stat.mtimeMs, lib });
  } catch { /* next load re-reads from disk */ }
}

/** Replace-not-append: wipe this file's entries, then write the fresh ones. */
export async function replaceFileEntries(
  root: string,
  doc: LibraryDocument,
  sections: LibrarySection[],
  chunks: LibraryChunk[]
): Promise<SessionLibrary> {
  return withMutationLock(libraryPath(root), async () => {
    const lib = await loadLibrary(root, doc.sessionId);
    deleteFileEntriesFrom(lib, doc.id);
    lib.documents[doc.id] = doc;
    for (const s of sections) lib.sections[s.id] = s;
    for (const c of chunks) {
      lib.chunks[c.id] = c;
      lib.order.push(c.id);
    }
    await saveLibrary(root, lib);
    return lib;
  });
}

function deleteFileEntriesFrom(lib: SessionLibrary, fileId: string): string[] {
  const removed: string[] = [];
  for (const [id, chunk] of Object.entries(lib.chunks)) {
    if (chunk.fileId === fileId) {
      removed.push(id);
      delete lib.chunks[id];
    }
  }
  for (const [id, section] of Object.entries(lib.sections)) {
    if (section.fileId === fileId) delete lib.sections[id];
  }
  delete lib.documents[fileId];
  const gone = new Set(removed);
  lib.order = lib.order.filter((id) => !gone.has(id));
  return removed;
}

export async function deleteFileEntries(root: string, sessionId: string, fileId: string): Promise<string[]> {
  const removed = await withMutationLock(libraryPath(root), async () => {
    const lib = await loadLibrary(root, sessionId);
    const removed = deleteFileEntriesFrom(lib, fileId);
    await saveLibrary(root, lib);
    return removed;
  });
  await removeFileVectors(root, sessionId, removed);
  return removed;
}

export async function deleteSessionLibrary(root: string): Promise<void> {
  for (const file of [libraryPath(root), vectorsPath(root)]) {
    try {
      await fs.unlink(file);
    } catch { /* already gone */ }
    libraryCache.delete(file);
    vectorCache.delete(file);
  }
  await sqliteStore.deleteSqliteVectors(root);
}

// ---- Reads ----

export async function listChunks(root: string, sessionId: string, fileIds?: string[]): Promise<LibraryChunk[]> {
  const lib = await loadLibrary(root, sessionId);
  const scope = fileIds && fileIds.length ? new Set(fileIds) : null;
  return lib.order.map((id) => lib.chunks[id]).filter((c) => c && (!scope || scope.has(c.fileId)));
}

export async function chunkById(root: string, sessionId: string, chunkId: string): Promise<LibraryChunk | null> {
  const lib = await loadLibrary(root, sessionId);
  return lib.chunks[chunkId] || null;
}

/** Neighbor expansion via prev/next links (same file, adjacent chunks). */
export async function chunkNeighbors(root: string, sessionId: string, chunkId: string): Promise<{ chunk: LibraryChunk | null; prev: LibraryChunk | null; next: LibraryChunk | null }> {
  const lib = await loadLibrary(root, sessionId);
  const chunk = lib.chunks[chunkId] || null;
  if (!chunk) return { chunk: null, prev: null, next: null };
  return {
    chunk,
    prev: (chunk.prevId && lib.chunks[chunk.prevId]) || null,
    next: (chunk.nextId && lib.chunks[chunk.nextId]) || null,
  };
}

export type SessionOutline = Array<{
  fileId: string;
  filename: string;
  headings: Array<{ path: string[]; summary: string; chunkCount: number }>;
  sectionCount: number;
  chunkCount: number;
}>;

/** Full outline (all headings + section summaries) for session-wide asks. */
export async function sessionOutline(root: string, sessionId: string): Promise<SessionOutline> {
  const lib = await loadLibrary(root, sessionId);
  return Object.values(lib.documents).map((doc) => ({
    fileId: doc.id,
    filename: doc.filename,
    headings: doc.sectionIds.map((id) => lib.sections[id]).filter(Boolean).map((s) => ({ path: s.headingPath, summary: s.summary, chunkCount: s.chunkIds.length })),
    sectionCount: doc.sectionIds.length,
    chunkCount: doc.chunkCount,
  }));
}

/** Compact session summary for the chat router: names + top headings/terms. */
export async function sessionSummary(root: string, sessionId: string, capTerms = 60): Promise<{ files: string[]; headings: string[]; terms: string[]; termSet: string[] }> {
  const lib = await loadLibrary(root, sessionId);
  const files = Object.values(lib.documents).map((d) => d.filename);
  const headings: string[] = [];
  const termFreq = new Map<string, number>();
  for (const section of Object.values(lib.sections)) {
    for (const h of section.headingPath) {
      if (!headings.includes(h)) headings.push(h);
    }
    for (const t of section.keyTerms) termFreq.set(t, (termFreq.get(t) || 0) + 1);
  }
  const terms = [...termFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, capTerms).map(([t]) => t);
  const fileTerms = files.flatMap((f) => f.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  return { files, headings: headings.slice(0, 40), terms, termSet: [...new Set([...terms, ...fileTerms])] };
}

// ---- Vector partition (per-session collection) ----

/**
 * Backend routing: SQLite when the runtime supports node:sqlite, JSON
 * otherwise. A one-time migration imports vectors.json on first use; any
 * sqlite failure must leave the JSON path untouched so it stays live.
 */
async function useSqliteVectors(root: string, sessionId: string): Promise<boolean> {
  if (!(await sqliteStore.sqliteVectorsAvailable())) return false;
  try {
    await sqliteStore.migrateJsonVectors(root, sessionId);
  } catch { /* migration failure keeps JSON live */ }
  return true;
}

export async function loadVectors(root: string, sessionId: string): Promise<VectorPartition> {
  const file = vectorsPath(root);
  const cached = vectorCache.get(file);
  if (cached) return cached;
  let partition: VectorPartition;
  if (await useSqliteVectors(root, sessionId)) {
    partition = await sqliteStore.loadVectorsSqlite(root, sessionId);
  } else {
    const stored = await readJson<VectorPartition | null>(file, null);
    if (!stored || stored.sessionId !== sessionId) {
      partition = { sessionId, embeddingModel: "", dims: 0, updatedAt: new Date().toISOString(), vectors: {} };
    } else {
      stored.vectors = stored.vectors || {};
      partition = stored;
    }
  }
  vectorCache.set(file, partition);
  return partition;
}

export async function saveVectors(root: string, partition: VectorPartition): Promise<void> {
  const file = vectorsPath(root);
  if (await useSqliteVectors(root, partition.sessionId)) {
    await sqliteStore.saveVectorsSqlite(root, partition);
  } else {
    partition.updatedAt = new Date().toISOString();
    await writeJson(file, partition);
  }
  vectorCache.set(file, partition);
}

/** Delete-then-upsert for one file's points (never append-only). */
export async function upsertFileVectors(root: string, sessionId: string, embeddingModel: string, dims: number, entries: Array<{ chunkId: string; vector: number[] }>): Promise<void> {
  const file = vectorsPath(root);
  if (await useSqliteVectors(root, sessionId)) {
    await sqliteStore.upsertFileVectorsSqlite(root, sessionId, embeddingModel, dims, entries);
    vectorCache.delete(file);
    return;
  }
  await withMutationLock(file, async () => {
    const partition = await loadVectors(root, sessionId);
    if (partition.embeddingModel && (partition.embeddingModel !== embeddingModel || partition.dims !== dims)) {
      // Dimension/space mismatch: the whole partition is invalid, not just
      // this file — the caller rebuilds from relational chunks instead.
      throw new Error(`embedding-space-mismatch:${partition.embeddingModel}/${partition.dims}`);
    }
    partition.embeddingModel = embeddingModel;
    partition.dims = dims;
    for (const e of entries) partition.vectors[e.chunkId] = e.vector;
    await saveVectors(root, partition);
  });
}

export async function removeFileVectors(root: string, sessionId: string, chunkIds: string[]): Promise<void> {
  if (!chunkIds.length) return;
  const file = vectorsPath(root);
  if (await useSqliteVectors(root, sessionId)) {
    await sqliteStore.removeFileVectorsSqlite(root, sessionId, chunkIds);
    vectorCache.delete(file);
    return;
  }
  await withMutationLock(file, async () => {
    const partition = await loadVectors(root, sessionId);
    for (const id of chunkIds) delete partition.vectors[id];
    await saveVectors(root, partition);
  });
}

export async function clearVectors(root: string, sessionId: string): Promise<void> {
  const file = vectorsPath(root);
  if (await useSqliteVectors(root, sessionId)) {
    await sqliteStore.clearVectorsSqlite(root, sessionId);
  } else {
    await withMutationLock(file, () => saveVectors(root, { sessionId, embeddingModel: "", dims: 0, updatedAt: new Date().toISOString(), vectors: {} }));
  }
  vectorCache.delete(file);
}

/** Wipe one file's derived data (library + vectors). Retry/replace converge. */
export async function wipeFileDerivedData(root: string, sessionId: string, fileId: string): Promise<void> {
  await deleteFileEntries(root, sessionId, fileId);
}

export function libraryFingerprint(text: string): string {
  return sha256Hex(text).slice(0, 16);
}
