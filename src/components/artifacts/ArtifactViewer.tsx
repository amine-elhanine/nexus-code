import React, { useState } from "react";
import { renderMarkdown } from "../../markdown.js";
import { CheckCircle2, FileCode2, Play, Sparkles, X, RotateCcw, Eye, FileText } from "lucide-react";

export type ArtifactStatus = "draft" | "pending_approval" | "approved" | "completed" | "rejected";

export interface ArtifactItem {
  id: string;
  sessionId: string;
  name: string;
  filename: string;
  path: string;
  content: string;
  status: ArtifactStatus;
  userFacing: boolean;
  requestFeedback: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactViewerProps {
  artifact: ArtifactItem;
  onClose: () => void;
  onApproveAndExecute?: (planContent: string) => void;
  onStatusChange?: (filename: string, status: ArtifactStatus) => void;
}

export const ArtifactViewer: React.FC<ArtifactViewerProps> = ({
  artifact,
  onClose,
  onApproveAndExecute,
  onStatusChange,
}) => {
  const [activeTab, setActiveTab] = useState<"preview" | "raw">("preview");
  const isPlan = artifact.filename === "implementation_plan.md";
  const isPending = artifact.status === "pending_approval";

  return (
    <div className="modal-layer" onClick={onClose}>
      <div className="modal-card artifact-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-card-head" style={{ padding: "14px 20px", marginBottom: 0, borderBottom: "1px solid #1c2635", background: "#131922" }}>
          <div className="daemons-title-row">
            {isPlan ? (
              <FileText size={18} className="text-amber-400" />
            ) : (
              <Sparkles size={18} className="text-purple-400" />
            )}
            <h2 style={{ margin: 0, fontSize: "16px", color: "#f1f5f9" }}>{artifact.name}</h2>
            <span className={`badge-status status-${artifact.status}`}>
              {artifact.status.replace("_", " ")}
            </span>
          </div>
          <div className="daemons-head-actions">
            <div className="tab-group-mini">
              <button
                type="button"
                className={`tab-mini ${activeTab === "preview" ? "active" : ""}`}
                onClick={() => setActiveTab("preview")}
              >
                <Eye size={12} /> Preview
              </button>
              <button
                type="button"
                className={`tab-mini ${activeTab === "raw" ? "active" : ""}`}
                onClick={() => setActiveTab("raw")}
              >
                <FileCode2 size={12} /> Markdown
              </button>
            </div>
            <button type="button" className="icon-plain" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="artifact-body-content">
          {activeTab === "preview" ? (
            <div
              className="chat-message-text md artifact-rendered"
              style={{ padding: 0 }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(artifact.content) }}
            />
          ) : (
            <pre className="artifact-raw">{artifact.content}</pre>
          )}
        </div>

        {/* Footer */}
        <div className="modal-card-foot artifact-footer-bar">
          <div className="artifact-meta-text">
            <span>File: <code>.forgepilot/artifacts/{artifact.filename}</code></span>
            <span>• Updated: {new Date(artifact.updatedAt).toLocaleTimeString()}</span>
          </div>

          <div className="artifact-button-group">
            {isPlan && isPending && onApproveAndExecute && (
              <>
                <button
                  type="button"
                  className="secondary danger-btn"
                  onClick={() => {
                    onStatusChange?.(artifact.filename, "rejected");
                    onClose();
                  }}
                >
                  <RotateCcw size={13} /> Request Changes
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    onStatusChange?.(artifact.filename, "approved");
                    onApproveAndExecute(artifact.content);
                    onClose();
                  }}
                >
                  <Play size={13} fill="currentColor" /> Approve & Execute
                </button>
              </>
            )}
            {(!isPlan || !isPending) && (
              <button type="button" className="secondary" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
