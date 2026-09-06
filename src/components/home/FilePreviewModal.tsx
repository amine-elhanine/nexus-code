import React, { useEffect, useRef, useState } from "react";
import { X, Download, FileText, Loader2, TriangleAlert } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";

type PreviewKind =
  | "markdown" | "pdf" | "image" | "docx" | "xlsx" | "pptx" | "text" | "unsupported";

const TEXT_EXTS = new Set([
  "txt", "tex", "csv", "json", "xml", "yaml", "yml", "toml", "log",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "go", "rs", "java",
  "c", "cpp", "h", "cs", "rb", "php", "swift", "css", "scss", "html",
  "sql", "sh", "md",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
// Plain-text rendering cap: bigger files degrade to download-only instead of
// freezing the renderer with a giant DOM.
const TEXT_RENDER_CAP = 2 * 1024 * 1024;

function kindFor(filename: string): PreviewKind {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (ext === "md" || ext === "markdown") return "markdown";
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

export function FilePreviewModal({
  filePath,
  onClose,
  onDownload,
}: {
  filePath: string;
  onClose: () => void;
  onDownload: (path: string) => void;
}) {
  const api = window.nexus || window.forgepilot;
  const fileName = filePath.split("/").pop() || filePath;
  const kind = kindFor(fileName);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<Array<{ name: string; html: string }>>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  // Library-rendered kinds (docx/pptx) paint into a dedicated container
  // React never touches — clearing bodyRef would wipe React's own children
  // and corrupt reconciliation.
  const libRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ destroy?: () => void } | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const trackUrl = (url: string) => {
      urlsRef.current.push(url);
      return url;
    };
    (async () => {
      try {
        const file = await api.readHomeFile(filePath);
        if (cancelled) return;
        const bytes = base64ToBytes(file.base64);
        if (kind === "markdown" || kind === "text") {
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
    })();
    return () => {
      cancelled = true;
      try {
        viewerRef.current?.destroy?.();
      } catch { /* ignore teardown errors */ }
      viewerRef.current = null;
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    };
  }, [filePath]);

  const needsLibContainer = (kind === "docx" || kind === "pptx") && status !== "error";

  return (
    <div className="modal-layer" onClick={onClose}>
      <div className="modal-card file-preview-card" onClick={(e) => e.stopPropagation()}>
        <div className="file-preview-head">
          <FileText size={15} />
          <div className="file-preview-title">
            <strong>{fileName}</strong>
            <small>{filePath}</small>
          </div>
          <button className="top-link" onClick={() => onDownload(filePath)} title="Download this file">
            <Download size={13} /> Download
          </button>
          <button className="icon-plain" onClick={onClose} title="Close preview">
            <X size={15} />
          </button>
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
        <div className="file-preview-body">
          {needsLibContainer && <div ref={libRef} className="file-preview-lib" />}
          {status === "loading" && (
            <div className="file-preview-center">
              <Loader2 size={18} className="spin" />
              <span>Loading preview…</span>
            </div>
          )}
          {status === "error" && (
            <div className="file-preview-center">
              <TriangleAlert size={18} />
              <span>{error}</span>
              <button className="top-link" onClick={() => onDownload(filePath)}>
                <Download size={13} /> Download instead
              </button>
            </div>
          )}
          {status === "ready" && kind === "markdown" && (
            <div className="md file-preview-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          )}
          {status === "ready" && kind === "text" && (
            <pre className="file-preview-text">{text}</pre>
          )}
          {status === "ready" && kind === "pdf" && blobUrl && (
            <iframe src={blobUrl} title={fileName} className="file-preview-frame" />
          )}
          {status === "ready" && kind === "image" && blobUrl && (
            <div className="file-preview-center">
              <img src={blobUrl} alt={fileName} className="file-preview-image" />
            </div>
          )}
          {status === "ready" && kind === "xlsx" && sheets[activeSheet] && (
            <div className="file-preview-sheet" dangerouslySetInnerHTML={{ __html: sheets[activeSheet].html }} />
          )}
          {status === "ready" && kind === "unsupported" && (
            <div className="file-preview-center">
              <FileText size={18} />
              <span>No in-app preview for this file type.</span>
              <button className="top-link" onClick={() => onDownload(filePath)}>
                <Download size={13} /> Download to open it
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
