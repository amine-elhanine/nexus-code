import {
  getNotebookSource,
  listNotebookSources,
  listNotebooks,
  notebookSessionDir,
  readParsedMarkdown,
  readSourceBytes,
  touchNotebook,
  updateSourceStatus,
  writeParsedMarkdown,
  writeSessionDigest,
  type NotebookSource,
  type NotebookSourceStatus,
} from "./notebook-store.js";
import { contentFingerprint, parseToMarkdown } from "./notebook-parse.js";
import {
  chunkSections,
  cleanMarkdown,
  extractStructure,
  keyTerms,
  oneSentenceSummary,
  sha256Hex,
  stableChunkId,
} from "./notebook-text.js";
import {
  clearVectors,
  loadLibrary,
  listChunks,
  loadVectors,
  replaceFileEntries,
  saveVectors,
  sectionIdFor,
  sessionSummary,
  upsertFileVectors,
  wipeFileDerivedData,
  type LibraryChunk,
  type LibrarySection,
} from "./notebook-library.js";
import { embedTexts } from "./notebook-embeddings.js";
import { notebookFlags } from "./notebook-flags.js";
import { getAppSettings, getNotebookParserConfig, listProviders } from "./store.js";

// Asynchronous ingestion: one idempotent background job per file.
// uploaded → parsing → chunking → indexing → ready | failed.
// Re-running a job converges (stable IDs + replace-not-append writes).

export const INTERMEDIATE_STATUSES: NotebookSourceStatus[] = ["uploaded", "parsing", "chunking", "indexing"];

const MAX_CONCURRENT_JOBS = 2;
const running = new Set<string>(); // `${notebookId}:${sourceId}`
const queued: Array<{ notebookId: string; sourceId: string }> = [];
let pumping = false;

export type JobProgress = { notebookId: string; sourceId: string; status: NotebookSourceStatus; chunks?: number; error?: string; detail?: string };
export type ProgressListener = (progress: JobProgress) => void;
const listeners = new Set<ProgressListener>();

export function onNotebookJobProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitProgress(progress: JobProgress) {
  for (const listener of listeners) {
    try {
      listener(progress);
    } catch { /* never fail a job over a listener */ }
  }
}

async function setStatus(notebookId: string, sourceId: string, status: NotebookSourceStatus, patch?: Partial<NotebookSource>) {
  await updateSourceStatus(notebookId, sourceId, { status, ...patch });
  const source = await getNotebookSource(notebookId, sourceId);
  emitProgress({ notebookId, sourceId, status, chunks: source?.chunks, error: source?.error });
}

/** Enqueue a file's ingestion job. Deduplicated: already queued/running wins. */
export function enqueueIngest(notebookId: string, sourceId: string): void {
  const key = `${notebookId}:${sourceId}`;
  if (running.has(key)) return;
  if (queued.some((j) => j.notebookId === notebookId && j.sourceId === sourceId)) return;
  queued.push({ notebookId, sourceId });
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queued.length && running.size < MAX_CONCURRENT_JOBS) {
      const job = queued.shift()!;
      const key = `${job.notebookId}:${job.sourceId}`;
      running.add(key);
      void runIngestJob(job.notebookId, job.sourceId)
        .catch((error) => {
          if (error instanceof SourceDeletedError) return; // expected on delete-during-ingest
          console.warn(`[notebook] ingest job failed for ${key}:`, error instanceof Error ? error.message : error);
        })
        .finally(() => {
          running.delete(key);
          void pump();
        });
    }
  } finally {
    pumping = false;
  }
}

/** Raised when the source/notebook was deleted while its job was running —
 *  the job must abort instead of re-creating the deleted data. */
export class SourceDeletedError extends Error {
  constructor() {
    super("Source was deleted while its ingestion job was running.");
    this.name = "SourceDeletedError";
  }
}

async function assertSourceExists(notebookId: string, sourceId: string): Promise<void> {
  if (!(await getNotebookSource(notebookId, sourceId))) throw new SourceDeletedError();
}

/** Indexable text: chunk body + heading path + key terms (+ synth questions).
 *  Synth questions steer retrieval only — never quoted as document content. */
export function indexableChunkText(chunk: { text: string; headingPath: string[] }, keyTerms: string[], synthQuestions?: string[]): string {
  const parts = [chunk.text, `\n\nSection: ${chunk.headingPath.join(" › ")}`, `\nKey terms: ${keyTerms.join(", ")}`];
  if (synthQuestions?.length) parts.push(`\nRelated questions: ${synthQuestions.join(" / ")}`);
  return parts.join("");
}

