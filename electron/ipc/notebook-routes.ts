// Notebook mode IPC routes — sources, ingestion, studio artifacts, chats,
// hybrid retrieval, embeddings. Each notebook owns its sources, vector index
// and conversations; retrieval never crosses notebook boundaries.

import { ipcMain } from "electron";
import {
  appendNotebookMessage, createNotebook, createNotebookChat, deleteNotebook, deleteNotebookChat, deleteNotebookSource,
  deleteNotebookNote, getNotebookSettings, importSourceBuffer, listNotebookChats, listNotebookNotes, listNotebookSources, listNotebooks,
  notebookIndexStats, notebookSessionDir, pickAndImportSourceFiles, readSessionDigest, recentChatHistory, renameNotebook, saveNotebookNote, saveNotebookSettings,
} from "../notebook-store.js";
import { getNotebookEmbeddingConfig, saveNotebookEmbeddingConfig, testEmbeddingEndpoint, type EmbeddingEndpoint } from "../notebook-embeddings.js";
import { answerNotebookQuestion, getChunkPassage, hybridRetrieve } from "../notebook-rag.js";
import { enqueueIngest, retrySource, reindexSessionFromLibrary } from "../notebook-jobs.js";
import { sessionOutline } from "../notebook-library.js";
import { listEmbeddingProviders, removeEmbeddingProvider, upsertEmbeddingProvider, getAppSettings, isMaskedSecret, type EmbeddingProviderConfig } from "../store.js";
import { beginCommandRun, endCommandRun, isCommandRunCancelled } from "../command-service.js";
import { RunCancelledError } from "../agent-service.js";
import {
  assertPayload, NotebookDocumentGenerateSchema, NotebookGeneratePayloadSchema, NotebookMindmapGenerateSchema,
  NotebookSummaryGenerateSchema, NotebookAskSchema, NotebookEmbeddingSaveSchema, NotebookEmbeddingProviderSchema,
} from "./schemas.js";
import type { MainIpcContext } from "./context.js";

// A notebook generation/chat occupies one "run" slot so cancels and
// concurrent-run guards share the same bookkeeping as Code/Home agent runs.
async function runNotebookGeneration<T>(ctx: MainIpcContext, runId: string, work: (isCancelled: () => boolean) => Promise<T>): Promise<T> {
  if (ctx.activeRunSessions.has(runId)) throw new Error("A generation task is already running for this notebook output.");
  ctx.activeRunSessions.add(runId);
  beginCommandRun(runId);
  try {
    const result = await work(() => isCommandRunCancelled(runId));
    if (isCommandRunCancelled(runId)) throw new RunCancelledError();
    return result;
  } finally {
    ctx.activeRunSessions.delete(runId);
    endCommandRun(runId);
  }
}

