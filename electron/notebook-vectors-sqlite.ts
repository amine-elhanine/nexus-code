import { promises as fs } from "node:fs";
import path from "node:path";
import type { VectorPartition } from "./notebook-library.js";

// SQLite-backed vector partition for Notebook Mode (node:sqlite, zero native
// dependencies — no electron-rebuild, no asar unpacking, works in plain node
// and Electron alike). Embeddings are stored as float64 blobs: byte-identical
// values to the JSON store, so cosine scores — and therefore rankings — are
// unchanged. Reads/writes are per-chunk upserts and deletes; the whole
// collection is never rewritten (the JSON store rewrote the entire file on
// every ingest).
//
// Why not vec0 KNN in SQL: node:sqlite hard-blocks loadExtension
// (ERR_INVALID_STATE, no flag unlocks it), and better-sqlite3 would drag in
// electron-rebuild + VS Build Tools + asar unpacking for every contributor.
// If that toolchain ever exists, the single place to swap is semanticScores()
// in notebook-rag.ts (vec0 MATCH with k = corpus size is exact). Until then
// this module is the durable store and scoring stays untouched.

function sqlitePath(root: string) {
  return path.join(root, "vectors.sqlite");
}

function vectorsJsonPath(root: string) {
  return path.join(root, "vectors.json");
}

let availability: boolean | null = null;

/** True when node:sqlite can be loaded (old runtimes fall back to JSON). */
export async function sqliteVectorsAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    const mod: any = await import("node:sqlite");
    const db = new mod.DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(x TEXT)");
    db.close();
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

async function openDb(root: string): Promise<any> {
  const mod: any = await import("node:sqlite");
  await fs.mkdir(root, { recursive: true });
  const db = new mod.DatabaseSync(sqlitePath(root));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS chunks(chunk_id TEXT PRIMARY KEY, embedding BLOB NOT NULL)");
  return db;
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float64Array(vector).buffer);
}

function fromBlob(blob: Uint8Array): number[] {
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  return Array.from(new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8));
}

/** node:sqlite has no transaction helper — explicit BEGIN/COMMIT/ROLLBACK. */
function transact(db: any, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch { /* already rolled back */ }
    throw error;
  }
}

function emptyPartition(sessionId: string): VectorPartition {
  return { sessionId, embeddingModel: "", dims: 0, updatedAt: new Date().toISOString(), vectors: {} };
}

function readMeta(db: any, key: string): string {
  const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v?: string } | undefined;
  return row?.v || "";
}

/** Ensures session ownership: stale rows from another session never leak in. */
function ensureSession(db: any, sessionId: string): void {
  if (readMeta(db, "session_id") !== sessionId) {
    db.exec("DELETE FROM chunks");
    db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('session_id', ?)").run(sessionId);
  }
}

/**
 * One-time migration from vectors.json. Runs only when sqlite is missing and
 * the JSON file holds vectors; the JSON file is deleted after a verified
 * import (row count match), otherwise left untouched and JSON stays live.
 */
export async function migrateJsonVectors(root: string, sessionId: string): Promise<boolean> {
  let stored: VectorPartition | null = null;
  try {
    stored = JSON.parse(await fs.readFile(vectorsJsonPath(root), "utf8")) as VectorPartition;
  } catch {
    return false;
  }
  if (!stored || stored.sessionId !== sessionId || !stored.vectors || !Object.keys(stored.vectors).length) return false;
  const db = await openDb(root);
  try {
    ensureSession(db, sessionId);
    const insert = db.prepare("INSERT OR REPLACE INTO chunks(chunk_id, embedding) VALUES (?, ?)");
    const applyMeta = db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)");
    transact(db, () => {
      for (const [id, vec] of Object.entries(stored!.vectors)) insert.run(id, toBlob(vec));
      applyMeta.run("embedding_model", stored!.embeddingModel || "");
      applyMeta.run("dims", String(stored!.dims || 0));
    });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    if (count !== Object.keys(stored.vectors).length) return false;
  } finally {
    db.close();
  }
  await fs.unlink(vectorsJsonPath(root)).catch(() => {});
  return true;
}

