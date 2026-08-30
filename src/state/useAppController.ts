import { useEffect, useRef, useState } from "react";
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
  SandboxConfig,
  SandboxStatus,
  SessionRecord,
  WorkspaceDiffFile,
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
  { id: "together", label: "Together AI", packageName: "@langchain/community", envKey: "TOGETHER_AI_API_KEY", models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"] },
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
  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus>({ configured: false, status: "not_configured", sandbox: null });
  const [sandboxRequireApproval, setSandboxRequireApproval] = useState(true);
  const [sandboxAllowNetwork, setSandboxAllowNetwork] = useState(false);
  const [sandboxTimeout, setSandboxTimeout] = useState("120");
  const [sandboxEnabled, setSandboxEnabled] = useState(true);
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
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [liveEvents, setLiveEvents] = useState<ChatItem[]>([]);
  const liveEventsRef = useRef<ChatItem[]>([]);
  const [view, setView] = useState<AppView>("chat");
  const [mode, setMode] = useState("Ask");
  const [running, setRunning] = useState(false);
  const [showSessions, setShowSessions] = useState(true);
  const [showFiles, setShowFiles] = useState(true);
  const [showContext, setShowContext] = useState(true);
  const [showProviders, setShowProviders] = useState(false);
  const [showSandbox, setShowSandbox] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showComposerMenu, setShowComposerMenu] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectRoot, setNewProjectRoot] = useState("");
  const [skillsEnabled, setSkillsEnabled] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<{ isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null>(null);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [projectRules, setProjectRules] = useState<{ hasRules: boolean; ruleFiles: any[]; combinedPromptSection: string } | null>(null);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  const [showDaemonsModal, setShowDaemonsModal] = useState(false);
  const [inspectDiffFile, setInspectDiffFile] = useState<WorkspaceDiffFile | null>(null);

  const dirty = fileContent !== savedContent;
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const definition = providerDefinitions.find((provider) => provider.id === selectedProvider?.provider) || providerDefinitions[0];
  const currentMessages = (activeSession?.messages || []) as ChatItem[];
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
      api.getSandboxConfig(),
      api.getSandboxStatus(),
      api.getSkillsConfig(),
      api.listCustomCommands(),
    ]).then(async ([projectList, providerList, definitions, config, status, skillsConfig, cmds]) => {
      setProjects(projectList);
      setProviders(providerList);
      if (definitions?.length) setProviderDefinitions(definitions);
      setSandboxConfig(config);
      setSandboxStatus(status);
      setSkillsEnabled(skillsConfig?.enabled !== false);
      if (cmds?.length) setCustomCommands(cmds as SlashCommand[]);
      if (config) {
        setSandboxRequireApproval(config.requireApproval !== false);
        setSandboxAllowNetwork(config.allowNetwork);
        setSandboxTimeout(String(config.commandTimeoutSeconds || 120));
        setSandboxEnabled(config.enabled);
      }
      if (projectList[0]) await activateProject(projectList[0].id);
    });

    return api.onAgentEvent((event) => {
      if (event.type === "token") {
        setStreamingText((current) => current + event.text);
        return;
      }
      if (event.type === "assistant" || event.type === "error") setStreamingText("");
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
        const log = liveEventsRef.current;
        liveEventsRef.current = [];
        setLiveEvents([]);
        setActiveSession((current) => {
          if (!current) return current;
          const base = log.length ? [...current.messages, ...log] : current.messages;
          const currentUsage = current.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
          const newUsage = event.usage
            ? {
                inputTokens: currentUsage.inputTokens + event.usage.inputTokens,
                outputTokens: currentUsage.outputTokens + event.usage.outputTokens,
                totalTokens: currentUsage.totalTokens + event.usage.totalTokens,
                estimatedCost: Number((currentUsage.estimatedCost + event.usage.estimatedCost).toFixed(4)),
              }
            : currentUsage;
          return { ...current, usage: newUsage, messages: [...base, item] };
        });
        setRunning(false);
        return;
      }
      liveEventsRef.current = pushLiveEvent(liveEventsRef.current, item);
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

  async function loadSandboxStatus() {
    try {
      setSandboxStatus(await api.getSandboxStatus());
    } catch {
      setSandboxStatus({ configured: false, status: "unknown", sandbox: null });
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
      await loadSandboxStatus();
    } catch {
      setFiles([]);
      setGitBranch("No Git repository");
      await loadSandboxStatus();
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
      },
    });
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

  async function createProject() {
    if (!newProjectRoot.trim()) {
      await openProjectFromDialog();
      setShowCreateProject(false);
      return;
    }
    const result = await api.createProject(
      newProjectName.trim() || newProjectRoot.split(/[\\/]/).pop() || "New project",
      newProjectRoot.trim()
    );
    resetWorkspace();
    setProjects(await api.listProjects());
    setActiveProject(result.project);
    setActiveSession(result.session);
    setSessions(result.project.sessions);
    setSelectedProviderId("");
    setSelectedModel("");
    setShowCreateProject(false);
    await loadWorkspace();
  }

  async function createSession() {
    if (!activeProject) return;
    const sess = await api.createSession(activeProject.id, "New coding task");
    setSessions((current) => [sess, ...current]);
    setActiveSession(sess);
    setView("chat");
  }

  async function activateSession(sessionId: string) {
    if (!activeProject) return;
    const sess = await api.activateSession(activeProject.id, sessionId);
    setActiveSession(sess);
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
    const request = (overrideRequest || draft).trim();
    if (!request || running) return;
    if (!activeProject || !activeSession) {
      setView("files");
      return;
    }
    if (!providers.length) {
      setShowProviders(true);
      return;
    }
    const imagesToSend = attachedImages.length ? [...attachedImages] : undefined;
    setAttachedImages([]);
    setRunning(true);
    setDraft("");
    setStreamingText("");
    liveEventsRef.current = [];
    setLiveEvents([]);
    setActiveSession((current) =>
      current
        ? {
            ...current,
            messages: [...current.messages, { role: "user", text: request, images: imagesToSend, createdAt: nowIso() }],
          }
        : current
    );
    try {
      await api.runAgent({
        request,
        images: imagesToSend,
        providerId: selectedProviderId || undefined,
        model: selectedModel || undefined,
        mode: mode.toLowerCase(),
      });
      try {
        if (activeProject) {
          const freshSessions = await api.listSessions(activeProject.id);
          setSessions(freshSessions);
          const freshCurrent = freshSessions.find((s) => s.id === activeSession?.id);
          if (freshCurrent) {
            setActiveSession((prev) => (prev ? { ...prev, usage: freshCurrent.usage } : freshCurrent));
          }
          if (activeSession) {
            const wt = await api.getWorktreeStatus(activeSession.id);
            setWorktreeStatus(wt);
          }
        }
      } catch {
        /* sidebar keeps its current list */
      }
    } catch (error) {
      setRunning(false);
      setStreamingText("");
      const log = liveEventsRef.current;
      liveEventsRef.current = [];
      setLiveEvents([]);
      setActiveSession((current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                ...(log.length ? log : []),
                { role: "event", kind: "error", text: error instanceof Error ? error.message : "Agent failed", createdAt: nowIso() },
              ],
            }
          : current
      );
    }
  }

  async function stopAgent() {
    try {
      await api.cancelAgent();
    } catch {
      /* already stopped */
    }
  }

  async function undoRun(checkpointId: string) {
    if (!checkpointId) return;
    try {
      await api.restoreCheckpoint(checkpointId);
      if (activeProject && activeSession) {
        const updated = await api.updateSession(activeProject.id, activeSession.id, { checkpointId: undefined });
        setActiveSession(updated);
      }
      await refreshDiff();
      await loadWorkspace();
    } catch (error) {
      console.error(error);
    }
  }

  async function keepChanges() {
    if (activeProject && activeSession) {
      const updated = await api.updateSession(activeProject.id, activeSession.id, { checkpointId: undefined });
      setActiveSession(updated);
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

  async function saveSandbox() {
    const saved = await api.saveSandboxConfig({
      provider: "local",
      enabled: sandboxEnabled,
      requireApproval: sandboxRequireApproval,
      allowNetwork: sandboxAllowNetwork,
      commandTimeoutSeconds: Number(sandboxTimeout) || 120,
    });
    setSandboxConfig(saved);
    setShowSandbox(false);
    await loadSandboxStatus();
  }

  async function stopSandbox() {
    await api.stopSandbox();
    await loadSandboxStatus();
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
    sandboxConfig,
    sandboxStatus,
    sandboxRequireApproval,
    setSandboxRequireApproval,
    sandboxAllowNetwork,
    setSandboxAllowNetwork,
    sandboxTimeout,
    setSandboxTimeout,
    sandboxEnabled,
    setSandboxEnabled,
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
    liveEvents,
    view,
    setView,
    mode,
    setMode,
    running,
    showSessions,
    setShowSessions,
    showFiles,
    setShowFiles,
    showContext,
    setShowContext,
    showProviders,
    setShowProviders,
    showSandbox,
    setShowSandbox,
    showMcp,
    setShowMcp,
    showSkills,
    setShowSkills,
    showComposerMenu,
    setShowComposerMenu,
    showCreateProject,
    setShowCreateProject,
    newProjectName,
    setNewProjectName,
    newProjectRoot,
    setNewProjectRoot,
    skillsEnabled,
    setSkillsEnabled,
    confirmDialog,
    setConfirmDialog,
    activeArtifact,
    setActiveArtifact,
    worktreeStatus,
    attachedImages,
    setAttachedImages,
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
    // Actions
    activateProject,
    deleteProjectById,
    openProjectFromDialog,
    createProject,
    createSession,
    activateSession,
    deleteActiveSession,
    openFile,
    saveFile,
    toggleFolder,
    loadWorkspace,
    refreshDiff,
    revertSingleFile,
    revertAllChanges,
    undoRun,
    keepChanges,
    switchModel,
    handleProvidersChange,
    saveSandbox,
    stopSandbox,
    saveMemories,
    submit,
    stopAgent,
    setActiveFile,
    setOpenFiles,
  };
}
