import { useCallback, useEffect, useRef, useState } from "react";
import type { NotebookChat, NotebookEmbeddingConfig, NotebookMeta, NotebookNote, NotebookPassage, NotebookRagAnswer, NotebookSettings, NotebookSource, NotebookStats } from "../types.js";

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
  const activeChatRef = useRef<NotebookChat | null>(null);
  activeChatRef.current = activeChat;

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
        const [s, c, st, config, savedNotes] = await Promise.all([typed.notebookSources(notebookId), typed.notebookChats(notebookId), typed.notebookStats(notebookId), typed.notebookSettings(notebookId), typed.notebookNotes(notebookId)]);
        setSources(s);
        setChats(c);
        setStats(st);
        setSettings(config);
        setNotes(savedNotes);
        setActiveChat((prev) => {
          if (prev && prev.notebookId === notebookId) {
            return c.find((x) => x.id === prev.id) || c[0] || null;
          }
          return c[0] || null;
        });
      } catch {
        /* backend unavailable */
      }
    },
    []
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

  // Streamed answer tokens for notebook conversations (scoped by chat id so
  // concurrent sessions never mix).
  useEffect(() => {
    if (!enabled) return;
    const typed = api as unknown as { onAgentEvent?: (listener: (event: { type: string; sessionId: string; text: string }) => void) => () => void };
    if (typeof typed.onAgentEvent !== "function") return;
    return typed.onAgentEvent((event) => {
      if (!event.sessionId) return;
      const id = event.sessionId;
      if (event.type === "status") {
        setStepsByChat((prev) => {
          const current = prev[id] || [];
          if (!event.text || current[current.length - 1] === event.text) return prev;
          return { ...prev, [id]: [...current, event.text].slice(-8) };
        });
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

  async function createChat() {
    if (!activeNotebook) return;
    const typed = api as unknown as { notebookCreateChat: (id: string) => Promise<NotebookChat> };
    const chat = await typed.notebookCreateChat(activeNotebook.id);
    setChats((prev) => [chat, ...prev]);
    setActiveChat(chat);
  }

  async function removeChat(chatId: string) {
    if (!activeNotebook) return;
    const typed = api as unknown as { notebookDeleteChat: (a: string, b: string) => Promise<NotebookChat[]> };
    const next = await typed.notebookDeleteChat(activeNotebook.id, chatId);
    setChats(next);
    if (activeChat?.id === chatId) setActiveChat(next[0] || null);
  }

  async function uploadFromPicker() {
    if (!activeNotebook) return;
    setNotice("Importing files…");
    try {
      const typed = api as unknown as { notebookPickFiles: (id: string) => Promise<NotebookSource[]> };
      const next = await typed.notebookPickFiles(activeNotebook.id);
      setSources(next);
      setNotice("Indexing in the background — ask in a moment if sources show “indexing”.");
      setTimeout(() => void refreshNotebookDetail(activeNotebook.id), 4000);
      setTimeout(() => void refreshNotebookDetail(activeNotebook.id), 10000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed.");
    }
  }

  async function uploadBrowserFiles(files: FileList | File[]) {
    if (!activeNotebook) return;
    const list = Array.from(files).slice(0, 10);
    const typed = api as unknown as {
      notebookUploadContent: (a: string, b: string, c: string) => Promise<NotebookSource[]>;
      notebookUploadBase64: (a: string, b: string, c: string) => Promise<NotebookSource[]>;
    };
    setNotice(`Uploading ${list.length} file(s)…`);
    try {
      for (const file of list) {
        if (file.size > 8 * 1024 * 1024) {
          setNotice(`${file.name} is over 8 MB — use the file picker instead.`);
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
      setTimeout(() => activeNotebook && void refreshNotebookDetail(activeNotebook.id), 8000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed.");
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

  return {
    notebooks,
    activeNotebook,
    setActiveNotebook,
    enterNotebook,
    exitToSessions,
    renameCurrentNotebook,
    sources,
    chats,
    activeChat,
    setActiveChat,
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
    createChat,
    removeChat,
    uploadFromPicker,
    uploadBrowserFiles,
    ask,
  };
}
