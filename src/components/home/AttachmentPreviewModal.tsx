import React, { useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, TriangleAlert, X } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";
import { attachmentKind, formatAttachmentSize, loadAttachmentBytes } from "../../utils/attachments.js";
import type { ChatAttachment } from "../../types.js";

export function AttachmentPreviewModal({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  const kind = attachmentKind(attachment.name);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<Array<{ name: string; html: string }>>([]);
  const [activeSheet, setActiveSheet] = useState(0);
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
        // Images render straight from the attachment URL (custom protocol +
        // data URLs both work in <img>); everything else needs raw bytes.
        if (kind === "image") {
          if (!cancelled) setStatus("ready");
          return;
        }
        const { buffer, mimeType } = await loadAttachmentBytes(attachment);
        if (cancelled) return;
        const bytes = new Uint8Array(buffer);
        if (kind === "markdown" || kind === "text") {
          if (bytes.length > 2 * 1024 * 1024) throw new Error("File is too large to display. Download it instead.");
          setText(new TextDecoder().decode(bytes));
        } else if (kind === "pdf") {
          const blob = new Blob([buffer], { type: "application/pdf" });
          setBlobUrl(trackUrl(URL.createObjectURL(blob)));
        } else if (kind === "docx") {
          const { renderAsync } = await import("docx-preview");
          if (cancelled || !libRef.current) return;
          libRef.current.innerHTML = "";
          try {
            await renderAsync(buffer, libRef.current);
          } catch {
            // Legacy .doc (OLE container, not OOXML) can't render in-app.
            throw new Error("This Word file can't be previewed in-app (legacy .doc?). Download to open it.");
          }
        } else if (kind === "xlsx") {
          const XLSX = await import("xlsx");
          if (cancelled) return;
          const ext = attachment.name.split(".").pop()?.toLowerCase();
          const workbook =
            ext === "csv" || ext === "tsv"
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
          try {
            const viewer = await PptxViewer.open(buffer, libRef.current, {
              zipLimits: RECOMMENDED_ZIP_LIMITS,
              listOptions: { windowed: true },
            });
            viewerRef.current = viewer as { destroy?: () => void };
          } catch {
            throw new Error("This presentation can't be previewed in-app (legacy .ppt?). Download to open it.");
          }
        } else {
          // Unsupported binary: offer download; try text as last resort.
          void mimeType;
          throw new Error("No in-app preview for this file type.");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.url]);

  const needsLibContainer = (kind === "docx" || kind === "pptx") && status !== "error";
  const downloadHref = attachment.url.startsWith("data:") ? attachment.url : attachment.url;

  return (
    <div className="modal-layer attachment-preview-layer" onClick={onClose}>
      <div className="modal-card file-preview-card" onClick={(event) => event.stopPropagation()}>
        <div className="file-preview-head">
          <FileText size={15} />
          <div className="file-preview-title">
            <strong>{attachment.name}</strong>
            <small>
              {formatAttachmentSize(attachment.size)}{attachment.mimeType ? ` · ${attachment.mimeType}` : ""}
            </small>
          </div>
          <a className="top-link" href={downloadHref} download={attachment.name}>
            <Download size={13} /> Download
          </a>
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
              <a className="top-link" href={downloadHref} download={attachment.name}>
                <Download size={13} /> Download instead
              </a>
            </div>
          )}
          {status === "ready" && kind === "image" && (
            <div className="attachment-preview-body">
              <img src={attachment.url} alt={attachment.name} />
            </div>
          )}
          {status === "ready" && kind === "markdown" && (
            <div className="md file-preview-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          )}
          {status === "ready" && kind === "text" && (
            <pre className="file-preview-text">{text}</pre>
          )}
          {status === "ready" && kind === "pdf" && blobUrl && (
            <iframe src={blobUrl} title={attachment.name} className="file-preview-frame" />
          )}
          {status === "ready" && kind === "xlsx" && sheets[activeSheet] && (
            <div className="file-preview-sheet" dangerouslySetInnerHTML={{ __html: sheets[activeSheet].html }} />
          )}
          {status === "ready" && kind === "unsupported" && (
            <div className="file-preview-center">
              <FileText size={18} />
              <span>No in-app preview for this file type.</span>
              <a className="top-link" href={downloadHref} download={attachment.name}>
                <Download size={13} /> Download to open it
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
