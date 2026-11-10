import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  X,
  Download,
  FileText,
  Loader2,
  TriangleAlert,
  Eye,
  Code2,
  Send,
  Maximize2,
  Minimize2,
  ExternalLink,
  Copy,
  Check,
  Presentation,
  FileSpreadsheet,
  Image as ImageIcon,
  FileCode,
} from "lucide-react";
import { safeMarkdown } from "../../markdown.js";
import { fixPptxRenderedSlide } from "../../utils/pptx-preview.js";

type PreviewKind =
  | "markdown"
  | "pdf"
  | "image"
  | "docx"
  | "xlsx"
  | "pptx"
  | "text"
  | "html"
  | "unsupported";

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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getArtifactFormat(filename: string) {
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") {
    return {
      label: "PDF",
      badgeClass: "badge-pdf",
      icon: <FileText size={15} style={{ color: "#ef4444" }} />,
      color: "#ef4444",
      bg: "rgba(239, 68, 68, 0.15)",
    };
  }
  if (["pptx", "ppsx", "key"].includes(ext)) {
    return {
      label: "SLIDES",
      badgeClass: "badge-slides",
      icon: <Presentation size={15} style={{ color: "#f59e0b" }} />,
      color: "#f59e0b",
      bg: "rgba(245, 158, 11, 0.15)",
    };
  }
  if (["xlsx", "xls", "csv"].includes(ext)) {
    return {
      label: "SHEET",
      badgeClass: "badge-sheet",
      icon: <FileSpreadsheet size={15} style={{ color: "#10b981" }} />,
      color: "#10b981",
      bg: "rgba(16, 185, 129, 0.15)",
    };
  }
  if (["docx", "doc"].includes(ext)) {
    return {
      label: "DOCX",
      badgeClass: "badge-docx",
      icon: <FileText size={15} style={{ color: "#3b82f6" }} />,
      color: "#3b82f6",
      bg: "rgba(59, 130, 246, 0.15)",
    };
  }
  if (["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) {
    return {
      label: "IMAGE",
      badgeClass: "badge-image",
      icon: <ImageIcon size={15} style={{ color: "#ec4899" }} />,
      color: "#ec4899",
      bg: "rgba(236, 72, 153, 0.15)",
    };
  }
  return {
    label: ext ? ext.toUpperCase() : "DOC",
    badgeClass: "badge-doc",
    icon: <FileCode size={15} style={{ color: "#8b5cf6" }} />,
    color: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.15)",
  };
}

