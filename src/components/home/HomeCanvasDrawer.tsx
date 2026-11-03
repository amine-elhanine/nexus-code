import React, { useEffect, useRef, useState, useCallback } from "react";
import { X, Download, FileText, Loader2, TriangleAlert, History, Code2, Eye, Send, Sparkles } from "lucide-react";
import { safeMarkdown } from "../../markdown.js";
import type { ArtifactVersionManifest } from "../../types.js";

type PreviewKind = "markdown" | "pdf" | "image" | "docx" | "xlsx" | "pptx" | "text" | "html" | "unsupported";

const TEXT_EXTS = new Set([
  "txt", "tex", "csv", "json", "xml", "yaml", "yml", "toml", "log",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "go", "rs", "java",
  "c", "cpp", "h", "cs", "rb", "php", "swift", "css", "scss", "sql", "sh", "md",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const TEXT_RENDER_CAP = 2 * 1024 * 1024;

function kindFor(filename: string): PreviewKind {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "docx") return "docx";
  if (["xlsx", "xls", "csv"].includes(ext)) return "xlsx";
  if (["pptx", "ppsx"].includes(ext)) return "pptx";
  if (TEXT_EXTS.has(ext) || ext === "tex") return "text";
  return "unsupported";
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function HomeCanvasDrawer({
  filePath,
  onClose,
  onDownload,
  onRefine,
  width = 460,
  onResizeStart,
  refreshToken,
}: {
  filePath: string;
  onClose: () => void;
  onDownload: (path: string) => void;
  onRefine?: (instruction: string) => void;
  width?: number;
  onResizeStart?: (e: React.PointerEvent) => void;
  refreshToken?: string;
}) {
  const api = window.nexus;
  const fileName = filePath.split("/").pop() || filePath;
  const kind = kindFor(fileName);
  const needsLibContainer = kind === "docx" || kind === "pptx";
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<Array<{ name: string; html: string }>>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [manifest, setManifest] = useState<ArtifactVersionManifest | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [refineInput, setRefineInput] = useState("");

  const libRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ destroy?: () => void } | null>(null);
  const urlsRef = useRef<string[]>([]);

  const loadVersions = useCallback(async () => {
    if (typeof api?.getArtifactVersions === "function") {
      try {
        const m = await api.getArtifactVersions(filePath);
        setManifest(m as ArtifactVersionManifest | null);
      } catch {
        setManifest(null);
      }
    }
  }, [api, filePath]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions, refreshToken]);

  const loadFileContent = useCallback(async () => {
    let cancelled = false;
    const trackUrl = (url: string) => {
      urlsRef.current.push(url);
      return url;
    };
    try {
      setStatus("loading");
      const file = await api.readHomeFile(filePath);
      if (cancelled) return;
      const bytes = base64ToBytes(file.base64);

      if (kind === "markdown" || kind === "text" || kind === "html") {
        if (file.size > TEXT_RENDER_CAP) {
          throw new Error("File is too large to display. Download it instead.");
        }
        setText(new TextDecoder().decode(bytes));
      } else if (kind === "pdf") {
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
        setBlobUrl(trackUrl(URL.createObjectURL(blob)));
      } else if (kind === "image") {
        const blob = new Blob([bytes.buffer as ArrayBuffer]);
        setBlobUrl(trackUrl(URL.createObjectURL(blob)));
      } else if (kind === "docx") {
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !libRef.current) return;
        libRef.current.innerHTML = "";
        await renderAsync(bytes.buffer as ArrayBuffer, libRef.current);
      } else if (kind === "xlsx") {
        const XLSX = await import("xlsx");
        if (cancelled) return;
        const ext = fileName.split(".").pop()?.toLowerCase();
        const workbook =
          ext === "csv"
            ? XLSX.read(new TextDecoder().decode(bytes), { type: "string" })
            : XLSX.read(bytes, { type: "array" });
        const rendered = workbook.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(workbook.Sheets[name] || {}),
        }));
        if (cancelled) return;
        setSheets(rendered);
        setActiveSheet(0);
      } else if (kind === "pptx") {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
        if (cancelled || !libRef.current) return;
        libRef.current.innerHTML = "";
        const viewer = await PptxViewer.open(bytes.buffer as ArrayBuffer, libRef.current, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          listOptions: { windowed: true },
        });
        viewerRef.current = viewer as { destroy?: () => void };
      }
      if (!cancelled) setStatus("ready");
    } catch (err) {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }
  }, [api, filePath, fileName, kind]);

  useEffect(() => {
    void loadFileContent();
    return () => {
      try {
        viewerRef.current?.destroy?.();
      } catch { /* ignore teardown errors */ }
      viewerRef.current = null;
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    };
  }, [loadFileContent, refreshToken]);

  const handleRollback = async () => {
    if (!selectedVersion || restoring || typeof api?.restoreArtifactVersion !== "function") return;
    setRestoring(true);
    try {
      const ok = await api.restoreArtifactVersion(filePath, selectedVersion);
      if (ok) {
        await loadFileContent();
        await loadVersions();
        setSelectedVersion(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  };

  const handleSendRefine = () => {
    const q = refineInput.trim();
    if (!q) return;
    onRefine?.(`Refine file "${filePath}":\n${q}`);
    setRefineInput("");
  };

  return (
    <aside
      className="home-canvas-drawer"
      style={{
        width,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderLeft: "1px solid var(--border-subtle, #333)",
        background: "var(--bg-canvas, #181818)",
        position: "relative",
        zIndex: 10,
      }}
    >
      {onResizeStart && (
        <div
          className="context-resize"
          onPointerDown={onResizeStart}
          title="Drag to resize Canvas"
          style={{ position: "absolute", left: -4, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 12 }}
        />
      )}

      {/* Canvas Top Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border-subtle, #333)",
          background: "var(--bg-elevated, #202020)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
          <span style={{ color: "var(--accent, #3b82f6)" }}>
            <Sparkles size={14} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <strong style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {fileName}
            </strong>
            <small style={{ fontSize: 10, opacity: 0.6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {filePath}
            </small>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {manifest && manifest.versions.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <History size={12} style={{ opacity: 0.7 }} />
              <select
                aria-label="Canvas artifact version"
                value={selectedVersion ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedVersion(val ? Number(val) : null);
                }}
                style={{
                  fontSize: 11,
                  background: "var(--bg-input, #161616)",
                  color: "var(--fg, #eee)",
                  border: "1px solid var(--border-subtle, #333)",
                  borderRadius: 4,
                  padding: "2px 4px",
                }}
              >
                <option value="">v{manifest.currentVersion} (current)</option>
                {manifest.versions.slice().reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} · {new Date(v.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </option>
                ))}
              </select>
              {selectedVersion !== null && selectedVersion !== manifest.currentVersion && (
                <button
                  className="top-link"
                  onClick={() => void handleRollback()}
                  disabled={restoring}
                  style={{ fontSize: 10, padding: "2px 6px" }}
                >
                  {restoring ? "Reverting…" : `Revert`}
                </button>
              )}
            </div>
          )}

          {(kind === "markdown" || kind === "html" || kind === "text") && (
            <div style={{ display: "flex", background: "var(--bg-input, #161616)", borderRadius: 4, padding: 2, border: "1px solid var(--border-subtle, #333)" }}>
              <button
                className={`pane-action${tab === "preview" ? " active" : ""}`}
                style={{ padding: "2px 6px", fontSize: 11 }}
                onClick={() => setTab("preview")}
                title="Preview artifact"
              >
                <Eye size={11} />
              </button>
              <button
                className={`pane-action${tab === "source" ? " active" : ""}`}
                style={{ padding: "2px 6px", fontSize: 11 }}
                onClick={() => setTab("source")}
                title="View raw source"
              >
                <Code2 size={11} />
              </button>
            </div>
          )}

          <button className="icon-plain" onClick={() => onDownload(filePath)} title="Download file">
            <Download size={13} />
          </button>
          <button className="icon-plain" onClick={onClose} title="Close Canvas">
            <X size={14} />
          </button>
        </div>
      </div>

      {kind === "xlsx" && sheets.length > 1 && (
        <div className="file-preview-tabs">
          {sheets.map((sheet, idx) => (
            <button
              key={sheet.name}
              className={idx === activeSheet ? "active" : ""}
              onClick={() => setActiveSheet(idx)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* Canvas Main Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {needsLibContainer && <div ref={libRef} className="file-preview-lib" />}
        {status === "loading" && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 8, opacity: 0.7 }}>
            <Loader2 size={16} className="spin" />
            <span>Loading artifact…</span>
          </div>
        )}
        {status === "error" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 8, color: "#f87171" }}>
            <TriangleAlert size={20} />
            <span style={{ fontSize: 12 }}>{error}</span>
          </div>
        )}
        {status === "ready" && tab === "source" && (
          <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {text}
          </pre>
        )}
        {status === "ready" && tab === "preview" && (
          <>
            {kind === "markdown" && (
              <div className="md file-preview-md" dangerouslySetInnerHTML={{ __html: safeMarkdown(text) }} />
            )}
            {kind === "html" && (
              <iframe
                srcDoc={text}
                title={fileName}
                sandbox="allow-scripts"
                style={{ width: "100%", height: "100%", border: "none", background: "#fff", borderRadius: 4 }}
              />
            )}
            {kind === "text" && (
              <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {text}
              </pre>
            )}
            {kind === "pdf" && blobUrl && (
              <iframe src={blobUrl} title={fileName} style={{ width: "100%", height: "100%", border: "none" }} />
            )}
            {kind === "image" && blobUrl && (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <img src={blobUrl} alt={fileName} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
              </div>
            )}
            {kind === "xlsx" && sheets[activeSheet] && (
              <div className="file-preview-sheet" dangerouslySetInnerHTML={{ __html: sheets[activeSheet].html }} />
            )}
            {kind === "unsupported" && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginTop: 40, opacity: 0.7 }}>
                <FileText size={28} />
                <span>Download this deliverable to open it with its default desktop application.</span>
                <button className="top-link" onClick={() => onDownload(filePath)}>
                  <Download size={13} /> Download {fileName}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Docked "Ask Nexus to Refine" Bar */}
      <div
        style={{
          borderTop: "1px solid var(--border-subtle, #333)",
          background: "var(--bg-elevated, #202020)",
          padding: "8px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {["Add detail", "Make concise", "Format as table", "Fix issues"].map((pill) => (
            <button
              key={pill}
              onClick={() => onRefine?.(`Refine file "${filePath}":\n${pill}`)}
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 12,
                border: "1px solid var(--border-subtle, #333)",
                background: "transparent",
                color: "var(--fg-muted, #aaa)",
                cursor: "pointer",
              }}
            >
              {pill}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="text"
            className="text-field"
            value={refineInput}
            onChange={(e) => setRefineInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendRefine();
              }
            }}
            placeholder="Ask Nexus to edit or refine this file…"
            style={{ fontSize: 12, flex: 1 }}
          />
          <button
            className="primary"
            onClick={handleSendRefine}
            disabled={!refineInput.trim()}
            style={{ padding: "6px 10px", borderRadius: 6, cursor: "pointer" }}
            title="Send refinement to assistant"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </aside>
  );
}
