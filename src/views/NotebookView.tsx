import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft, ArrowUp, BookOpen, Check, ChevronRight, Clapperboard, Download, FileText, Globe, HelpCircle,
  Layers, Loader2, Network, Pencil, Plus, Presentation, RefreshCw, Sparkles, Square, Trash2, Upload, X,
} from "lucide-react";
import { ModelSelect } from "./AgentView.js";
import { ActivityGroupView, CopyTextButton } from "../components/chat/ChatMessageItem.js";
import { renderMarkdown } from "../markdown.js";
import { timeLabel } from "../utils/format.js";
import { SourcePassageModal, type PassageAction } from "../components/notebook/SourcePassageModal.js";
import { DocumentViewerModal } from "../components/notebook/DocumentViewerModal.js";
import { FilePreviewModal } from "../components/home/FilePreviewModal.js";
import type { ChatItem, NotebookChat, NotebookDocument, NotebookMeta, NotebookNote, NotebookPassage, NotebookSettings, NotebookSource, NotebookStats, ProviderConfig, ProviderDefinition } from "../types.js";

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

const STUDIO_QUICK_PROMPTS: Record<string, string> = {
  quiz: "Create a short quiz from my in-scope sources. Ask me one question at a time and wait for my answer.",
  fiches: "Create concise Q/A flashcards covering the key concepts in my in-scope sources.",
  mindmap: "Build a text mind map (nested Markdown list) of the main topics and subtopics in my in-scope sources.",
  resume: "Write a concise summary of the main ideas across my in-scope sources, with citations.",
};

