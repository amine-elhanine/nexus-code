import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { nowIso, pushLiveEvent } from "../utils/format.js";
import { isKnownBinaryFile } from "../utils/binaryFiles.js";
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

export function sortSessionsByUpdatedAt(list: SessionRecord[]): SessionRecord[] {
  return [...list].sort((a, b) => {
    const tA = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tB = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tB - tA;
  });
}

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
  // Binary workspace files (pptx/docx/xlsx/pdf/images) never enter the editor
  // buffer — this path opens the FilePreviewModal in App instead.
  const [workspacePreviewPath, setWorkspacePreviewPath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [diff, setDiff] = useState<WorkspaceDiffFile[]>([]);
  // Explorer decorations: path -> git code (U/A/M/D/R) from `git status`.
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streamingText, setStreamingText] = useState("");
  // Live events are bucketed per session so concurrent runs in different
  // sessions each render their own activity, never each other's.
  const [liveEvents, setLiveEvents] = useState<Record<string, ChatItem[]>>({});
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const liveEventsRef = useRef<Record<string, ChatItem[]>>({});
  const activeSessionRef = useRef<SessionRecord | null>(null);
  activeSessionRef.current = activeSession ?? null;
  // Same pattern for the project: the mount-only event subscription below
  // must read the current project, not the mount-time one.
  const activeProjectRef = useRef<ProjectRecord | null>(null);
  activeProjectRef.current = activeProject ?? null;
  const [view, setView] = useState<AppView>("chat");
  const [mode, setMode] = useState("Ask");
  const [showSessions, setShowSessions] = useState(true);
  const [showContext, setShowContext] = useState(true);
  const [showProviders, setShowProviders] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState(true);
  const [rulesEnabled, setRulesEnabled] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<{ isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null>(null);
  const [projectRules, setProjectRules] = useState<{ hasRules: boolean; ruleFiles: any[]; combinedPromptSection: string } | null>(null);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  // Area: "home" = general assistant, "code" = repo coding agent, "notebook" = isolated RAG notebooks.
  const [area, setArea] = useState<"home" | "code" | "notebook">("home");
  const [showDaemonsModal, setShowDaemonsModal] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [inspectDiffFile, setInspectDiffFile] = useState<WorkspaceDiffFile | null>(null);
  const [undoing, setUndoing] = useState(false);

  const dirty = fileContent !== savedContent;
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const definition = providerDefinitions.find((provider) => provider.id === selectedProvider?.provider) || providerDefinitions[0];
  const currentMessages = (activeSession?.messages || []) as ChatItem[];
  const running = Boolean(activeSession && runningSessionIds.has(activeSession.id));
  const liveEventsForSession = activeSession ? liveEvents[activeSession.id] || [] : [];
  // Nexus telemetry storage (.nexus/.forgepilot/.deepagents) is machinery,
  // not project content — the explorer never shows it, matching how IDEs
  // hide their own metadata folders.
  const TELEMETRY_DIRS = new Set([".nexus", ".forgepilot", ".deepagents"]);
  const visibleFiles = files.filter((entry) => {
    if (TELEMETRY_DIRS.has(entry.path.split("/")[0])) return false;
    const parts = entry.path.split("/");
    return parts.length === 1 || parts.slice(0, -1).every((_, index) => expandedFolders.has(parts.slice(0, index + 1).join("/")));
  });

  const api = window.nexus || window.forgepilot;

  useEffect(() => {
    void Promise.all([
      api.listProjects(),
      api.listProviders(),
      api.listProviderDefinitions(),
      api.getRulesConfig(),
      api.getSkillsConfig(),
      api.listCustomCommands(),
    ]).then(async ([projectList, providerList, definitions, rulesConfig, skillsConfig, cmds]) => {
      setProjects(projectList);
      setProviders(providerList);
      if (definitions?.length) setProviderDefinitions(definitions);
      setRulesEnabled(rulesConfig?.enabled !== false);
      setSkillsEnabled(skillsConfig?.enabled !== false);
      if (cmds?.length) setCustomCommands(cmds as SlashCommand[]);
      if (projectList[0]) {
        await activateProject(projectList[0].id);
      }
    });

    return api.onAgentEvent((event) => {
      const bucket = event.sessionId || "unknown";
      // Events from a session other than the currently viewed one still
      // accumulate (so switching later shows them) but don't stream into view.
      if (event.type === "token") {
        // This subscription intentionally runs once. Read the ref so tokens
        // follow the session selected after the initial render as well.
        if (activeSessionRef.current?.id && event.sessionId === activeSessionRef.current.id) {
          setStreamingText((current) => current + event.text);
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
        void api.listSessions(activeProjectRef.current?.id || "").then((fresh) => {
          if (!fresh) return;
          setSessions(sortSessionsByUpdatedAt(fresh as unknown as SessionRecord[]));
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

  function resetWorkspace() {
    setFiles([]);
    setExpandedFolders(new Set());
    setActiveFile("");
    setOpenFiles([]);
    setFileContent("");
    setSavedContent("");
    setWorkspacePreviewPath(null);
    setDiff([]);
    setGitBranch("No Git repository");
  }

  async function loadGit() {
    try {
      const [info, statusEntries] = await Promise.all([
        api.getGit(),
        api.getWorkspaceGitStatus().catch(() => []),
      ]);
      setGitBranch(info.branch);
      const map: Record<string, string> = {};
      for (const entry of statusEntries || []) map[entry.path] = entry.code;
      setGitStatus(map);
    } catch {
      setGitBranch("No Git repository");
      setGitStatus({});
    }
  }

  async function activateProject(projectId: string) {
    resetWorkspace();
    const result = await api.activateProject(projectId);
    setActiveProject(result.project);
    setActiveSession(result.session);
    setSessions(sortSessionsByUpdatedAt(result.project.sessions));
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
    try {
      const paths = await api.listWorkspace();
      const mapped = paths.map((p) => ({
        path: p.replace(/\\/g, "/").replace(/\/$/, ""),
        kind: p.endsWith("/") ? ("folder" as const) : ("file" as const),
      }));
      setFiles(mapped);
      // Reloads happen after agent runs, undos and reverts. Keep the user's
      // editor intact: retain open tabs and the active file, re-reading its
      // content from disk so agent edits surface — unless the buffer has
      // unsaved edits, which win. Only fall back to the first file when
      // nothing valid is open. Project switches reset explicitly via
      // resetWorkspace() before calling this.
      setOpenFiles((current) => current.filter((file) => mapped.some((entry) => entry.path === file && entry.kind === "file")));
      if (activeFile && mapped.some((entry) => entry.path === activeFile && entry.kind === "file")) {
        if (!dirty) {
          try {
            const result = await api.readFile(activeFile);
            setFileContent(result.content);
            setSavedContent(result.content);
          } catch { /* keep the current buffer */ }
        }
      } else {
        // Auto-picking a tab on reload must never land on a binary file —
        // those live in the previewer, not the editor.
        const first = mapped.find((item) => item.kind === "file" && !isKnownBinaryFile(item.path));
        if (first) await openFile(first.path);
      }
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
    setConfirmDialog({
      title: `Delete session "${sess?.title || "session"}"?`,
      message: "This will permanently delete this coding session and its memory.",
      confirmLabel: "Delete session",
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const updatedProject = await api.deleteSession(activeProject.id, sessionId);
          setProjects((current) => current.map((p) => (p.id === updatedProject.id ? updatedProject : p)));
          setSessions(sortSessionsByUpdatedAt(updatedProject.sessions));
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
      },
    });
  }

  async function renameSession(sessionId: string, title: string) {
    if (!activeProject) return;
    const next = title.trim().slice(0, 80);
    if (!next) return;
    try {
      const updated = await api.updateSession(activeProject.id, sessionId, { title: next });
      setSessions((current) => sortSessionsByUpdatedAt(current.map((s) => (s.id === updated.id ? updated : s))));
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
    setSessions(sortSessionsByUpdatedAt(result.project.sessions));
    setSelectedProviderId(result.session.model?.providerId || "");
    setSelectedModel(result.session.model?.model || "");
    await loadWorkspace();
  }

  async function createSession() {
    if (!activeProject) return;
    const sess = await api.createSession(activeProject.id, "New coding task");
    setSessions((current) => sortSessionsByUpdatedAt([sess, ...current]));
    setActiveSession(sess);
    setView("chat");
  }

  function enterHome() {
    setArea("home");
    setStreamingText("");
  }

  async function enterCode() {
    setArea("code");
    setStreamingText("");
    if (!activeProject && projects[0]) {
      await activateProject(projects[0].id);
    }
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
    try {
      const wt = await api.getWorktreeStatus(sessionId);
      setWorktreeStatus(wt);
    } catch {
      setWorktreeStatus(null);
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
    // Binary containers never enter the editor buffer: previewing them as
    // text would show mojibake, and an accidental save would corrupt the
    // file. Route to the preview modal instead.
    if (isKnownBinaryFile(file)) {
      setWorkspacePreviewPath(file);
      return;
    }
    setActiveFile(file);
    setOpenFiles((current) => (current.includes(file) ? current : [...current, file]));
    try {
      const result = await api.readFile(file);
      setFileContent(result.content);
      setSavedContent(result.content);
    } catch (error) {
      // Unknown-extension binary caught by the backend's NUL-byte guard —
      // still better in the previewer (clean download card) than in Monaco.
      if (error instanceof Error && /binary file/i.test(error.message)) {
        setWorkspacePreviewPath(file);
        return;
      }
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
    const session = activeSession;
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
    const userMsgTime = nowIso();
    setActiveSession((current) =>
      current
        ? {
            ...current,
            updatedAt: userMsgTime,
            messages: [...current.messages, { role: "user", text: request, images: imagesToSend, attachments: attachmentsToSend, createdAt: userMsgTime }],
          }
        : current
    );
    setSessions((current) => {
      const idx = current.findIndex((s) => s.id === session.id);
      if (idx === -1) return current;
      const updatedSess: SessionRecord = {
        ...current[idx],
        updatedAt: userMsgTime,
      };
      const without = current.filter((s) => s.id !== session.id);
      return [updatedSess, ...without];
    });
    try {
      await api.runAgent({
        request,
        images: imagesToSend,
        attachments: attachmentsToSend,
        providerId: selectedProviderId || undefined,
        model: selectedModel || undefined,
        sessionId: session.id,
        projectId: activeProject?.id,
        mode: mode.toLowerCase(),
      });
      // The final assistant message and transcript are persisted by the main
      // process; refresh from the store so usage/checkpoint state is exact.
      try {
        if (activeProject) {
          const freshSessions = await api.listSessions(activeProject.id);
          setSessions(sortSessionsByUpdatedAt(freshSessions as unknown as SessionRecord[]));
          const freshCurrent = (freshSessions as unknown as SessionRecord[]).find((s) => s.id === session.id);
          if (freshCurrent) {
            setActiveSession((prev) => (prev && prev.id === session.id ? { ...prev, messages: freshCurrent.messages, usage: freshCurrent.usage, checkpointId: freshCurrent.checkpointId, checkpointIds: freshCurrent.checkpointIds } : prev));
          }
          const wt = await api.getWorktreeStatus(session.id);
          setWorktreeStatus(wt);
        }
        await refreshDiff();
        await loadWorkspace();
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
      const { [session.id]: _dropped, ...rest } = liveEventsRef.current;
      liveEventsRef.current = rest;
      setLiveEvents(rest);
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
    const sid = activeSession?.id;
    if (sid) {
      setRunningSessionIds((current) => {
        const next = new Set(current);
        next.delete(sid);
        return next;
      });
      setStreamingText("");
    }
    try {
      // Scoped: only this session's run is cancelled, others keep working.
      await api.cancelAgent(sid);
    } catch {
      /* already stopped */
    }
  }

  async function refreshActiveSession() {
    if (!activeProject || !activeSession) return;
    try {
      const freshSessions = await api.listSessions(activeProject.id);
      setSessions(sortSessionsByUpdatedAt(freshSessions as unknown as SessionRecord[]));
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

  async function revertSingleHunk(filePath: string, hunkHeader: string) {
    try {
      await (api as unknown as { revertHunk: (f: string, h: string) => Promise<boolean> }).revertHunk(filePath, hunkHeader);
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
        setSessions((current) => sortSessionsByUpdatedAt(current.map((s) => (s.id === updated.id ? updated : s))));
      }
      return;
    }
    setSelectedProviderId(providerId);
    setSelectedModel(model);
    if (activeProject && activeSession) {
      const modelPayload = { providerId, model };
      const updated = await api.updateSession(activeProject.id, activeSession.id, { model: modelPayload });
      setActiveSession(updated);
      setSessions((current) => sortSessionsByUpdatedAt(current.map((s) => (s.id === updated.id ? updated : s))));
    }
  }

  function handleProvidersChange(nextProviders: ProviderConfig[]) {
    setProviders(nextProviders);
    const activeProv = nextProviders.find((p) => p.id === selectedProviderId);
    const modelValid = activeProv && activeProv.enabled !== false ? activeProv.models.includes(selectedModel) : false;
    if (!activeProv || !modelValid) {
      // Disabled connections stay configured but are not selectable.
      const usable = nextProviders.filter((p) => p.enabled !== false);
      const fallbackId = usable[0]?.id || "";
      const fallbackModel = usable[0]?.models[0] || "";
      setSelectedProviderId(fallbackId);
      setSelectedModel(fallbackModel);
      if (activeProject && activeSession) {
        const modelPayload = fallbackId && fallbackModel ? { providerId: fallbackId, model: fallbackModel } : undefined;
        void api.updateSession(activeProject.id, activeSession.id, { model: modelPayload }).then((updated) => {
          setActiveSession(updated);
          setSessions((current) => sortSessionsByUpdatedAt(current.map((s) => (s.id === updated.id ? updated : s))));
        });
      }
    }
  }

  async function removeProjectFact(fact: string) {
    if (!activeProject) return;
    try {
      const project = await api.removeProjectFact(activeProject.id, fact);
      setActiveProject(project);
    } catch (error) {
      console.error("Failed to remove project fact", error);
    }
  }

  async function clearSessionMemory() {
    if (!activeProject || !activeSession) return;
    try {
      const session = await api.updateSessionMemory(activeProject.id, activeSession.id, "");
      setActiveSession(session);
    } catch (error) {
      console.error("Failed to clear session memory", error);
    }
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
    workspacePreviewPath,
    setWorkspacePreviewPath,
    dirty,
    diff,
    gitStatus,
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
    rulesEnabled,
    setRulesEnabled,
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
    enterHome,
    enterCode,
    enterNotebook,
    setArea,
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
    revertSingleHunk,
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
    removeProjectFact,
    clearSessionMemory,
    submit,
    stopAgent,
    setActiveFile,
    setOpenFiles,
  };
}
