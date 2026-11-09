import React from "react";
import {
  FileText,
  FileSpreadsheet,
  Presentation,
  Image as ImageIcon,
  FileCode,
  Eye,
  Download,
} from "lucide-react";
import type { ArtifactItem } from "../../types.js";

export type ArtifactFormatInfo = {
  typeLabel: string;
  badgeClass: string;
  icon: React.ReactNode;
  accentColor: string;
  bgColor: string;
};

export function getArtifactFormatInfo(filename: string): ArtifactFormatInfo {
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";

  if (ext === "pdf") {
    return {
      typeLabel: "PDF",
      badgeClass: "badge-pdf",
      icon: <FileText size={15} style={{ color: "#ef4444" }} />,
      accentColor: "#ef4444",
      bgColor: "rgba(239, 68, 68, 0.14)",
    };
  }
  if (["pptx", "ppsx", "key"].includes(ext)) {
    return {
      typeLabel: "SLIDES",
      badgeClass: "badge-slides",
      icon: <Presentation size={15} style={{ color: "#f59e0b" }} />,
      accentColor: "#f59e0b",
      bgColor: "rgba(245, 158, 11, 0.14)",
    };
  }
  if (["xlsx", "xls", "csv"].includes(ext)) {
    return {
      typeLabel: "SHEET",
      badgeClass: "badge-sheet",
      icon: <FileSpreadsheet size={15} style={{ color: "#10b981" }} />,
      accentColor: "#10b981",
      bgColor: "rgba(16, 185, 129, 0.14)",
    };
  }
  if (["docx", "doc"].includes(ext)) {
    return {
      typeLabel: "DOCX",
      badgeClass: "badge-docx",
      icon: <FileText size={15} style={{ color: "#3b82f6" }} />,
      accentColor: "#3b82f6",
      bgColor: "rgba(59, 130, 246, 0.14)",
    };
  }
  if (["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) {
    return {
      typeLabel: "IMAGE",
      badgeClass: "badge-image",
      icon: <ImageIcon size={15} style={{ color: "#ec4899" }} />,
      accentColor: "#ec4899",
      bgColor: "rgba(236, 72, 153, 0.14)",
    };
  }
  return {
    typeLabel: ext ? ext.toUpperCase() : "ARTIFACT",
    badgeClass: "badge-doc",
    icon: <FileCode size={15} style={{ color: "#8b5cf6" }} />,
    accentColor: "#8b5cf6",
    bgColor: "rgba(139, 92, 246, 0.14)",
  };
}

export function ArtifactCard({
  artifact,
  metaText,
  onClick,
  onDownload,
}: {
  artifact: ArtifactItem;
  metaText?: string;
  onClick: () => void;
  onDownload?: (e: React.MouseEvent) => void;
}) {
  const displayName = artifact.filename || artifact.name || "artifact";
  const info = getArtifactFormatInfo(displayName);

  const handleDownloadClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDownload) {
      onDownload(e);
      return;
    }
    const api = window.nexus;
    const path = artifact.path || artifact.filename || displayName;
    if (typeof api?.downloadHomeFile === "function") {
      api.downloadHomeFile(path).catch(() => {});
    } else if (typeof api?.downloadWorkspaceFile === "function") {
      api.downloadWorkspaceFile(path).catch(() => {});
    }
  };

  return (
    <div
      className="chat-artifact-chip"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={`Click to preview ${displayName} in sidebar`}
    >
      <div className="chat-artifact-chip-icon" style={{ backgroundColor: info.bgColor }}>
        {info.icon}
      </div>

      <div className="chat-artifact-chip-body">
        <div className="chat-artifact-chip-title-row">
          <span className="chat-artifact-chip-title" title={displayName}>
            {displayName}
          </span>
          <span className={`chat-artifact-format-badge ${info.badgeClass}`}>
            {info.typeLabel}
          </span>
        </div>
        {metaText && (
          <div className="chat-artifact-chip-meta">
            {metaText}
          </div>
        )}
      </div>

      <div className="chat-artifact-chip-actions">
        <button
          type="button"
          className="chat-artifact-action-btn view-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title="Open in right sidebar"
        >
          <Eye size={12} />
          <span>Preview</span>
        </button>

        <button
          type="button"
          className="chat-artifact-action-btn download-btn"
          onClick={handleDownloadClick}
          title="Download file"
        >
          <Download size={12} />
        </button>
      </div>
    </div>
  );
}
