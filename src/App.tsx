import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { renderMarkdown } from "./markdown.js";
import { ArtifactViewer } from "./components/artifacts/ArtifactViewer.js";
import { WorktreeBar } from "./components/worktree/WorktreeBar.js";
import { SlashCommandPopup, type SlashCommand } from "./components/chat/SlashCommandPopup.js";
import { MonacoEditorView } from "./components/editor/MonacoEditorView.js";
import { XTermView } from "./components/terminal/XTermView.js";
import { ProjectRulesModal } from "./components/rules/ProjectRulesModal.js";
import { MonacoDiffModal } from "./components/diff/MonacoDiffModal.js";
import { DaemonsModal } from "./components/daemons/DaemonsModal.js";
import { VoiceDictationButton } from "./components/chat/VoiceDictationButton.js";
import { IntegratedBrowserView } from "./components/browser/IntegratedBrowserView.js";
import {
  Activity, ArrowUp, BookOpen, Bot, Brain, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot,
  Code2, Coins, Columns, Copy, Eye, File, FileCode2, FileJson, Folder, FolderOpen, GitBranch, Globe, History, Image as ImageIcon,
  KeyRound, Layers, Loader2, Menu, MessageSquare, Mic, MoreHorizontal, PanelBottom, PanelLeft, PanelRight, Play,
  Plus, RefreshCw, RotateCcw, Save, Search, Send, Server, Settings2, ShieldCheck, Sparkles, Terminal, Trash2,
  Undo2, Upload, X, Zap, Square, Puzzle, Minus, Minimize2,
} from "lucide-react";

type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" };
type AgentUsage = { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number };
type SubagentRole = "researcher" | "tester" | "coder";
type SubagentStep = { toolName: string; summary?: string; timestamp: string };
type SubagentItem = { id: string; role: SubagentRole; task: string; status: "running" | "completed" | "failed"; steps: SubagentStep[]; output?: string; usage?: AgentUsage };
type ArtifactStatus = "draft" | "pending_approval" | "approved" | "completed" | "rejected";
type ArtifactItem = { id: string; sessionId: string; name: string; filename: string; path: string; content: string; status: ArtifactStatus; userFacing: boolean; requestFeedback: boolean; createdAt: string; updatedAt: string };
type AgentEvent = { type: "status" | "tool" | "token" | "assistant" | "plan" | "error" | "usage" | "subagent" | "artifact"; text: string; timestamp: string; items?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem };
type ProviderDefinition = { id: string; label: string; packageName: string; envKey: string; defaultBaseUrl?: string; models: string[] };
type ProviderConfig = { id: string; label: string; provider: string; apiKey: string; baseUrl?: string; models: string[] };
type SessionRecord = { id: string; title: string; createdAt: string; updatedAt: string; memory: string; checkpointId?: string; usage?: AgentUsage; messages: Array<{ role: "user" | "assistant" | "event"; text: string; images?: string[]; kind?: AgentEvent["type"]; createdAt: string; plan?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem }>; model?: { providerId: string; model: string } };
type ProjectRecord = { id: string; name: string; root: string; createdAt: string; updatedAt: string; memory: string; sessions: SessionRecord[]; sandbox?: { provider: "local"; mode: "workspace-permissions"; status: string; path: string; lastSyncAt?: string } };
type AppView = "chat" | "files" | "diff" | "terminal" | "browser" | "memory";
type ChatItem = { role: "user" | "assistant" | "event"; text: string; images?: string[]; kind?: AgentEvent["type"]; createdAt: string; plan?: PlanItem[]; usage?: AgentUsage; subagent?: SubagentItem; artifact?: ArtifactItem };
type FileEntry = { path: string; kind: "file" | "folder" };
type WorkspaceDiffFile = { path: string; directory: string; name: string; additions: number; deletions: number; status: string; patch: string };
type DiffSide = { number?: number; text: string };
type SplitDiffRow = { kind: "context" | "change" | "added" | "deleted" | "hunk"; old?: DiffSide; new?: DiffSide; text?: string };
type SandboxConfig = { provider: "local"; enabled: boolean; requireApproval: boolean; allowNetwork: boolean; commandTimeoutSeconds: number };
type SandboxStatus = { configured: boolean; status: string; sandbox: ProjectRecord["sandbox"] | null };
type McpTransport = "stdio" | "http" | "sse";
type McpServerConfig = { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
type McpTestResult = { ok: boolean; tools: string[]; error?: string };
type SkillInfo = { name: string; description: string; path: string; source: "global" | "project" };

const FALLBACK_PROVIDERS: ProviderDefinition[] = [
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

function NexusLogo({ size = 20 }: { size?: number }) {
  return (
    <div
      className="nexus-logo-wrapper"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#18202a",
        borderRadius: Math.round(size * 0.24),
        border: "1px solid #27364b",
        boxShadow: "0 0 10px rgba(52, 211, 153, 0.35)",
        flexShrink: 0,
      }}
    >
      <svg
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <polygon
          points="50,6 88,28 88,72 50,94 12,72 12,28"
          fill="#34d399"
        />
        <polygon
          points="50,28 73,41 73,69 50,82 27,69 27,41"
          fill="#18202a"
        />
      </svg>
    </div>
  );
}