/** Right-panel Studio: output-type tiles on top, generation composer, outputs below. */
function StudioPanel({ generating, hasSources, docSteps, onGenerate, onQuickPrompt }: {
  generating: boolean;
  hasSources: boolean;
  docSteps: string[];
  onGenerate: (kind: NotebookDocument["kind"], format: NotebookDocument["format"], prompt: string) => void;
  onQuickPrompt: (key: keyof typeof STUDIO_QUICK_PROMPTS) => void;
}) {
  const [kind, setKind] = useState<NotebookDocument["kind"]>("report");
  const [format, setFormat] = useState<NotebookDocument["format"]>("docx");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    setFormat(kind === "slides" ? "pptx" : "docx");
  }, [kind]);

  const tiles = [
    { key: "report", icon: <FileText size={15} />, label: "Rapports", tone: "green" },
    { key: "slides", icon: <Presentation size={15} />, label: "Présentation", tone: "yellow" },
    { key: "quiz", icon: <HelpCircle size={15} />, label: "Quiz", tone: "blue" },
    { key: "fiches", icon: <Layers size={15} />, label: "Fiches", tone: "purple" },
    { key: "mindmap", icon: <Network size={15} />, label: "Carte mentale", tone: "pink" },
    { key: "resume", icon: <Sparkles size={15} />, label: "Résumé", tone: "gray" },
  ] as const;

  return (
    <div>
      <div className="studio-grid">
        {tiles.map((tile) => {
          const selectable = tile.key === "report" || tile.key === "slides";
          const active = selectable && kind === tile.key;
          return (
            <button
              key={tile.key}
              className={`studio-card tone-${tile.tone}${active ? " active" : ""}`}
              onClick={() => {
                if (tile.key === "report" || tile.key === "slides") setKind(tile.key);
                else onQuickPrompt(tile.key);
              }}
              title={selectable ? (tile.key === "report" ? "Generate a grounded report (DOCX/PDF)" : "Generate grounded slides (PPTX)") : "Fill the discussion box with this prompt"}
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
          placeholder={kind === "slides" ? "Slide deck topic… (empty = full overview)" : "Report topic… (empty = full overview)"}
          spellCheck={false}
          className="text-field"
        />
        {kind === "report" && (
          <div className="doc-toggle-group studio-format" role="group" aria-label="Report format">
            <button className={`doc-toggle${format === "docx" ? " active" : ""}`} onClick={() => setFormat("docx")} title="Word document">DOCX</button>
            <button className={`doc-toggle${format === "pdf" ? " active" : ""}`} onClick={() => setFormat("pdf")} title="PDF document">PDF</button>
          </div>
        )}
        <button
          className="studio-generate"
          disabled={generating || !hasSources}
          onClick={() => onGenerate(kind, kind === "slides" ? "pptx" : format, prompt.trim())}
          title={hasSources ? "Generate from in-scope sources with citations" : "Upload sources first"}
        >
          {generating ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          {generating ? " Generating…" : kind === "slides" ? " Generate PPTX" : ` Generate ${format.toUpperCase()}`}
        </button>
      </div>
      {(generating || docSteps.length > 0) && (
        <div style={{ marginTop: 8 }}>
          <ActivityGroupView
            events={(docSteps.length ? docSteps : ["Starting the document agent…"]).map((step, index) => ({
              role: "event",
              text: step,
              kind: step.startsWith("Working:") || step.includes("·") ? "tool" : "status",
              createdAt: new Date(Date.now() - (docSteps.length - index) * 1000).toISOString(),
            }))}
            running={generating}
            currentText={
              generating
                ? docSteps[docSteps.length - 1] || "Starting the document agent…"
                : `${docSteps.length || 1} step${docSteps.length === 1 ? "" : "s"} completed`
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
  generatingDoc,
  docSteps,
  onGenerateDocument,
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
  generatingDoc: boolean;
  docSteps: string[];
  onGenerateDocument: (kind: NotebookDocument["kind"], format: NotebookDocument["format"], prompt: string) => void;
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
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const [viewNoteId, setViewNoteId] = useState<string | null>(null);
  const viewDoc = viewDocId ? documents.find((d) => d.id === viewDocId) || null : null;
  const viewNote = viewNoteId ? notes.find((n) => n.id === viewNoteId) || null : null;
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
        <div className="notebook-side">
          <div className="context-section-title">
            <span>SOURCES {scopedCount}/{sources.length}</span>
            {excludedIds.length > 0 && <button className="pane-action" onClick={onResetScope} title="Ask all files again"><RefreshCw size={11} /></button>}
          </div>
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

        {/* Middle: chatting interface */}
        <div className="notebook-main">
          <div className="agent-transcript" ref={transcriptRef}>
            {!activeChat && <div className="empty-pane">Starting the chat… upload sources on the left, then ask.</div>}
            {activeChat && !activeChat.messages.length && !streaming && (
              <div className="empty-pane">No messages yet — ask anything about your sources.</div>
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
        <div className="notebook-side">
          <div className="context-section-title"><span>STUDIO</span></div>
          <StudioPanel
            generating={generatingDoc}
            hasSources={sources.length > 0}
            docSteps={docSteps}
            onGenerate={onGenerateDocument}
            onQuickPrompt={(key) => setDraft(STUDIO_QUICK_PROMPTS[key])}
          />

          <div className="context-section-title" style={{ marginTop: 12 }}>
            <span>OUTPUTS</span><small>{documents.length + notes.length}</small>
          </div>
          <div className="artifact-list">
            {documents.map((doc) => (
              <div className="artifact-card clickable" key={doc.id} onClick={() => { setViewNoteId(null); setViewDocId(doc.id); }} title="Open in window" style={{ cursor: "pointer" }}>
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
              <div className="artifact-card clickable" key={note.id} onClick={() => { setViewDocId(null); setViewNoteId(note.id); }} title="Open in window" style={{ cursor: "pointer" }}>
                <div className="artifact-card-head">
                  <FileText size={12} /><span className="artifact-card-name">{note.title}</span>
                  <button className="pane-action" onClick={(e) => { e.stopPropagation(); onDeleteNote(note.id); }} title="Delete note"><Trash2 size={11} /></button>
                </div>
                <div className="artifact-card-excerpt">{note.content.slice(0, 240)}</div>
                {note.citations.length > 0 && <small>{note.citations.length} cited passage{note.citations.length === 1 ? "" : "s"}</small>}
              </div>
            ))}
            {!documents.length && !notes.length && <div className="empty-pane">Reports (DOCX/PDF) and slides (PPTX) you generate appear here, with citations. Saved notes too.</div>}
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
    </div>
  );
}
