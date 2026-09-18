import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft, ArrowUp, BookOpen, Check, ChevronRight, Clapperboard, Download, FileText, Globe, HelpCircle,
  Layers, Loader2, Network, PanelLeft, PanelRight, Pencil, Plus, Presentation, RefreshCw, Sparkles, Square, Trash2, Upload, X,
} from "lucide-react";
import { ModelSelect } from "./AgentView.js";
import { ActivityGroupView, CopyTextButton } from "../components/chat/ChatMessageItem.js";
import { renderMarkdown } from "../markdown.js";
import { timeLabel } from "../utils/format.js";
import { SourcePassageModal, type PassageAction } from "../components/notebook/SourcePassageModal.js";
import { DocumentViewerModal } from "../components/notebook/DocumentViewerModal.js";
import { QuizPlayerModal } from "../components/notebook/QuizPlayerModal.js";
import { FlashcardPlayerModal } from "../components/notebook/FlashcardPlayerModal.js";
import { MindmapViewerModal } from "../components/notebook/MindmapViewerModal.js";
import { FilePreviewModal } from "../components/home/FilePreviewModal.js";
import type { ChatItem, NotebookChat, NotebookDocument, NotebookFlashcardSet, NotebookMeta, NotebookMindmap, NotebookNote, NotebookPassage, NotebookQuiz, NotebookQuizType, NotebookSettings, NotebookSource, NotebookStats, NotebookSummary, NotebookSummaryLength, ProviderConfig, ProviderDefinition } from "../types.js";

function verdictColor(verdict?: string) {
  if (verdict === "grounded") return "#3fb950";
  if (verdict === "partial") return "#d29922";
  if (verdict === "ungrounded") return "#f85149";
  return "#8b949e";
}

function ingestionBadge(status: NotebookSource["status"]) {
  if (status === "ready") return <span className="ingestion-badge ready">ready</span>;
  if (status === "failed") return <span className="ingestion-badge error">failed</span>;
  const label = status === "uploaded" ? "queued" : status === "parsing" ? "parsing…" : status === "chunking" ? "chunking…" : "indexing…";
  return <span className="ingestion-badge indexing"><Loader2 size={11} className="spin" /> {label}</span>;
}

type StudioKind = NotebookDocument["kind"] | "quiz" | "fiches" | "mindmap" | "summary";

/** Builds the rich markdown preview for a saved summary. */
function summaryToMarkdown(summary: NotebookSummary): string {
  const lines = [`# ${summary.title}`, "", "## Overview", "", summary.overview, ""];
  for (const section of summary.sections) {
    lines.push(`## ${section.heading}`, "", section.body, "");
    if (section.keyPoints.length) {
      lines.push("**Key points:**", "");
      for (const point of section.keyPoints) lines.push(`- ${point}`);
      lines.push("");
    }
  }
  lines.push("## Key takeaways", "");
  for (const takeaway of summary.takeaways) lines.push(`- ${takeaway}`);
  return lines.join("\n");
}