export function registerNotebookRoutes(ctx: MainIpcContext): void {
  ipcMain.handle("notebook:list", () => listNotebooks());
  ipcMain.handle("notebook:create", (_event, name: string, description?: string) => createNotebook(name, description));
  ipcMain.handle("notebook:rename", (_event, notebookId: string, name: string, description?: string) => renameNotebook(notebookId, name, description));
  ipcMain.handle("notebook:delete", (_event, notebookId: string) => deleteNotebook(notebookId));
  ipcMain.handle("notebook:stats", (_event, notebookId: string) => notebookIndexStats(notebookId));
  ipcMain.handle("notebook:sources", (_event, notebookId: string) => listNotebookSources(notebookId));
  ipcMain.handle("notebook:pickFiles", async (_event, notebookId: string) => {
    const before = new Set((await listNotebookSources(notebookId)).map((s) => s.id));
    const { sources, failures } = await pickAndImportSourceFiles(notebookId);
    // Upload returns immediately; background jobs do parse → chunk → index.
    for (const source of sources) {
      if (!before.has(source.id) && source.status === "uploaded") enqueueIngest(notebookId, source.id);
    }
    return { sources, failures };
  });
  ipcMain.handle("notebook:uploadContent", async (_event, notebookId: string, filename: string, content: string) => {
    const record = await importSourceBuffer(notebookId, filename, Buffer.from(content, "utf8"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:uploadBase64", async (_event, notebookId: string, filename: string, base64: string) => {
    const record = await importSourceBuffer(notebookId, filename, Buffer.from(base64, "base64"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:importYouTube", async (_event, notebookId: string, url: string) => {
    const { fetchYouTubeTranscript, youTubeSourceFilename, youTubeTranscriptDocument } = await import("../notebook-youtube.js");
    const transcript = await fetchYouTubeTranscript(url);
    const record = await importSourceBuffer(notebookId, youTubeSourceFilename(transcript.title), Buffer.from(youTubeTranscriptDocument(transcript), "utf8"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:importWebsite", async (_event, notebookId: string, url: string) => {
    const { crawlWebsite, websiteCrawlDocument, websiteSourceFilename } = await import("../notebook-web.js");
    const crawl = await crawlWebsite(url);
    if (!crawl.pages.some((p) => !p.thin && p.text.trim())) {
      throw new Error("No readable content found — the site may render in JavaScript or block automated fetching.");
    }
    const firstTitle = crawl.pages.find((p) => !p.thin && p.text.trim())?.title || crawl.host;
    const record = await importSourceBuffer(notebookId, websiteSourceFilename(crawl.host, firstTitle), Buffer.from(websiteCrawlDocument(crawl), "utf8"));
    enqueueIngest(notebookId, record.id);
    return listNotebookSources(notebookId);
  });
  ipcMain.handle("notebook:deleteSource", async (_event, notebookId: string, sourceId: string) => deleteNotebookSource(notebookId, sourceId));
  ipcMain.handle("notebook:reindexSource", async (_event, notebookId: string, sourceId: string) => {
    // Retry: wipe the file's derived data and re-enqueue from raw bytes.
    await retrySource(notebookId, sourceId);
    return { sources: await listNotebookSources(notebookId) };
  });
  ipcMain.handle("notebook:reindexAll", async (_event, notebookId: string) => {
    // Embedding-model change recovery: re-embed relational chunks in place.
    const result = await reindexSessionFromLibrary(notebookId);
    return { result, sources: await listNotebookSources(notebookId) };
  });
  ipcMain.handle("notebook:outline", (_event, notebookId: string) => sessionOutline(notebookSessionDir(notebookId), notebookId));
  ipcMain.handle("notebook:digest", (_event, notebookId: string) => readSessionDigest(notebookId));
  ipcMain.handle("notebook:settings:get", (_event, notebookId: string) => getNotebookSettings(notebookId));
  ipcMain.handle("notebook:settings:save", (_event, notebookId: string, instructions: string) => saveNotebookSettings(notebookId, instructions));
  ipcMain.handle("notebook:notes:list", (_event, notebookId: string) => listNotebookNotes(notebookId));
  ipcMain.handle("notebook:notes:save", (_event, input: Parameters<typeof saveNotebookNote>[0]) => saveNotebookNote(input));
  ipcMain.handle("notebook:notes:delete", (_event, notebookId: string, noteId: string) => deleteNotebookNote(notebookId, noteId));
  ipcMain.handle("notebook:documents:list", async (_event, notebookId: string) => {
    const { listNotebookDocuments } = await import("../notebook-documents.js");
    return listNotebookDocuments(notebookId);
  });
  ipcMain.handle("notebook:document:generate", async (_event, payload: { notebookId: string; kind: "report" | "slides"; format: "docx" | "pdf" | "pptx"; prompt?: string; fileIds?: string[]; providerId?: string; model?: string }) => {
    assertPayload(NotebookDocumentGenerateSchema, payload, "notebook:document:generate");
    const statusKey = `nbdoc:${payload.notebookId}`;
    const runId = statusKey;
    if (ctx.activeRunSessions.has(runId)) throw new Error("A document is already being generated for this notebook.");
    ctx.activeRunSessions.add(runId);
    beginCommandRun(runId);
    try {
      const { generateNotebookDocument } = await import("../notebook-documents.js");
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      if (isCommandRunCancelled(runId)) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: "Generating document…" });
      const { doc, fallbackReason } = await generateNotebookDocument(payload.notebookId, {
        kind: payload.kind,
        format: payload.format,
        prompt: payload.prompt,
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        providerId: payload.providerId,
        model: payload.model,
        instructions: notebookSettings.instructions,
        runId,
        isCancelled: () => isCommandRunCancelled(runId),
        onStatus: (text) => ctx.emitFor(statusKey, { type: "status", text }),
      });
      if (isCommandRunCancelled(runId)) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: `Saved ${doc.filename}` });
      return { doc, fallbackReason };
    } catch (error) {
      if (error instanceof RunCancelledError || isCommandRunCancelled(runId)) {
        ctx.emitFor(statusKey, { type: "status", text: "Document generation cancelled." });
        throw new Error("Document generation cancelled.");
      }
      throw error;
    } finally {
      ctx.activeRunSessions.delete(runId);
      endCommandRun(runId);
    }
  });
  ipcMain.handle("notebook:document:delete", async (_event, notebookId: string, docId: string) => {
    const { deleteNotebookDocument } = await import("../notebook-documents.js");
    return deleteNotebookDocument(notebookId, docId);
  });
  ipcMain.handle("notebook:document:download", async (_event, notebookId: string, docId: string) => {
    const { downloadNotebookDocument } = await import("../notebook-documents.js");
    return downloadNotebookDocument(notebookId, docId);
  });
  ipcMain.handle("notebook:document:read", async (_event, notebookId: string, docId: string) => {
    const { readNotebookDocument } = await import("../notebook-documents.js");
    return readNotebookDocument(notebookId, docId);
  });
  ipcMain.handle("notebook:quizzes:list", async (_event, notebookId: string) => {
    const { listNotebookQuizzes } = await import("../notebook-quiz.js");
    return listNotebookQuizzes(notebookId);
  });
  ipcMain.handle("notebook:quiz:generate", async (_event, payload: { notebookId: string; topic?: string; count?: number; quizType?: "mcq" | "truefalse" | "mixed"; fileIds?: string[]; providerId?: string; model?: string }) => {
    assertPayload(NotebookGeneratePayloadSchema, payload, "notebook:quiz:generate");
    const statusKey = `nbquiz:${payload.notebookId}`;
    const quiz = await runNotebookGeneration(ctx, statusKey, async (isCancelled) => {
      const { generateNotebookQuiz } = await import("../notebook-quiz.js");
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      if (isCancelled()) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: "Generating quiz…" });
      return generateNotebookQuiz(payload.notebookId, {
        topic: payload.topic,
        count: payload.count,
        quizType: payload.quizType,
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        providerId: payload.providerId,
        model: payload.model,
        instructions: notebookSettings.instructions,
        runId: statusKey,
        isCancelled,
        onStatus: (text) => ctx.emitFor(statusKey, { type: "status", text }),
      });
    });
    ctx.emitFor(statusKey, { type: "status", text: `Saved ${quiz.title}` });
    return { quiz };
  });
  ipcMain.handle("notebook:quiz:delete", async (_event, notebookId: string, quizId: string) => {
    const { deleteNotebookQuiz } = await import("../notebook-quiz.js");
    return deleteNotebookQuiz(notebookId, quizId);
  });
  ipcMain.handle("notebook:flashcards:list", async (_event, notebookId: string) => {
    const { listNotebookFlashcardSets } = await import("../notebook-flashcards.js");
    return listNotebookFlashcardSets(notebookId);
  });
  ipcMain.handle("notebook:flashcards:generate", async (_event, payload: { notebookId: string; topic?: string; count?: number; fileIds?: string[]; providerId?: string; model?: string }) => {
    assertPayload(NotebookGeneratePayloadSchema, payload, "notebook:flashcards:generate");
    const statusKey = `nbfiches:${payload.notebookId}`;
    const set = await runNotebookGeneration(ctx, statusKey, async (isCancelled) => {
      const { generateNotebookFlashcards } = await import("../notebook-flashcards.js");
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      if (isCancelled()) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: "Generating flashcards…" });
      return generateNotebookFlashcards(payload.notebookId, {
        topic: payload.topic,
        count: payload.count,
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        providerId: payload.providerId,
        model: payload.model,
        instructions: notebookSettings.instructions,
        runId: statusKey,
        isCancelled,
        onStatus: (text) => ctx.emitFor(statusKey, { type: "status", text }),
      });
    });
    ctx.emitFor(statusKey, { type: "status", text: `Saved ${set.title}` });
    return { set };
  });
  ipcMain.handle("notebook:flashcards:delete", async (_event, notebookId: string, setId: string) => {
    const { deleteNotebookFlashcardSet } = await import("../notebook-flashcards.js");
    return deleteNotebookFlashcardSet(notebookId, setId);
  });
  ipcMain.handle("notebook:mindmaps:list", async (_event, notebookId: string) => {
    const { listNotebookMindmaps } = await import("../notebook-mindmaps.js");
    return listNotebookMindmaps(notebookId);
  });
  ipcMain.handle("notebook:mindmaps:generate", async (_event, payload: { notebookId: string; topic?: string; maxNodes?: number; fileIds?: string[]; providerId?: string; model?: string }) => {
    assertPayload(NotebookMindmapGenerateSchema, payload, "notebook:mindmaps:generate");
    const statusKey = `nbmap:${payload.notebookId}`;
    const map = await runNotebookGeneration(ctx, statusKey, async (isCancelled) => {
      const { generateNotebookMindmap } = await import("../notebook-mindmaps.js");
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      if (isCancelled()) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: "Generating mind map…" });
      return generateNotebookMindmap(payload.notebookId, {
        topic: payload.topic,
        maxNodes: payload.maxNodes,
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        providerId: payload.providerId,
        model: payload.model,
        instructions: notebookSettings.instructions,
        runId: statusKey,
        isCancelled,
        onStatus: (text) => ctx.emitFor(statusKey, { type: "status", text }),
      });
    });
    ctx.emitFor(statusKey, { type: "status", text: `Saved ${map.title}` });
    return { map };
  });
  ipcMain.handle("notebook:mindmaps:delete", async (_event, notebookId: string, mapId: string) => {
    const { deleteNotebookMindmap } = await import("../notebook-mindmaps.js");
    return deleteNotebookMindmap(notebookId, mapId);
  });
  ipcMain.handle("notebook:summaries:list", async (_event, notebookId: string) => {
    const { listNotebookSummaries } = await import("../notebook-summaries.js");
    return listNotebookSummaries(notebookId);
  });
  ipcMain.handle("notebook:summaries:generate", async (_event, payload: { notebookId: string; topic?: string; length?: "brief" | "standard" | "detailed"; fileIds?: string[]; providerId?: string; model?: string }) => {
    assertPayload(NotebookSummaryGenerateSchema, payload, "notebook:summaries:generate");
    const statusKey = `nbsum:${payload.notebookId}`;
    const summary = await runNotebookGeneration(ctx, statusKey, async (isCancelled) => {
      const { generateNotebookSummary } = await import("../notebook-summaries.js");
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      if (isCancelled()) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: "Generating summary…" });
      return generateNotebookSummary(payload.notebookId, {
        topic: payload.topic,
        length: payload.length,
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        providerId: payload.providerId,
        model: payload.model,
        instructions: notebookSettings.instructions,
        runId: statusKey,
        isCancelled,
        onStatus: (text) => ctx.emitFor(statusKey, { type: "status", text }),
      });
    });
    ctx.emitFor(statusKey, { type: "status", text: `Saved ${summary.title}` });
    return { summary };
  });
  ipcMain.handle("notebook:summaries:delete", async (_event, notebookId: string, summaryId: string) => {
    const { deleteNotebookSummary } = await import("../notebook-summaries.js");
    return deleteNotebookSummary(notebookId, summaryId);
  });

  // ── Audio Overview IPC (NotebookLM Parity) ──
  ipcMain.handle("notebook:audio:list", async (_event, notebookId: string) => {
    const { listNotebookAudioOverviews } = await import("../notebook-audio.js");
    return listNotebookAudioOverviews(notebookId);
  });
  ipcMain.handle("notebook:audio:generate", async (_event, payload: { notebookId: string; topic?: string; fileIds?: string[]; providerId?: string; model?: string }) => {
    assertPayload(NotebookGeneratePayloadSchema, payload, "notebook:audio:generate");
    const statusKey = `nbaudio:${payload.notebookId}`;
    const audio = await runNotebookGeneration(ctx, statusKey, async (isCancelled) => {
      const { generateNotebookAudioOverview } = await import("../notebook-audio.js");
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      if (isCancelled()) throw new RunCancelledError();
      ctx.emitFor(statusKey, { type: "status", text: "Scripting podcast episode…" });
      return generateNotebookAudioOverview(payload.notebookId, {
        topic: payload.topic,
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        providerId: payload.providerId,
        model: payload.model,
        instructions: notebookSettings.instructions,
        runId: statusKey,
        isCancelled,
        onStatus: (text) => ctx.emitFor(statusKey, { type: "status", text }),
      });
    });
    ctx.emitFor(statusKey, { type: "status", text: `Saved ${audio.title}` });
    return { audio };
  });
  ipcMain.handle("notebook:audio:delete", async (_event, notebookId: string, audioId: string) => {
    const { deleteNotebookAudioOverview } = await import("../notebook-audio.js");
    return deleteNotebookAudioOverview(notebookId, audioId);
  });
  ipcMain.handle("notebook:passage", (_event, notebookId: string, chunkId: string) => getChunkPassage(notebookId, chunkId));
  ipcMain.handle("notebook:chats", (_event, notebookId: string) => listNotebookChats(notebookId));
  ipcMain.handle("notebook:createChat", (_event, notebookId: string, title?: string) => createNotebookChat(notebookId, title));
  ipcMain.handle("notebook:deleteChat", (_event, notebookId: string, chatId: string) => deleteNotebookChat(notebookId, chatId));
  ipcMain.handle("notebook:retrieve", (_event, notebookId: string, query: string, topK?: number, fileIds?: string[]) => hybridRetrieve(notebookId, query, topK || 8, fileIds));
  ipcMain.handle("notebook:ask", async (_event, payload: { notebookId: string; chatId: string; question: string; fileIds?: string[]; providerId?: string; model?: string; effort?: string; topK?: number }) => {
    assertPayload(NotebookAskSchema, payload, "notebook:ask");
    if (ctx.activeRunSessions.has(payload.chatId)) {
      throw new Error("A response is already running in this chat. Stop it before sending another question.");
    }
    ctx.activeRunSessions.add(payload.chatId);
    beginCommandRun(payload.chatId);
    const started = Date.now();
    try {
      // Register the run before any async setup so cancellation during storage
      // or settings reads cannot be erased by a later beginCommandRun call.
      // Persist the user turn FIRST: a crash mid-answer must not lose it.
      await appendNotebookMessage(payload.notebookId, payload.chatId, {
        role: "user",
        text: payload.question,
        createdAt: new Date().toISOString(),
      });
      ctx.emitFor(payload.chatId, { type: "status", text: "Searching notebook sources…" });
      const history = (await recentChatHistory(payload.notebookId, payload.chatId))
        .slice(0, -1)
        .map((m) => ({ role: m.role as "user" | "assistant", text: m.text }));
      const notebookSettings = await getNotebookSettings(payload.notebookId);
      const appSettings = await getAppSettings();
      if (isCommandRunCancelled(payload.chatId)) throw new RunCancelledError();
      const result = await answerNotebookQuestion(payload.notebookId, payload.question, history, {
        fileIds: payload.fileIds?.length ? payload.fileIds : undefined,
        chatProviderId: payload.providerId,
        chatModel: payload.model,
        chatEffort: payload.effort,
        topK: payload.topK || 8,
        instructions: notebookSettings.instructions,
        rerank: appSettings.notebookRerankEnabled ? {
          enabled: true,
          providerId: appSettings.notebookRerankProviderId,
          model: appSettings.notebookRerankModel,
        } : undefined,
        runId: payload.chatId,
        isCancelled: () => isCommandRunCancelled(payload.chatId),
        onStatus: (text) => ctx.emitFor(payload.chatId, { type: "status", text }),
        onToken: (delta) => ctx.emitFor(payload.chatId, { type: "token", text: delta }),
        onStreamReset: () => ctx.emitFor(payload.chatId, { type: "stream-reset", text: "" }),
        onTool: (name, summary, detail) => ctx.emitFor(payload.chatId, { type: "tool", text: summary || name, detail }),
        onThinking: (delta) => ctx.emitFor(payload.chatId, { type: "thinking", text: delta }),
      });
      const chat = await appendNotebookMessage(payload.notebookId, payload.chatId, {
        role: "assistant",
        text: result.answer,
        createdAt: new Date().toISOString(),
        citations: result.sources,
        retrieval: result.retrieval,
        metadata: result.metadata,
        steps: result.steps,
        evaluation: result.evaluation,
      });
      const summary = result.metadata.refused
        ? "not covered in your files — refused rather than guessed"
        : `answered from ${result.sources.length} passage${result.sources.length === 1 ? "" : "s"} in ${((Date.now() - started) / 1000).toFixed(1)}s`;
      ctx.emitFor(payload.chatId, { type: "status", text: summary });
      return { result, chat };
    } catch (error) {
      if (error instanceof RunCancelledError || isCommandRunCancelled(payload.chatId)) {
        const chat = await appendNotebookMessage(payload.notebookId, payload.chatId, {
          role: "assistant",
          text: "Run cancelled by user.",
          createdAt: new Date().toISOString(),
        });
        ctx.emitFor(payload.chatId, { type: "status", text: "Run cancelled." });
        return {
          result: {
            answer: "Run cancelled by user.",
            sources: [],
            retrieval: [],
            metadata: { routing: "retrieve", topScore: 0, refused: false, fallbackModel: false },
            embeddingModel: "",
            dims: 0,
          },
          chat,
        };
      }
      throw error;
    } finally {
      ctx.activeRunSessions.delete(payload.chatId);
      endCommandRun(payload.chatId);
    }
  });
  ipcMain.handle("notebook:embedding:get", () => getNotebookEmbeddingConfig());
  ipcMain.handle("notebook:embedding:save", (_event, config: { providerId: string; model: string }) => {
    assertPayload(NotebookEmbeddingSaveSchema, config, "notebook:embedding:save");
    return saveNotebookEmbeddingConfig(config);
  });
  ipcMain.handle("notebook:embedding-providers:list", async () => (await listEmbeddingProviders()).map((p) => ({ ...p, apiKey: p.apiKey ? "********" : "" })));
  ipcMain.handle("notebook:embedding-provider:save", async (_event, input: Omit<EmbeddingProviderConfig, "id"> & { id?: string }) => {
    assertPayload(NotebookEmbeddingProviderSchema, input, "notebook:embedding-provider:save");
    const existing = input.id ? (await listEmbeddingProviders()).find((p) => p.id === input.id) : undefined;
    const payload = { ...input, apiKey: isMaskedSecret(input.apiKey) ? existing?.apiKey || "" : input.apiKey };
    return (await upsertEmbeddingProvider(payload)).map((p) => ({ ...p, apiKey: p.apiKey ? "********" : "" }));
  });
  ipcMain.handle("notebook:embedding-provider:remove", async (_event, providerId: string) => (await removeEmbeddingProvider(providerId)).map((p) => ({ ...p, apiKey: p.apiKey ? "********" : "" })));
  ipcMain.handle("notebook:embedding-provider:test", async (_event, input: EmbeddingEndpoint & { model: string; id?: string }) => {
    let apiKey = input.apiKey || "";
    // Saved providers come back with a masked key — resolve the real one so
    // testing an existing entry doesn't authenticate with "********".
    if (isMaskedSecret(apiKey) && input.id) {
      apiKey = (await listEmbeddingProviders()).find((p) => p.id === input.id)?.apiKey || "";
    }
    return testEmbeddingEndpoint({ ...input, apiKey });
  });
}