async function describeNotebookImage(buffer: Buffer, filename: string, mimeType: string, config: { providerId?: string; model?: string } = {}): Promise<string | null> {
  const appSettings = await getAppSettings();
  if (appSettings.notebookVisionEnabled === false) return null;
  const providers = await listProviders().catch(() => []);
  const provider = config.providerId
    ? providers.find((item) => item.id === config.providerId)
    : appSettings.notebookVisionProviderId
      ? providers.find((item) => item.id === appSettings.notebookVisionProviderId)
      : providers.find((item) => item.models.length);
  const modelName = config.model || appSettings.notebookVisionModel || provider?.models[0];
  if (!provider || !modelName) return null;
  const { createChatModel } = await import("./providers.js");
  const llm = await createChatModel(provider, modelName);
  const response = await llm.invoke([{
    role: "user",
    content: [
      { type: "text", text: `Describe this image for a research notebook. Extract visible text, explain charts/diagrams, identify important objects or relationships, and clearly mark uncertainty. Be factual and concise. Filename: ${filename}` },
      { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
    ],
  } as never]);
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : (part as { text?: string }).text || "").join(" ");
  return null;
}

/** Run one file's ingestion end to end. Re-runnable: wipes the file's
 *  derived data first, then re-derives everything with stable IDs. */