/** Right-panel Studio: output-type tiles on top, generation composer, outputs below. */
function StudioPanel({ generating, generatingQuiz, generatingFlashcards, generatingMindmap, generatingSummary, hasSources, docSteps, quizSteps, fichesSteps, mapSteps, summarySteps, onGenerate, onGenerateQuiz, onGenerateFlashcards, onGenerateMindmap, onGenerateSummary }: {
  generating: boolean;
  generatingQuiz: boolean;
  generatingFlashcards: boolean;
  generatingMindmap: boolean;
  generatingSummary: boolean;
  hasSources: boolean;
  docSteps: string[];
  quizSteps: string[];
  fichesSteps: string[];
  mapSteps: string[];
  summarySteps: string[];
  onGenerate: (kind: NotebookDocument["kind"], format: NotebookDocument["format"], prompt: string) => void;
  onGenerateQuiz: (topic: string, count: number, quizType: NotebookQuizType) => void;
  onGenerateFlashcards: (topic: string, count: number) => void;
  onGenerateMindmap: (topic: string) => void;
  onGenerateSummary: (topic: string, length: NotebookSummaryLength) => void;
}) {
  const [kind, setKind] = useState<StudioKind>("report");
  const [format, setFormat] = useState<NotebookDocument["format"]>("docx");
  const [prompt, setPrompt] = useState("");
  const [quizCount, setQuizCount] = useState(5);
  const [quizType, setQuizType] = useState<NotebookQuizType>("mixed");
  const [fichesCount, setFichesCount] = useState(10);
  const [summaryLength, setSummaryLength] = useState<NotebookSummaryLength>("standard");

  useEffect(() => {
    setFormat(kind === "slides" ? "pptx" : "docx");
  }, [kind]);

  const tiles = [
    { key: "report", icon: <FileText size={15} />, label: "Reports", tone: "green" },
    { key: "slides", icon: <Presentation size={15} />, label: "Presentation", tone: "yellow" },
    { key: "quiz", icon: <HelpCircle size={15} />, label: "Quiz", tone: "blue" },
    { key: "fiches", icon: <Layers size={15} />, label: "Flashcards", tone: "purple" },
    { key: "mindmap", icon: <Network size={15} />, label: "Mind map", tone: "pink" },
    { key: "summary", icon: <Sparkles size={15} />, label: "Summary", tone: "gray" },
  ] as const;

  const busy = kind === "quiz" ? generatingQuiz : kind === "fiches" ? generatingFlashcards : kind === "mindmap" ? generatingMindmap : kind === "summary" ? generatingSummary : generating;
  const steps = kind === "quiz" ? quizSteps : kind === "fiches" ? fichesSteps : kind === "mindmap" ? mapSteps : kind === "summary" ? summarySteps : docSteps;

  return (
    <div>
      <div className="studio-grid">
        {tiles.map((tile) => {
          const active = kind === tile.key;
          return (
            <button
              key={tile.key}
              className={`studio-card tone-${tile.tone}${active ? " active" : ""}`}
              onClick={() => setKind(tile.key)}
              title={tile.key === "report" ? "Generate a grounded report (DOCX/PDF)" : tile.key === "slides" ? "Generate grounded slides (PPTX)" : tile.key === "quiz" ? "Generate an interactive grounded quiz" : tile.key === "fiches" ? "Generate interactive grounded flashcards" : tile.key === "mindmap" ? "Generate an interactive grounded mind map" : "Generate a rich grounded summary"}
            >
              <span className="studio-card-icon">{tile.icon}</span>
              <span className="studio-card-label">{tile.label}</span>
              <ChevronRight size={13} className="studio-card-chevron" />
            </button>
          );
        })}
      </div>
      <div className="studio-composer">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={kind === "slides" ? "Slide deck topic… (empty = full overview)" : kind === "quiz" ? "Quiz topic… (empty = full overview)" : kind === "fiches" ? "Flashcard topic… (empty = full overview)" : kind === "mindmap" ? "Mind-map topic… (empty = full overview)" : kind === "summary" ? "Summary topic… (empty = full overview)" : "Report topic… (empty = full overview)"}
          spellCheck={false}
          className="text-field"
        />
        {kind === "report" && (
          <div className="doc-toggle-group studio-format" role="group" aria-label="Report format">
            <button className={`doc-toggle${format === "docx" ? " active" : ""}`} onClick={() => setFormat("docx")} title="Word document">DOCX</button>
            <button className={`doc-toggle${format === "pdf" ? " active" : ""}`} onClick={() => setFormat("pdf")} title="PDF document">PDF</button>
          </div>
        )}
        {kind === "quiz" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
              Questions
              <input
                type="number"
                min={3}
                max={20}
                value={quizCount}
                onChange={(e) => setQuizCount(Math.min(20, Math.max(3, Number(e.target.value) || 5)))}
                className="text-field"
                style={{ width: 60 }}
              />
            </label>
            <div className="doc-toggle-group studio-format" role="group" aria-label="Question type">
              <button className={`doc-toggle${quizType === "mcq" ? " active" : ""}`} onClick={() => setQuizType("mcq")} title="Multiple choice, 4 options">MCQ</button>
              <button className={`doc-toggle${quizType === "truefalse" ? " active" : ""}`} onClick={() => setQuizType("truefalse")} title="True / False">T/F</button>
              <button className={`doc-toggle${quizType === "mixed" ? " active" : ""}`} onClick={() => setQuizType("mixed")} title="Blend of MCQ and True/False">Mixed</button>
            </div>
          </div>
        )}
        {kind === "fiches" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
              Cards
              <input
                type="number"
                min={3}
                max={30}
                value={fichesCount}
                onChange={(e) => setFichesCount(Math.min(30, Math.max(3, Number(e.target.value) || 10)))}
                className="text-field"
                style={{ width: 60 }}
              />
            </label>
          </div>
        )}
        {kind === "summary" && (
          <div className="doc-toggle-group studio-format" role="group" aria-label="Summary length">
            <button className={`doc-toggle${summaryLength === "brief" ? " active" : ""}`} onClick={() => setSummaryLength("brief")} title="Short overview with 3 sections">Brief</button>
            <button className={`doc-toggle${summaryLength === "standard" ? " active" : ""}`} onClick={() => setSummaryLength("standard")} title="Full synthesis with 5 sections">Standard</button>
            <button className={`doc-toggle${summaryLength === "detailed" ? " active" : ""}`} onClick={() => setSummaryLength("detailed")} title="Deep dive with 7 sections">Detailed</button>
          </div>
        )}
        {kind === "quiz" ? (
          <button
            className="studio-generate"
            disabled={busy || !hasSources}
            onClick={() => onGenerateQuiz(prompt.trim(), quizCount, quizType)}
            title={hasSources ? "Generate an interactive quiz with citations" : "Upload sources first"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
            {busy ? " Generating…" : " Generate Quiz"}
          </button>
        ) : kind === "fiches" ? (
          <button
            className="studio-generate"
            disabled={busy || !hasSources}
            onClick={() => onGenerateFlashcards(prompt.trim(), fichesCount)}
            title={hasSources ? "Generate interactive flashcards with citations" : "Upload sources first"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
            {busy ? " Generating…" : " Generate Flashcards"}
          </button>
        ) : kind === "mindmap" ? (
          <button
            className="studio-generate"
            disabled={busy || !hasSources}
            onClick={() => onGenerateMindmap(prompt.trim())}
            title={hasSources ? "Generate an interactive mind map with citations" : "Upload sources first"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
            {busy ? " Generating…" : " Generate Mind Map"}
          </button>
        ) : kind === "summary" ? (
          <button
            className="studio-generate"
            disabled={busy || !hasSources}
            onClick={() => onGenerateSummary(prompt.trim(), summaryLength)}
            title={hasSources ? "Generate a rich grounded summary with citations" : "Upload sources first"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
            {busy ? " Generating…" : " Generate Summary"}
          </button>
        ) : (
          <button
            className="studio-generate"
            disabled={busy || !hasSources}
            onClick={() => onGenerate(kind as NotebookDocument["kind"], kind === "slides" ? "pptx" : format, prompt.trim())}
            title={hasSources ? "Generate from in-scope sources with citations" : "Upload sources first"}
          >
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
            {busy ? " Generating…" : kind === "slides" ? " Generate PPTX" : ` Generate ${format.toUpperCase()}`}
          </button>
        )}
      </div>
      {(busy || steps.length > 0) && (
        <div style={{ marginTop: 8 }}>
          <ActivityGroupView
            events={(steps.length ? steps : ["Starting the agent…"]).map((step, index) => ({
              role: "event",
              text: step,
              kind: step.startsWith("Working:") || step.includes("·") ? "tool" : "status",
              createdAt: new Date(Date.now() - (steps.length - index) * 1000).toISOString(),
            }))}
            running={busy}
            currentText={
              busy
                ? steps[steps.length - 1] || "Starting the agent…"
                : `${steps.length || 1} step${steps.length === 1 ? "" : "s"} completed`
            }
          />
        </div>
      )}
    </div>
  );
}

export function NotebookView({
  notebooks,
  activeNotebook,
  setActiveNotebook,
  sources,
  activeChat,
  stats,
  draft,
  setDraft,
  asking,
  notice,
  excludedIds,
  scopedIds,
  streaming,
  workingSteps,
  passage,
  settings,
  notes,
  documents,
  quizzes,
  flashcards,
  mindmaps,
  summaries,
  generatingDoc,
  generatingQuiz,
  generatingFlashcards,
  generatingMindmap,
  generatingSummary,
  docSteps,
  quizSteps,
  fichesSteps,
  mapSteps,
  summarySteps,
  onGenerateDocument,
  onGenerateQuiz,
  onDeleteQuiz,
  onGenerateFlashcards,
  onDeleteFlashcards,
  onGenerateMindmap,
  onDeleteMindmap,
  onGenerateSummary,
  onDeleteSummary,
  onDownloadDocument,
  onDeleteDocument,
  onCreateNotebook,
  onDeleteNotebook,
  onPickFiles,
  onImportYouTube,
  onImportWebsite,
  onBrowserFiles,
  onRefresh,
  onDeleteSource,
  onReindexSource,
  onReindexAll,
  onToggleScope,
  onResetScope,
  onOpenPassage,
  onClosePassage,
  onPassageAction,
  onSaveInstructions,
  onSaveNote,
  onDeleteNote,
  onRename,
  onAsk,
  onStop,
  onExitToSessions,
  selectedProviderId,
  selectedModel,
  providers,
  definitions,
  switchModel,
  onOpenProviders,
  hasProvider,
}: {
  notebooks: NotebookMeta[];
  activeNotebook: NotebookMeta | null;
  setActiveNotebook: (nb: NotebookMeta) => void;
  sources: NotebookSource[];
  activeChat: NotebookChat | null;
  stats: NotebookStats | null;
  draft: string;
  setDraft: (value: string) => void;
  asking: boolean;
  notice: string;
  excludedIds: string[];
  scopedIds: string[];
  streaming: string;
  workingSteps: string[];
  passage: NotebookPassage | null;
  settings: NotebookSettings;
  notes: NotebookNote[];
  documents: NotebookDocument[];
  quizzes: NotebookQuiz[];
  flashcards: NotebookFlashcardSet[];
  mindmaps: NotebookMindmap[];
  summaries: NotebookSummary[];
  generatingDoc: boolean;
  generatingQuiz: boolean;
  generatingFlashcards: boolean;
  generatingMindmap: boolean;
  generatingSummary: boolean;
  docSteps: string[];
  quizSteps: string[];
  fichesSteps: string[];
  mapSteps: string[];
  summarySteps: string[];
  onGenerateDocument: (kind: NotebookDocument["kind"], format: NotebookDocument["format"], prompt: string) => void;
  onGenerateQuiz: (topic: string, count: number, quizType: NotebookQuizType) => void;
  onDeleteQuiz: (quizId: string) => void;
  onGenerateFlashcards: (topic: string, count: number) => void;
  onDeleteFlashcards: (setId: string) => void;
  onGenerateMindmap: (topic: string) => void;
  onDeleteMindmap: (mapId: string) => void;
  onGenerateSummary: (topic: string, length: NotebookSummaryLength) => void;
  onDeleteSummary: (summaryId: string) => void;
  onDownloadDocument: (docId: string) => void;
  onDeleteDocument: (docId: string) => void;
  onCreateNotebook: (name: string) => void;
  onDeleteNotebook: (id: string) => void;
  onPickFiles: () => void;
  onImportYouTube: (url: string) => void;
  onImportWebsite: (url: string) => void;
  onBrowserFiles: (files: FileList | File[]) => void;
  onRefresh: () => void;
  onDeleteSource: (sourceId: string) => void;
  onReindexSource: (sourceId: string) => void;
  onReindexAll: () => void;
  onToggleScope: (sourceId: string) => void;
  onResetScope: () => void;
  onOpenPassage: (chunkId: string) => void;
  onClosePassage: () => void;
  onPassageAction: (action: PassageAction, passage: NotebookPassage) => void;
  onSaveInstructions: (instructions: string) => void;
  onSaveNote: (note: { title: string; content: string; citations: NotebookNote["citations"] }) => void;
  onDeleteNote: (noteId: string) => void;
  onRename: (name: string) => void;
  onAsk: () => void;
  onStop: () => void;
  onExitToSessions: () => void;
  selectedProviderId: string;
  selectedModel: string;
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  switchModel: (providerId: string, model: string) => void;
  onOpenProviders: () => void;
  hasProvider: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onAsk();
    }
  }

  const [editingName, setEditingName] = useState<string | null>(null);
  const [instructionDraft, setInstructionDraft] = useState(settings.instructions);

  const [showSources, setShowSources] = useState(() => {
    try {
      const saved = localStorage.getItem("nexus-notebook-show-sources");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });

  const [showStudio, setShowStudio] = useState(() => {
    try {
      const saved = localStorage.getItem("nexus-notebook-show-studio");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });

  const [sourcesWidth, setSourcesWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("nexus-notebook-sources-width"));
      return saved >= 180 && saved <= 500 ? saved : 250;
    } catch {
      return 250;
    }
  });

  const [studioWidth, setStudioWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("nexus-notebook-studio-width"));
      return saved >= 220 && saved <= 600 ? saved : 280;
    } catch {
      return 280;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("nexus-notebook-show-sources", String(showSources));
    } catch { /* ignore */ }
  }, [showSources]);

  useEffect(() => {
    try {
      localStorage.setItem("nexus-notebook-show-studio", String(showStudio));
    } catch { /* ignore */ }
  }, [showStudio]);

  function startSourcesResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = sourcesWidth;
    let latest = startW;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    const move = (ev: PointerEvent) => {
      latest = Math.min(500, Math.max(180, startW + (ev.clientX - startX)));
      setSourcesWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem("nexus-notebook-sources-width", String(Math.round(latest)));
      } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startStudioResize(event: React.PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = studioWidth;
    let latest = startW;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    const move = (ev: PointerEvent) => {
      latest = Math.min(600, Math.max(220, startW + (startX - ev.clientX)));
      setStudioWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        localStorage.setItem("nexus-notebook-studio-width", String(Math.round(latest)));
      } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const [viewNoteId, setViewNoteId] = useState<string | null>(null);
  const [viewQuizId, setViewQuizId] = useState<string | null>(null);
  const [viewFichesId, setViewFichesId] = useState<string | null>(null);
  const [viewMapId, setViewMapId] = useState<string | null>(null);
  const [viewSummaryId, setViewSummaryId] = useState<string | null>(null);
  const viewDoc = viewDocId ? documents.find((d) => d.id === viewDocId) || null : null;
  const viewNote = viewNoteId ? notes.find((n) => n.id === viewNoteId) || null : null;
  const viewQuiz = viewQuizId ? quizzes.find((q) => q.id === viewQuizId) || null : null;
  const viewFiches = viewFichesId ? flashcards.find((s) => s.id === viewFichesId) || null : null;
  const viewMap = viewMapId ? mindmaps.find((m) => m.id === viewMapId) || null : null;
  const viewSummary = viewSummaryId ? summaries.find((s) => s.id === viewSummaryId) || null : null;
  // Link import form, shared by YouTube transcripts and website crawls.
  const [linkKind, setLinkKind] = useState<"youtube" | "website" | null>(null);
  const [linkUrl, setLinkUrl] = useState("");

  function submitLink() {
    const link = linkUrl.trim();
    if (!link || !linkKind) return;
    if (linkKind === "youtube") onImportYouTube(link);
    else onImportWebsite(link);
    setLinkUrl("");
    setLinkKind(null);
  }

  function toggleLinkForm(kind: "youtube" | "website") {
    setLinkKind((prev) => (prev === kind ? null : kind));
    setLinkUrl("");
  }

  useEffect(() => setInstructionDraft(settings.instructions), [settings.instructions]);

  function submitRename() {
    if (editingName !== null && editingName.trim()) onRename(editingName);
    setEditingName(null);
  }

  // Keep the chat pinned to the latest message / streamed token.
  const messageCount = activeChat?.messages.length || 0;
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, asking, streaming]);

  const latestAnswer = [...(activeChat?.messages || [])].reverse().find((message) => message.role === "assistant" && message.text.trim());

  const evalSummary = useMemo(() => {
    const evals = (activeChat?.messages || []).filter((m) => m.role === "assistant" && m.evaluation);
    if (!evals.length) return null;
    const avg = evals.reduce((sum, m) => sum + (m.evaluation?.groundedness || 0), 0) / evals.length;
    return { count: evals.length, avg: Math.round(avg * 10) / 10 };
  }, [activeChat]);

  function exportTranscript() {
    if (!activeChat || !activeNotebook) return;
    const lines = [`# ${activeNotebook.name} — ${activeChat.title}`, ""];
    for (const message of activeChat.messages) {
      lines.push(message.role === "user" ? "## You" : "## Notebook");
      lines.push("", message.text, "");
      if (message.role === "assistant" && message.citations?.length) {
        lines.push("**Sources:** " + message.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; "), "");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeNotebook.name.replace(/[^\w\-]+/g, "_")}-${activeChat.title.replace(/[^\w\-]+/g, "_")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // ---- Sessions overview: pick a session to enter ----
  if (!activeNotebook) {
    return (
      <div className="agent-view notebook-view">
        <div className="agent-view-head">
          <div>
            <span className="view-kicker">NOTEBOOK · SESSIONS</span>
            <h1>Notebook sessions</h1>
            <p>Each session is isolated — its own sources, index, and chat. Click one to enter it.</p>
          </div>
          <div className="agent-view-meta">
            <button className="top-link" onClick={() => onCreateNotebook("")} title="Create a new notebook session">
              <Plus size={12} /> New session
            </button>
          </div>
        </div>
        {!!notice && <div className="input-note" style={{ margin: "0 0 8px", padding: "0 30px" }}>{notice}</div>}
        <div className="notebook-sessions-grid">
          {notebooks.map((nb) => (
            <div key={nb.id} className="notebook-card" onClick={() => setActiveNotebook(nb)} title={`Enter ${nb.name}`}>
              <div className="notebook-card-icon"><BookOpen size={18} /></div>
              <div className="notebook-card-name">{nb.name}</div>
              {!!nb.description && <div className="notebook-card-desc">{nb.description}</div>}
              <div className="notebook-card-meta">Updated {new Date(nb.updatedAt).toLocaleDateString()}</div>
              <button
                className="pane-action notebook-card-delete"
                title="Delete session"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteNotebook(nb.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="notebook-card notebook-card-new" onClick={() => onCreateNotebook("")} title="Create a new notebook session">
            <Plus size={18} />
            <span>New session</span>
          </div>
          {!notebooks.length && (
            <div className="empty-pane">No sessions yet — create one to start uploading documents.</div>
          )}
        </div>
      </div>
    );
  }

  // ---- Entered session: sources left, chat middle, cited sources right ----
  const pendingCount = sources.filter((s) => s.status !== "ready" && s.status !== "failed").length;
  const scopedCount = scopedIds.length;

  return (
    <div className="agent-view notebook-view">
      <div className="agent-view-head">
        <div className="notebook-enter-head">
          <button className="top-link" onClick={onExitToSessions} title="Back to all sessions">
            <ArrowLeft size={12} /> Sessions
          </button>
          <div>
            <span className="view-kicker">NOTEBOOK · DISCUSSION</span>
            {editingName !== null ? (
              <input
                autoFocus
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitRename();
                  } else if (e.key === "Escape") {
                    setEditingName(null);
                  }
                }}
                onBlur={submitRename}
                className="text-field notebook-rename-field"
              />
            ) : (
              <h1>
                {activeNotebook.name}
                <button className="pane-action" onClick={() => setEditingName(activeNotebook.name)} title="Rename session" style={{ display: "inline-grid", marginLeft: 6, verticalAlign: "middle" }}>
                  <Pencil size={12} />
                </button>
              </h1>
            )}
            <p>
              {stats
                ? `${stats.readySources}/${stats.sources} sources ready · ${stats.chunks} chunks · ${stats.sections} sections · ${stats.embeddingModel || "no index yet"}`
                : "Upload documents on the left, then ask in the middle."}
            </p>
          </div>
        </div>
        <div className="agent-view-meta">
          <button className="top-link" onClick={onRefresh} title="Refresh sources and stats">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      <div className="notebook-layout">
        {/* Left sidebar: upload + ingestion pipeline + file scope */}
        {showSources ? (
          <aside className="notebook-side notebook-side-sources" style={{ width: sourcesWidth }}>
            <div className="context-head notebook-side-head">
              <div>
                <span className="context-kicker">SOURCES</span>
                <strong className="notebook-side-title">Session Sources</strong>
                <small>{scopedCount} of {sources.length} in scope</small>
              </div>
              <div className="notebook-side-head-actions">
                {excludedIds.length > 0 && (
                  <button className="pane-action" onClick={onResetScope} title="Ask all files again">
                    <RefreshCw size={11} />
                  </button>
                )}
                <button className="context-panel-icon" onClick={() => setShowSources(false)} title="Collapse sources sidebar">
                  <PanelLeft size={15} />
                </button>
              </div>
            </div>
            <div className="notebook-side-body">
              <div className="notebook-upload-row">
                <button className="new-session-btn" onClick={onPickFiles}><FileText size={13} /> Add files</button>
                <button className="pane-action" onClick={() => fileInputRef.current?.click()} title="Upload from this window"><Upload size={13} /></button>
                <button
                  className={`pane-action${linkKind === "youtube" ? " active" : ""}`}
                  onClick={() => toggleLinkForm("youtube")}
                  title="Add a YouTube video — its transcript becomes a source"
                >
                  <Clapperboard size={13} />
                </button>
                <button
                  className={`pane-action${linkKind === "website" ? " active" : ""}`}
                  onClick={() => toggleLinkForm("website")}
                  title="Add a website — the page plus linked pages become a source"
                >
                  <Globe size={13} />
                </button>
              </div>
              {linkKind && (
                <form
                  className="youtube-add-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitLink();
                  }}
                >
                  <input
                    type="text"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder={linkKind === "youtube" ? "Paste a YouTube link…" : "Paste a website link…"}
                    spellCheck={false}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="primary-sm"
                    disabled={!linkUrl.trim()}
                    title={linkKind === "youtube" ? "Fetch the transcript and add it as a source" : "Read the site and add it as a source"}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className="pane-action"
                    onClick={() => {
                      setLinkKind(null);
                      setLinkUrl("");
                    }}
                    title="Cancel"
                  >
                    <X size={12} />
                  </button>
                </form>
              )}
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                multiple
                accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.tex,.pdf,.docx,.pptx,.html,.htm,.png,.jpg,.jpeg,.webp"
                onChange={(e) => {
                  if (e.target.files?.length) void onBrowserFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {!!pendingCount && (
                <div className="settings-note" style={{ margin: "8px 0" }}>
                  <Loader2 size={12} className="spin" />
                  <span>Processing {pendingCount} file{pendingCount === 1 ? "" : "s"} — uploaded → parsing → chunking → indexing…</span>
                </div>
              )}
              <div className="home-files-list">
                {sources.map((source) => {
                  const inScope = !excludedIds.includes(source.id);
                  return (
                    <div className="home-file-row" key={source.id} title={source.error || `${source.chunks} chunks · ${source.chars} chars`}>
                      <input
                        type="checkbox"
                        checked={inScope}
                        onChange={() => onToggleScope(source.id)}
                        title={inScope ? "Included in questions — click to exclude" : "Excluded from questions — click to include"}
                        className="scope-checkbox"
                      />
                      <FileText size={13} />
                      <div className="home-file-info">
                        <span className="home-file-name">{source.filename}</span>
                        <small>
                          {ingestionBadge(source.status)}
                          {source.status === "ready" ? ` · ${source.chunks} chunks` : ""}
                          {source.status === "failed" && source.error ? ` · ${source.error}` : ""}
                        </small>
                      </div>
                      <button className="pane-action" onClick={() => onReindexSource(source.id)} title={source.status === "failed" ? "Retry ingestion from raw bytes" : "Re-parse and re-index this source"}><RefreshCw size={12} /></button>
                      <button className="pane-action" onClick={() => onDeleteSource(source.id)} title="Delete source and all its derived data"><Trash2 size={12} /></button>
                    </div>
                  );
                })}
                {!sources.length && <div className="empty-pane">Upload documents to ground answers. This session is isolated.</div>}
              </div>
              <div className="context-section-title" style={{ marginTop: 12 }}><span>PIPELINE</span></div>
              <div className="empty-pane" style={{ textAlign: "left" }}>
                parse → clean → structure → chunk → embed ({stats?.embeddingModel || "pending"}) → hybrid retrieve.
                Failures show a retry button; deleting a file wipes its derived data.
              </div>
              <button className="new-session-btn" onClick={onReindexAll} title="Re-embed every file from stored chunks (use after changing the embedding model)">
                <RefreshCw size={12} /> Re-index all
              </button>
            </div>
            <div className="context-resize notebook-resize-right" onPointerDown={startSourcesResize} title="Drag to resize sources sidebar" />
          </aside>
        ) : (
          <button className="context-restore notebook-restore-left" onClick={() => setShowSources(true)} title="Open sources sidebar">
            <PanelLeft size={15} />
          </button>
        )}

        {/* Middle: chatting interface */}
        <div className="notebook-main">
          <div className="agent-transcript" ref={transcriptRef}>
            {!activeChat && <div className="empty-pane">Starting the chat… upload sources on the left, then ask.</div>}
            {activeChat && !activeChat.messages.length && !streaming && (
              <div className="empty-agent">
                <div className="empty-agent-icon">
                  <Sparkles size={20} />
                </div>
                <h2>Grounded Notebook Discussion</h2>
                <p>
                  Ask questions, explore concepts, or generate documents grounded in your sources.
                  The agent searches your index, quotes passages, and plans multi-step research.
                </p>
                <div className="home-suggestions">
                  <button className="home-suggestion" onClick={() => setDraft("Give me a comprehensive summary of all in-scope sources.")}>
                    <FileText size={13} />
                    <span>Summarize sources</span>
                  </button>
                  <button className="home-suggestion" onClick={() => setDraft("What are the key concepts, definitions, and theories covered?")}>
                    <BookOpen size={13} />
                    <span>Key concepts</span>
                  </button>
                  <button className="home-suggestion" onClick={() => setDraft("Create a practice quiz with 5 questions based on these documents.")}>
                    <HelpCircle size={13} />
                    <span>Quiz me</span>
                  </button>
                  <button className="home-suggestion" onClick={() => setDraft("Compare the main arguments and find any points of agreement or disagreement.")}>
                    <Sparkles size={13} />
                    <span>Compare perspectives</span>
                  </button>
                </div>
              </div>
            )}
            {activeChat?.messages.map((message, index) => (
              <div key={`${message.createdAt}-${index}`} className={`chat-item ${message.role}${message.metadata?.refused ? " refused" : ""}`}>
                <div className="chat-author">
                  {message.role === "assistant" ? (
                    <>
                      <span className="agent-avatar">
                        <BookOpen size={12} />
                      </span>{" "}
                      Notebook
                    </>
                  ) : (
                    <>
                      <span className="you-avatar">ME</span> You
                    </>
                  )}
                  <time>{timeLabel(message.createdAt)}</time>
                </div>
                {message.role === "assistant" ? (
                  <div className="chat-message-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
                ) : (
                  <div className="chat-text">{message.text}</div>
                )}
                {message.role === "assistant" && !!message.steps?.length && (
                  <div style={{ margin: "6px 0" }}>
                    <ActivityGroupView
                      events={message.steps.map((st) => ({
                        role: "event",
                        text: st.title,
                        kind: (st.status === "failed" ? "error" : "tool") as any,
                        detail: st.detail,
                        createdAt: message.createdAt,
                      }))}
                      running={false}
                      currentText={`${message.steps.length} research step${message.steps.length === 1 ? "" : "s"} completed`}
                    />
                  </div>
                )}
                {message.role === "assistant" && Boolean(message.text?.trim()) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                    <CopyTextButton text={message.text} />
                  </div>
                )}
                {message.role === "assistant" && message.metadata?.refused && (
                  <span className="eval-pill" style={{ borderColor: verdictColor("ungrounded") }} title="The groundedness gate refused rather than guessing">
                    not in your files
                  </span>
                )}
                {message.role === "assistant" && message.evaluation && (
                  <span className="eval-pill" style={{ borderColor: verdictColor(message.evaluation.verdict) }} title={(message.evaluation.issues || []).join("\n") || "Self-evaluation"}>
                    groundedness {message.evaluation.groundedness}/10 · {message.evaluation.verdict}
                  </span>
                )}
                {message.role === "assistant" && !!message.citations?.length && (
                  <div className="citation-list">
                    {message.citations.map((cite) => (
                      <button key={cite.chunkId} className="citation-row clickable" title={`${cite.snippet}\n\nClick to open the passage`} onClick={() => onOpenPassage(cite.chunkId)}>
                        <span className="citation-tag">[S{cite.index}]</span>
                        <span className="citation-name">{cite.sourceName} — {cite.heading}</span>
                        <span className="citation-score">{cite.score.toFixed(2)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {message.role === "assistant" && !!message.retrieval?.length && (
                  <details className="retrieval-trace">
                    <summary>retrieval trace ({message.retrieval.length} passages{message.metadata?.routing ? ` · ${message.metadata.routing}` : ""})</summary>
                    {message.retrieval.map((r) => (
                      <div key={r.chunkId} className="retrieval-row">
                        <span>{r.score.toFixed(3)}</span>
                        <span>{r.methods.join("+")}</span>
                        <span>{r.sourceName}</span>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
            {asking && (
              <ActivityGroupView
                events={(workingSteps.length ? workingSteps : ["Starting the notebook agent…"]).map((step, index) => ({
                  role: "event",
                  text: step,
                  kind: step.startsWith("Working:") || step.includes("·") ? "tool" : "status",
                  createdAt: new Date(Date.now() - (workingSteps.length - index) * 1000).toISOString(),
                }))}
                running={true}
                currentText={
                  streaming
                    ? "Synthesizing grounded answer…"
                    : workingSteps[workingSteps.length - 1] || "Agentic research in progress…"
                }
              />
            )}
            {!!streaming && (
              <div className="chat-item assistant streaming">
                <div className="chat-author">
                  <span className="agent-avatar">
                    <BookOpen size={12} />
                  </span>{" "}
                  Notebook
                </div>
                <div className="chat-message-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(streaming) }} />
                <span className="stream-caret">▍</span>
              </div>
            )}
          </div>
          <div className="agent-input-area">
            <div className="agent-input">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={excludedIds.length ? `Ask ${scopedCount} selected file${scopedCount === 1 ? "" : "s"}… (Enter to send)` : "Ask about your sources… (Enter to send)"}
                rows={3}
              />
              <div className="input-footer">
                <div className="input-left">
                  <ModelSelect selectedProviderId={selectedProviderId} selectedModel={selectedModel} providers={providers} definitions={definitions} switchModel={switchModel} onOpenProviders={onOpenProviders} />
                </div>
                <button className={`send-button${asking ? " stop" : ""}`} disabled={(!asking && !draft.trim()) || (!hasProvider && !asking)} onClick={asking ? onStop : onAsk} title={asking ? "Stop" : "Ask notebook"}>
                  {asking ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
                </button>
              </div>
            </div>
            {!!notice && <div className="input-note">{notice}</div>}
            {!hasProvider && <div className="input-note">Configure a provider (top right) to chat.</div>}
          </div>
        </div>

        {/* Right sidebar: Studio (output types on top, generated outputs below) */}
        {showStudio ? (
          <aside className="notebook-side notebook-side-studio" style={{ width: studioWidth }}>
            <div className="context-resize" onPointerDown={startStudioResize} title="Drag to resize studio sidebar" />
            <div className="context-head notebook-side-head">
              <div>
                <span className="context-kicker">STUDIO</span>
                <strong className="notebook-side-title">Outputs & Tools</strong>
                <small>{documents.length + notes.length + quizzes.length + flashcards.length + mindmaps.length + summaries.length} saved</small>
              </div>
              <button className="context-panel-icon" onClick={() => setShowStudio(false)} title="Collapse studio sidebar">
                <PanelRight size={15} />
              </button>
            </div>
            <div className="notebook-side-body">
              <StudioPanel
                generating={generatingDoc}
                generatingQuiz={generatingQuiz}
                generatingFlashcards={generatingFlashcards}
                generatingMindmap={generatingMindmap}
                generatingSummary={generatingSummary}
                hasSources={sources.length > 0}
                docSteps={docSteps}
                quizSteps={quizSteps}
                fichesSteps={fichesSteps}
                mapSteps={mapSteps}
                summarySteps={summarySteps}
                onGenerate={onGenerateDocument}
                onGenerateQuiz={onGenerateQuiz}
                onGenerateFlashcards={onGenerateFlashcards}
                onGenerateMindmap={onGenerateMindmap}
                onGenerateSummary={onGenerateSummary}
              />

              <div className="context-section-title" style={{ marginTop: 12 }}>
                <span>OUTPUTS</span><small>{documents.length + notes.length + quizzes.length + flashcards.length + mindmaps.length + summaries.length}</small>
              </div>
              <div className="artifact-list">
                {summaries.map((summary) => (
                  <div className="artifact-card clickable" key={summary.id} onClick={() => { setViewDocId(null); setViewNoteId(null); setViewQuizId(null); setViewFichesId(null); setViewMapId(null); setViewSummaryId(summary.id); }} title="Read this summary" style={{ cursor: "pointer" }}>
                    <div className="artifact-card-head">
                      <Sparkles size={12} /><span className="artifact-card-name">{summary.title}</span>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteSummary(summary.id); }} title="Delete summary"><Trash2 size={11} /></button>
                    </div>
                    <div className="artifact-card-excerpt">Summary · {summary.sections.length} sections · {summary.length} · {summary.citations.length} cited passages</div>
                    {summary.topic && <small>“{summary.topic.slice(0, 120)}”</small>}
                  </div>
                ))}
                {mindmaps.map((map) => (
                  <div className="artifact-card clickable" key={map.id} onClick={() => { setViewDocId(null); setViewNoteId(null); setViewQuizId(null); setViewFichesId(null); setViewSummaryId(null); setViewMapId(map.id); }} title="Open this mind map" style={{ cursor: "pointer" }}>
                    <div className="artifact-card-head">
                      <Network size={12} /><span className="artifact-card-name">{map.title}</span>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteMindmap(map.id); }} title="Delete mind map"><Trash2 size={11} /></button>
                    </div>
                    <div className="artifact-card-excerpt">Mind map · {map.nodeCount} nodes · {map.citations.length} cited passages</div>
                    {map.topic && <small>“{map.topic.slice(0, 120)}”</small>}
                  </div>
                ))}
                {flashcards.map((set) => (
                  <div className="artifact-card clickable" key={set.id} onClick={() => { setViewDocId(null); setViewNoteId(null); setViewQuizId(null); setViewMapId(null); setViewSummaryId(null); setViewFichesId(set.id); }} title="Study these flashcards" style={{ cursor: "pointer" }}>
                    <div className="artifact-card-head">
                      <Layers size={12} /><span className="artifact-card-name">{set.title}</span>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteFlashcards(set.id); }} title="Delete flashcards"><Trash2 size={11} /></button>
                    </div>
                    <div className="artifact-card-excerpt">Flashcards · {set.cards.length} cards · {set.citations.length} cited passages</div>
                    {set.topic && <small>“{set.topic.slice(0, 120)}”</small>}
                  </div>
                ))}
                {quizzes.map((quiz) => (
                  <div className="artifact-card clickable" key={quiz.id} onClick={() => { setViewDocId(null); setViewNoteId(null); setViewFichesId(null); setViewMapId(null); setViewSummaryId(null); setViewQuizId(quiz.id); }} title="Take this quiz" style={{ cursor: "pointer" }}>
                    <div className="artifact-card-head">
                      <HelpCircle size={12} /><span className="artifact-card-name">{quiz.title}</span>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteQuiz(quiz.id); }} title="Delete quiz"><Trash2 size={11} /></button>
                    </div>
                    <div className="artifact-card-excerpt">Quiz · {quiz.questions.length} questions · {quiz.quizType === "mcq" ? "MCQ" : quiz.quizType === "truefalse" ? "True/False" : "Mixed"} · {quiz.citations.length} cited passages</div>
                    {quiz.topic && <small>“{quiz.topic.slice(0, 120)}”</small>}
                  </div>
                ))}
                {documents.map((doc) => (
                  <div className="artifact-card clickable" key={doc.id} onClick={() => { setViewNoteId(null); setViewQuizId(null); setViewFichesId(null); setViewMapId(null); setViewSummaryId(null); setViewDocId(doc.id); }} title="Open in window" style={{ cursor: "pointer" }}>
                    <div className="artifact-card-head">
                      <FileText size={12} /><span className="artifact-card-name">{doc.title}</span>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDownloadDocument(doc.id); }} title={`Download ${doc.filename}`}><Download size={11} /></button>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteDocument(doc.id); }} title="Delete document"><Trash2 size={11} /></button>
                    </div>
                    <div className="artifact-card-excerpt">{doc.kind === "slides" ? `${doc.slideCount} slides` : `${doc.sectionCount} sections`} · {doc.format.toUpperCase()} · {Math.round(doc.size / 1024)} KB · {doc.citations.length} cited passages{doc.engine === "skill-agent" ? " · skill-designed" : ""}</div>
                    {doc.prompt && <small>“{doc.prompt.slice(0, 120)}”</small>}
                  </div>
                ))}
                {notes.map((note) => (
                  <div className="artifact-card clickable" key={note.id} onClick={() => { setViewDocId(null); setViewQuizId(null); setViewFichesId(null); setViewMapId(null); setViewSummaryId(null); setViewNoteId(note.id); }} title="Open in window" style={{ cursor: "pointer" }}>
                    <div className="artifact-card-head">
                      <FileText size={12} /><span className="artifact-card-name">{note.title}</span>
                      <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteNote(note.id); }} title="Delete note"><Trash2 size={11} /></button>
                    </div>
                    <div className="artifact-card-excerpt">{note.content.slice(0, 240)}</div>
                    {note.citations.length > 0 && <small>{note.citations.length} cited passage{note.citations.length === 1 ? "" : "s"}</small>}
                  </div>
                ))}
                {!documents.length && !notes.length && !quizzes.length && !flashcards.length && !mindmaps.length && !summaries.length && <div className="empty-pane">Reports (DOCX/PDF), slides (PPTX), quizzes, flashcards, mind maps, and summaries you generate appear here, with citations. Saved notes too.</div>}
              </div>
              {latestAnswer && (
                <button
                  className="new-session-btn"
                  onClick={() => onSaveNote({ title: latestAnswer.text.slice(0, 60), content: latestAnswer.text, citations: latestAnswer.citations || [] })}
                  title="Save the latest grounded answer as a cited note"
                >
                  <Plus size={12} /> Save latest answer as note
                </button>
              )}

              <details className="retrieval-trace" style={{ marginTop: 12 }}>
                <summary>Notebook goal</summary>
                <textarea
                  className="text-field notebook-instructions"
                  value={instructionDraft}
                  onChange={(event) => setInstructionDraft(event.target.value)}
                  placeholder="Tell the notebook how to help: e.g. teach me like a professor, compare evidence, use concise bullet points…"
                  rows={4}
                  style={{ marginTop: 8 }}
                />
                <button className="new-session-btn" onClick={() => onSaveInstructions(instructionDraft)} disabled={instructionDraft === settings.instructions} style={{ marginTop: 6 }}>
                  <Check size={12} /> Save goal
                </button>
              </details>

              {stats?.digest && !!stats.digest.topics.length && (
                <>
                  <div className="context-section-title"><span>SESSION DIGEST</span></div>
                  <div className="digest-topics">{stats.digest.topics.join(" · ")}</div>
                </>
              )}
              {!!evalSummary && (
                <div className="settings-note" style={{ marginBottom: 8 }}>
                  <span>⌀ groundedness {evalSummary.avg}/10 across {evalSummary.count} answer{evalSummary.count === 1 ? "" : "s"}</span>
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button className="new-session-btn" onClick={exportTranscript} disabled={!activeChat?.messages.length} title="Download this chat as Markdown">
                  <Download size={13} /> Export chat
                </button>
              </div>
            </div>
          </aside>
        ) : (
          <button className="context-restore notebook-restore-right" onClick={() => setShowStudio(true)} title="Open studio sidebar">
            <PanelRight size={15} />
          </button>
        )}
      </div>
      {passage && <SourcePassageModal passage={passage} onClose={onClosePassage} onAction={(action) => onPassageAction(action, passage)} />}
      {viewDoc && activeNotebook && (
        <FilePreviewModal
          filePath={viewDoc.filename}
          load={() => window.nexus.notebookReadDocument(activeNotebook.id, viewDoc.id)}
          onClose={() => setViewDocId(null)}
          onDownload={() => onDownloadDocument(viewDoc.id)}
        />
      )}
      {viewNote && (
        <DocumentViewerModal
          title={viewNote.title}
          subtitle={`Saved note · created ${new Date(viewNote.createdAt).toLocaleString()}`}
          meta={`${viewNote.citations.length} cited passage${viewNote.citations.length === 1 ? "" : "s"}`}
          markdown={viewNote.content}
          citations={viewNote.citations}
          onClose={() => setViewNoteId(null)}
        />
      )}
      {viewQuiz && (
        <QuizPlayerModal quiz={viewQuiz} onClose={() => setViewQuizId(null)} />
      )}
      {viewFiches && (
        <FlashcardPlayerModal set={viewFiches} onClose={() => setViewFichesId(null)} />
      )}
      {viewMap && (
        <MindmapViewerModal map={viewMap} onClose={() => setViewMapId(null)} />
      )}
      {viewSummary && (
        <DocumentViewerModal
          title={viewSummary.title}
          subtitle={`${viewSummary.length === "brief" ? "Brief" : viewSummary.length === "standard" ? "Standard" : "Detailed"} summary · ${viewSummary.sections.length} sections · topic: ${viewSummary.topic}`}
          meta={`${viewSummary.citations.length} cited passage${viewSummary.citations.length === 1 ? "" : "s"}`}
          prompt={viewSummary.topic}
          markdown={summaryToMarkdown(viewSummary)}
          citations={viewSummary.citations}
          onClose={() => setViewSummaryId(null)}
        />
      )}
    </div>
  );
}