function getSmartRefinePills(kind: PreviewKind, filename: string) {
  if (kind === "pptx") {
    return [
      { label: "+2 Slides", prompt: `Please add 2 more substantive, well-structured slides to "${filename}".` },
      { label: "Make concise", prompt: `Please edit "${filename}" to make the bullet points tighter, punchier, and more concise.` },
      { label: "Add visual notes", prompt: `Please add illustrative bullet callouts, takeaways, and visual descriptions to "${filename}".` },
      { label: "Convert to PDF", prompt: `Please generate a matching PDF report from the contents of "${filename}".` },
    ];
  }
  if (kind === "xlsx") {
    return [
      { label: "+Summary row", prompt: `Please add a summary and totals row with formulas to "${filename}".` },
      { label: "Format numbers", prompt: `Please format numbers with clean decimals, percentages, and currencies in "${filename}".` },
      { label: "Add comparison", prompt: `Please add structured benchmark and comparison columns to "${filename}".` },
      { label: "Sort metrics", prompt: `Please sort and highlight the key metrics in "${filename}".` },
    ];
  }
  if (kind === "docx" || kind === "pdf" || kind === "markdown" || kind === "text") {
    return [
      { label: "+Executive summary", prompt: `Please add or strengthen a high-level executive summary at the start of "${filename}".` },
      { label: "Add comparison table", prompt: `Please add a structured Markdown comparison table to "${filename}".` },
      { label: "Expand takeaways", prompt: `Please expand the key takeaways and actionable conclusions in "${filename}".` },
      { label: "Make concise", prompt: `Please polish "${filename}" for readability and make it more concise.` },
    ];
  }
  return [
    { label: "Add detail", prompt: `Please add more depth, detail, and evidence to "${filename}".` },
    { label: "Make concise", prompt: `Please make "${filename}" tighter and more concise.` },
    { label: "Format as table", prompt: `Please reorganize the key data in "${filename}" into a clean table.` },
    { label: "Fix issues", prompt: `Please review and fix any errors or formatting issues in "${filename}".` },
  ];
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
  width,
  isExpanded = false,
  onToggleExpand,
  onResizeStart,
  refreshToken,
  scope = "home",
}: {
  filePath: string;
  onClose: () => void;
  onDownload?: (path: string) => void;
  onRefine?: (instruction: string) => void;
  width?: number | string;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onResizeStart?: (e: React.PointerEvent) => void;
  refreshToken?: string;
  scope?: "home" | "code";
}) {
  const api = window.nexus;
  const fileName = filePath.split("/").pop() || filePath;
  const kind = kindFor(fileName);
  const formatInfo = getArtifactFormat(fileName);
  const isTextLike = kind === "markdown" || kind === "html" || kind === "text";
  const needsLibContainer = kind === "docx" || kind === "pptx";

  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [fileSize, setFileSize] = useState<number>(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<Array<{ name: string; html: string }>>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [refineInput, setRefineInput] = useState("");
  const [copied, setCopied] = useState(false);

  const libRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ destroy?: () => void } | null>(null);
  const urlsRef = useRef<string[]>([]);

  const loadFileContent = useCallback(async () => {
    let cancelled = false;
    const trackUrl = (url: string) => {
      urlsRef.current.push(url);
      return url;
    };
    try {
      setStatus("loading");
      let file: { name: string; path: string; size: number; base64: string };
      if (scope === "code" && typeof api?.readWorkspaceFileBase64 === "function") {
        try {
          file = await api.readWorkspaceFileBase64(filePath);
        } catch {
          file = await api.readHomeFile(filePath);
        }
      } else {
        try {
          file = await api.readHomeFile(filePath);
        } catch {
          if (typeof api?.readWorkspaceFileBase64 === "function") {
            file = await api.readWorkspaceFileBase64(filePath);
          } else {
            throw new Error(`Could not load ${filePath}`);
          }
        }
      }
      if (cancelled) return;
      setFileSize(file.size || 0);
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
          onSlideRendered: (_idx, slideEl) => fixPptxRenderedSlide(slideEl),
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
  }, [api, filePath, fileName, kind, scope]);

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

  const handleSendRefine = (promptOverride?: string) => {
    const q = (promptOverride || refineInput).trim();
    if (!q) return;
    onRefine?.(`Please edit and update the file "${fileName}":\n${q}`);
    setRefineInput("");
  };

  const handleDownload = () => {
    if (onDownload) {
      onDownload(filePath);
      return;
    }
    if (scope === "code" && typeof api?.downloadWorkspaceFile === "function") {
      api.downloadWorkspaceFile(filePath).catch(() => {});
    } else if (typeof api?.downloadHomeFile === "function") {
      api.downloadHomeFile(filePath).catch(() => {});
    }
  };

  const handleOpenExternal = async () => {
    try {
      const typed = api as unknown as {
        openHomeFile?: (p: string) => Promise<boolean>;
        openWorkspaceFileExternal?: (p: string) => Promise<boolean>;
        openHomeFolder?: () => Promise<void>;
      };
      if (scope === "code" && typeof typed?.openWorkspaceFileExternal === "function") {
        await typed.openWorkspaceFileExternal(filePath);
      } else if (typeof typed?.openHomeFile === "function") {
        await typed.openHomeFile(filePath);
      } else if (typeof typed?.openHomeFolder === "function") {
        await typed.openHomeFolder();
      }
    } catch {
      handleDownload();
    }
  };

  const handleCopyText = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* best effort */ }
  };

  const refinePills = getSmartRefinePills(kind, fileName);

  return (
    <aside
      className="home-canvas-drawer"
      style={{
        width: width ?? "100%",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-surface, #0b1118)",
        position: "relative",
        zIndex: 10,
        overflow: "hidden",
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

      {/* Canvas Clean Header */}
      <div className="canvas-header-bar">
        <div className="canvas-header-left">
          <div className="canvas-format-icon" style={{ backgroundColor: formatInfo.bg }}>
            {formatInfo.icon}
          </div>
          <div className="canvas-title-wrap">
            <span className="canvas-file-name" title={filePath}>
              {fileName}
            </span>
            <div className="canvas-meta-row">
              <span className={`canvas-format-pill ${formatInfo.badgeClass}`}>
                {formatInfo.label}
              </span>
              {fileSize > 0 && (
                <span className="canvas-file-size">{formatBytes(fileSize)}</span>
              )}
              {kind === "xlsx" && sheets.length > 0 && (
                <span className="canvas-meta-extra">{sheets.length} sheet{sheets.length > 1 ? "s" : ""}</span>
              )}
            </div>
          </div>
        </div>

        <div className="canvas-header-actions">
          {/* Text/Source toggle for text-based artifacts */}
          {isTextLike && (
            <div className="canvas-segmented-tabs">
              <button
                type="button"
                className={`canvas-seg-btn ${tab === "preview" ? "active" : ""}`}
                onClick={() => setTab("preview")}
                title="Preview artifact"
              >
                <Eye size={11} />
                <span>Preview</span>
              </button>
              <button
                type="button"
                className={`canvas-seg-btn ${tab === "source" ? "active" : ""}`}
                onClick={() => setTab("source")}
                title="View raw source"
              >
                <Code2 size={11} />
                <span>Code</span>
              </button>
            </div>
          )}

          {/* Copy content button for text-like formats */}
          {isTextLike && text && (
            <button
              type="button"
              className="canvas-action-btn"
              onClick={() => void handleCopyText()}
              title="Copy content to clipboard"
            >
              {copied ? <Check size={12} style={{ color: "#34d399" }} /> : <Copy size={12} />}
            </button>
          )}

          {/* Open with system desktop application */}
          <button
            type="button"
            className="canvas-action-btn"
            onClick={() => void handleOpenExternal()}
            title="Open in default desktop app (PowerPoint, Excel, Word...)"
          >
            <ExternalLink size={13} />
          </button>

          {/* Download file */}
          <button
            type="button"
            className="canvas-action-btn highlight-download"
            onClick={handleDownload}
            title="Download file to computer"
          >
            <Download size={13} />
          </button>

          {/* Wide view toggle */}
          {onToggleExpand && (
            <button
              type="button"
              className="canvas-action-btn"
              onClick={onToggleExpand}
              title={isExpanded ? "Collapse to standard width" : "Expand to wide view"}
            >
              {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          )}

          {/* Close preview */}
          <button
            type="button"
            className="canvas-action-btn canvas-close-btn"
            onClick={onClose}
            title="Close Canvas"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Spreadsheet Multiple Sheets Switcher */}
      {kind === "xlsx" && sheets.length > 1 && (
        <div className="file-preview-tabs">
          {sheets.map((sheet, idx) => (
            <button
              key={sheet.name}
              type="button"
              className={idx === activeSheet ? "active" : ""}
              onClick={() => setActiveSheet(idx)}
            >
              <FileSpreadsheet size={11} style={{ marginRight: 4 }} />
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* Canvas Main Body */}
      <div className="canvas-body-container">
        {needsLibContainer && <div ref={libRef} className="file-preview-lib" />}
        {status === "loading" && (
          <div className="canvas-state-center">
            <Loader2 size={18} className="spin" style={{ color: "#38bdf8" }} />
            <span>Loading {fileName}…</span>
          </div>
        )}
        {status === "error" && (
          <div className="canvas-state-center error">
            <TriangleAlert size={22} />
            <span className="error-title">Failed to load artifact</span>
            <span className="error-desc">{error}</span>
            <button type="button" className="canvas-retry-btn" onClick={() => void loadFileContent()}>
              Retry
            </button>
          </div>
        )}
        {status === "ready" && tab === "source" && (
          <pre className="canvas-source-pre">
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
                className="canvas-preview-frame"
              />
            )}
            {kind === "text" && (
              <pre className="canvas-text-pre">
                {text}
              </pre>
            )}
            {kind === "pdf" && blobUrl && (
              <iframe src={blobUrl} title={fileName} className="canvas-preview-frame pdf" />
            )}
            {kind === "image" && blobUrl && (
              <div className="canvas-image-wrap">
                <img src={blobUrl} alt={fileName} className="canvas-preview-img" />
              </div>
            )}
            {kind === "xlsx" && sheets[activeSheet] && (
              <div className="file-preview-sheet" dangerouslySetInnerHTML={{ __html: sheets[activeSheet].html }} />
            )}
            {kind === "unsupported" && (
              <div className="canvas-state-center">
                <FileText size={32} style={{ color: "var(--faint, #6b788a)" }} />
                <span>This file type is best viewed in its native application.</span>
                <button type="button" className="canvas-download-cta" onClick={() => void handleOpenExternal()}>
                  <ExternalLink size={13} /> Open with default app
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Docked "Ask Nexus to Refine" Bar */}
      <div className="canvas-refine-bar">
        <div className="canvas-refine-chips">
          {refinePills.map((pill) => (
            <button
              key={pill.label}
              type="button"
              className="canvas-refine-chip"
              onClick={() => handleSendRefine(pill.prompt)}
              title={pill.prompt}
            >
              <span>{pill.label}</span>
            </button>
          ))}
        </div>
        <div className="canvas-refine-input-row">
          <input
            type="text"
            className="canvas-refine-input"
            value={refineInput}
            onChange={(e) => setRefineInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendRefine();
              }
            }}
            placeholder="Ask Nexus to edit or refine this file…"
          />
          <button
            type="button"
            className="canvas-refine-submit"
            onClick={() => handleSendRefine()}
            disabled={!refineInput.trim()}
            title="Send edit request to agent"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </aside>
  );
}