export async function runIngestJob(notebookId: string, sourceId: string): Promise<void> {
  const root = notebookSessionDir(notebookId);
  const source = await getNotebookSource(notebookId, sourceId);
  if (!source) return;
  try {
    // Wipe-then-derive: re-uploads and retries converge instead of duplicating.
    await wipeFileDerivedData(root, notebookId, sourceId);
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(`${root}/sources/${sourceId}.md`).catch(() => {});
    } catch { /* best effort */ }

    // 1-2. Parse raw bytes to canonical markdown (persisted artifact).
    await setStatus(notebookId, sourceId, "parsing");
    const { buffer, filename } = await readSourceBytes(notebookId, sourceId);
    const parserConfig = await getNotebookParserConfig();
    const parsed = await parseToMarkdown(buffer, filename, {
      allowCloud: notebookFlags.cloudParser,
      llamaParse: parserConfig.enabled && parserConfig.provider === "llamaparse" && parserConfig.apiKey
        ? parserConfig
        : undefined,
      describeImage: (image, imageFilename, mimeType) => describeNotebookImage(image, imageFilename, mimeType),
      onStatus: (text) => emitProgress({ notebookId, sourceId, status: "parsing", detail: text }),
    });
    await writeParsedMarkdown(notebookId, sourceId, parsed.markdown);
    const fingerprint = contentFingerprint(parsed.markdown);
    await updateSourceStatus(notebookId, sourceId, {
      parser: parsed.parser,
      fingerprint,
      pageCount: parsed.pageCount,
      chars: parsed.markdown.length,
    });

    // 3-4. Clean boilerplate, extract deterministic structure. (The source may
    // have been deleted mid-parse — re-check before writing anything new.)
    await assertSourceExists(notebookId, sourceId);
    await setStatus(notebookId, sourceId, "chunking");
    const { cleaned } = cleanMarkdown(parsed.markdown);
    const rawSections = extractStructure(cleaned, filename.replace(/\.[^.]+$/, ""));
    const sections: LibrarySection[] = rawSections.map((s, i) => ({
      id: sectionIdFor(notebookId, sourceId, s.headingPath, i),
      sessionId: notebookId,
      fileId: sourceId,
      heading: s.heading,
      level: s.level,
      headingPath: s.headingPath,
      text: s.text,
      summary: oneSentenceSummary(s.text),
      keyTerms: keyTerms(s.text),
      tableCount: (s.text.match(/^\s*\|.*\|\s*$/gm) || []).length ? 1 : 0,
      codeBlockCount: (s.text.match(/^(`{3,}|~{3,})/gm) || []).length / 2,
      chunkIds: [],
    }));

    // 5. Chunk with stable deterministic IDs + prev/next links.
    const chunkInputs = chunkSections(
      sections.map((s) => ({ sectionId: s.id, headingPath: s.headingPath, text: s.text })),
      { maxTokens: 400, overlapSentences: 1 }
    );
    if (!chunkInputs.length) throw new Error("No indexable content found after parsing.");
    const chunks: LibraryChunk[] = chunkInputs.map((input, docIndex) => {
      const contentHash = sha256Hex(input.text).slice(0, 16);
      return {
        id: stableChunkId(notebookId, sourceId, input.sectionId, input.ordinalInSection, contentHash),
        sessionId: notebookId,
        fileId: sourceId,
        sectionId: input.sectionId,
        headingPath: input.headingPath,
        ordinalInSection: input.ordinalInSection,
        docIndex,
        text: input.text,
        tokenCount: input.tokenCount,
        structured: input.structured,
        prevId: null,
        nextId: null,
      };
    });
    chunks.forEach((chunk, i) => {
      chunk.prevId = i > 0 ? chunks[i - 1].id : null;
      chunk.nextId = i + 1 < chunks.length ? chunks[i + 1].id : null;
    });
    for (const section of sections) {
      section.chunkIds = chunks.filter((c) => c.sectionId === section.id).map((c) => c.id);
    }
    await assertSourceExists(notebookId, sourceId);
    await replaceFileEntries(
      root,
      { id: sourceId, sessionId: notebookId, filename: source.filename, fingerprint, parser: parsed.parser, sectionIds: sections.map((s) => s.id), chunkCount: chunks.length, updatedAt: new Date().toISOString() },
      sections,
      chunks
    );

    // 6. Optional search-only enrichment (flag-gated, never in answer context).
    if (notebookFlags.synthQuestions) {
      await attachSynthQuestions(chunks);
      // Persist enrichment alongside chunks (relational write, replace-based).
      const { loadLibrary, saveLibrary } = await import("./notebook-library.js");
      const lib = await loadLibrary(root, notebookId);
      for (const chunk of chunks) {
        const stored = lib.chunks[chunk.id];
        if (stored && chunk.synthQuestions) stored.synthQuestions = chunk.synthQuestions;
      }
      await saveLibrary(root, lib);
    }

    // 7. Embed + upsert into the per-session vector partition (delete-first).
    await assertSourceExists(notebookId, sourceId);
    await setStatus(notebookId, sourceId, "indexing", { chunks: chunks.length });
    const sectionTerms = new Map(sections.map((s) => [s.id, s.keyTerms]));
    const indexable = chunks.map((c) => indexableChunkText(c, sectionTerms.get(c.sectionId) || [], c.synthQuestions));
    const { vectors, model, dims } = await embedTexts(indexable);
    try {
      await upsertFileVectors(
        root,
        notebookId,
        model,
        dims,
        chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] || [] }))
      );
    } catch (error) {
      // Embedding-space change: rebuild the whole partition from relational
      // chunks (no re-parse needed), then retry this file's upsert.
      if (error instanceof Error && error.message.startsWith("embedding-space-mismatch")) {
        await reindexSessionFromLibrary(notebookId);
        await upsertFileVectors(
          root,
          notebookId,
          model,
          dims,
          chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] || [] }))
        );
      } else throw error;
    }

    await setStatus(notebookId, sourceId, "ready", { chunks: chunks.length, chars: parsed.markdown.length, error: undefined });
    await touchNotebook(notebookId);
    await maybeBuildDigest(notebookId);
  } catch (error) {
    await setStatus(notebookId, sourceId, "failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Re-embed every relational chunk (embedding-model change recovery). */
export async function reindexSessionFromLibrary(notebookId: string): Promise<{ chunks: number; model: string; dims: number }> {
  const root = notebookSessionDir(notebookId);
  const chunks = await listChunks(root, notebookId);
  await clearVectors(root, notebookId);
  if (!chunks.length) {
    const partition = await loadVectors(root, notebookId);
    return { chunks: 0, model: partition.embeddingModel, dims: partition.dims };
  }
  const { loadLibrary } = await import("./notebook-library.js");
  const lib = await loadLibrary(root, notebookId);
  const indexable = chunks.map((c) => {
    const section = lib.sections[c.sectionId];
    return indexableChunkText(c, section?.keyTerms || [], c.synthQuestions);
  });
  const { vectors, model, dims } = await embedTexts(indexable);
  await upsertFileVectors(
    root,
    notebookId,
    model,
    dims,
    chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] || [] }))
  );
  return { chunks: chunks.length, model, dims };
}

/** Retry: wipe the file's derived data and re-enqueue from raw bytes. */
export async function retrySource(notebookId: string, sourceId: string): Promise<void> {
  const root = notebookSessionDir(notebookId);
  const source = await getNotebookSource(notebookId, sourceId);
  if (!source) throw new Error("Source not found.");
  await wipeFileDerivedData(root, notebookId, sourceId);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(`${root}/sources/${sourceId}.md`).catch(() => {});
  } catch { /* best effort */ }
  await updateSourceStatus(notebookId, sourceId, { status: "uploaded", error: undefined, chunks: 0 });
  enqueueIngest(notebookId, sourceId);
}

/** Startup recovery: files stuck mid-pipeline reset to `uploaded` + requeue. */
export async function recoverInterruptedJobs(): Promise<number> {
  let requeued = 0;
  const notebooks = await listNotebooks().catch(() => []);
  for (const nb of notebooks) {
    const sources = await listNotebookSources(nb.id).catch(() => []);
    // Older concurrent ingestion runs could leave library.json/vectors.json
    // truncated or out of sync while the source rows still said "ready".
    // Treat that as recoverable derived-data corruption and rebuild from the
    // original uploaded bytes instead of making chat search an empty index.
    const ready = sources.filter((source) => source.status === "ready");
    const root = notebookSessionDir(nb.id);
    const library = await loadLibrary(root, nb.id).catch(() => null);
    const expectedChunks = ready.reduce((sum, source) => sum + (source.chunks || 0), 0);
    const libraryLooksBroken = ready.length > 0 && (!library || Object.keys(library.documents).length < ready.length || Object.keys(library.chunks).length < expectedChunks);
    if (libraryLooksBroken) {
      for (const source of ready) {
        await retrySource(nb.id, source.id).catch(() => {});
        requeued++;
      }
      continue;
    }
    if (expectedChunks > 0) {
      const vectors = await loadVectors(root, nb.id).catch(() => null);
      if (!vectors || Object.keys(vectors.vectors || {}).length < expectedChunks) {
        await reindexSessionFromLibrary(nb.id).catch(() => {});
      }
    }
    for (const source of sources) {
      if (INTERMEDIATE_STATUSES.includes(source.status)) {
        await updateSourceStatus(nb.id, source.id, { status: "uploaded" }).catch(() => {});
        enqueueIngest(nb.id, source.id);
        requeued++;
      }
    }
  }
  return requeued;
}

/** Wait until no jobs are queued/running (tests + graceful shutdown). */
export async function drainJobs(timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while ((queued.length || running.size) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function pendingJobCount(): number {
  return queued.length + running.size;
}

// ---- Flag-gated: synthetic questions (search-only enrichment) ----

async function attachSynthQuestions(chunks: LibraryChunk[]): Promise<void> {
  let providers: Array<{ id: string; label: string; provider: string; apiKey: string; baseUrl?: string; models: string[] }>;
  try {
    providers = await listProviders();
  } catch {
    return;
  }
  const provider = providers[0];
  const modelName = provider?.models[0];
  if (!provider || !modelName) return;
  try {
    const { createChatModel } = await import("./providers.js");
    const llm = await createChatModel(provider, modelName);
    for (let i = 0; i < chunks.length; i += 4) {
      const batch = chunks.slice(i, i + 4);
      const prompt = `For each numbered passage below, write 2 short questions (under 15 words each) that this passage answers. Reply with JSON only: {"0": ["q1", "q2"], "1": ["q1", "q2"], ...}.\n\n${batch.map((c, j) => `--- ${j} ---\n${c.text.slice(0, 1200)}`).join("\n\n")}`;
      const res = await llm.invoke([{ role: "user", content: prompt } as never]);
      const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]) as Record<string, string[]>;
      batch.forEach((c, j) => {
        const qs = parsed[String(j)];
        if (Array.isArray(qs)) c.synthQuestions = qs.filter((q) => typeof q === "string").map((q) => q.slice(0, 200)).slice(0, 3);
      });
    }
  } catch {
    // Enrichment is advisory — ingestion succeeds without it.
  }
}

// ---- Flag-gated: session digest (outline + topics when all files ready) ----

export async function maybeBuildDigest(notebookId: string, force = false): Promise<void> {
  if (!notebookFlags.sessionDigest && !force) return;
  const sources = await listNotebookSources(notebookId);
  if (!sources.length || sources.some((s) => s.status !== "ready")) return;
  const root = notebookSessionDir(notebookId);
  const summary = await sessionSummary(root, notebookId);
  const outline = summary.files.flatMap((f) => {
    const heads = summary.headings.filter(Boolean).slice(0, 12);
    return [`${f}: ${heads.slice(0, 6).join(" · ") || "no headings"}`];
  });
  await writeSessionDigest(notebookId, { outline, topics: summary.terms.slice(0, 15) });
  await touchNotebook(notebookId);
}

/** Read parsed markdown for retries/debugging (first-class artifact). */
export async function getParsedMarkdown(notebookId: string, sourceId: string): Promise<string> {
  return readParsedMarkdown(notebookId, sourceId);
}
