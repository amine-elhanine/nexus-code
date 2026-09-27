import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type {
  AgentUsage,
  ChatAttachment,
  ChatItem,
  ProviderConfig,
  ProviderDefinition,
  SessionRecord,
} from "../types.js";
import { getSessionUsage } from "../utils/format.js";

export type HomeFile = { path: string; name: string; size: number; modified: string };
export type HomeMemoryStructureView = {
  profile: string[];
  preferences: string[];
  facts: string[];
  context: string[];
  recentDeliverables: Array<{ date: string; summary: string; sessionId?: string }>;
  customNotes?: string;
};

export function sortHomeSessions(list: SessionRecord[]): SessionRecord[] {
  return [...list].sort((a, b) => {
    const tA = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tB = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tB - tA;
  });
}

export function useHomeController(enabled = true) {
  const api = window.nexus || window.forgepilot;

  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [homeRoot, setHomeRoot] = useState("");
  const [homeMemory, setHomeMemory] = useState("");
  const emptyStructure: HomeMemoryStructureView = { profile: [], preferences: [], facts: [], context: [], recentDeliverables: [] };
  const [homeStructure, setHomeStructure] = useState<HomeMemoryStructureView>(emptyStructure);
  const [homeFiles, setHomeFiles] = useState<HomeFile[]>([]);
  const [homeSessionFiles, setHomeSessionFiles] = useState<HomeFile[]>([]);
  const [draft, setDraft] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [liveEvents, setLiveEvents] = useState<Record<string, ChatItem[]>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());

  // In-line session rename state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");

  const liveEventsRef = useRef<Record<string, ChatItem[]>>({});
  liveEventsRef.current = liveEvents;
  // Guards re-submits within the same tick (before runningSessionIds state
  // propagates) — see submit below.
  const submitInflightRef = useRef<Set<string>>(new Set());
  const activeSessionRef = useRef<SessionRecord | null>(null);
  activeSessionRef.current = activeSession;
  const sessionsRef = useRef<SessionRecord[]>([]);
  sessionsRef.current = sessions;

  const refreshFiles = useCallback(async () => {
    try {
      const files = await api.listHomeFiles();
      setHomeFiles(files || []);
    } catch {
      /* ignore file list error */
    }
  }, [api]);

  const refreshSessionFiles = useCallback(
    async (sessionId: string) => {
      if (!sessionId) {
        setHomeSessionFiles([]);
        return;
      }
      try {
        const files = await api.listHomeSessionFiles(sessionId);
        setHomeSessionFiles(files || []);
      } catch {
        setHomeSessionFiles([]);
      }
    },
    [api]
  );

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.listHomeSessions();
      const sorted = sortHomeSessions(list || []);
      setSessions(sorted);
      return sorted;
    } catch {
      return [];
    }
  }, [api]);

  const refreshHomeMemory = useCallback(async () => {
    try {
      const value = await (api as unknown as { getHomeMemory: () => Promise<string> }).getHomeMemory?.();
      if (typeof value === "string") setHomeMemory(value);
    } catch {
      /* memory is best-effort */
    }
    try {
      const detailed = await (api as unknown as { getHomeMemoryStructured?: () => Promise<{ structure: HomeMemoryStructureView }> }).getHomeMemoryStructured?.();
      if (detailed?.structure) setHomeStructure(detailed.structure);
    } catch {
      /* structured view is best-effort */
    }
  }, [api]);

  const saveHomeMemory = useCallback(async (memory: string) => {
    try {
      const value = await (api as unknown as { updateHomeMemory: (m: string) => Promise<string> }).updateHomeMemory?.(memory);
      setHomeMemory(typeof value === "string" ? value : memory);
    } catch (error) {
      console.error("Failed to save home memory", error);
    }
  }, [api]);

  // Initial load
  useEffect(() => {
    let mounted = true;
    void Promise.all([
      api.getHome().catch(() => ({ root: "", project: { id: "home", name: "Home", root: "" } })),
      api.listHomeSessions().catch(() => []),
      api.listHomeFiles().catch(() => []),
      (api as unknown as { getHomeMemory?: () => Promise<string> }).getHomeMemory?.().catch(() => ""),
      (api as unknown as { getHomeMemoryStructured?: () => Promise<{ structure: HomeMemoryStructureView }> }).getHomeMemoryStructured?.().catch(() => null),
    ]).then(([homeInfo, sessionList, files, memory, detailed]) => {
      if (!mounted) return;
      if (homeInfo?.root) setHomeRoot(homeInfo.root);
      const sorted = sortHomeSessions(sessionList || []);
      setSessions(sorted);
      if (files) setHomeFiles(files);
      if (typeof memory === "string") setHomeMemory(memory);
      if (detailed?.structure) setHomeStructure(detailed.structure);
      if (sorted.length > 0) {
        setActiveSession(sorted[0]);
        void refreshSessionFiles(sorted[0].id);
      }
    });

    return () => {
      mounted = false;
    };
  }, [api, refreshSessionFiles]);

  // Subscribe to agent streaming and events for Home sessions
  useEffect(() => {
    return api.onAgentEvent((event) => {
      const bucket = event.sessionId || "unknown";
      // Verify whether this event belongs to a Home session
      const isHomeSession = sessionsRef.current.some((s) => s.id === bucket) || (activeSessionRef.current?.id === bucket);
      if (!isHomeSession && event.sessionId) return;

      if (event.type === "token") {
        if (activeSessionRef.current?.id && event.sessionId === activeSessionRef.current.id) {
          setStreamingText((curr) => curr + event.text);
        }
        return;
      }

      // While tool actions or steps are running, clear any speculative pre-tool text
      if (event.type === "tool" || event.type === "status" || event.type === "plan") {
        if (activeSessionRef.current?.id && event.sessionId === activeSessionRef.current.id) {
          setStreamingText("");
        }
      }

      const item: ChatItem = {
        role: event.type === "assistant" ? "assistant" : "event",
        text: event.text,
        kind: event.type,
        createdAt: event.timestamp,
        usage: event.usage,
        subagent: event.subagent,
        plan: event.items,
        artifact: event.artifact,
        detail: event.detail,
      };

      if (event.type === "assistant" || event.type === "error") {
        const log = liveEventsRef.current[bucket] || [];
        const { [bucket]: _dropped, ...rest } = liveEventsRef.current;
        liveEventsRef.current = rest;
        setLiveEvents(rest);
        setStreamingText("");
        setRunningSessionIds((curr) => {
          const next = new Set(curr);
          next.delete(bucket);
          return next;
        });

        // Deterministic display (Code parity): fold the final item into the
        // local transcript NOW from the event itself. The backend refetch
        // below only reconciles — previously display depended entirely on a
        // refetch that fires before the backend has persisted the answer,
        // so the streamed text vanished with nothing replacing it.
        const targetSessionId = bucket;
        setActiveSession((current) => {
          if (!current || current.id !== targetSessionId) return current;
          const logItems = log.filter((entry) => !(entry.kind === "usage"));
          const finalItem: ChatItem = event.type === "assistant"
            ? { role: "assistant", text: event.text, createdAt: event.timestamp || new Date().toISOString(), usage: event.usage }
            : { role: "event", kind: "error", text: event.text, createdAt: event.timestamp || new Date().toISOString() };
          const tail = current.messages[current.messages.length - 1] as ChatItem | undefined;
          if (tail && tail.role === finalItem.role && tail.text === finalItem.text && (tail.kind || null) === (finalItem.kind || null)) return current;
          return { ...current, messages: [...current.messages, ...logItems, finalItem] };
        });
        // Background reconcile with server truth (usage totals, memory, files).
        // Never clobber: if the server copy is shorter than local, its persist
        // simply hasn't landed yet — keep local until the next refresh.
        void api.activateHomeSession(bucket).then((fresh) => {
          if (!fresh || fresh.id !== targetSessionId) return;
          setActiveSession((prev) => {
            if (!prev || prev.id !== targetSessionId) return prev;
            const serverMessages = (fresh.messages || []) as ChatItem[];
            if (serverMessages.length < prev.messages.length) return prev;
            void refreshSessionFiles(fresh.id);
            return { ...prev, ...fresh, messages: serverMessages };
          });
        });
        void refreshFiles();
        void refreshSessions();
      } else {
        const nextLog = [...(liveEventsRef.current[bucket] || []), item];
        const next = { ...liveEventsRef.current, [bucket]: nextLog };
        liveEventsRef.current = next;
        setLiveEvents(next);
      }
    });
  }, [api, refreshFiles, refreshSessionFiles, refreshSessions]);

  const createChat = useCallback(async (title = "New chat") => {
    try {
      const newSession = await api.createHomeSession(title);
      setSessions((curr) => sortHomeSessions([newSession, ...curr]));
      setActiveSession(newSession);
      setHomeSessionFiles([]);
      setDraft("");
      setAttachedImages([]);
      setAttachments([]);
      return newSession;
    } catch (error) {
      console.error("Failed to create home session", error);
      return null;
    }
  }, [api]);

  const selectChat = useCallback(
    async (sessionId: string) => {
      try {
        const session = await api.activateHomeSession(sessionId);
        if (session) {
          setActiveSession(session);
          setStreamingText("");
          void refreshSessionFiles(session.id);
        }
      } catch (error) {
        console.error("Failed to activate home session", error);
      }
    },
    [api, refreshSessionFiles]
  );

  const deleteChat = useCallback(
    async (sessionId: string, options?: { deleteFiles?: boolean }) => {
      try {
        await api.deleteHomeSession(sessionId, options);
        const updated = await refreshSessions();
        if (activeSession?.id === sessionId) {
          const next = updated[0] || null;
          setActiveSession(next);
          if (next) void refreshSessionFiles(next.id);
          else setHomeSessionFiles([]);
        }
        void refreshFiles();
      } catch (error) {
        console.error("Failed to delete home session", error);
      }
    },
    [activeSession?.id, api, refreshFiles, refreshSessionFiles, refreshSessions]
  );

  const startRename = useCallback((session: SessionRecord) => {
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  }, []);

  const commitRename = useCallback(async () => {
    if (!editingSessionId) return;
    const title = editingSessionTitle.trim();
    if (title) {
      await api.updateHomeSession(editingSessionId, { title });
      await refreshSessions();
      if (activeSession?.id === editingSessionId) {
        setActiveSession((curr) => (curr ? { ...curr, title } : null));
      }
    }
    setEditingSessionId(null);
    setEditingSessionTitle("");
  }, [activeSession?.id, api, editingSessionId, editingSessionTitle, refreshSessions]);

  const cancelRename = useCallback(() => {
    setEditingSessionId(null);
    setEditingSessionTitle("");
  }, []);

  const submit = useCallback(
    async (
      overrideText?: string,
      modelConfig?: { providerId: string; model: string }
    ) => {
      const text = (overrideText ?? draft).trim();
      if (!text && !attachedImages.length && !attachments.length) return;

      let currentActive = activeSessionRef.current;
      if (!currentActive) {
        currentActive = await createChat();
        if (!currentActive) return;
      }

      const sessionId = currentActive.id;
      // Drop re-submits while this chat's run is still active (e.g. double
      // Enter during silent setup) — the backend rejects twins, but the
      // optimistic user message below would already corrupt the transcript.
      if (submitInflightRef.current.has(sessionId)) return;
      submitInflightRef.current.add(sessionId);
      const imagesToSend = [...attachedImages];
      const attachmentsToSend = [...attachments];

      setDraft("");
      setAttachedImages([]);
      setAttachments([]);
      setStreamingText("");
      setRunningSessionIds((curr) => new Set(curr).add(sessionId));

      // Append user turn locally for instant feedback
      setActiveSession((curr) => {
        if (!curr || curr.id !== sessionId) return curr;
        return {
          ...curr,
          messages: [
            ...curr.messages,
            {
              role: "user",
              text,
              images: imagesToSend.length ? imagesToSend : undefined,
              attachments: attachmentsToSend.length ? attachmentsToSend : undefined,
              createdAt: new Date().toISOString(),
            },
          ],
        };
      });

      try {
        await api.runHomeAgent({
          sessionId,
          request: text,
          images: imagesToSend.length ? imagesToSend : undefined,
          attachments: attachmentsToSend.length ? attachmentsToSend : undefined,
          providerId: modelConfig?.providerId,
          model: modelConfig?.model,
        });
      } catch (error) {
        console.error("Home agent run failed", error);
      } finally {
        submitInflightRef.current.delete(sessionId);
        setRunningSessionIds((curr) => {
          const next = new Set(curr);
          next.delete(sessionId);
          return next;
        });
        const fresh = await api.activateHomeSession(sessionId);
        if (fresh) {
          // Same never-clobber AND never-hijack rule as the event path: if
          // the user switched to another chat while this run finished, the
          // completed session must not yank the view back.
          setActiveSession((prev) => {
            if (!prev || prev.id !== fresh.id) return prev;
            const serverMessages = (fresh.messages || []) as ChatItem[];
            if (serverMessages.length < prev.messages.length) return prev;
            return fresh;
          });
          void refreshSessionFiles(fresh.id);
        }
        void refreshFiles();
        void refreshSessions();
        void refreshHomeMemory();
      }
    },
    [activeSessionRef, api, attachedImages, attachments, createChat, draft, refreshFiles, refreshHomeMemory, refreshSessionFiles, refreshSessions]
  );

  const stopAgent = useCallback(async () => {
    const active = activeSessionRef.current;
    if (active) {
      await api.cancelHomeAgent(active.id);
    }
  }, [api]);

  const running = Boolean(activeSession && runningSessionIds.has(activeSession.id));
  const currentMessages = (activeSession?.messages || []) as ChatItem[];
  const liveEventsForActive = activeSession ? liveEvents[activeSession.id] || [] : [];
  const currentSessionUsage = useMemo(
    () => (activeSession ? getSessionUsage(activeSession) : null),
    [activeSession]
  );

  return {
    sessions,
    activeSession,
    homeRoot,
    homeFiles,
    homeSessionFiles,
    draft,
    setDraft,
    attachedImages,
    setAttachedImages,
    attachments,
    setAttachments,
    streamingText,
    liveEvents: liveEventsForActive,
    running,
    sessionUsage: currentSessionUsage,
    currentMessages,
    editingSessionId,
    editingSessionTitle,
    setEditingSessionTitle,
    startRename,
    commitRename,
    cancelRename,
    createChat,
    selectChat,
    deleteChat,
    submit,
    stopAgent,
    refreshFiles,
    refreshSessionFiles,
    refreshSessions,
    homeMemory,
    setHomeMemory,
    refreshHomeMemory,
    saveHomeMemory,
    homeStructure,
    removeFact: async (category: string, fact: string) => {
      try {
        const structure = await (api as unknown as { removeHomeMemoryFact: (c: string, f: string) => Promise<HomeMemoryStructureView> }).removeHomeMemoryFact(category, fact);
        if (structure) setHomeStructure(structure);
        void refreshHomeMemory();
      } catch (error) {
        console.error("Failed to remove memory fact", error);
      }
    },
    clearSessionMemory: async () => {
      const active = activeSessionRef.current;
      if (!active) return;
      try {
        const fresh = await api.updateHomeSession(active.id, { memory: "" });
        setActiveSession(fresh);
      } catch (error) {
        console.error("Failed to clear session memory", error);
      }
    },
    saveMemories: async (nextHomeMemory: string, nextSessionMemory: string) => {
      await saveHomeMemory(nextHomeMemory);
      const active = activeSessionRef.current;
      if (active) {
        try {
          const fresh = await api.updateHomeSession(active.id, { memory: nextSessionMemory });
          setActiveSession(fresh);
        } catch (error) {
          console.error("Failed to save home session memory", error);
        }
      }
    },
  };
}
