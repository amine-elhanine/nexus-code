import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { nowIso, pushLiveEvent } from "../utils/format.js";
import type {
  AppView,
  ArtifactItem,
  ChatItem,
  ConfirmDialogState,
  FileEntry,
  ProjectRecord,
  ProviderConfig,
  ProviderDefinition,
  SessionRecord,
  WorkspaceDiffFile,
  ChatAttachment,
} from "../types.js";

export const FALLBACK_PROVIDERS: ProviderDefinition[] = [
  { id: "openai", label: "OpenAI", packageName: "@langchain/openai", envKey: "OPENAI_API_KEY", models: ["gpt-5.5", "gpt-5.5-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"] },
  { id: "anthropic", label: "Anthropic", packageName: "@langchain/anthropic", envKey: "ANTHROPIC_API_KEY", models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  { id: "google", label: "Google Gemini", packageName: "@langchain/google-genai", envKey: "GOOGLE_API_KEY", models: ["gemini-3.7-pro", "gemini-3.7-flash", "gemini-2.5-flash"] },
  { id: "mistral", label: "Mistral", packageName: "@langchain/mistralai", envKey: "MISTRAL_API_KEY", models: ["mistral-large-latest", "codestral-latest", "mistral-small-latest"] },
  { id: "groq", label: "Groq", packageName: "@langchain/groq", envKey: "GROQ_API_KEY", models: ["openai/gpt-oss-120b", "llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b"] },
  { id: "xai", label: "xAI", packageName: "@langchain/xai", envKey: "XAI_API_KEY", models: ["grok-4", "grok-4-fast", "grok-3-mini"] },
  { id: "openrouter", label: "OpenRouter", packageName: "@langchain/openrouter", envKey: "OPENROUTER_API_KEY", models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "google/gemini-3.7-pro"] },
  { id: "ollama", label: "Ollama", packageName: "@langchain/ollama", envKey: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434", models: ["qwen3-coder", "devstral", "llama3.3"] },
  { id: "deepseek", label: "DeepSeek", packageName: "@langchain/deepseek", envKey: "DEEPSEEK_API_KEY", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "opencode-zen", label: "OpenCode Zen", packageName: "@langchain/openai", envKey: "OPENCODE_API_KEY", defaultBaseUrl: "https://opencode.ai/zen/v1", models: ["kimi-k2.6", "kimi-k2.5", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "qwen3.7-max", "claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.5"] },
  { id: "together", label: "Together AI", packageName: "@langchain/community", envKey: "TOGETHER_AI_KEY", models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"] },
  { id: "fireworks", label: "Fireworks", packageName: "@langchain/community", envKey: "FIREWORKS_API_KEY", models: ["accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/qwen3-coder"] },
  { id: "azure", label: "Azure OpenAI", packageName: "@langchain/openai", envKey: "AZURE_OPENAI_API_KEY", models: ["gpt-5.5", "gpt-4.1", "o3"] },
  { id: "bedrock", label: "AWS Bedrock", packageName: "@langchain/aws", envKey: "AWS_ACCESS_KEY_ID", models: ["anthropic.claude-sonnet-4-6", "amazon.nova-pro-v1:0"] },
  { id: "custom", label: "Custom (OpenAI-compatible)", packageName: "@langchain/openai", envKey: "CUSTOM_API_KEY", models: [] },
];

export function useAppController() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerDefinitions, setProviderDefinitions] = useState<ProviderDefinition[]>(FALLBACK_PROVIDERS);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [gitBranch, setGitBranch] = useState("No Git repository");
  const [activeFile, setActiveFile] = useState("");
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [diff, setDiff] = useState<WorkspaceDiffFile[]>([]);
  // Keep each workspace's composer independent. Switching between Home and
  // Code must not leak an unfinished prompt or its attachments into the
  // other agent, and returning should restore exactly what was left there.
  const [homeDraft, setHomeDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  // Live events are bucketed per session so concurrent runs in different
  // sessions each render their own activity, never each other's.
  const [liveEvents, setLiveEvents] = useState<Record<string, ChatItem[]>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const liveEventsRef = useRef<Record<string, ChatItem[]>>({});
  const activeSessionRef = useRef<SessionRecord | null>(null);
  activeSessionRef.current = activeSession ?? null;
  const [view, setView] = useState<AppView>("chat");
  const [mode, setMode] = useState("Ask");
  const [showSessions, setShowSessions] = useState(true);
  const [showContext, setShowContext] = useState(true);
  const [showProviders, setShowProviders] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<{ isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null>(null);
  const [homeAttachedImages, setHomeAttachedImages] = useState<string[]>([]);
  const [codeAttachedImages, setCodeAttachedImages] = useState<string[]>([]);
  const [homeAttachments, setHomeAttachments] = useState<ChatAttachment[]>([]);
  const [codeAttachments, setCodeAttachments] = useState<ChatAttachment[]>([]);
  const [projectRules, setProjectRules] = useState<{ hasRules: boolean; ruleFiles: any[]; combinedPromptSection: string } | null>(null);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  // Area: "home" = general assistant, "code" = repo coding agent, "notebook" = isolated RAG notebooks.
  const [area, setArea] = useState<"home" | "code" | "notebook">("home");
  const [homeProject, setHomeProject] = useState<ProjectRecord | null>(null);
  const [homeRoot, setHomeRoot] = useState("");
  const [homeFiles, setHomeFiles] = useState<Array<{ path: string; name: string; size: number; modified: string }>>([]);
  const [homeSessionFiles, setHomeSessionFiles] = useState<Array<{ path: string; name: string; size: number; modified: string }>>([]);
  const [showDaemonsModal, setShowDaemonsModal] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [inspectDiffFile, setInspectDiffFile] = useState<WorkspaceDiffFile | null>(null);
  const [undoing, setUndoing] = useState(false);

  const draft = area === "home" ? homeDraft : codeDraft;
  const setDraft = (value: SetStateAction<string>) => (area === "home" ? setHomeDraft(value) : setCodeDraft(value));
  const attachedImages = area === "home" ? homeAttachedImages : codeAttachedImages;
  const setAttachedImages = (updater: SetStateAction<string[]>) => {
    if (area === "home") setHomeAttachedImages(updater);
    else setCodeAttachedImages(updater);
  };
  const attachments = area === "home" ? homeAttachments : codeAttachments;
  const setAttachments = (updater: SetStateAction<ChatAttachment[]>) => {
    if (area === "home") setHomeAttachments(updater);
    else setCodeAttachments(updater);
  };

  const dirty = fileContent !== savedContent;
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const definition = providerDefinitions.find((provider) => provider.id === selectedProvider?.provider) || providerDefinitions[0];
  const currentMessages = (activeSession?.messages || []) as ChatItem[];
  const running = Boolean(activeSession && runningSessionIds.has(activeSession.id));
  const liveEventsForSession = activeSession ? liveEvents[activeSession.id] || [] : [];
  const visibleFiles = files.filter((entry) => {
    const parts = entry.path.split("/");
    return parts.length === 1 || parts.slice(0, -1).every((_, index) => expandedFolders.has(parts.slice(0, index + 1).join("/")));
  });

  const api = window.nexus || window.forgepilot;

  useEffect(() => {
    void Promise.all([
      api.listProjects(),
      api.listProviders(),
      api.listProviderDefinitions(),
      api.getSkillsConfig(),
      api.listCustomCommands(),
    ]).then(async ([projectList, providerList, definitions, skillsConfig, cmds]) => {
      setProjects(projectList);
      setProviders(providerList);
      if (definitions?.length) setProviderDefinitions(definitions);
      setSkillsEnabled(skillsConfig?.enabled !== false);
      if (cmds?.length) setCustomCommands(cmds as SlashCommand[]);
      // Land on Home by default; coding projects stay one click away.
      try {
        const home = await api.getHome();
        setHomeProject(home.project);
        setHomeRoot(home.root);
        setActiveProject(home.project);
        const homeSessions = await api.listSessions(home.project.id);
        setSessions(homeSessions);
        // Activate, don't just display: the main process tracks the active
        // project/session in globals, and agent:run refuses ("Select or
        // create a project first") until something is activated.
        if (homeSessions[0]) {
          const sess = await api.activateSession(home.project.id, homeSessions[0].id);
          setActiveSession(sess);
          setSelectedProviderId(sess.model?.providerId || "");
          setSelectedModel(sess.model?.model || "");
        } else {
          setActiveSession(null);
        }
        void refreshHomeFiles();
      } catch {
        if (projectList[0]) await activateProject(projectList[0].id);
      }
    });

    return api.onAgentEvent((event) => {
      const bucket = event.sessionId || "unknown";
      // Events from a session other than the currently viewed one still
      // accumulate (so switching later shows them) but don't stream into view.
      if (event.type === "token") {
        if (activeSession?.id && event.sessionId === activeSession.id) {
          setStreamingText((current) => current + event.text);
        }
        return;
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
      };
      if (event.type === "artifact" && event.artifact) {
        if (event.artifact.filename === "implementation_plan.md" && event.artifact.status === "pending_approval") {
          setActiveArtifact(event.artifact);
        }
      }
      if (event.type === "assistant" || event.type === "error") {
        const log = liveEventsRef.current[bucket] || [];
        const { [bucket]: _dropped, ...rest } = liveEventsRef.current;
        liveEventsRef.current = rest;
        setLiveEvents(rest);
        if (event.type === "assistant" && event.usage) {
          setStreamingText("");
        } else {
          setStreamingText("");
        }
        setRunningSessionIds((current) => {
          const next = new Set(current);
          next.delete(bucket);
          return next;
        });
        // Reflect the completed response and folded activity log into the active session immediately.
        const targetSessionId = bucket;
        setActiveSession((current) => {
          if (!current || current.id !== targetSessionId) return current;
          const base = current.messages;
          const logItems = log.filter((entry) => !(entry.kind === "usage"));
          const finalItem: ChatItem = event.type === "assistant"
            ? { role: "assistant", text: event.text, createdAt: event.timestamp || nowIso(), usage: event.usage }
            : { role: "event", kind: "error", text: event.text, createdAt: event.timestamp || nowIso() };
          return { ...current, messages: [...base, ...logItems, finalItem] };
        });
        void api.listSessions(activeProject?.id || "").then((fresh) => {
          if (!fresh) return;
          setSessions(fresh as unknown as SessionRecord[]);
          const freshCurrent = (fresh as unknown as SessionRecord[]).find((s) => s.id === targetSessionId);
          if (freshCurrent) {
            setActiveSession((prev) => (prev && prev.id === targetSessionId ? { ...prev, messages: freshCurrent.messages, usage: freshCurrent.usage, checkpointId: freshCurrent.checkpointId, checkpointIds: freshCurrent.checkpointIds } : prev));
          }
        }).catch(() => { /* sidebar keeps its current list */ });
        return;
      }
      liveEventsRef.current = pushLiveEvent(liveEventsRef.current, bucket, item);
      setLiveEvents(liveEventsRef.current);
    });
  }, []);

  // Keep the Home right sidebar in sync: per-session files follow the active
  // home chat and refresh whenever the global file list changes (new docs).
  useEffect(() => {
    if (area !== "home" || !activeSession?.id) {
      if (area !== "home") setHomeSessionFiles([]);
      return;
    }
    void refreshHomeSessionFiles(activeSession.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, activeSession?.id, homeFiles.length]);

  function resetWorkspace() {
    setFiles([]);
    setExpandedFolders(new Set());
    setActiveFile("");
    setOpenFiles([]);
    setFileContent("");
    setSavedContent("");
    setDiff([]);
    setGitBranch("No Git repository");
  }

  async function loadGit() {
    try {
      const info = await api.getGit();
      setGitBranch(info.branch);
    } catch {
      setGitBranch("No Git repository");
    }
  }

  async function activateProject(projectId: string) {
    resetWorkspace();
    const result = await api.activateProject(projectId);
    setActiveProject(result.project);
    setActiveSession(result.session);
    setSessions(result.project.sessions);
    const currentProviders = await api.listProviders();
    setProviders(currentProviders);
    const sessionModel = result.session?.model;
    const targetProvider = sessionModel ? currentProviders.find((p) => p.id === sessionModel.providerId) : undefined;
    const isValid = targetProvider && sessionModel ? targetProvider.models.includes(sessionModel.model) : false;
    if (isValid && sessionModel) {
      setSelectedProviderId(sessionModel.providerId);
      setSelectedModel(sessionModel.model);
    } else if (currentProviders.length > 0) {
      setSelectedProviderId(currentProviders[0].id);
      setSelectedModel(currentProviders[0].models[0] || "");
    } else {
      setSelectedProviderId("");
      setSelectedModel("");
    }
    void api.getProjectRules(projectId).then(setProjectRules).catch(() => setProjectRules(null));
    void api.listCustomCommands().then((c) => setCustomCommands(c as SlashCommand[])).catch(() => {});
    await loadWorkspace();
  }

  async function loadWorkspace() {
    resetWorkspace();
    try {
      const paths = await api.listWorkspace();
      const mapped = paths.map((p) => ({
        path: p.replace(/\\/g, "/").replace(/\/$/, ""),
        kind: p.endsWith("/") ? ("folder" as const) : ("file" as const),
      }));
      setFiles(mapped);
      const first = mapped.find((item) => item.kind === "file");
      if (first) await openFile(first.path);
      await loadGit();
      // Keep the Undo button / diff counts truthful right after (re)load.
      try {
        setDiff(await api.getDiff());
      } catch {
        /* diff stays empty */
      }
    } catch {
      setFiles([]);
      setGitBranch("No Git repository");
    }
  }

  function toggleFolder(folder: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  function deleteProjectById(projectId: string) {
    const proj = projects.find((p) => p.id === projectId);
    setConfirmDialog({
      title: `Delete project "${proj?.name || "project"}"?`,
      message: "This will permanently delete the project and all its saved coding sessions.",
      confirmLabel: "Delete project",
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const remaining = await api.deleteProject(projectId);
          setProjects(remaining);
          if (projectId === activeProject?.id) {
            resetWorkspace();
            setActiveProject(null);
            setActiveSession(null);
            setSessions([]);
          }
        } catch (error) {
          console.error(error);
        }
      },
    });
  }

  function deleteActiveSession(sessionId: string) {
    if (!activeProject) return;
    const sess = sessions.find((s) => s.id === sessionId);
    const isHomeProject = activeProject.id === "home";
    // Home chats own files in the Nexus folder: count them first so the
    // confirm dialog states exactly what will be removed from disk.
    const showDialog = (ownedFiles: number) => {
      const homeSuffix = ownedFiles > 0 ? ` Its ${ownedFiles} file${ownedFiles === 1 ? "" : "s"} in the Nexus folder will also be permanently deleted.` : "";
      setConfirmDialog({
        title: `Delete session "${sess?.title || "session"}"?`,
        message: isHomeProject
          ? `This will permanently delete this chat and its memory.${homeSuffix}`
          : "This will permanently delete this coding session and its memory.",
        confirmLabel: "Delete session",
        danger: true,
        onConfirm: async () => {
          setConfirmDialog(null);
          try {
            const updatedProject = await api.deleteSession(activeProject.id, sessionId, isHomeProject ? { deleteFiles: true } : undefined);
            setProjects((current) => current.map((p) => (p.id === updatedProject.id ? updatedProject : p)));
            setSessions(updatedProject.sessions);
            const nextSession = updatedProject.sessions[0] || null;
            setActiveSession(nextSession);
          if (nextSession) {
            const m = nextSession.model;
            const p = m ? providers.find((x) => x.id === m.providerId) : undefined;
            if (p && m && p.models.includes(m.model)) {
              setSelectedProviderId(m.providerId);
              setSelectedModel(m.model);
            } else if (providers.length > 0) {
              setSelectedProviderId(providers[0].id);
              setSelectedModel(providers[0].models[0] || "");
            } else {
              setSelectedProviderId("");
              setSelectedModel("");
            }
          }
        } catch (error) {
          console.error(error);
        }
        // The file panel must not keep showing files that were just deleted.
        if (isHomeProject) void refreshHomeFiles();
      },
    });
    };
    if (isHomeProject) {
      void (api.listHomeSessionFiles(sessionId) as Promise<Array<unknown>>)
        .then((files) => showDialog(files.length))
        .catch(() => showDialog(0));
    } else {
      showDialog(0);
    }
  }

  async function renameSession(sessionId: string, title: string) {
    if (!activeProject) return;
    const next = title.trim().slice(0, 80);
    if (!next) return;
    try {
      const updated = await api.updateSession(activeProject.id, sessionId, { title: next });
      setSessions((current) => current.map((s) => (s.id === updated.id ? updated : s)));
      setActiveSession((current) => (current && current.id === updated.id ? updated : current));
    } catch (error) {
      console.error(error);
    }
  }

  async function openProjectFromDialog() {
    const result = await api.selectProject();
    if (!result) return;
    resetWorkspace();
    setProjects(await api.listProjects());
    setActiveProject(result.project);
    setActiveSession(result.session);
    setSessions(result.project.sessions);
    setSelectedProviderId(result.session.model?.providerId || "");
    setSelectedModel(result.session.model?.model || "");
    await loadWorkspace();
  }

  async function createSession() {
    if (!activeProject) return;
    const sess = await api.createSession(activeProject.id, "New coding task");
    setSessions((current) => [sess, ...current]);
    setActiveSession(sess);
    setView("chat");
  }

  async function refreshHomeFiles() {
    try {
      setHomeFiles(await api.listHomeFiles());
    } catch {
      setHomeFiles([]);
    }
    // Per-session files depend on the global list; refresh them too so the
    // Home right sidebar never goes stale after a download/refresh.
    void refreshHomeSessionFiles();
  }

  async function refreshHomeSessionFiles(sessionId?: string) {
    const targetId = sessionId ?? activeSessionRef.current?.id;
    if (!targetId) {
      setHomeSessionFiles([]);
      return;
    }
    try {
      const fn = (api as unknown as { listHomeSessionFiles?: (id: string) => Promise<Array<{ path: string; name: string; size: number; modified: string }>> }).listHomeSessionFiles;
      if (typeof fn === "function") {
        setHomeSessionFiles(await fn.call(api, targetId));
      } else {
        // Older preload without the new channel: fall back to global list.
        setHomeSessionFiles([]);
      }
    } catch {
      setHomeSessionFiles([]);
    }
  }

  async function createHomeSession() {
    const home = homeProject || (await api.getHome()).project;
    if (!homeProject) {
      const info = await api.getHome();
      setHomeProject(info.project);
      setHomeRoot(info.root);
    }
    const sess = await api.createSession(home.id, "New chat");
    setSessions((current) => [sess, ...current]);
    setActiveSession(sess);
    setHomeSessionFiles([]);
    return sess;
  }

  async function enterHome() {
    setArea("home");
    setStreamingText("");
    try {
      const info = await api.getHome();
      setHomeProject(info.project);
      setHomeRoot(info.root);
      setActiveProject(info.project);
      const homeSessions = await api.listSessions(info.project.id);
      setSessions(homeSessions);
      // Same as on launch: activate so the main process globals (used by
      // agent:run) point at this session immediately.
      if (homeSessions[0]) {
        const sess = await api.activateSession(info.project.id, homeSessions[0].id);
        setActiveSession(sess);
        setSelectedProviderId(sess.model?.providerId || selectedProviderId);
        setSelectedModel(sess.model?.model || selectedModel);
        void refreshHomeSessionFiles(sess.id);
      } else {
        setActiveSession(null);
        setHomeSessionFiles([]);
      }
      setWorktreeStatus(null);
      void refreshHomeFiles();
    } catch {
      /* home stays empty until backend recovers */
    }
  }

  async function enterCode() {
    setArea("code");
    setStreamingText("");
    const codeProjects = projects.filter((p) => p.id !== "home");
    const target = codeProjects.find((p) => p.id === activeProject?.id && p.id !== "home") || codeProjects[0];
    if (target) await activateProject(target.id);
  }

  function enterNotebook() {
    setArea("notebook");
    setStreamingText("");
  }

  async function activateSession(sessionId: string) {
    if (!activeProject) return;
    const sess = await api.activateSession(activeProject.id, sessionId);
    setActiveSession(sess);
    setStreamingText("");
    if (activeProject.id === "home") {
      setWorktreeStatus(null);
      void refreshHomeSessionFiles(sess.id);
    } else {
      try {
        const wt = await api.getWorktreeStatus(sessionId);
        setWorktreeStatus(wt);
      } catch {
        setWorktreeStatus(null);
      }
    }
    const targetProvider = sess.model ? providers.find((p) => p.id === sess.model?.providerId) : undefined;
    const isValid = targetProvider && sess.model ? targetProvider.models.includes(sess.model.model) : false;
    if (isValid && sess.model) {
      setSelectedProviderId(sess.model.providerId);
      setSelectedModel(sess.model.model);
    } else if (providers.length > 0) {
      setSelectedProviderId(providers[0].id);
      setSelectedModel(providers[0].models[0] || "");
    } else {
      setSelectedProviderId("");
      setSelectedModel("");
    }
    setView("chat");
  }

  async function openFile(file: string) {
    if (file.endsWith("/")) return;
    setActiveFile(file);
    setOpenFiles((current) => (current.includes(file) ? current : [...current, file]));
    try {
      const result = await api.readFile(file);
      setFileContent(result.content);
      setSavedContent(result.content);
    } catch {
      setFileContent(`// Unable to read ${file}`);
      setSavedContent("");
    }
  }

  async function saveFile() {
    if (!activeFile || !dirty) return;
    await api.writeFile(activeFile, fileContent);
    setSavedContent(fileContent);
    await refreshDiff();
  }

  async function refreshDiff() {
    try {
      setDiff(await api.getDiff());
    } catch {
      setDiff([]);
    }
  }

  async function submit(overrideRequest?: string) {
    const rawRequest = (overrideRequest || draft).trim();
    const hasFiles = attachedImages.length > 0 || attachments.length > 0;
    if ((!rawRequest && !hasFiles) || running) return;
    // Attachment-only sends get a readable transcript line; the agent still
    // receives the extracted file contents via attachmentDocs.
    const request = rawRequest || `Please review the attached file${attachments.length === 1 ? "" : "s"}: ${attachments.map((a) => a.name).join(", ")}`;
    // Home creates its chat lazily on first send so landing on Home never
    // litters the sidebar with empty sessions.
    let session = activeSession;
    if (area === "home" && homeProject && !session) {
      session = await createHomeSession();
    }
    if (!activeProject || !session) {
      setView("files");
      return;
    }
    if (!providers.length) {
      setShowProviders(true);
      return;
    }
    const imagesToSend = attachedImages.length ? [...attachedImages] : undefined;
    const attachmentsToSend = attachments.length ? [...attachments] : undefined;
    setAttachedImages([]);
    setAttachments([]);
    setRunningSessionIds((current) => new Set(current).add(session.id));
    setDraft("");
    setStreamingText("");
    const { [session.id]: _dropped, ...rest } = liveEventsRef.current;
    liveEventsRef.current = rest;
    setLiveEvents(rest);
    setActiveSession((current) =>
      current
        ? {
            ...current,
            messages: [...current.messages, { role: "user", text: request, images: imagesToSend, attachments: attachmentsToSend, createdAt: nowIso() }],
          }
        : current
    );
    try {
      await api.runAgent({
        request,
        images: imagesToSend,
        attachments: attachmentsToSend,
        providerId: selectedProviderId || undefined,
        model: selectedModel || undefined,
        // Home always runs fully autonomously; the coding area keeps its
        // Plan / Ask / Auto selector.
        mode: area === "home" ? "auto" : mode.toLowerCase(),
      });
      // The final assistant message and transcript are persisted by the main
      // process; refresh from the store so usage/checkpoint state is exact.
      try {
        if (activeProject) {
          const freshSessions = await api.listSessions(activeProject.id);
          setSessions(freshSessions as unknown as SessionRecord[]);
          const freshCurrent = (freshSessions as unknown as SessionRecord[]).find((s) => s.id === session.id);
          if (freshCurrent) {
            setActiveSession((prev) => (prev && prev.id === session.id ? { ...prev, messages: freshCurrent.messages, usage: freshCurrent.usage, checkpointId: freshCurrent.checkpointId, checkpointIds: freshCurrent.checkpointIds } : prev));
          }
          const wt = await api.getWorktreeStatus(session.id);
          setWorktreeStatus(wt);
        }
        // Home deliverables land in the Nexus folder — refresh the files
        // panel so new documents appear with their download buttons.
        // refreshHomeFiles also refreshes per-session files via the watcher,
        // but force it here with the explicit id (ref may lag mid-run).
        if (area === "home") {
          await refreshHomeFiles();
          await refreshHomeSessionFiles(session.id);
        } else {
          // Code runs edit the workspace: refresh files + diff so the
          // one-click Undo button and the Diff tab are correct immediately.
          await refreshDiff();
          await loadWorkspace();
        }
      } catch {
        /* sidebar keeps its current list */
      }
    } catch (error) {
      setRunningSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      setStreamingText("");
      const log = liveEventsRef.current[session.id] || [];
      delete liveEventsRef.current[session.id];
      setLiveEvents(liveEventsRef.current);
      setActiveSession((current) =>
        current && current.id === session.id
          ? {
              ...current,
              messages: [
                ...current.messages,
                ...log,
                { role: "event", kind: "error", text: error instanceof Error ? error.message : "Agent failed", createdAt: nowIso() },
              ],
            }
          : current
      );
    }
  }

  async function stopAgent() {
    try {
      // Scoped: only this session's run is cancelled, others keep working.
      await api.cancelAgent(activeSession?.id);
    } catch {
      /* already stopped */
    }
  }

  async function refreshActiveSession() {
    if (!activeProject || !activeSession) return;
    try {
      const freshSessions = await api.listSessions(activeProject.id);
      setSessions(freshSessions as unknown as SessionRecord[]);
      const freshCurrent = (freshSessions as unknown as SessionRecord[]).find((s) => s.id === activeSession.id);
      if (freshCurrent) setActiveSession(freshCurrent);
    } catch { /* keep current session on failure */ }
  }

  function undoStack(): string[] {
    if (activeSession?.checkpointIds?.length) return activeSession.checkpointIds;
    if (activeSession?.checkpointId) return [activeSession.checkpointId];
    return [];
  }

  async function undoRun(checkpointId: string) {
    if (!checkpointId || !activeSession || !activeProject || undoing) return;
    setUndoing(true);
    try {
      // Main pops the id from the stack; refresh from the store so the
      // remaining levels stay exact (multi-level Undo).
      await api.restoreCheckpoint(checkpointId);
      await refreshActiveSession();
      await refreshDiff();
      await loadWorkspace();
    } catch (error) {
      // Unknown/expired checkpoints surface to the user instead of vanishing.
      const message = error instanceof Error ? error.message : "Undo failed.";
      setConfirmDialog({
        title: "Could not undo run",
        message,
        confirmLabel: "Dismiss",
        danger: false,
        onConfirm: () => setConfirmDialog(null),
      });
      await refreshActiveSession();
    } finally {
      setUndoing(false);
    }
  }

  // One-click Undo for the Code area: pops the latest pre-run snapshot
  // (files + Nexus-only session-branch commits), otherwise falls back to
  // discarding the current git diff (manual saves with no checkpoint).
  async function undoLatest() {
    if (undoing || running) return;
    const stack = undoStack();
    if (stack.length && activeSession && activeProject) {
      await undoRun(stack[stack.length - 1]);
      return;
    }
    // No checkpoint (manual edits, or history already kept/cleared):
    // refresh first so we don't offer a stale destructive action.
    let currentDiff = diff;
    try {
      currentDiff = await api.getDiff();
      setDiff(currentDiff);
    } catch {
      /* keep the last known diff */
    }
    if (!currentDiff.length) return;
    revertAllChanges();
  }

  const undoLevels = undoStack().length;
  const canUndo = undoLevels > 0 || diff.length > 0;

  async function keepChanges() {
    if (activeProject && activeSession) {
      try {
        await api.clearCheckpoints();
      } catch {
        /* backend clear is best-effort; still refresh below */
      }
      await refreshActiveSession();
    }
  }

  async function revertSingleFile(filePath: string) {
    try {
      await api.revertFile(filePath);
      await refreshDiff();
      await loadWorkspace();
    } catch (error) {
      console.error(error);
    }
  }

  function revertAllChanges() {
    setConfirmDialog({
      title: "Discard all changes?",
      message: "Discard all uncommitted changes in the project workspace? This action cannot be undone.",
      confirmLabel: "Discard changes",
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await api.revertAll();
          await refreshDiff();
          await loadWorkspace();
        } catch (error) {
          console.error(error);
        }
      },
    });
  }

  async function switchModel(providerId: string, model: string) {
    if (!providerId || !model) {
      setSelectedProviderId("");
      setSelectedModel("");
      if (activeProject && activeSession) {
        const updated = await api.updateSession(activeProject.id, activeSession.id, { model: undefined });
        setActiveSession(updated);
        setSessions((current) => current.map((s) => (s.id === updated.id ? updated : s)));
      }
      return;
    }
    setSelectedProviderId(providerId);
    setSelectedModel(model);
    if (activeProject && activeSession) {
      const modelPayload = { providerId, model };
      const updated = await api.updateSession(activeProject.id, activeSession.id, { model: modelPayload });
      setActiveSession(updated);
      setSessions((current) => current.map((s) => (s.id === updated.id ? updated : s)));
    }
  }

  function handleProvidersChange(nextProviders: ProviderConfig[]) {
    setProviders(nextProviders);
    const activeProv = nextProviders.find((p) => p.id === selectedProviderId);
    const modelValid = activeProv ? activeProv.models.includes(selectedModel) : false;
    if (!activeProv || !modelValid) {
      const fallbackId = nextProviders[0]?.id || "";
      const fallbackModel = nextProviders[0]?.models[0] || "";
      setSelectedProviderId(fallbackId);
      setSelectedModel(fallbackModel);
      if (activeProject && activeSession) {
        const modelPayload = fallbackId && fallbackModel ? { providerId: fallbackId, model: fallbackModel } : undefined;
        void api.updateSession(activeProject.id, activeSession.id, { model: modelPayload }).then((updated) => {
          setActiveSession(updated);
          setSessions((current) => current.map((s) => (s.id === updated.id ? updated : s)));
        });
      }
    }
  }

  async function saveMemories(projectMemory: string, sessionMemory: string) {
    if (!activeProject || !activeSession) return;
    const project = await api.updateProjectMemory(activeProject.id, projectMemory);
    const session = await api.updateSessionMemory(activeProject.id, activeSession.id, sessionMemory);
    setActiveProject(project);
    setActiveSession(session);
  }

  return {
    projects,
    activeProject,
    sessions,
    activeSession,
    providers,
    providerDefinitions,
    selectedProviderId,
    selectedModel,
    files,
    expandedFolders,
    gitBranch,
    activeFile,
    openFiles,
    fileContent,
    setFileContent,
    dirty,
    diff,
    draft,
    setDraft,
    streamingText,
    liveEvents: liveEventsForSession,
    view,
    setView,
    mode,
    setMode,
    running,
    showSessions,
    setShowSessions,
    showContext,
    setShowContext,
    showProviders,
    setShowProviders,
    showMcp,
    setShowMcp,
    showSkills,
    setShowSkills,
    skillsEnabled,
    setSkillsEnabled,
    confirmDialog,
    setConfirmDialog,
    activeArtifact,
    setActiveArtifact,
    worktreeStatus,
    attachedImages,
    setAttachedImages,
    attachments,
    setAttachments,
    projectRules,
    showRulesModal,
    setShowRulesModal,
    customCommands,
    showDaemonsModal,
    setShowDaemonsModal,
    inspectDiffFile,
    setInspectDiffFile,
    selectedProvider,
    definition,
    currentMessages,
    visibleFiles,
    area,
    homeProject,
    homeRoot,
    homeFiles,
    homeSessionFiles,
    refreshHomeFiles,
    refreshHomeSessionFiles,
    enterHome,
    enterCode,
    enterNotebook,
    setArea,
    createHomeSession,
    // Actions
    activateProject,
    deleteProjectById,
    openProjectFromDialog,
    createSession,
    activateSession,
    deleteActiveSession,
    renameSession,
    openFile,
    saveFile,
    toggleFolder,
    loadWorkspace,
    refreshDiff,
    revertSingleFile,
    revertAllChanges,
    undoRun,
    undoLatest,
    undoStack,
    undoLevels,
    canUndo,
    undoing,
    keepChanges,
    switchModel,
    handleProvidersChange,
    saveMemories,
    submit,
    stopAgent,
    setActiveFile,
    setOpenFiles,
  };
}