function WindowControls() {
  const [isMax, setIsMax] = useState(false);

  const handleToggleMax = async () => {
    try {
      const next = await window.nexus?.maximizeWindow?.();
      setIsMax(Boolean(next));
    } catch { /* ignore */ }
  };

  return (
    <div className="window-controls">
      <button
        className="win-btn win-min"
        onClick={() => void window.nexus?.minimizeWindow?.()}
        title="Minimize"
      >
        <Minus size={13} />
      </button>
      <button
        className="win-btn win-max"
        onClick={() => void handleToggleMax()}
        title={isMax ? "Restore" : "Maximize"}
      >
        {isMax ? <Minimize2 size={11} /> : <Square size={10} />}
      </button>
      <button
        className="win-btn win-close"
        onClick={() => void window.nexus?.closeWindow?.()}
        title="Close"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function nowIso() { return new Date().toISOString(); }
function timeLabel(value: string) { return value === "now" ? "now" : new Date(value).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
function fileIcon(file: string) { return file.endsWith(".json") ? <FileJson size={14} /> : file.endsWith(".ts") || file.endsWith(".tsx") ? <FileCode2 size={14} /> : <File size={14} />; }
function pushLiveEvent(events: ChatItem[], item: ChatItem) { return [...events, item]; }

function getSessionUsage(session?: SessionRecord | null): AgentUsage | undefined {
  if (!session) return undefined;
  let inputTokens = session.usage?.inputTokens || 0;
  let outputTokens = session.usage?.outputTokens || 0;
  let totalTokens = session.usage?.totalTokens || 0;
  let estimatedCost = session.usage?.estimatedCost || 0;

  // Aggregate all messages that contain usage info
  let msgInput = 0;
  let msgOutput = 0;
  let msgTotal = 0;
  let msgCost = 0;
  for (const message of session.messages || []) {
    if (message.usage) {
      msgInput += message.usage.inputTokens || 0;
      msgOutput += message.usage.outputTokens || 0;
      msgTotal += message.usage.totalTokens || 0;
      msgCost += message.usage.estimatedCost || 0;
    }
  }

  // If message sum is larger or session.usage was missing/underreported, use the full message aggregate
  if (msgTotal > totalTokens) {
    inputTokens = msgInput;
    outputTokens = msgOutput;
    totalTokens = msgTotal;
    estimatedCost = Number(msgCost.toFixed(4));
  }

  if (totalTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost: Number(estimatedCost.toFixed(4)),
    };
  }
  return session.usage;
}

function App() {
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
  const [terminalOutput, setTerminalOutput] = useState("ForgePilot terminal\nOpen a project to run commands in its root.");
  const [terminalInput, setTerminalInput] = useState("npm.cmd run check");
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

  useEffect(() => {
    void Promise.all([window.forgepilot.listProjects(), window.forgepilot.listProviders(), window.forgepilot.listProviderDefinitions(), window.forgepilot.getSandboxConfig(), window.forgepilot.getSandboxStatus(), window.forgepilot.getSkillsConfig(), window.forgepilot.listCustomCommands()]).then(async ([projectList, providerList, definitions, config, status, skillsConfig, cmds]) => {
      setProjects(projectList); setProviders(providerList); if (definitions?.length) setProviderDefinitions(definitions); setSandboxConfig(config); setSandboxStatus(status); setSkillsEnabled(skillsConfig?.enabled !== false); if (cmds?.length) setCustomCommands(cmds as SlashCommand[]); if (config) { setSandboxRequireApproval(config.requireApproval !== false); setSandboxAllowNetwork(config.allowNetwork); setSandboxTimeout(String(config.commandTimeoutSeconds || 120)); setSandboxEnabled(config.enabled); }
      if (projectList[0]) await activateProject(projectList[0].id);
    });
    return window.forgepilot.onAgentEvent((event) => {
      if (event.type === "token") { setStreamingText((current) => current + event.text); return; }
      if (event.type === "assistant" || event.type === "error") setStreamingText("");
      const item: ChatItem = { role: event.type === "assistant" ? "assistant" : "event", text: event.text, kind: event.type, createdAt: event.timestamp, usage: event.usage, subagent: event.subagent, plan: event.items, artifact: event.artifact };
      if (event.type === "artifact" && event.artifact) {
        if (event.artifact.filename === "implementation_plan.md" && event.artifact.status === "pending_approval") {
          setActiveArtifact(event.artifact);
        }
      }
      if (event.type === "assistant" || event.type === "error") {
        // Fold the whole run log into the transcript as one collapsed group, then close with the final message.
        const log = liveEventsRef.current;
        liveEventsRef.current = [];
        setLiveEvents([]);
        setActiveSession((current) => {
          if (!current) return current;
          const base = log.length ? [...current.messages, ...log] : current.messages;
          const currentUsage = current.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
          const newUsage = event.usage ? {
            inputTokens: currentUsage.inputTokens + event.usage.inputTokens,
            outputTokens: currentUsage.outputTokens + event.usage.outputTokens,
            totalTokens: currentUsage.totalTokens + event.usage.totalTokens,
            estimatedCost: Number((currentUsage.estimatedCost + event.usage.estimatedCost).toFixed(4)),
          } : currentUsage;
          return { ...current, usage: newUsage, messages: [...base, item] };
        });
        setRunning(false);
        return;
      }
      liveEventsRef.current = pushLiveEvent(liveEventsRef.current, item);
      setLiveEvents(liveEventsRef.current);
    });
  }, []);

  function resetWorkspace() { setFiles([]); setExpandedFolders(new Set()); setActiveFile(""); setOpenFiles([]); setFileContent(""); setSavedContent(""); setDiff([]); setGitBranch("No Git repository"); }
  async function loadGit() { try { const info = await window.forgepilot.getGit(); setGitBranch(info.branch); } catch { setGitBranch("No Git repository"); } }
  async function loadSandboxStatus() { try { setSandboxStatus(await window.forgepilot.getSandboxStatus()); } catch { setSandboxStatus({ configured: false, status: "unknown", sandbox: null }); } }
  async function activateProject(projectId: string) {
    resetWorkspace();
    const result = await window.forgepilot.activateProject(projectId);
    setActiveProject(result.project);
    setActiveSession(result.session);
    setSessions(result.project.sessions);
    const currentProviders = await window.forgepilot.listProviders();
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
    void window.forgepilot.getProjectRules(projectId).then(setProjectRules).catch(() => setProjectRules(null));
    void window.forgepilot.listCustomCommands().then((c) => setCustomCommands(c as SlashCommand[])).catch(() => {});
    await loadWorkspace();
  }
  async function loadWorkspace() {
    resetWorkspace();
    try { const paths = await window.forgepilot.listWorkspace(); const mapped = paths.map((path) => ({ path: path.replace(/\\/g, "/").replace(/\/$/, ""), kind: path.endsWith("/") ? "folder" as const : "file" as const })); setFiles(mapped); const first = mapped.find((item) => item.kind === "file"); if (first) await openFile(first.path); await loadGit(); await loadSandboxStatus(); } catch { setFiles([]); setGitBranch("No Git repository"); await loadSandboxStatus(); }
  }
  function toggleFolder(folder: string) { setExpandedFolders((current) => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next; }); }
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
          const remaining = await window.forgepilot.deleteProject(projectId);
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
          const updatedProject = await window.forgepilot.deleteSession(activeProject.id, sessionId);
          setProjects((current) => current.map((project) => project.id === updatedProject.id ? updatedProject : project));
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
    const result = await window.forgepilot.selectProject(); if (!result) return;
    resetWorkspace(); setProjects(await window.forgepilot.listProjects()); setActiveProject(result.project); setActiveSession(result.session); setSessions(result.project.sessions); setSelectedProviderId(result.session.model?.providerId || ""); setSelectedModel(result.session.model?.model || ""); await loadWorkspace();
  }
  async function createProject() {
    if (!newProjectRoot.trim()) { await openProjectFromDialog(); setShowCreateProject(false); return; }
    const result = await window.forgepilot.createProject(newProjectName.trim() || newProjectRoot.split(/[\\/]/).pop() || "New project", newProjectRoot.trim()); resetWorkspace(); setProjects(await window.forgepilot.listProjects()); setActiveProject(result.project); setActiveSession(result.session); setSessions(result.project.sessions); setSelectedProviderId(""); setSelectedModel(""); setShowCreateProject(false); await loadWorkspace();
  }
  async function createSession() { if (!activeProject) return; const session = await window.forgepilot.createSession(activeProject.id, "New coding task"); setSessions((current) => [session, ...current]); setActiveSession(session); setView("chat"); }
  async function activateSession(sessionId: string) {
    if (!activeProject) return;
    const session = await window.forgepilot.activateSession(activeProject.id, sessionId);
    setActiveSession(session);
    try {
      const wt = await window.forgepilot.getWorktreeStatus(sessionId);
      setWorktreeStatus(wt);
    } catch {
      setWorktreeStatus(null);
    }
    const targetProvider = session.model ? providers.find((p) => p.id === session.model?.providerId) : undefined;
    const isValid = targetProvider && session.model ? targetProvider.models.includes(session.model.model) : false;
    if (isValid && session.model) {
      setSelectedProviderId(session.model.providerId);
      setSelectedModel(session.model.model);
    } else if (providers.length > 0) {
      setSelectedProviderId(providers[0].id);
      setSelectedModel(providers[0].models[0] || "");
    } else {
      setSelectedProviderId("");
      setSelectedModel("");
    }
    setView("chat");
  }
  async function openFile(file: string) { if (file.endsWith("/")) return; setActiveFile(file); setOpenFiles((current) => current.includes(file) ? current : [...current, file]); try { const result = await window.forgepilot.readFile(file); setFileContent(result.content); setSavedContent(result.content); } catch { setFileContent(`// Unable to read ${file}`); setSavedContent(""); } }
  async function saveFile() { if (!activeFile || !dirty) return; await window.forgepilot.writeFile(activeFile, fileContent); setSavedContent(fileContent); await refreshDiff(); }
  async function refreshDiff() { try { setDiff(await window.forgepilot.getDiff()); } catch { setDiff([]); } }
  async function runTerminal() { if (!activeProject || !terminalInput.trim()) return; setTerminalOutput(`$ ${terminalInput}\n\nRunning…`); try { setTerminalOutput(`$ ${terminalInput}\n\n${await window.forgepilot.runCommand(terminalInput)}`); } catch (error) { setTerminalOutput(`$ ${terminalInput}\n\n${error instanceof Error ? error.message : String(error)}`); } }
  async function submit(overrideRequest?: string) {
    const request = (overrideRequest || draft).trim();
    if (!request || running) return;
    if (!activeProject || !activeSession) { setView("files"); return; }
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
    setActiveSession((current) => current ? { ...current, messages: [...current.messages, { role: "user", text: request, images: imagesToSend, createdAt: nowIso() }] } : current);
    try {
      await window.forgepilot.runAgent({ request, images: imagesToSend, providerId: selectedProviderId || undefined, model: selectedModel || undefined, mode: mode.toLowerCase() });
      try {
        if (activeProject) {
          const freshSessions = await window.forgepilot.listSessions(activeProject.id);
          setSessions(freshSessions);
          const freshCurrent = freshSessions.find((s) => s.id === activeSession?.id);
          if (freshCurrent) {
            setActiveSession((prev) => prev ? { ...prev, usage: freshCurrent.usage } : freshCurrent);
          }
          if (activeSession) {
            const wt = await window.forgepilot.getWorktreeStatus(activeSession.id);
            setWorktreeStatus(wt);
          }
        }
      } catch { /* sidebar keeps its current list */ }
    } catch (error) {
      setRunning(false);
      setStreamingText("");
      const log = liveEventsRef.current;
      liveEventsRef.current = [];
      setLiveEvents([]);
      setActiveSession((current) => current ? { ...current, messages: [...current.messages, ...(log.length ? log : []), { role: "event", kind: "error", text: error instanceof Error ? error.message : "Agent failed", createdAt: nowIso() }] } : current);
    }
  }
  async function stopAgent() { try { await window.forgepilot.cancelAgent(); } catch { /* run already finished */ } }
  async function undoRun(checkpointId: string) {
    if (!checkpointId) return;
    try {
      await window.forgepilot.restoreCheckpoint(checkpointId);
      if (activeProject && activeSession) {
        const updated = await window.forgepilot.updateSession(activeProject.id, activeSession.id, { checkpointId: undefined });
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
      const updated = await window.forgepilot.updateSession(activeProject.id, activeSession.id, { checkpointId: undefined });
      setActiveSession(updated);
    }
  }
  async function revertSingleFile(filePath: string) {
    try {
      await window.forgepilot.revertFile(filePath);
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
          await window.forgepilot.revertAll();
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
        const updated = await window.forgepilot.updateSession(activeProject.id, activeSession.id, { model: undefined });
        setActiveSession(updated);
        setSessions((current) => current.map((session) => session.id === updated.id ? updated : session));
      }
      return;
    }
    setSelectedProviderId(providerId);
    setSelectedModel(model);
    if (activeProject && activeSession) {
      const modelPayload = { providerId, model };
      const updated = await window.forgepilot.updateSession(activeProject.id, activeSession.id, { model: modelPayload });
      setActiveSession(updated);
      setSessions((current) => current.map((session) => session.id === updated.id ? updated : session));
    }
  }
  function handleProvidersChange(nextProviders: ProviderConfig[]) {
    setProviders(nextProviders);
    const activeProvider = nextProviders.find((p) => p.id === selectedProviderId);
    const modelValid = activeProvider ? activeProvider.models.includes(selectedModel) : false;
    if (!activeProvider || !modelValid) {
      const fallbackId = nextProviders[0]?.id || "";
      const fallbackModel = nextProviders[0]?.models[0] || "";
      setSelectedProviderId(fallbackId);
      setSelectedModel(fallbackModel);
      if (activeProject && activeSession) {
        const modelPayload = fallbackId && fallbackModel ? { providerId: fallbackId, model: fallbackModel } : undefined;
        void window.forgepilot.updateSession(activeProject.id, activeSession.id, { model: modelPayload }).then((updated) => {
          setActiveSession(updated);
          setSessions((current) => current.map((s) => s.id === updated.id ? updated : s));
        });
      }
    }
  }
  async function saveSandbox() { const saved = await window.forgepilot.saveSandboxConfig({ provider: "local", enabled: sandboxEnabled, requireApproval: sandboxRequireApproval, allowNetwork: sandboxAllowNetwork, commandTimeoutSeconds: Number(sandboxTimeout) || 120 }); setSandboxConfig(saved); setShowSandbox(false); await loadSandboxStatus(); }
  async function stopSandbox() { await window.forgepilot.stopSandbox(); await loadSandboxStatus(); }
  async function saveMemories(projectMemory: string, sessionMemory: string) { if (!activeProject || !activeSession) return; const project = await window.forgepilot.updateProjectMemory(activeProject.id, projectMemory); const session = await window.forgepilot.updateSessionMemory(activeProject.id, activeSession.id, sessionMemory); setActiveProject(project); setActiveSession(session); }

  const headerTitle = activeSession?.title || "No session selected";
  const currentSessionUsage = getSessionUsage(activeSession);
  return <div className="product-shell">
    <header className="product-topbar">
      <div className="product-left">
        <button className="icon-plain" onClick={() => setShowSessions((value) => !value)} title="Toggle project and session navigation">
          <Menu size={15} />
        </button>
        <div className="product-logo">
          <NexusLogo size={20} />
          <span className="nexus-title">nexus<span className="nexus-cursor">_</span></span>
        </div>
        <div className="top-separator" />
        <button className="project-menu" onClick={() => setShowSessions((value) => !value)}>
          <FolderOpen size={13} />
          <strong>{activeProject?.name || "Projects"}</strong>
          <ChevronDown size={12} />
        </button>
        <span className="branch">
          <GitBranch size={11} /> {gitBranch}
        </span>
      </div>

      <div className="session-top-title">
        <span className="green-dot" />
        <span className="session-title-text">{headerTitle}</span>
        <small>{activeProject ? "Local session" : "Open a project"}</small>
      </div>

      <div className="product-right">
        {currentSessionUsage && currentSessionUsage.totalTokens > 0 && (
          <span className="token-chip" title={`${currentSessionUsage.inputTokens.toLocaleString()} prompt + ${currentSessionUsage.outputTokens.toLocaleString()} completion tokens`}>
            <Coins size={11} /> {currentSessionUsage.totalTokens >= 1000 ? `${(currentSessionUsage.totalTokens / 1000).toFixed(1)}k` : currentSessionUsage.totalTokens.toLocaleString()} tokens · ~${currentSessionUsage.estimatedCost.toFixed(4)}
          </span>
        )}
        {projectRules && projectRules.hasRules && (
          <button className="top-link" onClick={() => setShowRulesModal(true)} title="View active project rules">
            <BookOpen size={13} /> Rules ({projectRules.ruleFiles.length})
          </button>
        )}
        <button className="top-link" onClick={() => setShowDaemonsModal(true)} title="Manage background services and dev servers">
          <Server size={13} /> Services
        </button>
        <button className="top-link" onClick={() => setView("diff")}>
          <GitBranch size={13} /> {diff.length ? `Diff (${diff.length})` : "Diff"}
        </button>
        <button className="top-link" onClick={() => setShowSandbox(true)}>
          <ShieldCheck size={13} /> Sandbox
        </button>
        <button className="top-link" onClick={() => setShowMcp(true)}>
          <Server size={13} /> MCP
        </button>
        <button className="top-link" onClick={() => setShowSkills(true)}>
          <Puzzle size={13} /> Skills
        </button>
        <button className="top-link" onClick={() => setShowProviders(true)}>
          <KeyRound size={13} /> Providers
        </button>
        <button className="icon-plain" onClick={() => setShowProviders(true)} title="Settings">
          <Settings2 size={15} />
        </button>
        <span className="user-chip">ME</span>
        <div className="top-separator window-ctrl-sep" />
        <WindowControls />
      </div>
    </header>
    <div className="product-body">
      {showSessions && <aside className="session-pane"><div className="pane-top"><span>PROJECTS</span><button className="pane-action" onClick={() => setShowCreateProject(true)}><Plus size={15} /></button></div><button className="create-project-btn" onClick={() => setShowCreateProject(true)}><Plus size={14} /> New project</button><div className="project-list">{projects.map((project) => <button key={project.id} className={`project-row ${project.id === activeProject?.id ? "active" : ""}`} onClick={() => void activateProject(project.id)}><span className="project-dot" /><span>{project.name}</span><small>{project.sessions.length}</small><i className="row-delete" onClick={(event) => { event.stopPropagation(); void deleteProjectById(project.id); }}><Trash2 size={12} /></i></button>)}{!projects.length && <div className="empty-pane">Create a project to start.</div>}</div>{activeProject && <><div className="pane-top sessions-label"><span>SESSIONS</span><button className="pane-action" onClick={() => void createSession()}><Plus size={15} /></button></div><button className="new-session-btn" onClick={() => void createSession()}><MessageSquare size={13} /> New coding session <kbd>⌘ N</kbd></button><div className="session-list">{sessions.map((session) => <button key={session.id} className={`session-row ${session.id === activeSession?.id ? "active" : ""}`} onClick={() => void activateSession(session.id)}><MessageSquare size={13} /><span>{session.title}</span><small>{session.messages.length}</small><i className="row-delete" onClick={(event) => { event.stopPropagation(); void deleteActiveSession(session.id); }}><Trash2 size={12} /></i></button>)}</div></>}</aside>}
      <main className="coding-workspace">
        <div className="workspace-bar"><div className="workspace-breadcrumb"><button className="bar-toggle" onClick={() => setShowFiles((value) => !value)}><PanelLeft size={14} /></button><span>{activeProject?.name || "No project"}</span><i>/</i><strong>{view === "chat" ? "Agent session" : view === "memory" ? "Memory" : view === "diff" ? "Git diff" : view === "terminal" ? "Terminal" : view === "browser" ? "Live Browser" : activeFile}</strong></div><div className="workspace-actions"><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><MessageSquare size={13} /> Agent</button><button className={view === "files" ? "active" : ""} onClick={() => setView("files")}><Code2 size={13} /> Files</button><button className={view === "diff" ? "active" : ""} onClick={() => { setView("diff"); void refreshDiff(); }}><GitBranch size={13} /> Diff</button><button className={view === "terminal" ? "active" : ""} onClick={() => setView("terminal")}><Terminal size={13} /> Terminal</button><button className={view === "browser" ? "active" : ""} onClick={() => setView("browser")}><Globe size={13} /> Browser</button><button className={view === "memory" ? "active" : ""} onClick={() => setView("memory")}><Brain size={13} /> Memory</button></div></div>
        <div className="workspace-content">
          {showFiles && <aside className="file-pane"><div className="file-pane-header"><span>EXPLORER</span><div><button className="pane-action" onClick={() => void loadWorkspace()}><RefreshCw size={13} /></button></div></div><div className="root-label"><ChevronDown size={13} /> {activeProject?.name?.toUpperCase() || "NO WORKSPACE"}</div><div className="file-tree">{visibleFiles.map((entry) => <FileRow key={entry.path} entry={entry} active={entry.path === activeFile} expanded={expandedFolders.has(entry.path)} onClick={() => entry.kind === "folder" ? toggleFolder(entry.path) : void openFile(entry.path)} />)}</div><div className="file-pane-footer"><span>{files.filter((entry) => entry.kind === "file").length} files</span><span>LOCAL</span></div></aside>}
          <section className="center-pane">{view === "chat" ? <AgentView hasProject={Boolean(activeProject)} activeFile={activeFile} messages={currentMessages} draft={draft} setDraft={setDraft} submit={(override) => void submit(override)} running={running} onStop={() => void stopAgent()} streamingText={streamingText} liveEvents={liveEvents} mode={mode} setMode={setMode} selectedProviderId={selectedProviderId} selectedModel={selectedModel} providers={providers} definitions={providerDefinitions} files={files} checkpointId={activeSession?.checkpointId} diffCount={diff.length} onUndoRun={(id) => void undoRun(id)} onKeepChanges={() => void keepChanges()} switchModel={(providerId, model) => void switchModel(providerId, model)} onOpenProviders={() => setShowProviders(true)} onAttachFile={() => { setDraft((current) => `${current}${current ? "\n" : ""}@${activeFile || "current-file"}`); setShowComposerMenu(false); }} onAttachDiff={() => { setDraft((current) => `${current}${current ? "\n" : ""}Review the current Git diff`); setShowComposerMenu(false); }} showComposerMenu={showComposerMenu} setShowComposerMenu={setShowComposerMenu} sessionUsage={currentSessionUsage} activeSessionId={activeSession?.id} worktreeStatus={worktreeStatus} onOpenArtifact={(art) => setActiveArtifact(art)} onOpenDiff={() => { setView("diff"); void refreshDiff(); }} onMergeSuccess={() => { void refreshDiff(); void loadWorkspace(); }} onDiscardSuccess={() => { void refreshDiff(); void loadWorkspace(); }} attachedImages={attachedImages} setAttachedImages={setAttachedImages} customCommands={customCommands} /> : view === "memory" ? <MemoryView project={activeProject} session={activeSession} onSave={saveMemories} /> : view === "diff" ? <DiffView diff={diff} onRefresh={() => void refreshDiff()} onRevertFile={(f) => void revertSingleFile(f)} onRevertAll={() => void revertAllChanges()} onInspectFile={(f) => setInspectDiffFile(f)} /> : view === "terminal" ? <XTermView projectRoot={activeProject?.root} /> : view === "browser" ? <IntegratedBrowserView projectRoot={activeProject?.root} onSendToAgent={(p) => { setDraft(p); setView("chat"); }} /> : <MonacoEditorView activeFile={activeFile} openFiles={openFiles} setActiveFile={(file) => void openFile(file)} setOpenFiles={setOpenFiles} content={fileContent} setContent={setFileContent} dirty={dirty} save={() => void saveFile()} />}</section>
        </div>
      </main>
      {showContext ? <aside className="context-pane"><div className="context-head"><div><span className="context-kicker">CURRENT SESSION</span><strong>{headerTitle}</strong><small>{activeProject?.name || "No project"}</small></div><button className="context-panel-icon" onClick={() => setShowContext(false)} title="Close context panel"><PanelRight size={15} /></button></div><div className="context-summary"><span className="status-ring">{running ? <Loader2 size={13} className="spin" /> : <Check size={13} />}</span><div><strong>{running ? "Agent is working" : "Ready to code"}</strong><small>{running ? "Inspecting and changing your project" : "Plan, implement, review"}</small></div></div><div className="context-section"><div className="context-section-title"><span>SESSION TOOLS</span><small>{running ? "ACTIVE" : "READY"}</small></div><ContextRow icon={<FileCode2 size={14} />} label="File inspection" detail="Read, search, edit" active={Boolean(activeProject)} /><ContextRow icon={<Terminal size={14} />} label="Terminal" detail="Interactive live shell" active={Boolean(activeProject)} /><ContextRow icon={<GitBranch size={14} />} label="Git diff" detail={diff.length ? `${diff.length} changes to review` : "Clean working tree"} active={Boolean(diff.length)} /></div>{currentSessionUsage && currentSessionUsage.totalTokens > 0 && <div className="context-section"><div className="context-section-title"><span>SESSION TOTAL TOKENS</span><small>CUMULATIVE</small></div><MemoryRow label="Total tokens" value={`${currentSessionUsage.totalTokens.toLocaleString()} tokens`} /><MemoryRow label="In / Out" value={`${currentSessionUsage.inputTokens.toLocaleString()} in / ${currentSessionUsage.outputTokens.toLocaleString()} out`} /><MemoryRow label="Est. cost" value={`~$${currentSessionUsage.estimatedCost.toFixed(4)}`} /></div>}{projectRules && projectRules.hasRules && <div className="context-section"><div className="context-section-title"><span>PROJECT RULES</span><button onClick={() => setShowRulesModal(true)}><ChevronRight size={13} /></button></div><MemoryRow label="Active rule files" value={`${projectRules.ruleFiles.length} file${projectRules.ruleFiles.length === 1 ? "" : "s"}`} /></div>}<div className="context-section"><div className="context-section-title"><span>MEMORY</span><button onClick={() => setView("memory")}><ChevronRight size={13} /></button></div><MemoryRow label="Project memory" value={activeProject?.memory ? "Updated" : "Empty"} /><MemoryRow label="Session memory" value={activeSession?.memory ? "Updated" : "Empty"} /></div><div className="context-section"><div className="context-section-title"><span>MODEL</span><button onClick={() => setShowProviders(true)}><Settings2 size={13} /></button></div><div className="active-model" onClick={() => setShowProviders(true)} style={{ cursor: "pointer" }}><span className="model-orb"><Sparkles size={13} /></span><div><strong>{selectedModel || "No model selected"}</strong><small>{selectedProvider?.label || "Add a provider"}</small></div><ChevronDown size={13} /></div></div><div className="context-bottom"><ShieldCheck size={13} /><span>{sandboxStatus.status === "ready" ? "Sandbox ready · isolated execution" : sandboxStatus.configured ? `Sandbox · ${sandboxStatus.status}` : "Sandbox not configured"}</span><button className="sandbox-stop" onClick={() => void stopSandbox()} disabled={sandboxStatus.status !== "ready"}><Square size={11} /></button></div></aside> : <button className="context-restore" onClick={() => setShowContext(true)} title="Open context panel"><PanelRight size={15} /></button>}
    </div>
    {showCreateProject && <Modal title="Create project" subtitle="Add a local repository as a persistent Nexus project" onClose={() => setShowCreateProject(false)}><label>Project name<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="My application" /></label><label>Local folder<input value={newProjectRoot} onChange={(event) => setNewProjectRoot(event.target.value)} placeholder="C:\\Users\\you\\code\\my-app" /></label><div className="modal-actions"><button className="secondary" onClick={() => void openProjectFromDialog()}>Choose folder</button><button className="primary" onClick={() => void createProject()}>Create project</button></div></Modal>}
    {showProviders && <ProviderModal providers={providers} definitions={providerDefinitions} onProvidersChange={handleProvidersChange} onClose={() => setShowProviders(false)} />}
    {showSandbox && <SandboxModal config={sandboxConfig} requireApproval={sandboxRequireApproval} setRequireApproval={setSandboxRequireApproval} allowNetwork={sandboxAllowNetwork} setAllowNetwork={setSandboxAllowNetwork} timeout={sandboxTimeout} setTimeout={setSandboxTimeout} enabled={sandboxEnabled} setEnabled={setSandboxEnabled} status={sandboxStatus} onSave={() => void saveSandbox()} onClose={() => setShowSandbox(false)} />}
    {showMcp && <McpModal onClose={() => setShowMcp(false)} />}
    {showSkills && <SkillsModal hasProject={Boolean(activeProject)} enabled={skillsEnabled} onToggle={async (enabled) => { setSkillsEnabled(enabled); await window.forgepilot.saveSkillsConfig({ enabled }); }} onClose={() => setShowSkills(false)} />}
    {showDaemonsModal && (
      <DaemonsModal
        projectRoot={activeProject?.root}
        onClose={() => setShowDaemonsModal(false)}
      />
    )}
    {inspectDiffFile && (
      <MonacoDiffModal
        fileName={inspectDiffFile.name}
        filePath={inspectDiffFile.path}
        patch={inspectDiffFile.patch}
        additions={inspectDiffFile.additions}
        deletions={inspectDiffFile.deletions}
        onClose={() => setInspectDiffFile(null)}
        onRevertFile={(f) => {
          void revertSingleFile(f);
          setInspectDiffFile(null);
        }}
      />
    )}
    {showRulesModal && projectRules && (
      <ProjectRulesModal
        ruleFiles={projectRules.ruleFiles}
        onClose={() => setShowRulesModal(false)}
      />
    )}
    {activeArtifact && (
      <ArtifactViewer
        artifact={activeArtifact}
        onClose={() => setActiveArtifact(null)}
        onApproveAndExecute={(plan) => {
          setMode("Auto");
          void submit(`Execute the approved implementation plan:\n\n${plan}`);
        }}
        onStatusChange={async (filename, status) => {
          if (activeSession) {
            const updated = await window.forgepilot.updateArtifactStatus(activeSession.id, filename, status);
            if (updated) setActiveArtifact(updated);
          }
        }}
      />
    )}
    {confirmDialog && (
      <ConfirmModal
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        danger={confirmDialog.danger}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(null)}
      />
    )}
  </div>;
}

