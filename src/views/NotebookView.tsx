import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft, ArrowUp, BookOpen, Check, Download, FileText, Loader2, Pencil, Plus,
  RefreshCw, Square, Trash2, Upload,
} from "lucide-react";
import { ModelSelect } from "./AgentView.js";
import { renderMarkdown } from "../markdown.js";
import { timeLabel } from "../utils/format.js";
import { SourcePassageModal, type PassageAction } from "../components/notebook/SourcePassageModal.js";
import type { NotebookChat, NotebookMeta, NotebookNote, NotebookPassage, NotebookSettings, NotebookSource, NotebookStats, ProviderConfig, ProviderDefinition } from "../types.js";

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
  onCreateNotebook,
  onDeleteNotebook,
  onPickFiles,
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
  onCreateNotebook: (name: string) => void;
  onDeleteNotebook: (id: string) => void;
  onPickFiles: () => void;
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
            <span className="view-kicker">NOTEBOOK · AGENTIC RAG</span>
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
            <span>SOURCES · SCOPE {scopedCount}/{sources.length}</span>
            {excludedIds.length > 0 && <button className="pane-action" onClick={onResetScope} title="Ask all files again"><RefreshCw size={11} /></button>}
          </div>
          <div className="notebook-upload-row">
            <button className="new-session-btn" onClick={onPickFiles}><FileText size={13} /> Add files</button>
            <button className="pane-action" onClick={() => fileInputRef.current?.click()} title="Upload from this window"><Upload size={13} /></button>
          </div>
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
            {asking && !streaming && (
              <div className="notebook-working" aria-live="polite">
                <div className="notebook-working-title"><Loader2 size={14} className="spin" /> Working through your notebook</div>
                <div className="notebook-working-steps">
                  {(workingSteps.length ? workingSteps : ["Starting the notebook agent…"]).map((step, index) => {
                    const activeStep = index === (workingSteps.length || 1) - 1;
                    return (
                    <div className={`notebook-working-step ${activeStep ? "active" : "done"}`} key={`${step}-${index}`}>
                      <span className="notebook-step-mark">{activeStep ? "·" : "✓"}</span>
                      <span>{step}</span>
                    </div>
                    );
                  })}
                </div>
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

        {/* Right sidebar: notes and digest */}
        <div className="notebook-side">
          <div className="context-section-title"><span>NOTEBOOK GOAL</span></div>
          <textarea
            className="text-field notebook-instructions"
            value={instructionDraft}
            onChange={(event) => setInstructionDraft(event.target.value)}
            placeholder="Tell the notebook how to help: e.g. teach me like a professor, compare evidence, use concise bullet points…"
            rows={4}
          />
          <button className="new-session-btn" onClick={() => onSaveInstructions(instructionDraft)} disabled={instructionDraft === settings.instructions}>
            <Check size={12} /> Save goal
          </button>

          <div className="context-section-title" style={{ marginTop: 12 }}>
            <span>NOTES</span><small>{notes.length}</small>
          </div>
          {latestAnswer && (
            <button
              className="new-session-btn"
              onClick={() => onSaveNote({ title: latestAnswer.text.slice(0, 60), content: latestAnswer.text, citations: latestAnswer.citations || [] })}
              title="Save the latest grounded answer as a cited note"
            >
              <Plus size={12} /> Save latest answer
            </button>
          )}
          <div className="artifact-list">
            {notes.map((note) => (
              <div className="artifact-card" key={note.id}>
                <div className="artifact-card-head">
                  <FileText size={12} /><span className="artifact-card-name">{note.title}</span>
                  <button className="pane-action" onClick={() => onDeleteNote(note.id)} title="Delete note"><Trash2 size={11} /></button>
                </div>
                <div className="artifact-card-excerpt">{note.content.slice(0, 240)}</div>
                {note.citations.length > 0 && <small>{note.citations.length} cited passage{note.citations.length === 1 ? "" : "s"}</small>}
              </div>
            ))}
            {!notes.length && <div className="empty-pane">Save important answers here. Notes keep their source citations.</div>}
          </div>

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
    </div>
  );
}
