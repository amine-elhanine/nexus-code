import React, { useState } from "react";
import { Download, Maximize2, FileText, Presentation, Table2, File as FileIcon, FileType } from "lucide-react";

const FORMAT_ICONS: Record<string, React.ReactNode> = {
  docx: <FileText size={15} />,
  pptx: <Presentation size={15} />,
  xlsx: <Table2 size={15} />,
  pdf: <FileType size={15} />,
  tex: <FileType size={15} />,
  csv: <Table2 size={15} />,
  md: <FileText size={15} />,
};

const FORMAT_LABELS: Record<string, string> = {
  docx: "DOCX", pptx: "PPTX", xlsx: "XLSX", pdf: "PDF", tex: "TEX", csv: "CSV", md: "MD",
};

export function HomeDeliverableCard({
  fileName,
  onOpenCanvas,
  onDownload,
}: {
  fileName: string;
  onOpenCanvas?: (filePath: string) => void;
  onDownload?: (filePath: string) => void;
}) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const [saved, setSaved] = useState(false);

  const download = async () => {
    if (!onDownload) return;
    await onDownload(fileName);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="home-deliverable-card">
      <span className={`deliverable-icon ${ext}`}>
        {FORMAT_ICONS[ext] || <FileIcon size={15} />}
      </span>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span className="deliverable-name">{fileName}</span>
        <span className="deliverable-size">{FORMAT_LABELS[ext] || ext.toUpperCase()} · workspace file</span>
      </div>
      <div className="deliverable-actions">
        {onOpenCanvas && (
          <button type="button" onClick={() => onOpenCanvas(fileName)} title="Open in Canvas (split view)">
            <Maximize2 size={11} />
            <span>Canvas</span>
          </button>
        )}
        {onDownload && (
          <button type="button" onClick={() => void download()} title="Download file">
            <Download size={11} />
            <span>{saved ? "✓" : "Save"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