function AgentView({
  hasProject, activeFile, messages, draft, setDraft, submit, running, onStop, streamingText, liveEvents, mode, setMode,
  selectedProviderId, selectedModel, providers, definitions, files, checkpointId, diffCount, onUndoRun,
  onKeepChanges, switchModel, onOpenProviders, onAttachFile, onAttachDiff, showComposerMenu, setShowComposerMenu, sessionUsage,
  activeSessionId, worktreeStatus, onOpenArtifact, onOpenDiff, onMergeSuccess, onDiscardSuccess,
  attachedImages, setAttachedImages, customCommands
}: {
  hasProject: boolean; activeFile: string; messages: ChatItem[]; draft: string; setDraft: (value: string) => void;
  submit: (override?: string) => void; running: boolean; onStop: () => void; streamingText: string; liveEvents: ChatItem[]; mode: string; setMode: (value: string) => void;
  selectedProviderId: string; selectedModel: string; providers: ProviderConfig[]; definitions: ProviderDefinition[];
  files: FileEntry[]; checkpointId?: string; diffCount: number; onUndoRun: (id: string) => void; onKeepChanges: () => void;
  switchModel: (providerId: string, model: string) => void; onOpenProviders: () => void; onAttachFile: () => void;
  onAttachDiff: () => void; showComposerMenu: boolean; setShowComposerMenu: (value: boolean) => void;
  sessionUsage?: AgentUsage;
  activeSessionId?: string;
  worktreeStatus?: { isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenDiff?: () => void;
  onMergeSuccess?: () => void;
  onDiscardSuccess?: () => void;
  attachedImages: string[];
  setAttachedImages: React.Dispatch<React.SetStateAction<string[]>>;
  customCommands?: SlashCommand[];
}) {
  const provider = providers.find((item) => item.id === selectedProviderId);
  const def = definitions.find((item) => item.id === provider?.provider);
  const models = provider?.models?.length ? provider.models : def?.models || [];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages, liveEvents, streamingText]);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);

  const isSlash = draft.startsWith("/") && !draft.includes(" ");

  const transcriptNodes: ReactNode[] = [];
  let pendingActivity: ChatItem[] = [];
  const flushActivity = () => { if (pendingActivity.length) { transcriptNodes.push(<ActivityGroupView key={`activity-${pendingActivity[0].createdAt}-${transcriptNodes.length}`} events={pendingActivity} running={false} onOpenArtifact={onOpenArtifact} />); pendingActivity = []; } };
  messages.forEach((message, index) => { if (message.role === "event") pendingActivity.push(message); else { flushActivity(); transcriptNodes.push(<ChatItemView key={`${message.createdAt}-${index}`} message={message} onOpenArtifact={onOpenArtifact} />); } });
  flushActivity();

  const matchingFiles = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return files.filter((f) => f.kind === "file" && f.path.toLowerCase().includes(query)).slice(0, 8);
  }, [mentionQuery, files]);

  function handleDraftChange(value: string, cursorPosition: number) {
    setDraft(value);
    const beforeCursor = value.slice(0, cursorPosition);
    const match = beforeCursor.match(/@([a-zA-Z0-9_./-]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function insertMention(filePath: string) {
    if (!textareaRef.current) return;
    const cursor = textareaRef.current.selectionStart || draft.length;
    const beforeCursor = draft.slice(0, cursor);
    const afterCursor = draft.slice(cursor);
    const updatedBefore = beforeCursor.replace(/@([a-zA-Z0-9_./-]*)$/, `@${filePath} `);
    setDraft(`${updatedBefore}${afterCursor}`);
    setMentionQuery(null);
    setTimeout(() => textareaRef.current?.focus(), 10);
  }

  function handleSlashSelect(cmd: SlashCommand) {
    if (cmd.mode) {
      setMode(cmd.mode === "plan" ? "Plan" : cmd.mode === "auto" ? "Auto" : "Ask");
    }
    setDraft("");
    if (cmd.promptTemplate) {
      let template = cmd.promptTemplate;
      template = template.replace(/\{\{input\}\}/gi, "");
      template = template.replace(/\{\{activeFile\}\}/gi, activeFile || "workspace files");
      template = template.replace(/\{\{diffSummary\}\}/gi, diffCount ? `${diffCount} changed files` : "clean working tree");
      submit(template.trim());
      return;
    }
    if (cmd.command === "/test") {
      submit("Run project verification and tests");
    } else if (cmd.command === "/diff") {
      onOpenDiff?.();
    } else if (cmd.command === "/checkpoint") {
      submit("Create checkpoint and review workspace state");
    } else if (cmd.command === "/help") {
      submit("What tools, commands, and skills are available in this project?");
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (loadEvt) => {
            const url = loadEvt.target?.result as string;
            if (url) setAttachedImages((current) => [...current, url]);
          };
          reader.readAsDataURL(file);
        }
      }
    }
  }

  function handleImageFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList) return;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = (loadEvt) => {
          const url = loadEvt.target?.result as string;
          if (url) setAttachedImages((current) => [...current, url]);
        };
        reader.readAsDataURL(file);
      }
    }
    event.target.value = "";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && matchingFiles.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % matchingFiles.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current - 1 + matchingFiles.length) % matchingFiles.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(matchingFiles[mentionIndex].path);
        return;
      }
      if (event.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }

    if (isSlash) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((c) => c + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((c) => Math.max(0, c - 1));
        return;
      }
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      submit();
    }
  }

  return <div className="agent-view">
    {activeSessionId && worktreeStatus?.isGit && worktreeStatus.worktree && (
      <WorktreeBar
        sessionId={activeSessionId}
        isGit={worktreeStatus.isGit}
        worktree={worktreeStatus.worktree}
        onMergeSuccess={onMergeSuccess}
        onDiscardSuccess={onDiscardSuccess}
      />
    )}
    <div className="agent-view-head">
      <div>
        <span className="view-kicker">CODING AGENT</span>
        <h1>{running ? "Working on your task" : hasProject ? "Ready for your task" : "Open a project to begin"}</h1>
        <p>{running ? "The agent is using the selected project context." : hasProject ? "Describe the outcome. ForgePilot will inspect, plan, implement and validate." : "Create or open a local project. Nothing is preloaded."}</p>
      </div>
      <div className="agent-view-meta">
        {sessionUsage && sessionUsage.totalTokens > 0 && (
          <span className="session-usage-pill" title={`${sessionUsage.inputTokens.toLocaleString()} in / ${sessionUsage.outputTokens.toLocaleString()} out`}>
            <Coins size={12} />
            <span>Session: <b>{sessionUsage.totalTokens >= 1000 ? `${(sessionUsage.totalTokens / 1000).toFixed(1)}k` : sessionUsage.totalTokens.toLocaleString()}</b> tokens</span>
            <span className="cost">~${sessionUsage.estimatedCost.toFixed(4)}</span>
          </span>
        )}
        <span className="local-badge"><span /> Local</span>
        <span className="mode-badge">{mode} mode</span>
      </div>
    </div>
    <div className="agent-transcript" ref={transcriptRef}>
      {!messages.length && <div className="empty-agent"><div className="empty-agent-icon"><Sparkles size={20} /></div><h2>Start a coding session</h2><p>Ask for a feature, a bug fix, a refactor, or a code review. Type @ to reference files, or / for slash shortcuts.</p></div>}
      {transcriptNodes}
      {checkpointId && diffCount > 0 && !running && (
        <div className="rollback-card">
          <div className="rollback-info">
            <GitBranch size={14} />
            <span>Agent made changes in <strong>{diffCount} file{diffCount === 1 ? "" : "s"}</strong></span>
          </div>
          <div className="rollback-actions">
            <button className="secondary" onClick={() => onUndoRun(checkpointId)} title="Discard all changes from this run">
              <RotateCcw size={12} /> Undo run
            </button>
            <button className="primary" onClick={onKeepChanges} title="Accept and keep all changes">
              <Check size={12} /> Keep changes
            </button>
          </div>
        </div>
      )}
      {running && <ActivityGroupView events={liveEvents} running currentText={streamingText} onOpenArtifact={onOpenArtifact} />}
    </div>
    <div className="agent-input-area">
      <input
        type="file"
        ref={imageInputRef}
        style={{ display: "none" }}
        accept="image/*"
        multiple
        onChange={handleImageFileSelect}
      />
      <div className="agent-input" style={{ position: "relative" }}>
        {mentionQuery !== null && matchingFiles.length > 0 && (
          <div className="mention-dropdown">
            {matchingFiles.map((file, idx) => (
              <button
                key={file.path}
                className={`mention-item ${idx === mentionIndex ? "active" : ""}`}
                onClick={() => insertMention(file.path)}
              >
                {fileIcon(file.path)}
                <span>{file.path}</span>
              </button>
            ))}
          </div>
        )}
        {isSlash && (
          <SlashCommandPopup
            filter={draft}
            customCommands={customCommands}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
          />
        )}
        {attachedImages.length > 0 && (
          <div className="image-attachments-bar">
            {attachedImages.map((img, idx) => (
              <div className="image-preview-chip" key={idx}>
                <img src={img} alt="Preview" className="image-preview-thumb" />
                <button
                  className="image-preview-remove"
                  onClick={() => setAttachedImages((current) => current.filter((_, i) => i !== idx))}
                  title="Remove image"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value, event.target.selectionStart || event.target.value.length)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Ask the agent to inspect, change, test, or review your project… (paste images with Ctrl+V, type @ for files, / for commands)"
          rows={3}
        />
        <div className="input-footer">
          <div className="input-left">
            <div className="composer-more-wrap">
              <button className="attach-button" onClick={() => setShowComposerMenu(!showComposerMenu)} title="Attach context"><Plus size={14} /></button>
              {showComposerMenu && (
                <div className="composer-menu">
                  <button disabled={!activeFile} onClick={onAttachFile}><FileCode2 size={13} /> Attach current file</button>
                  <button onClick={onAttachDiff}><GitBranch size={13} /> Attach Git diff</button>
                  <button onClick={() => { imageInputRef.current?.click(); setShowComposerMenu(false); }}><ImageIcon size={13} /> Attach screenshot / image</button>
                </div>
              )}
            </div>
            <VoiceDictationButton onTranscript={(text) => setDraft(draft ? `${draft} ${text}` : text)} disabled={running} />
            <div className="mode-select">
              {["Plan", "Ask", "Auto"].map((item) => <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item}</button>)}
            </div>
            <ModelSelect selectedProviderId={selectedProviderId} selectedModel={selectedModel} providers={providers} definitions={definitions} switchModel={switchModel} onOpenProviders={onOpenProviders} />
          </div>
          <button className={`send-button${running ? " stop" : ""}`} disabled={!running && !draft.trim() && attachedImages.length === 0} onClick={running ? onStop : () => submit()} title={running ? "Stop the agent" : "Send"}>{running ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}</button>
        </div>
      </div>
      <div className="input-note"><ShieldCheck size={12} /> ForgePilot can edit files, inspect websites, and run safe commands inside this workspace</div>
    </div>
  </div>;
}

function DiffView({ diff, onRefresh, onRevertFile, onRevertAll, onInspectFile }: { diff: WorkspaceDiffFile[]; onRefresh: () => void; onRevertFile: (path: string) => void; onRevertAll: () => void; onInspectFile?: (file: WorkspaceDiffFile) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (file: string) => setExpanded((current) => { const next = new Set(current); next.has(file) ? next.delete(file) : next.add(file); return next; });
  const additions = diff.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.reduce((sum, file) => sum + file.deletions, 0);

  return <div className="artifact-view diff-artifact-view">
    <div className="artifact-head">
      <div>
        <span className="view-kicker">REVIEW ARTIFACT</span>
        <h2>Changed files</h2>
        <p>{diff.length ? `${diff.length} changed file${diff.length === 1 ? "" : "s"} in the active project` : "No changes in the active project"}</p>
      </div>
      <div className="diff-head-actions">
        <select className="diff-scope-select" value="unstaged" aria-label="Diff scope"><option value="unstaged">Unstaged</option></select>
        <span className="diff-total-add">+{additions}</span>
        <span className="diff-total-del">−{deletions}</span>
        {diff.length > 0 && <button className="secondary danger-btn" onClick={onRevertAll} title="Discard all workspace changes"><RotateCcw size={13} /> Discard all</button>}
        <button className="secondary" onClick={onRefresh}><RefreshCw size={13} /> Refresh</button>
      </div>
    </div>
    <div className="diff-file-list">
      {diff.map((file) => (
        <div className="diff-file" key={file.path}>
          <button className="diff-file-row" onClick={() => toggle(file.path)}>
            <span className="diff-file-icon">{fileIcon(file.name)}</span>
            <span className="diff-file-name">{file.name}</span>
            <span className="diff-file-directory">{file.directory}</span>
            <span className="diff-file-stats"><b>+{file.additions}</b><em>−{file.deletions}</em></span>
            {onInspectFile && (
              <i className="diff-revert-btn" onClick={(event) => { event.stopPropagation(); onInspectFile(file); }} title="Inspect in Monaco Side-by-Side Diff"><Columns size={12} /></i>
            )}
            <i className="diff-revert-btn" onClick={(event) => { event.stopPropagation(); onRevertFile(file.path); }} title="Discard changes in this file"><RotateCcw size={12} /></i>
            {expanded.has(file.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {expanded.has(file.path) && <DiffPatch patch={file.patch} />}
        </div>
      ))}
      {!diff.length && <div className="diff-empty"><GitBranch size={18} /><span>The working tree is clean.</span></div>}
    </div>
  </div>;
}

function ModelSelect({ selectedProviderId, selectedModel, providers, definitions, switchModel, onOpenProviders }: { selectedProviderId: string; selectedModel: string; providers: ProviderConfig[]; definitions: ProviderDefinition[]; switchModel: (providerId: string, model: string) => void; onOpenProviders: () => void }) {
  const provider = providers.find((item) => item.id === selectedProviderId);
  const modelExists = provider?.models.includes(selectedModel);
  const selectValue = provider && modelExists ? `${selectedProviderId}::${selectedModel}` : "";

  return (
    <div className="model-select">
      <select
        value={selectValue}
        onChange={(event) => {
          const val = event.target.value;
          if (!val) {
            onOpenProviders();
            return;
          }
          const [id, ...rest] = val.split("::");
          switchModel(id, rest.join("::"));
        }}
      >
        <option value="">{providers.length ? "Select model…" : "Configure provider…"}</option>
        {providers.map((item) => (
          <optgroup key={item.id} label={item.label}>
            {item.models.map((model) => (
              <option key={`${item.id}-${model}`} value={`${item.id}::${model}`}>
                {model}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {provider && <span className="provider-dot" style={{ pointerEvents: "none" }}>{provider.label.slice(0, 1)}</span>}
      <ChevronDown size={12} style={{ pointerEvents: "none" }} />
    </div>
  );
}

function ChatItemView({ message, onOpenArtifact }: { message: ChatItem; onOpenArtifact?: (artifact: ArtifactItem) => void }) {
  if (message.artifact) {
    return (
      <div className="chat-artifact-card" onClick={() => onOpenArtifact?.(message.artifact!)}>
        <div className="chat-artifact-left">
          <Sparkles size={16} className="text-amber-400" />
          <div>
            <div className="chat-artifact-name">{message.artifact.name}</div>
            <small style={{ color: "#7b889b", fontSize: "10px" }}>{message.artifact.filename}</small>
          </div>
        </div>
        <div className="chat-artifact-right">
          <span className={`badge-status status-${message.artifact.status}`}>
            {message.artifact.status.replace("_", " ")}
          </span>
          <Eye size={14} style={{ color: "#a89df7" }} />
        </div>
      </div>
    );
  }
  if (message.role === "event" && message.kind === "subagent" && message.subagent) {
    return <SubagentCardView subagent={message.subagent} timestamp={message.createdAt} />;
  }
  if (message.role === "event" && message.kind === "plan" && message.plan?.length) {
    return <div className="plan-card">
      <div className="plan-card-head">
        <span className="view-kicker">WORKING PLAN</span>
        <time>{timeLabel(message.createdAt)}</time>
      </div>
      {message.plan.map((item, index) => (
        <div className={`plan-item ${item.status}`} key={index}>
          <span className="plan-status">{item.status === "completed" ? <Check size={12} /> : item.status === "in_progress" ? <Loader2 size={12} className="spin" /> : <CircleDot size={12} />}</span>
          <span>{item.content}</span>
        </div>
      ))}
    </div>;
  }
  if (message.role === "event") {
    return <div className={`chat-event-row ${message.kind}`}>
      <span>{message.kind === "tool" ? <Terminal size={12} /> : message.kind === "error" ? <X size={12} /> : <Activity size={12} />}</span>
      <p>{message.text}</p>
      <time>{timeLabel(message.createdAt)}</time>
    </div>;
  }
  return <div className={`chat-message ${message.role}`}>
    <div className="chat-author">
      {message.role === "assistant" ? <><span className="agent-avatar"><Bot size={13} /></span> ForgePilot</> : <><span className="you-avatar">ME</span> You</>}
      <time>{timeLabel(message.createdAt)}</time>
    </div>
    {message.images && message.images.length > 0 && (
      <div className="chat-message-images">
        {message.images.map((img, idx) => (
          <img key={idx} src={img} alt="Attached screenshot" className="chat-attached-img" />
        ))}
      </div>
    )}
    <div className="chat-message-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
    {message.role === "assistant" && message.usage && message.usage.totalTokens > 0 && (
      <div className="message-usage-footer" title={`${message.usage.inputTokens.toLocaleString()} input tokens, ${message.usage.outputTokens.toLocaleString()} output tokens`}>
        <Coins size={11} />
        <span><b>{message.usage.totalTokens.toLocaleString()}</b> tokens ({message.usage.inputTokens.toLocaleString()} in / {message.usage.outputTokens.toLocaleString()} out)</span>
        <span className="message-usage-cost">~${message.usage.estimatedCost.toFixed(4)}</span>
      </div>
    )}
  </div>;
}

function ActivityGroupView({ events, running, currentText, onOpenArtifact }: { events: ChatItem[]; running: boolean; currentText?: string; onOpenArtifact?: (artifact: ArtifactItem) => void }) {
  const [expanded, setExpanded] = useState(running);
  const latest = currentText || events[events.length - 1]?.text || (running ? "Inspecting the workspace…" : "Completed agent activity");
  const hasError = events.some((event) => event.kind === "error");
  return <div className={`activity-group ${running ? "running" : hasError ? "error" : "completed"}`}>
    <button className="activity-group-summary" onClick={() => setExpanded((value) => !value)}>
      <span className="activity-group-icon">{running ? <Loader2 size={13} className="spin" /> : hasError ? <X size={13} /> : <Check size={13} />}</span>
      <span className="activity-group-title">{latest}</span>
      <span className="activity-group-count">{events.length ? `${events.length} step${events.length === 1 ? "" : "s"}` : "Working"}</span>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
    {expanded && <div className="activity-group-body">
      {events.map((event, index) => <details className="activity-step" key={`${event.createdAt}-${index}`} open={index === events.length - 1 && running}>
        <summary><span className={`activity-step-dot ${event.kind || "status"}`}>{event.kind === "tool" ? <Terminal size={11} /> : event.kind === "error" ? <X size={11} /> : event.kind === "plan" ? <Brain size={11} /> : event.kind === "subagent" ? <Bot size={11} /> : <Activity size={11} />}</span><span>{event.text || event.kind || "Agent action"}</span><time>{timeLabel(event.createdAt)}</time><ChevronRight size={12} /></summary>
        <div className="activity-step-detail"><ChatItemView message={event} onOpenArtifact={onOpenArtifact} /></div>
      </details>)}
      {running && currentText && <div className="activity-current"><Loader2 size={11} className="spin" />{currentText}</div>}
    </div>}
  </div>;
}

function SubagentCardView({ subagent, timestamp }: { subagent: SubagentItem; timestamp: string }) {
  const [expanded, setExpanded] = useState(false);
  const roleLabel = subagent.role === "researcher" ? "Researcher" : subagent.role === "tester" ? "Tester" : "Coder";
  const roleIcon = subagent.role === "researcher" ? <Search size={11} /> : subagent.role === "tester" ? <Terminal size={11} /> : <Code2 size={11} />;

  return (
    <div className={`subagent-card ${subagent.status}`}>
      <div className="subagent-card-head" onClick={() => setExpanded(!expanded)}>
        <div className="subagent-card-left">
          <span className={`subagent-role-pill ${subagent.role}`}>
            {roleIcon} {roleLabel}
          </span>
          <span className="subagent-task-title">{subagent.task}</span>
        </div>
        <div className="subagent-card-right">
          <span className={`subagent-status-badge ${subagent.status}`}>
            {subagent.status === "running" ? <Loader2 size={11} className="spin" /> : subagent.status === "completed" ? <Check size={11} /> : <X size={11} />}
            {subagent.status}
          </span>
          <time style={{ fontSize: "10px", color: "#6b5f9e" }}>{timeLabel(timestamp)}</time>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </div>
      {expanded && (
        <div className="subagent-body">
          {subagent.steps.length > 0 && (
            <>
              <div className="subagent-steps-head">
                <span>Tool Execution Steps ({subagent.steps.length})</span>
              </div>
              <div className="subagent-steps-list">
                {subagent.steps.map((step, idx) => (
                  <div className="subagent-step-item" key={idx}>
                    <CheckCircle2 size={10} />
                    <span>{step.toolName}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {subagent.output && (
            <div className="subagent-output-block">
              {subagent.output}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({ entry, active, expanded, onClick }: { entry: FileEntry; active: boolean; expanded: boolean; onClick: () => void }) {
  const nested = entry.path.includes("/");
  return <button className={`tree-row ${active ? "active" : ""} ${nested ? "nested" : ""}`} onClick={onClick}>
    {entry.kind === "folder" ? <>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FolderOpen size={14} /></> : <>{!nested && <span className="indent" />}{fileIcon(entry.path)}</>}
    <span>{entry.path.split("/").pop()}</span>
  </button>;
}

function EditorView({ activeFile, openFiles, setActiveFile, setOpenFiles, content, setContent, dirty, save }: { activeFile: string; openFiles: string[]; setActiveFile: (file: string) => void; setOpenFiles: (files: string[]) => void; content: string; setContent: (value: string) => void; dirty: boolean; save: () => void }) {
  return <div className="editor-view">
    <div className="editor-tabs">{openFiles.map((file) => <button key={file} className={file === activeFile ? "active" : ""} onClick={() => setActiveFile(file)}>{fileIcon(file)}<span>{file.split("/").pop()}</span>{file === activeFile && dirty && <i />}<X size={12} onClick={(event) => { event.stopPropagation(); setOpenFiles(openFiles.filter((item) => item !== file)); }} /></button>)}</div>
    <div className="editor-toolbar"><span>{activeFile || "No file"}</span><div><span className={dirty ? "unsaved" : "saved"}>{dirty ? "Unsaved" : "Saved"}</span><button disabled={!dirty} onClick={save}><Save size={13} /> Save</button></div></div>
    <div className="editor-content"><div className="line-numbers">{content.split("\n").map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)} /></div>
  </div>;
}

function parseDiffPatch(patch: string): SplitDiffRow[] { let oldLine = 0; let newLine = 0; const rows: SplitDiffRow[] = []; let deleted: DiffSide[] = []; let added: DiffSide[] = []; const flushChanges = () => { const count = Math.max(deleted.length, added.length); for (let index = 0; index < count; index++) { const old = deleted[index]; const next = added[index]; rows.push({ kind: old && next ? "change" : old ? "deleted" : "added", old, new: next }); } deleted = []; added = []; }; for (const line of patch.split(/\r?\n/)) { if (line.startsWith("@@")) { flushChanges(); const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/); if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); } rows.push({ kind: "hunk", text: line }); continue; } if (!line || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\\\ No newline")) continue; if (line.startsWith("+")) { added.push({ number: newLine++, text: line.slice(1) }); continue; } if (line.startsWith("-")) { deleted.push({ number: oldLine++, text: line.slice(1) }); continue; } flushChanges(); const text = line.startsWith(" ") ? line.slice(1) : line; rows.push({ kind: "context", old: { number: oldLine++, text }, new: { number: newLine++, text } }); } flushChanges(); return rows; }
function DiffLineView({ side, kind }: { side?: DiffSide; kind: "context" | "added" | "deleted" }) { return <div className={`diff-line-view ${kind}`}><span className="diff-line-number">{side?.number ?? ""}</span><span className="diff-line-bar" /><code>{side?.text || "\u00a0"}</code></div>; }
function DiffPatch({ patch }: { patch: string }) { const rows = parseDiffPatch(patch); const rendered: ReactNode[] = []; rows.forEach((row, index) => { if (row.kind === "hunk") rendered.push(<div className="diff-hunk-row" key={`${index}-hunk`}>{row.text}</div>); else if (row.kind === "context") rendered.push(<DiffLineView key={`${index}-context`} side={row.new} kind="context" />); else { if (row.old) rendered.push(<DiffLineView key={`${index}-old`} side={row.old} kind="deleted" />); if (row.new) rendered.push(<DiffLineView key={`${index}-new`} side={row.new} kind="added" />); } }); return <div className="diff-code-panel">{rendered.length ? rendered : <div className="diff-code-empty">No patch available for this file.</div>}</div>; }
function TerminalView({ input, setInput, output, run }: { input: string; setInput: (value: string) => void; output: string; run: () => void }) { return <div className="artifact-view terminal-view"><div className="artifact-head"><div><span className="view-kicker">EXECUTION ARTIFACT</span><h2>Integrated terminal</h2><p>Run validation commands in the selected project root.</p></div><button className="secondary" onClick={run}><Play size={13} fill="currentColor" /> Run</button></div><div className="terminal-box"><pre>{output}</pre><div className="terminal-command"><span>$</span><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") run(); }} /><button onClick={run}><ArrowUp size={14} /></button></div></div></div>; }
function MemoryView({ project, session, onSave }: { project: ProjectRecord | null; session: SessionRecord | null; onSave: (projectMemory: string, sessionMemory: string) => void }) { const [projectMemory, setProjectMemory] = useState(project?.memory || ""); const [sessionMemory, setSessionMemory] = useState(session?.memory || ""); useEffect(() => { setProjectMemory(project?.memory || ""); setSessionMemory(session?.memory || ""); }, [project?.id, session?.id, project?.memory, session?.memory]); return <div className="memory-view artifact-view"><div className="artifact-head"><div><span className="view-kicker">PERSISTENT CONTEXT</span><h2>Memory</h2><p>Project memory is shared by every session. Session memory stays local to this task.</p></div><button className="primary" onClick={() => onSave(projectMemory, sessionMemory)}><Save size={13} /> Save memory</button></div><div className="memory-grid"><MemoryEditor label="Project memory" description="Shared conventions, architecture decisions and long-term project facts." value={projectMemory} onChange={setProjectMemory} /><MemoryEditor label="Session memory" description="Decisions, discoveries and progress for this coding session." value={sessionMemory} onChange={setSessionMemory} /></div><div className="memory-note"><Sparkles size={14} /><span>The agent appends useful task outcomes to both memory levels after a run. You can edit them at any time.</span></div></div>; }
function MemoryEditor({ label, description, value, onChange }: { label: string; description: string; value: string; onChange: (value: string) => void }) { return <div className="memory-card"><div className="memory-card-head"><div><strong>{label}</strong><p>{description}</p></div><Brain size={15} /></div><textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder="No memory written yet…" /></div>; }
function ContextRow({ icon, label, detail, active }: { icon: ReactNode; label: string; detail: string; active: boolean }) { return <div className="context-row"><span className={active ? "context-icon active" : "context-icon"}>{icon}</span><div><strong>{label}</strong><small>{detail}</small></div><span className={active ? "context-check" : "context-dash"}>{active ? <Check size={12} /> : "—"}</span></div>; }
function MemoryRow({ label, value }: { label: string; value: string }) { return <div className="memory-row"><span>{label}</span><small className={value === "Updated" ? "memory-updated" : ""}>{value}</small></div>; }
function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) { return <div className="modal-layer" onClick={onClose}><div className="modal-card" onClick={(event) => event.stopPropagation()}><div className="modal-card-head"><div><span className="view-kicker">NEXUS</span><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-plain" onClick={onClose}><X size={16} /></button></div>{children}</div></div>; }

type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
};

function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-layer confirm-layer" onClick={onCancel}>
      <div className="modal-card confirm-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-card-head" style={{ marginBottom: "10px" }}>
          <div>
            <span className="view-kicker" style={{ color: danger ? "var(--red)" : "var(--purple)" }}>
              {danger ? "CONFIRM ACTION" : "CONFIRMATION"}
            </span>
            <h2 style={{ fontSize: "16px", margin: "6px 0 4px" }}>{title}</h2>
          </div>
          <button className="icon-plain" onClick={onCancel}><X size={15} /></button>
        </div>
        <p style={{ color: "#a6b2c2", fontSize: "11px", lineHeight: "1.5", margin: "0 0 18px" }}>
          {message}
        </p>
        <div className="modal-actions" style={{ marginTop: "0" }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button
            className={danger ? "primary danger-confirm-btn" : "primary"}
            onClick={onConfirm}
          >
            {danger ? <Trash2 size={13} /> : <Check size={13} />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type ProviderFormState = {
  id?: string;
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
};

function emptyProviderForm(definitions: ProviderDefinition[]): ProviderFormState {
  const def = definitions[0];
  return {
    provider: def?.id || "openai",
    label: def?.label || "OpenAI",
    apiKey: "",
    baseUrl: def?.defaultBaseUrl || "",
    models: [...(def?.models || [])],
  };
}

function formFromProvider(provider: ProviderConfig): ProviderFormState {
  return {
    id: provider.id,
    provider: provider.provider,
    label: provider.label,
    apiKey: provider.apiKey || "",
    baseUrl: provider.baseUrl || "",
    models: provider.models && provider.models.length ? [...provider.models] : [],
  };
}

function ProviderModal({
  providers,
  definitions,
  onProvidersChange,
  onClose,
}: {
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ProviderFormState>(() => emptyProviderForm(definitions));
  const [newModelInput, setNewModelInput] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProviderConfig | null>(null);

  const currentDef = definitions.find((d) => d.id === form.provider) || definitions[0];
  const isCustom = form.provider === "custom";

  function handleSelectDefinition(defId: string) {
    const def = definitions.find((d) => d.id === defId);
    if (!def) return;
    setForm((prev) => ({
      ...prev,
      provider: def.id,
      label: def.id === "custom" ? (prev.label || "Custom endpoint") : def.label,
      baseUrl: def.defaultBaseUrl || "",
      models: [...(def.models || [])],
    }));
    setNewModelInput("");
    setFetchNote("");
    setFetchError("");
  }

  function handleEdit(provider: ProviderConfig) {
    setForm(formFromProvider(provider));
    setIsEditing(true);
    setNewModelInput("");
    setFetchNote("");
    setFetchError("");
  }

  function handleNew() {
    setForm(emptyProviderForm(definitions));
    setIsEditing(false);
    setNewModelInput("");
    setFetchNote("");
    setFetchError("");
  }

  function updateModel(index: number, value: string) {
    setForm((prev) => {
      const next = [...prev.models];
      next[index] = value;
      return { ...prev, models: next };
    });
  }

  function removeModel(index: number) {
    setForm((prev) => {
      const next = prev.models.filter((_, i) => i !== index);
      return { ...prev, models: next };
    });
  }

  function handleAddModel() {
    const raw = newModelInput.trim();
    if (!raw) return;
    const items = raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    setForm((prev) => ({
      ...prev,
      models: Array.from(new Set([...prev.models, ...items])),
    }));
    setNewModelInput("");
  }

  async function handleDelete(providerId: string) {
    try {
      const remaining = await window.forgepilot.removeProvider(providerId);
      onProvidersChange(remaining);
      handleNew();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unable to remove provider.");
    }
  }

  async function handleSave() {
    if (!form.provider) return;
    if (isCustom && !form.baseUrl.trim()) return;

    const parsedModels = form.models.map((m) => m.trim()).filter(Boolean);
    const models = parsedModels.length ? parsedModels : currentDef?.models || [];
    const label = isCustom ? (form.label.trim() || "Custom endpoint") : (currentDef?.label || form.label || "Provider");

    try {
      const saved = await window.forgepilot.saveProvider({
        id: isEditing ? form.id : undefined,
        provider: form.provider,
        label,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl.trim() || undefined,
        models,
      });
      onProvidersChange(saved);
      handleNew();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unable to save provider.");
    }
  }

  async function fetchModels() {
    setFetching(true);
    setFetchNote("");
    setFetchError("");
    try {
      const found = await window.forgepilot.fetchProviderModels(form.baseUrl || "", form.apiKey || "");
      const existing = form.models.map((item) => item.trim()).filter(Boolean);
      const merged = Array.from(new Set([...existing, ...found]));
      setForm((prev) => ({ ...prev, models: merged }));
      setFetchNote(`Fetched ${found.length} model${found.length === 1 ? "" : "s"} from the endpoint.`);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unable to fetch models.");
    } finally {
      setFetching(false);
    }
  }

  return (
    <Modal title="Model providers" subtitle="Connect providers once, then switch between any of their models in each session." onClose={onClose}>
      <div className="provider-layout">
        <div className="provider-list">
          <div className="pane-top" style={{ padding: "0 0 8px 0" }}>
            <span>CONFIGURED PROVIDERS</span>
            <button className="pane-action" onClick={handleNew} title="Add new provider"><Plus size={14} /></button>
          </div>
          {providers.map((provider) => (
            <div className={`provider-card ${form.id === provider.id ? "active" : ""}`} key={provider.id}>
              <div className="provider-card-main" onClick={() => handleEdit(provider)} style={{ cursor: "pointer" }}>
                <span className="provider-logo">{provider.label.slice(0, 1)}</span>
                <div>
                  <strong>{provider.label}</strong>
                  <small>{provider.models.length} models · {provider.apiKey ? "key configured" : "local"}</small>
                </div>
              </div>
              <div className="provider-card-actions">
                <button onClick={(event) => { event.stopPropagation(); handleEdit(provider); }} title="Edit provider settings"><Settings2 size={13} /></button>
                <button className="danger" onClick={(event) => { event.stopPropagation(); setDeleteTarget(provider); }} title="Delete provider"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {!providers.length && (
            <div className="empty-provider">
              <KeyRound size={18} />
              <p>No providers configured.</p>
            </div>
          )}
        </div>
        <div className="provider-form">
          <div className="form-title">
            <span>{isEditing ? `Edit ${form.label || "connection"}` : "Add provider"}</span>
            <small>{isEditing ? "Editing connection" : "LangChain integration"}</small>
          </div>
          <label>
            Provider
            <select value={form.provider || "openai"} onChange={(e) => handleSelectDefinition(e.target.value)}>
              {definitions.map((def) => (
                <option key={def.id} value={def.id}>{def.label}</option>
              ))}
            </select>
          </label>
          {isCustom && (
            <label>
              Display name
              <input value={form.label || ""} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} placeholder="My local server" />
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              value={form.apiKey || ""}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={isCustom ? "Optional — only if your endpoint requires a key" : currentDef?.envKey || "Provider API key"}
            />
          </label>
          <label>
            Base URL <small>{isCustom ? "required" : "optional"}</small>
            <input
              value={form.baseUrl || ""}
              onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder={isCustom ? "http://127.0.0.1:1234/v1" : currentDef?.defaultBaseUrl || "Provider default"}
            />
          </label>
          <label style={{ marginBottom: "4px" }}>
            Models ({form.models.length}) <small>each model listed separately</small>
          </label>
          <div className="model-list-editor">
            {form.models.map((model, idx) => (
              <div className="model-row-item" key={idx}>
                <input
                  value={model}
                  onChange={(e) => updateModel(idx, e.target.value)}
                  placeholder="e.g. gpt-4.1, claude-3-7-sonnet"
                />
                <button
                  type="button"
                  onClick={() => removeModel(idx)}
                  title="Remove model"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            {!form.models.length && (
              <div style={{ color: "#6e7c8e", fontSize: "10.5px", padding: "4px 0" }}>
                No models added yet. Add a model below.
              </div>
            )}
          </div>
          <div className="model-add-bar">
            <input
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddModel();
                }
              }}
              placeholder="Model name (e.g. gpt-5.5-mini)"
            />
            <button
              type="button"
              className="secondary"
              disabled={!newModelInput.trim()}
              onClick={handleAddModel}
            >
              <Plus size={13} /> Add
            </button>
          </div>
          {isCustom && (
            <div className="provider-fetch">
              <button className="secondary" disabled={fetching || !form.baseUrl.trim()} onClick={() => void fetchModels()}>
                {fetching ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Fetch models from endpoint
              </button>
            </div>
          )}
          {fetchNote && <div style={{ margin: "6px 0", color: "var(--green)", fontSize: "11px" }}>{fetchNote}</div>}
          {fetchError && <div style={{ margin: "6px 0", color: "var(--red)", fontSize: "11px" }}>{fetchError}</div>}
          <div className="modal-actions" style={{ marginTop: "16px" }}>
            {isEditing && <button className="secondary" onClick={handleNew}>Cancel edit</button>}
            <button className="primary full" disabled={!form.provider || (isCustom && !form.baseUrl.trim())} onClick={() => void handleSave()}>
              <Check size={14} /> {isEditing ? "Save changes" : "Add provider"}
            </button>
          </div>
        </div>
      </div>
      {deleteTarget && (
        <ConfirmModal
          title={`Delete ${deleteTarget.label}?`}
          message={`Are you sure you want to remove the "${deleteTarget.label}" connection? Any sessions currently using this model will be reset.`}
          confirmLabel="Delete provider"
          danger
          onConfirm={() => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            void handleDelete(id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Modal>
  );
}
function SandboxModal({ config, requireApproval, setRequireApproval, allowNetwork, setAllowNetwork, timeout, setTimeout, enabled, setEnabled, status, onSave, onClose }: { config: SandboxConfig | null; requireApproval: boolean; setRequireApproval: (value: boolean) => void; allowNetwork: boolean; setAllowNetwork: (value: boolean) => void; timeout: string; setTimeout: (value: string) => void; enabled: boolean; setEnabled: (value: boolean) => void; status: SandboxStatus; onSave: () => void; onClose: () => void }) { return <Modal title="Local workspace sandbox" subtitle="Keep the agent on this project with local permissions, approvals and command limits. No Docker or remote sandbox is required." onClose={onClose}><div className="sandbox-status-card"><span className={`sandbox-status-dot ${status.status === "ready" ? "ready" : ""}`} /><div><strong>{status.configured ? `Local permissions · ${status.status}` : "Local sandbox not configured"}</strong><small>{status.sandbox?.path || "Bound to the selected project root."}</small></div></div><label className="toggle-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Enable local workspace sandbox</span></label><label className="toggle-label"><input type="checkbox" checked={requireApproval} onChange={(event) => setRequireApproval(event.target.checked)} /><span>Require approval for sensitive actions</span></label><label className="toggle-label"><input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} /><span>Allow network-dependent package commands</span></label><label>Command timeout in seconds<input type="number" min="10" step="10" value={timeout} onChange={(event) => setTimeout(event.target.value)} /></label><div className="sandbox-warning"><ShieldCheck size={14} /><span>File tools are scoped to the selected project root. Commands are validated argument by argument: shell chaining, substitution and redirection characters are rejected, only approved development tools run, python is limited to pytest, direct node scripts are executed with node's built-in permission model restricted to this folder, and spawned commands receive a minimal environment with no secrets or NODE_OPTIONS. This is a local permission sandbox, not a VM or kernel-level container — package scripts that npm runs on your behalf are not further restricted.</span></div><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={onSave}><Save size={13} /> Save local sandbox</button></div></Modal>; }

type McpFormState = {
  id?: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  enabled: boolean;
};
const EMPTY_MCP_FORM: McpFormState = { name: "", transport: "stdio", command: "", argsText: "", envText: "", url: "", headersText: "", enabled: true };

function parseNamedLines(text: string, separator: string) {
  return Object.fromEntries(text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const index = line.indexOf(separator);
    return index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + separator.length).trim()];
  }));
}
function formatNamedEntries(record: Record<string, string> | undefined, separator: string) {
  return Object.entries(record ?? {}).map(([key, value]) => `${key}${separator}${value}`).join("\n");
}
function buildMcpPayload(form: McpFormState) {
  return {
    id: form.id,
    name: form.name,
    transport: form.transport,
    enabled: form.enabled,
    command: form.transport === "stdio" ? form.command : undefined,
    args: form.transport === "stdio" ? form.argsText.split("\n").map((line) => line.trim()).filter(Boolean) : undefined,
    env: form.transport === "stdio" ? parseNamedLines(form.envText, "=") : undefined,
    url: form.transport !== "stdio" ? form.url : undefined,
    headers: form.transport !== "stdio" ? parseNamedLines(form.headersText, ": ") : undefined,
  };
}
function formFromServer(server: McpServerConfig): McpFormState {
  return {
    id: server.id, name: server.name, transport: server.transport, enabled: server.enabled,
    command: server.command || "",
    argsText: (server.args || []).join("\n"),
    envText: formatNamedEntries(server.env, "="),
    url: server.url || "",
    headersText: formatNamedEntries(server.headers, ": "),
  };
}

function McpModal({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [form, setForm] = useState<McpFormState | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteServer, setDeleteServer] = useState<McpServerConfig | null>(null);

  useEffect(() => { void window.forgepilot.listMcpServers().then(setServers).finally(() => setLoading(false)); }, []);
  function refreshForm(next: McpFormState) { setForm(next); setNote(""); setError(""); setTestResult(null); }
  async function reload() { setServers(await window.forgepilot.listMcpServers()); }
  async function save() {
    if (!form) return;
    setNote(""); setError("");
    try {
      setServers(await window.forgepilot.saveMcpServer(buildMcpPayload(form)));
      setNote("Server saved. New tools are picked up on the next agent run.");
      setForm(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save this MCP server.");
    }
  }
  async function remove(server: McpServerConfig) {
    try {
      setServers(await window.forgepilot.removeMcpServer(server.id));
      if (form?.id === server.id) setForm(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove this server.");
    }
  }
  async function toggleEnabled(server: McpServerConfig) {
    try { setServers(await window.forgepilot.saveMcpServer({ ...server, enabled: !server.enabled })); } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : "Unable to update this server."); }
  }
  async function test() {
    if (!form) return;
    setTesting(true); setTestResult(null); setError("");
    try { setTestResult(await window.forgepilot.testMcpServer(buildMcpPayload(form))); } finally { setTesting(false); }
  }
  const isStdio = form?.transport === "stdio";
  return <Modal title="MCP servers" subtitle="Connect Model Context Protocol servers — local commands or remote HTTP/SSE endpoints — and their tools join every agent run." onClose={onClose}>
    <div className="provider-layout">
      <div className="provider-list">
        {servers.map((server) => <div className="provider-card" key={server.id}>
          <div className="provider-card-main">
            <span className="provider-logo"><Server size={13} /></span>
            <div>
              <strong>{server.name}</strong>
              <small>{server.transport === "stdio" ? server.command : server.url} · {server.enabled ? "enabled" : "disabled"}</small>
            </div>
          </div>
          <div className="provider-card-actions">
            <label className="toggle-label compact" title={server.enabled ? "Disable this server" : "Enable this server"}>
              <input type="checkbox" checked={server.enabled} onChange={() => void toggleEnabled(server)} />
            </label>
            <button onClick={() => refreshForm(formFromServer(server))} title="Edit server"><Settings2 size={13} /></button>
            <button className="danger" onClick={() => setDeleteServer(server)} title="Remove server"><Trash2 size={13} /></button>
          </div>
        </div>)}
        {!servers.length && !loading && <div className="empty-provider"><Server size={18} /><p>No MCP servers configured.</p></div>}
      </div>
      <div className="provider-form">
        <div className="form-title"><span>{form?.id ? "Edit MCP server" : "Add MCP server"}</span><small>langchain-mcp-adapters</small></div>
        {!form && <button className="secondary full" onClick={() => refreshForm(EMPTY_MCP_FORM)}><Plus size={13} /> Add a server</button>}
        {form && <>
          <label>Display name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="filesystem" /></label>
          <label>Transport<select value={form.transport} onChange={(event) => refreshForm({ ...form, transport: event.target.value as McpTransport })}><option value="stdio">stdio — launch a local command</option><option value="http">HTTP — Streamable HTTP endpoint</option><option value="sse">SSE — Server-Sent Events endpoint</option></select></label>
          {isStdio && <>
            <label>Command<input value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder="npx" /></label>
            <label>Arguments <small>one per line</small><textarea value={form.argsText} onChange={(event) => setForm({ ...form, argsText: event.target.value })} rows={3} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\projects"} /></label>
            <label>Environment <small>KEY=VALUE per line</small><textarea value={form.envText} onChange={(event) => setForm({ ...form, envText: event.target.value })} rows={2} placeholder={"API_KEY=abc123"} /></label>
          </>}
          {!isStdio && <>
            <label>URL<input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://mcp.example.com/mcp" /></label>
            <label>Headers <small>Key: Value per line</small><textarea value={form.headersText} onChange={(event) => setForm({ ...form, headersText: event.target.value })} rows={2} placeholder={"Authorization: Bearer abc123"} /></label>
          </>}
          <div className="provider-fetch">
            <button className="secondary" disabled={testing || (isStdio ? !form.command.trim() : !form.url.trim())} onClick={() => void test()}>{testing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Test connection</button>
            {testResult?.ok && <small className="fetch-ok">Connected · {testResult.tools.length} tool{testResult.tools.length === 1 ? "" : "s"}: {testResult.tools.join(", ") || "(none)"}</small>}
            {testResult && !testResult.ok && <small className="fetch-error">{testResult.error}</small>}
          </div>
          <label className="toggle-label"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span>Enabled — include this server in agent runs</span></label>
          <div className="modal-actions">
            <button className="secondary" onClick={() => { setForm(null); setError(""); setNote(""); }}>Cancel</button>
            <button className="primary" disabled={!form.name.trim()} onClick={() => void save()}><Check size={14} /> Save server</button>
          </div>
        </>}
        {note && <small className="fetch-ok">{note}</small>}
        {error && <small className="fetch-error">{error}</small>}
      </div>
    </div>
    {deleteServer && (
      <ConfirmModal
        title={`Remove "${deleteServer.name}"?`}
        message="This will remove the MCP server configuration and disconnect its tools."
        confirmLabel="Remove server"
        danger
        onConfirm={() => {
          const s = deleteServer;
          setDeleteServer(null);
          void remove(s);
        }}
        onCancel={() => setDeleteServer(null)}
      />
    )}
  </Modal>;
}

function SkillsModal({ hasProject, enabled, onToggle, onClose }: { hasProject: boolean; enabled: boolean; onToggle: (enabled: boolean) => Promise<void>; onClose: () => void }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [activeTab, setActiveTab] = useState<"import" | "create" | "preview">("import");
  const [scope, setScope] = useState<"global" | "project">(hasProject ? "project" : "global");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [successNote, setSuccessNote] = useState("");
  const [loadError, setLoadError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SkillInfo | null>(null);
  const [previewSkill, setPreviewSkill] = useState<SkillInfo | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");

  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDesc, setNewSkillDesc] = useState("");
  const [newSkillContent, setNewSkillContent] = useState("");

  useEffect(() => {
    void reload();
  }, [hasProject]);

  async function reload() {
    setLoadError("");
    try {
      const list = await window.forgepilot.listSkills();
      setSkills(list);
    } catch (loadFail) {
      setLoadError(loadFail instanceof Error ? loadFail.message : "Unable to list skills.");
    }
  }

  async function openFolder(target: "global" | "project") {
    try {
      await window.forgepilot.openSkillsFolder(target);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open the folder.");
    }
  }

  async function chooseFile() {
    setError("");
    setSuccessNote("");
    const paths = await window.forgepilot.pickSkillFile();
    if (paths.length) {
      setSelectedSources((current) => Array.from(new Set([...current, ...paths])));
    }
  }

  async function chooseFolder() {
    setError("");
    setSuccessNote("");
    const paths = await window.forgepilot.pickSkillFolder();
    if (paths.length) {
      setSelectedSources((current) => Array.from(new Set([...current, ...paths])));
    }
  }

  async function importSelected() {
    if (!selectedSources.length) return;
    setError("");
    setSuccessNote("");
    setImporting(true);
    try {
      for (const sourcePath of selectedSources) {
        await window.forgepilot.importSkill(sourcePath, scope);
      }
      const count = selectedSources.length;
      setSelectedSources([]);
      setSuccessNote(`Successfully added ${count} skill${count === 1 ? "" : "s"} to the ${scope} library.`);
      await reload();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Unable to import one or more Skills.");
    } finally {
      setImporting(false);
    }
  }

  async function handleCreateSkill() {
    if (!newSkillName.trim()) {
      setError("Please provide a skill name.");
      return;
    }
    setError("");
    setSuccessNote("");
    setImporting(true);
    try {
      await window.forgepilot.createSkill({
        name: newSkillName.trim(),
        description: newSkillDesc.trim(),
        scope,
        content: newSkillContent.trim() || undefined,
      });
      setSuccessNote(`Created skill "${newSkillName}" in ${scope} library.`);
      setNewSkillName("");
      setNewSkillDesc("");
      setNewSkillContent("");
      await reload();
      setActiveTab("import");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create skill.");
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteSkill(skill: SkillInfo) {
    setError("");
    try {
      await window.forgepilot.deleteSkill(skill.path);
      if (previewSkill?.path === skill.path) {
        setPreviewSkill(null);
        setPreviewContent("");
        if (activeTab === "preview") setActiveTab("import");
      }
      await reload();
    } catch (delError) {
      setError(delError instanceof Error ? delError.message : "Unable to delete skill.");
    }
  }

  async function handleSelectPreview(skill: SkillInfo) {
    setPreviewSkill(skill);
    setActiveTab("preview");
    try {
      const content = await window.forgepilot.readSkillContent(skill.path);
      setPreviewContent(content);
    } catch {
      setPreviewContent("// Unable to read SKILL.md content");
    }
  }

  const globalSkills = skills.filter((skill) => skill.source === "global");
  const projectSkills = skills.filter((skill) => skill.source === "project");

  return (
    <Modal title="Skills" subtitle="Manage step-by-step instructions and guidelines for your coding agent." onClose={onClose}>
      <label className="toggle-row">
        <span>
          <strong>Enable skills middleware</strong>
          <small>Allow the agent to load global and project SKILL.md files.</small>
        </span>
        <input type="checkbox" checked={enabled} onChange={(event) => void onToggle(event.target.checked)} />
      </label>

      <div className="provider-layout">
        <div className="provider-list">
          <div className="pane-top" style={{ padding: "0 0 8px 0" }}>
            <span>GLOBAL SKILLS ({globalSkills.length})</span>
            <div style={{ display: "flex", gap: "4px" }}>
              <button className="pane-action" title="Open global skills folder" onClick={() => void openFolder("global")}><FolderOpen size={13} /></button>
            </div>
          </div>
          {globalSkills.map((skill) => (
            <div className={`provider-card ${previewSkill?.path === skill.path ? "active" : ""}`} key={skill.path}>
              <div className="provider-card-main" onClick={() => void handleSelectPreview(skill)} style={{ cursor: "pointer" }}>
                <span className="provider-logo"><Puzzle size={13} /></span>
                <div>
                  <strong>{skill.name}</strong>
                  <small>{skill.description || "No description"}</small>
                </div>
              </div>
              <div className="provider-card-actions">
                <button className="danger" onClick={(e) => { e.stopPropagation(); setDeleteTarget(skill); }} title="Delete skill"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {!globalSkills.length && <div className="empty-provider"><Puzzle size={16} /><p>No global skills yet.</p></div>}

          {hasProject && (
            <>
              <div className="pane-top" style={{ padding: "12px 0 8px 0" }}>
                <span>PROJECT SKILLS ({projectSkills.length})</span>
                <button className="pane-action" title="Open project skills folder" onClick={() => void openFolder("project")}><FolderOpen size={13} /></button>
              </div>
              {projectSkills.map((skill) => (
                <div className={`provider-card ${previewSkill?.path === skill.path ? "active" : ""}`} key={skill.path}>
                  <div className="provider-card-main" onClick={() => void handleSelectPreview(skill)} style={{ cursor: "pointer" }}>
                    <span className="provider-logo"><Puzzle size={13} /></span>
                    <div>
                      <strong>{skill.name}</strong>
                      <small>{skill.description || "No description"}</small>
                    </div>
                  </div>
                  <div className="provider-card-actions">
                    <button className="danger" onClick={(e) => { e.stopPropagation(); setDeleteTarget(skill); }} title="Delete skill"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
              {!projectSkills.length && <div className="empty-provider"><Puzzle size={16} /><p>No project skills yet.</p></div>}
            </>
          )}
          {loadError && <small className="fetch-error">{loadError}</small>}
        </div>

        <div className="provider-form">
          <div className="skills-tab-bar">
            <button className={`skills-tab-btn ${activeTab === "import" ? "active" : ""}`} onClick={() => setActiveTab("import")}>
              <Upload size={12} /> Import files
            </button>
            <button className={`skills-tab-btn ${activeTab === "create" ? "active" : ""}`} onClick={() => setActiveTab("create")}>
              <Plus size={12} /> Create skill
            </button>
            {previewSkill && (
              <button className={`skills-tab-btn ${activeTab === "preview" ? "active" : ""}`} onClick={() => setActiveTab("preview")}>
                <FileCode2 size={12} /> Inspect: {previewSkill.name}
              </button>
            )}
          </div>

          {activeTab === "import" && (
            <>
              <div className="form-title">
                <span>Import Skill Files</span>
                <small>Select SKILL.md or folder</small>
              </div>
              <label>
                Destination Library
                <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">Global (available to all projects)</option>
                  <option value="project" disabled={!hasProject}>Current project {hasProject ? "" : "(open a project first)"}</option>
                </select>
              </label>

              <label>Choose Skill Source Files</label>
              <div className="modal-actions" style={{ marginTop: "4px", marginBottom: "10px", justifyContent: "flex-start", gap: "8px" }}>
                <button className="secondary" disabled={scope === "project" && !hasProject} onClick={() => void chooseFile()}>
                  <FileCode2 size={13} /> Select SKILL.md file(s)
                </button>
                <button className="secondary" disabled={scope === "project" && !hasProject} onClick={() => void chooseFolder()}>
                  <FolderOpen size={13} /> Select Skill folder
                </button>
              </div>

              {selectedSources.length > 0 ? (
                <>
                  <label>Staged Skill Files ({selectedSources.length})</label>
                  <div className="selected-file-list">
                    {selectedSources.map((sourcePath) => (
                      <div className="selected-file" key={sourcePath}>
                        <File size={13} />
                        <span title={sourcePath}>{sourcePath.split(/[\\/]/).pop()}</span>
                        <button className="pane-action" onClick={() => setSelectedSources((current) => current.filter((item) => item !== sourcePath))}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="primary full"
                    disabled={!selectedSources.length || (scope === "project" && !hasProject) || importing}
                    onClick={() => void importSelected()}
                    style={{ marginTop: "8px" }}
                  >
                    <Upload size={13} /> {importing ? "Adding to library…" : `Add ${selectedSources.length} Skill${selectedSources.length === 1 ? "" : "s"} to ${scope === "global" ? "Global" : "Project"} Library`}
                  </button>
                </>
              ) : (
                <div style={{ padding: "14px", border: "1px dashed #283648", borderRadius: "6px", textAlign: "center", color: "#748296", fontSize: "11px", margin: "8px 0 14px" }}>
                  <Upload size={18} style={{ margin: "0 auto 6px", display: "block", color: "#54657c" }} />
                  Click <strong>Select SKILL.md file(s)</strong> or <strong>Select Skill folder</strong> above to stage skills for addition.
                </div>
              )}

              {successNote && <div style={{ color: "var(--green)", fontSize: "11px", marginTop: "10px" }}>✓ {successNote}</div>}
              {error && <div style={{ color: "var(--red)", fontSize: "11px", marginTop: "10px" }}>{error}</div>}
              {!hasProject && scope === "project" && <div style={{ color: "#e3a85b", fontSize: "11px", marginTop: "8px" }}>Open a project workspace to import project-scoped skills.</div>}
            </>
          )}

          {activeTab === "create" && (
            <>
              <div className="form-title">
                <span>Create New Skill</span>
                <small>Write instructions for agent</small>
              </div>
              <label>
                Skill Identifier
                <input value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder="e.g. react-best-practices" />
              </label>
              <label>
                Destination Library
                <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">Global (available to all projects)</option>
                  <option value="project" disabled={!hasProject}>Current project</option>
                </select>
              </label>
              <label>
                Description (when should agent activate this skill?)
                <input value={newSkillDesc} onChange={(e) => setNewSkillDesc(e.target.value)} placeholder="e.g. Use when writing, reviewing or refactoring React components" />
              </label>
              <label>
                SKILL.md Instructions (Markdown)
                <textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  rows={6}
                  placeholder={`# Skill Instructions\n\n1. Inspect the relevant components.\n2. Follow patterns specified here.\n3. Validate with tests.`}
                />
              </label>
              <button
                className="primary full"
                disabled={!newSkillName.trim() || (scope === "project" && !hasProject) || importing}
                onClick={() => void handleCreateSkill()}
                style={{ marginTop: "10px" }}
              >
                <Plus size={13} /> {importing ? "Creating skill…" : "Create Skill"}
              </button>

              {successNote && <div style={{ color: "var(--green)", fontSize: "11px", marginTop: "10px" }}>✓ {successNote}</div>}
              {error && <div style={{ color: "var(--red)", fontSize: "11px", marginTop: "10px" }}>{error}</div>}
            </>
          )}

          {activeTab === "preview" && previewSkill && (
            <>
              <div className="form-title">
                <span>{previewSkill.name}</span>
                <span className={`skill-scope-tag ${previewSkill.source}`}>{previewSkill.source}</span>
              </div>
              <small style={{ color: "#7f8d9f", fontSize: "10px", wordBreak: "break-all" }}>{previewSkill.path}</small>
              <pre className="skill-preview-box">{previewContent}</pre>
              <div className="modal-actions" style={{ justifyContent: "space-between", marginTop: "10px" }}>
                <button className="secondary danger-btn" onClick={() => setDeleteTarget(previewSkill)}>
                  <Trash2 size={13} /> Delete this skill
                </button>
                <button className="secondary" onClick={() => setActiveTab("import")}>
                  Back to import
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmModal
          title={`Delete skill "${deleteTarget.name}"?`}
          message={`Are you sure you want to delete this skill from the ${deleteTarget.source} library?`}
          confirmLabel="Delete skill"
          danger
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void handleDeleteSkill(target);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Modal>
  );
}

export default App;