async function sqliteExists(root: string): Promise<boolean> {
  try {
    await fs.access(sqlitePath(root));
    return true;
  } catch {
    return false;
  }
}

export async function loadVectorsSqlite(root: string, sessionId: string): Promise<VectorPartition> {
  if (!(await sqliteExists(root))) return emptyPartition(sessionId);
  const db = await openDb(root);
  try {
    if (readMeta(db, "session_id") && readMeta(db, "session_id") !== sessionId) return emptyPartition(sessionId);
    const vectors: Record<string, number[]> = {};
    for (const row of db.prepare("SELECT chunk_id, embedding FROM chunks").all() as Array<{ chunk_id: string; embedding: Uint8Array }>) {
      vectors[row.chunk_id] = fromBlob(row.embedding);
    }
    return {
      sessionId,
      embeddingModel: readMeta(db, "embedding_model"),
      dims: Number(readMeta(db, "dims")) || 0,
      updatedAt: new Date().toISOString(),
      vectors,
    };
  } finally {
    db.close();
  }
}

export async function saveVectorsSqlite(root: string, partition: VectorPartition): Promise<void> {
  const db = await openDb(root);
  try {
    ensureSession(db, partition.sessionId);
    transact(db, () => {
      db.exec("DELETE FROM chunks");
      const insert = db.prepare("INSERT INTO chunks(chunk_id, embedding) VALUES (?, ?)");
      for (const [id, vec] of Object.entries(partition.vectors || {})) insert.run(id, toBlob(vec));
      db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('embedding_model', ?)").run(partition.embeddingModel || "");
      db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('dims', ?)").run(String(partition.dims || 0));
    });
  } finally {
    db.close();
  }
}

/** Delete-then-upsert for one file's points (never append-only). */
export async function upsertFileVectorsSqlite(
  root: string,
  sessionId: string,
  embeddingModel: string,
  dims: number,
  entries: Array<{ chunkId: string; vector: number[] }>
): Promise<void> {
  const db = await openDb(root);
  try {
    ensureSession(db, sessionId);
    const currentModel = readMeta(db, "embedding_model");
    const currentDims = Number(readMeta(db, "dims")) || 0;
    if (currentModel && (currentModel !== embeddingModel || currentDims !== dims)) {
      throw new Error(`embedding-space-mismatch:${currentModel}/${currentDims}`);
    }
    transact(db, () => {
      const insert = db.prepare("INSERT OR REPLACE INTO chunks(chunk_id, embedding) VALUES (?, ?)");
      for (const e of entries) insert.run(e.chunkId, toBlob(e.vector));
      db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('embedding_model', ?)").run(embeddingModel);
      db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('dims', ?)").run(String(dims));
    });
  } finally {
    db.close();
  }
}

export async function removeFileVectorsSqlite(root: string, sessionId: string, chunkIds: string[]): Promise<void> {
  if (!chunkIds.length) return;
  if (!(await sqliteExists(root))) return;
  const db = await openDb(root);
  try {
    if (readMeta(db, "session_id") !== sessionId) return;
    transact(db, () => {
      const stmt = db.prepare("DELETE FROM chunks WHERE chunk_id = ?");
      for (const id of chunkIds) stmt.run(id);
    });
  } finally {
    db.close();
  }
}

export async function clearVectorsSqlite(root: string, sessionId: string): Promise<void> {
  const db = await openDb(root);
  try {
    ensureSession(db, sessionId);
    db.exec("DELETE FROM chunks");
    db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('embedding_model', '')").run();
    db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('dims', '0')").run();
  } finally {
    db.close();
  }
}

/** Removes sqlite artifacts (main file + WAL sidecars). */
export async function deleteSqliteVectors(root: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      await fs.unlink(sqlitePath(root) + suffix);
    } catch { /* already gone */ }
  }
}
