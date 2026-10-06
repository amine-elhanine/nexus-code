import { useCallback, useEffect, useRef, useState } from "react";
import type { NotebookChat, NotebookDocument, NotebookEmbeddingConfig, NotebookFlashcardSet, NotebookMeta, NotebookMindmap, NotebookNote, NotebookPassage, NotebookQuiz, NotebookQuizType, NotebookRagAnswer, NotebookSettings, NotebookSource, NotebookStats, NotebookSummary, NotebookSummaryLength } from "../types.js";

const INTERMEDIATE_STATUSES = new Set(["uploaded", "parsing", "chunking", "indexing"]);

export function useNotebookController(enabled: boolean) {
  const api = window.nexus || window.forgepilot;
  const [notebooks, setNotebooks] = useState<NotebookMeta[]>([]);
  const [activeNotebook, setActiveNotebook] = useState<NotebookMeta | null>(null);
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [chats, setChats] = useState<NotebookChat[]>([]);
  const [activeChat, setActiveChat] = useState<NotebookChat | null>(null);
  const [stats, setStats] = useState<NotebookStats | null>(null);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  const [embedding, setEmbedding] = useState<NotebookEmbeddingConfig>({ providerId: "", model: "text-embedding-3-small" });
  // File scope: excluded source ids. Empty = all files (default).
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  // Live streamed tokens per conversation (matches the app's token-stream UX).
  const [streamByChat, setStreamByChat] = useState<Record<string, string>>({});
  const [stepsByChat, setStepsByChat] = useState<Record<string, string[]>>({});
  const [passage, setPassage] = useState<NotebookPassage | null>(null);
  const [settings, setSettings] = useState<NotebookSettings>({ instructions: "", updatedAt: "" });
  const [notes, setNotes] = useState<NotebookNote[]>([]);
  const [documents, setDocuments] = useState<NotebookDocument[]>([]);
  const [quizzes, setQuizzes] = useState<NotebookQuiz[]>([]);
  const [flashcards, setFlashcards] = useState<NotebookFlashcardSet[]>([]);
  const [mindmaps, setMindmaps] = useState<NotebookMindmap[]>([]);
  const [generatingMindmap, setGeneratingMindmap] = useState(false);
  const [summaries, setSummaries] = useState<NotebookSummary[]>([]);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [generatingDoc, setGeneratingDoc] = useState(false);
  const [generatingQuiz, setGeneratingQuiz] = useState(false);
  const [generatingFlashcards, setGeneratingFlashcards] = useState(false);
  const [importingLink, setImportingLink] = useState<{ kind: "youtube" | "website"; url: string } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  // Current ingestion sub-step (vision image analysis, page OCR) for the card.
  const [ingestDetail, setIngestDetail] = useState("");
  const activeChatRef = useRef<NotebookChat | null>(null);
  activeChatRef.current = activeChat;
  // Guards the one-chat-per-session ensure below against parallel creates
  // (detail refresh + polling + ask can overlap).
  const ensuringChatRef = useRef<Promise<NotebookChat | null> | null>(null);

  const refreshNotebooks = useCallback(async () => {
    const typed = api as unknown as { listNotebooks?: () => Promise<NotebookMeta[]> };
    if (typeof typed.listNotebooks !== "function") {
      setNotice("Notebook backend is unavailable — restart the app with a fresh build (npm run dev rebuilds it).");
      return [];
    }
    try {
      const all = await typed.listNotebooks();
      setNotebooks(all);
      // Sessions-first: never auto-enter. The user clicks a session to enter it.
      return all;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load notebook sessions.");
      return [];
    }
  }, []);

  // One chat per session: the session IS the conversation. Ensures exactly
  // one chat exists (creating it on first enter) and returns it.
  const ensureSingleChat = useCallback(async (notebookId: string): Promise<NotebookChat | null> => {
    if (ensuringChatRef.current) return ensuringChatRef.current;
    const run = (async () => {
      const typed = api as unknown as {
        notebookChats: (id: string) => Promise<NotebookChat[]>;
        notebookCreateChat: (id: string) => Promise<NotebookChat>;
      };
      try {
        const existing = await typed.notebookChats(notebookId);
        // Legacy sessions may hold several conversations — the session's
        // single chat is the first; extras are left alone, never surfaced.
        if (existing.length) {
          setChats(existing);
          return existing[0];
        }
        const chat = await typed.notebookCreateChat(notebookId);
        setChats([chat]);
        return chat;
      } catch {
        return null;
      } finally {
        ensuringChatRef.current = null;
      }
    })();
    ensuringChatRef.current = run;
    return run;
  }, []);

  const refreshNotebookDetail = useCallback(
    async (notebookId: string) => {
      const typed = api as unknown as {
        notebookSources: (id: string) => Promise<NotebookSource[]>;
        notebookChats: (id: string) => Promise<NotebookChat[]>;
        notebookStats: (id: string) => Promise<NotebookStats>;
        notebookSettings: (id: string) => Promise<NotebookSettings>;
        notebookNotes: (id: string) => Promise<NotebookNote[]>;
      };
      try {
        const [s, c, st, config, savedNotes, savedDocs, savedQuizzes, savedFlashcards] = await Promise.all([typed.notebookSources(notebookId), typed.notebookChats(notebookId), typed.notebookStats(notebookId), typed.notebookSettings(notebookId), typed.notebookNotes(notebookId), (typed as unknown as { notebookDocuments?: (id: string) => Promise<NotebookDocument[]> }).notebookDocuments ? (typed as unknown as { notebookDocuments: (id: string) => Promise<NotebookDocument[]> }).notebookDocuments(notebookId).catch(() => [] as NotebookDocument[]) : Promise.resolve([] as NotebookDocument[]), (typed as unknown as { notebookQuizzes?: (id: string) => Promise<NotebookQuiz[]> }).notebookQuizzes ? (typed as unknown as { notebookQuizzes: (id: string) => Promise<NotebookQuiz[]> }).notebookQuizzes(notebookId).catch(() => [] as NotebookQuiz[]) : Promise.resolve([] as NotebookQuiz[]), (typed as unknown as { notebookFlashcards?: (id: string) => Promise<NotebookFlashcardSet[]> }).notebookFlashcards ? (typed as unknown as { notebookFlashcards: (id: string) => Promise<NotebookFlashcardSet[]> }).notebookFlashcards(notebookId).catch(() => [] as NotebookFlashcardSet[]) : Promise.resolve([] as NotebookFlashcardSet[])]);
        setSources(s);
        setStats(st);
        setSettings(config);
        setNotes(savedNotes);
        setDocuments(savedDocs);
        setQuizzes(savedQuizzes);
        setFlashcards(savedFlashcards);
        try {
          const typedMaps = api as unknown as { notebookMindmaps?: (id: string) => Promise<NotebookMindmap[]> };
          if (typeof typedMaps.notebookMindmaps === "function") setMindmaps(await typedMaps.notebookMindmaps(notebookId).catch(() => [] as NotebookMindmap[]));
        } catch { /* mindmaps unavailable */ }
        try {
          const typedSums = api as unknown as { notebookSummaries?: (id: string) => Promise<NotebookSummary[]> };
          if (typeof typedSums.notebookSummaries === "function") setSummaries(await typedSums.notebookSummaries(notebookId).catch(() => [] as NotebookSummary[]));
        } catch { /* summaries unavailable */ }
        if (c.length) {
          setChats(c);
          setActiveChat((prev) => {
            if (prev && prev.notebookId === notebookId) {
              return c.find((x) => x.id === prev.id) || c[0];
            }
            return c[0];
          });
        } else {
          // First enter: the session gets its one and only chat.
          const chat = await ensureSingleChat(notebookId);
          setActiveChat(chat);
        }
      } catch {
        /* backend unavailable */
      }
    },
    [ensureSingleChat]
  );

  useEffect(() => {
    if (!enabled) return;
    void refreshNotebooks();
    const typed = api as unknown as { getNotebookEmbedding: () => Promise<NotebookEmbeddingConfig> };
    if (typeof typed.getNotebookEmbedding === "function") {
      typed.getNotebookEmbedding().then(setEmbedding).catch(() => {});
    }
  }, [enabled]);

  useEffect(() => {
    if (enabled && activeNotebook) void refreshNotebookDetail(activeNotebook.id);
  }, [enabled, activeNotebook?.id]);

  // Poll while any source is mid-pipeline so per-file statuses flip to
  // ready/failed without manual refresh.
  const hasPending = sources.some((s) => INTERMEDIATE_STATUSES.has(s.status));
  useEffect(() => {
    if (!enabled || !activeNotebook || !hasPending) return;
    const timer = setInterval(() => {
      void refreshNotebookDetail(activeNotebook.id);
    }, 3000);
    return () => clearInterval(timer);
  }, [enabled, activeNotebook?.id, hasPending]);

  // Real-time job progress updates from the background ingestion pipeline
  useEffect(() => {
    if (!enabled) return;
    const typed = api as unknown as {
      onNotebookJobProgress?: (listener: (progress: { notebookId: string; sourceId: string; status: NotebookSource["status"]; chunks?: number; error?: string; detail?: string }) => void) => () => void;
    };
    if (typeof typed.onNotebookJobProgress !== "function") return;
    return typed.onNotebookJobProgress((progress) => {
      if (activeNotebook && progress.notebookId === activeNotebook.id) {
        // Vision/parsing sub-step detail (e.g. "Analyzing image page-3.png…").
        setIngestDetail(progress.status === "ready" || progress.status === "failed" || !progress.detail ? "" : progress.detail);
        setSources((prev) => {
          const index = prev.findIndex((s) => s.id === progress.sourceId);
          if (index === -1) {
            void refreshNotebookDetail(progress.notebookId);
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...next[index],
            status: progress.status,
            chunks: typeof progress.chunks === "number" ? progress.chunks : next[index].chunks,
            error: progress.error !== undefined ? progress.error : next[index].error,
          };
          return next;
        });
        if (progress.status === "ready" || progress.status === "failed") {
          void refreshNotebookDetail(progress.notebookId);
        }
      }
    });
  }, [enabled, activeNotebook?.id, refreshNotebookDetail]);

  // Streamed answer tokens for notebook conversations (scoped by chat id so
  // concurrent sessions never mix).
  useEffect(() => {
    if (!enabled) return;
    const typed = api as unknown as { onAgentEvent?: (listener: (event: { type: string; sessionId: string; text: string; detail?: string }) => void) => () => void };
    if (typeof typed.onAgentEvent !== "function") return;
    return typed.onAgentEvent((event) => {
      if (!event.sessionId) return;
      const id = event.sessionId;
      if (event.type === "status" || event.type === "tool") {
        setStepsByChat((prev) => {
          const current = prev[id] || [];
          if (!event.text || current[current.length - 1] === event.text) return prev;
          return { ...prev, [id]: [...current, event.text].slice(-16) };
        });
        return;
      }
      if (event.type === "stream-reset") {
        // The agent path bailed after streaming a partial answer and the
        // grounded fallback is taking over — clear the buffer so the fallback
        // answer replaces it instead of concatenating onto it.
        setStreamByChat((prev) => (prev[id] ? { ...prev, [id]: "" } : prev));
        return;
      }
      if (event.type === "token") setStreamByChat((prev) => ({ ...prev, [id]: (prev[id] || "") + event.text }));
    });
  }, [enabled]);

  function enterNotebook(nb: NotebookMeta) {
    setActiveNotebook(nb);
    setSources([]);
    setChats([]);
    setActiveChat(null);
    setStats(null);
    setDraft("");
    setNotice("");
    setExcludedIds([]);
    setPassage(null);
    setSettings({ instructions: "", updatedAt: "" });
    setNotes([]);
    setDocuments([]);
    setQuizzes([]);
    setFlashcards([]);
    setMindmaps([]);
    setSummaries([]);
    void refreshNotebookDetail(nb.id);
  }

  function exitToSessions() {
    setActiveNotebook(null);
    setSources([]);
    setChats([]);
    setActiveChat(null);
    setStats(null);
    setDraft("");
    setNotice("");
    setExcludedIds([]);
    setPassage(null);
    setSettings({ instructions: "", updatedAt: "" });
    setNotes([]);
    setDocuments([]);
    setQuizzes([]);
    setFlashcards([]);
    setMindmaps([]);
    setSummaries([]);
  }

  async function renameCurrentNotebook(name: string) {
    if (!activeNotebook || !name.trim()) return;
    try {
      const typed = api as unknown as { renameNotebook: (id: string, n: string) => Promise<NotebookMeta> };
      const updated = await typed.renameNotebook(activeNotebook.id, name.trim());
      setActiveNotebook(updated);
      setNotebooks((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not rename the session.");
    }
  }

  function toggleScope(sourceId: string) {
    setExcludedIds((prev) => (prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId]));
  }

  function resetScope() {
    setExcludedIds([]);
  }

  async function openPassage(chunkId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookPassage: (a: string, b: string) => Promise<NotebookPassage | null> };
      const result = await typed.notebookPassage(activeNotebook.id, chunkId);
      if (result) setPassage(result);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load the passage.");
    }
  }

  function closePassage() {
    setPassage(null);
  }

  async function saveInstructions(instructions: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { saveNotebookSettings: (id: string, value: string) => Promise<NotebookSettings> };
      setSettings(await typed.saveNotebookSettings(activeNotebook.id, instructions));
      setNotice("Notebook instructions saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save notebook instructions.");
    }
  }

  async function saveNote(note: { id?: string; title: string; content: string; citations: NotebookNote["citations"] }) {
    if (!activeNotebook) return;
    const typed = api as unknown as { saveNotebookNote: (input: { id?: string; notebookId: string; title: string; content: string; citations: NotebookNote["citations"] }) => Promise<NotebookNote> };
    const saved = await typed.saveNotebookNote({ ...note, notebookId: activeNotebook.id });
    setNotes((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
    setNotice("Note saved with source citations.");
  }

  async function removeNote(noteId: string) {
    if (!activeNotebook) return;
    const typed = api as unknown as { deleteNotebookNote: (id: string, noteId: string) => Promise<NotebookNote[]> };
    setNotes(await typed.deleteNotebookNote(activeNotebook.id, noteId));
  }

  async function generateDocument(kind: NotebookDocument["kind"], format: NotebookDocument["format"], prompt: string, providerId?: string, model?: string) {
    if (!activeNotebook || generatingDoc) return null;
    const statusKey = `nbdoc:${activeNotebook.id}`;
    setGeneratingDoc(true);
    // Reset the agent activity feed for this run so live tool steps render.
    setStepsByChat((prev) => ({ ...prev, [statusKey]: ["Starting the document agent…"] }));
    setStreamByChat((prev) => {
      const next = { ...prev };
      delete next[statusKey];
      return next;
    });
    setNotice(kind === "slides" ? "Agent is designing your presentation…" : `Agent is designing your ${format.toUpperCase()} report…`);
    try {
      const typed = api as unknown as {
        notebookGenerateDocument: (p: { notebookId: string; kind: NotebookDocument["kind"]; format: NotebookDocument["format"]; prompt?: string; fileIds?: string[]; providerId?: string; model?: string }) => Promise<{ doc: NotebookDocument; fallbackReason: string | null }>;
        notebookDocuments: (id: string) => Promise<NotebookDocument[]>;
      };
      const scope = scopedIds.length === sources.length ? undefined : scopedIds;
      const { doc, fallbackReason } = await typed.notebookGenerateDocument({ notebookId: activeNotebook.id, kind, format, prompt, fileIds: scope, providerId, model });
      try {
        setDocuments(await typed.notebookDocuments(activeNotebook.id));
      } catch {
        setDocuments((prev) => [doc, ...prev]);
      }
      const engineLabel = doc.engine === "skill-agent" ? "designed with document skill" : `built-in renderer${fallbackReason ? ` — skill path failed: ${fallbackReason.slice(0, 220)}` : ""}`;
      const fileCount = new Set(doc.citations.map((c) => c.sourceName)).size;
      setNotice(`Saved ${doc.filename} (${Math.round(doc.size / 1024)} KB, ${doc.citations.length} cited passages from ${fileCount} file${fileCount === 1 ? "" : "s"} · ${engineLabel}).`);
      return doc;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Document generation failed.");
      return null;
    } finally {
      setGeneratingDoc(false);
    }
  }

  async function generateQuiz(topic: string, count: number, quizType: NotebookQuizType, providerId?: string, model?: string) {
    if (!activeNotebook || generatingQuiz) return null;
    const statusKey = `nbquiz:${activeNotebook.id}`;
    setGeneratingQuiz(true);
    setStepsByChat((prev) => ({ ...prev, [statusKey]: ["Starting the quiz agent…"] }));
    setNotice("Generating a grounded quiz from your sources…");
    try {
      const typed = api as unknown as {
        notebookGenerateQuiz: (p: { notebookId: string; topic?: string; count?: number; quizType?: NotebookQuizType; fileIds?: string[]; providerId?: string; model?: string }) => Promise<{ quiz: NotebookQuiz }>;
        notebookQuizzes: (id: string) => Promise<NotebookQuiz[]>;
      };
      const scope = scopedIds.length === sources.length ? undefined : scopedIds;
      const { quiz } = await typed.notebookGenerateQuiz({ notebookId: activeNotebook.id, topic, count, quizType, fileIds: scope, providerId, model });
      try {
        setQuizzes(await typed.notebookQuizzes(activeNotebook.id));
      } catch {
        setQuizzes((prev) => [quiz, ...prev]);
      }
      setNotice(`Saved quiz “${quiz.title}” (${quiz.questions.length} questions from ${quiz.citations.length} cited passages).`);
      return quiz;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Quiz generation failed.");
      return null;
    } finally {
      setGeneratingQuiz(false);
    }
  }

  async function removeQuiz(quizId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookDeleteQuiz: (id: string, quiz: string) => Promise<NotebookQuiz[]> };
      setQuizzes(await typed.notebookDeleteQuiz(activeNotebook.id, quizId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  }

  async function generateFlashcards(topic: string, count: number, providerId?: string, model?: string) {
    if (!activeNotebook || generatingFlashcards) return null;
    const statusKey = `nbfiches:${activeNotebook.id}`;
    setGeneratingFlashcards(true);
    setStepsByChat((prev) => ({ ...prev, [statusKey]: ["Starting the flashcard agent…"] }));
    setNotice("Generating grounded flashcards from your sources…");
    try {
      const typed = api as unknown as {
        notebookGenerateFlashcards: (p: { notebookId: string; topic?: string; count?: number; fileIds?: string[]; providerId?: string; model?: string }) => Promise<{ set: NotebookFlashcardSet }>;
        notebookFlashcards: (id: string) => Promise<NotebookFlashcardSet[]>;
      };
      const scope = scopedIds.length === sources.length ? undefined : scopedIds;
      const { set } = await typed.notebookGenerateFlashcards({ notebookId: activeNotebook.id, topic, count, fileIds: scope, providerId, model });
      try {
        setFlashcards(await typed.notebookFlashcards(activeNotebook.id));
      } catch {
        setFlashcards((prev) => [set, ...prev]);
      }
      setNotice(`Saved flashcards “${set.title}” (${set.cards.length} cards from ${set.citations.length} cited passages).`);
      return set;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Flashcard generation failed.");
      return null;
    } finally {
      setGeneratingFlashcards(false);
    }
  }

  async function removeFlashcards(setId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookDeleteFlashcards: (id: string, set: string) => Promise<NotebookFlashcardSet[]> };
      setFlashcards(await typed.notebookDeleteFlashcards(activeNotebook.id, setId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  }

  async function generateMindmap(topic: string, providerId?: string, model?: string) {
    if (!activeNotebook || generatingMindmap) return null;
    const statusKey = `nbmap:${activeNotebook.id}`;
    setGeneratingMindmap(true);
    setStepsByChat((prev) => ({ ...prev, [statusKey]: ["Starting the mind-map agent…"] }));
    setNotice("Generating a grounded mind map from your sources…");
    try {
      const typed = api as unknown as {
        notebookGenerateMindmap: (p: { notebookId: string; topic?: string; fileIds?: string[]; providerId?: string; model?: string }) => Promise<{ map: NotebookMindmap }>;
        notebookMindmaps: (id: string) => Promise<NotebookMindmap[]>;
      };
      const scope = scopedIds.length === sources.length ? undefined : scopedIds;
      const { map } = await typed.notebookGenerateMindmap({ notebookId: activeNotebook.id, topic, fileIds: scope, providerId, model });
      try {
        setMindmaps(await typed.notebookMindmaps(activeNotebook.id));
      } catch {
        setMindmaps((prev) => [map, ...prev]);
      }
      setNotice(`Saved mind map “${map.title}” (${map.nodeCount} nodes from ${map.citations.length} cited passages).`);
      return map;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Mind-map generation failed.");
      return null;
    } finally {
      setGeneratingMindmap(false);
    }
  }

  async function removeMindmap(mapId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookDeleteMindmap: (id: string, map: string) => Promise<NotebookMindmap[]> };
      setMindmaps(await typed.notebookDeleteMindmap(activeNotebook.id, mapId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  }

  async function generateSummary(topic: string, length: NotebookSummaryLength, providerId?: string, model?: string) {
    if (!activeNotebook || generatingSummary) return null;
    const statusKey = `nbsum:${activeNotebook.id}`;
    setGeneratingSummary(true);
    setStepsByChat((prev) => ({ ...prev, [statusKey]: ["Starting the summary agent…"] }));
    setNotice("Generating a rich grounded summary from your sources…");
    try {
      const typed = api as unknown as {
        notebookGenerateSummary: (p: { notebookId: string; topic?: string; length?: NotebookSummaryLength; fileIds?: string[]; providerId?: string; model?: string }) => Promise<{ summary: NotebookSummary }>;
        notebookSummaries: (id: string) => Promise<NotebookSummary[]>;
      };
      const scope = scopedIds.length === sources.length ? undefined : scopedIds;
      const { summary } = await typed.notebookGenerateSummary({ notebookId: activeNotebook.id, topic, length, fileIds: scope, providerId, model });
      try {
        setSummaries(await typed.notebookSummaries(activeNotebook.id));
      } catch {
        setSummaries((prev) => [summary, ...prev]);
      }
      setNotice(`Saved summary “${summary.title}” (${summary.sections.length} sections from ${summary.citations.length} cited passages).`);
      return summary;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Summary generation failed.");
      return null;
    } finally {
      setGeneratingSummary(false);
    }
  }

  async function removeSummary(summaryId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookDeleteSummary: (id: string, summary: string) => Promise<NotebookSummary[]> };
      setSummaries(await typed.notebookDeleteSummary(activeNotebook.id, summaryId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  }

  async function downloadDocument(docId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookDownloadDocument: (id: string, doc: string) => Promise<string | null> };
      const dest = await typed.notebookDownloadDocument(activeNotebook.id, docId);
      setNotice(dest ? `Saved to ${dest}` : "Download cancelled.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Download failed.");
    }
  }

  async function removeDocument(docId: string) {
    if (!activeNotebook) return;
    try {
      const typed = api as unknown as { notebookDeleteDocument: (id: string, doc: string) => Promise<NotebookDocument[]> };
      setDocuments(await typed.notebookDeleteDocument(activeNotebook.id, docId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  }

  async function reindexAll() {
    if (!activeNotebook) return;
    try {
      setNotice("Re-embedding all files from stored chunks…");
      const typed = api as unknown as { notebookReindexAll: (id: string) => Promise<unknown> };
      await typed.notebookReindexAll(activeNotebook.id);
      await refreshNotebookDetail(activeNotebook.id);
      setNotice("Re-index complete.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Re-index failed.");
    }
  }

  async function createNotebook(name: string) {
    const typed = api as unknown as { createNotebook?: (n: string) => Promise<NotebookMeta> };
    if (typeof typed.createNotebook !== "function") {
      setNotice("Notebook backend is unavailable — restart the app with a fresh build (npm run dev rebuilds it).");
      return;
    }
    try {
      // New sessions start with their generated ID as the visible name. The
      // notebook header can rename it later without blocking creation.
      const nb = await typed.createNotebook(name.trim());
      const all = await refreshNotebooks();
      setNotebooks(all);
      // Enter the new session immediately with a fresh conversation ready.
      setActiveNotebook(nb);
      setSources([]);
      setStats(null);
      setDraft("");
      setNotice("");
      try {
        const chatTyped = api as unknown as { notebookCreateChat: (id: string) => Promise<NotebookChat> };
        const chat = await chatTyped.notebookCreateChat(nb.id);
        setChats([chat]);
        setActiveChat(chat);
        await refreshNotebookDetail(nb.id);
      } catch (error) {
        setChats([]);
        setActiveChat(null);
        setNotice(error instanceof Error ? error.message : "Session created, but the first conversation failed to start.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create the notebook session.");
    }
  }

  async function removeNotebook(notebookId: string) {
    try {
      const typed = api as unknown as { deleteNotebook: (id: string) => Promise<NotebookMeta[]> };
      const all = await typed.deleteNotebook(notebookId);
      setNotebooks(all);
      // Back to the sessions overview when the entered session is deleted.
      if (activeNotebook?.id === notebookId) exitToSessions();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete the notebook session.");
    }
  }

  async function uploadFromPicker() {
    if (!activeNotebook) return;
    setIsUploading(true);
    setNotice("Importing files…");
    try {
      const typed = api as unknown as { notebookPickFiles: (id: string) => Promise<{ sources: NotebookSource[]; failures: string[] }> };
      const { sources: next, failures } = await typed.notebookPickFiles(activeNotebook.id);
      setSources(next);
      const failureNote = failures.length ? ` ${failures.length} file${failures.length === 1 ? "" : "s"} failed: ${failures.slice(0, 3).join(" · ")}${failures.length > 3 ? ` +${failures.length - 3} more` : ""}` : "";
      setNotice(`Indexing in the background — ask in a moment if sources show “indexing”.${failureNote}`);
      void refreshNotebookDetail(activeNotebook.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function importYouTube(url: string) {
    if (!activeNotebook || asking) return;
    const link = url.trim();
    if (!link) return;
    setImportingLink({ kind: "youtube", url: link });
    setNotice("Fetching the video transcript…");
    try {
      const typed = api as unknown as { notebookImportYouTube: (id: string, u: string) => Promise<NotebookSource[]> };
      const next = await typed.notebookImportYouTube(activeNotebook.id, link);
      setSources(next);
      setNotice("Transcript added — indexing in the background, ask in a moment.");
      void refreshNotebookDetail(activeNotebook.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "YouTube import failed.");
    } finally {
      setImportingLink(null);
    }
  }

  async function importWebsite(url: string) {
    if (!activeNotebook || asking) return;
    const link = url.trim();
    if (!link) return;
    setImportingLink({ kind: "website", url: link });
    setNotice("Reading the website (start page plus linked pages)…");
    try {
      const typed = api as unknown as { notebookImportWebsite: (id: string, u: string) => Promise<NotebookSource[]> };
      const next = await typed.notebookImportWebsite(activeNotebook.id, link);
      setSources(next);
      setNotice("Website added — indexing in the background, ask in a moment.");
      void refreshNotebookDetail(activeNotebook.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Website import failed.");
    } finally {
      setImportingLink(null);
    }
  }

  async function uploadBrowserFiles(files: FileList | File[]) {
    if (!activeNotebook) return;
    setIsUploading(true);
    const list = Array.from(files).slice(0, 10);
    const typed = api as unknown as {
      notebookUploadContent: (a: string, b: string, c: string) => Promise<NotebookSource[]>;
      notebookUploadBase64: (a: string, b: string, c: string) => Promise<NotebookSource[]>;
    };
    setNotice(`Uploading ${list.length} file(s)…`);
    try {
      for (const file of list) {
        // Same limit the backend enforces (NOTEBOOK_MAX_UPLOAD_BYTES).
        if (file.size > 15 * 1024 * 1024) {
          setNotice(`${file.name} is over 15 MB — the upload limit is 15 MB.`);
          continue;
        }
        if (/\.(txt|md|markdown|json|csv|log|tex)$/i.test(file.name)) {
          const text = await file.text();
          await typed.notebookUploadContent(activeNotebook.id, file.name, text.slice(0, 500_000));
        } else {
          const buf = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let i = 0; i < buf.length; i += 0x8000) {
            binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          }
          await typed.notebookUploadBase64(activeNotebook.id, file.name, btoa(binary));
        }
      }
      await refreshNotebookDetail(activeNotebook.id);
      setNotice("Indexing in the background — ask in a moment if sources show “indexing”.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  const scopedIds = sources.filter((s) => !excludedIds.includes(s.id)).map((s) => s.id);

  async function ask(providerId?: string, model?: string, topK = 8, questionOverride?: string): Promise<NotebookRagAnswer | null> {
    if (!activeNotebook || !(questionOverride || draft).trim() || asking) return null;
    let chat = activeChat;
    if (!chat) {
      const typed = api as unknown as { notebookCreateChat: (id: string) => Promise<NotebookChat> };
      chat = await typed.notebookCreateChat(activeNotebook.id);
      setChats((prev) => [chat!, ...prev]);
    }
    const question = (questionOverride || draft).trim();
    const scope = scopedIds.length === sources.length ? undefined : scopedIds;
    if (!questionOverride) setDraft("");
    setAsking(true);
    setStreamByChat((prev) => ({ ...prev, [chat!.id]: "" }));
    setStepsByChat((prev) => ({ ...prev, [chat!.id]: ["Starting the notebook agent…"] }));
    setNotice(scope ? `Searching ${scope.length} of ${sources.length} selected files…` : "Searching session files → answering…");
    // Optimistic user message so the transcript never looks stuck.
    setActiveChat((prev) => (prev && chat && prev.id === chat.id ? { ...prev, messages: [...prev.messages, { role: "user", text: question, createdAt: new Date().toISOString() }] } : prev));
    try {
      const typed = api as unknown as {
        notebookAsk: (p: { notebookId: string; chatId: string; question: string; fileIds?: string[]; providerId?: string; model?: string; topK?: number }) => Promise<{ result: NotebookRagAnswer; chat: NotebookChat }>;
      };
      const { result, chat: updated } = await typed.notebookAsk({ notebookId: activeNotebook.id, chatId: chat.id, question, fileIds: scope, providerId, model, topK });
      setActiveChat(updated);
      setChats((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStreamByChat((prev) => {
        const next = { ...prev };
        delete next[chat!.id];
        return next;
      });
      setStepsByChat((prev) => {
        const next = { ...prev };
        delete next[chat!.id];
        return next;
      });
      const meta = result.metadata || {};
      setNotice(
        meta.refused
          ? "Not covered in your files — refused rather than guessed."
          : `Answered from ${result.sources.length} passage${result.sources.length === 1 ? "" : "s"} · top score ${(meta.topScore ?? 0).toFixed(2)} · routed: ${meta.routing || "retrieve"}${meta.fallbackModel ? " · fallback model" : ""}`
      );
      void refreshNotebookDetail(activeNotebook.id);
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Question failed.");
      setStreamByChat((prev) => {
        const next = { ...prev };
        delete next[chat!.id];
        return next;
      });
      setStepsByChat((prev) => {
        const next = { ...prev };
        delete next[chat!.id];
        return next;
      });
      // Roll back the optimistic message on failure.
      if (chat) {
        const typed = api as unknown as { notebookChats: (id: string) => Promise<NotebookChat[]> };
        try {
          const fresh = await typed.notebookChats(activeNotebook.id);
          setChats(fresh);
          setActiveChat(fresh.find((c) => c.id === chat!.id) || null);
        } catch { /* keep optimistic */ }
      }
      return null;
    } finally {
      setAsking(false);
    }
  }

  async function stopAsk() {
    setAsking(false);
    try {
      const typed = api as unknown as { cancelAgent?: (sessionId?: string) => Promise<unknown> };
      if (typeof typed.cancelAgent === "function") {
        await typed.cancelAgent(activeChatRef.current?.id);
      }
    } catch { /* already stopped */ }
  }

  return {
    notebooks,
    activeNotebook,
    setActiveNotebook,
    enterNotebook,
    exitToSessions,
    renameCurrentNotebook,
    sources,
    activeChat,
    stats,
    draft,
    setDraft,
    asking,
    notice,
    setNotice,
    embedding,
    excludedIds,
    scopedIds,
    toggleScope,
    resetScope,
    streamByChat,
    stepsByChat,
    passage,
    settings,
    notes,
    documents,
    quizzes,
    flashcards,
    generatingDoc,
    generatingQuiz,
    generatingFlashcards,
    generateDocument,
    generateQuiz,
    removeQuiz,
    generateFlashcards,
    removeFlashcards,
    mindmaps,
    generatingMindmap,
    generateMindmap,
    removeMindmap,
    summaries,
    generatingSummary,
    generateSummary,
    removeSummary,
    downloadDocument,
    removeDocument,
    openPassage,
    closePassage,
    saveInstructions,
    saveNote,
    removeNote,
    reindexAll,
    refreshNotebooks,
    refreshNotebookDetail,
    createNotebook,
    removeNotebook,
    importYouTube,
    importWebsite,
    uploadFromPicker,
    uploadBrowserFiles,
    importingLink,
    isUploading,
    ingestDetail,
    ask,
    stopAsk,
  };
}
