import React from "react";
import { BookOpen, FileCode, CheckCircle2, X } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";

interface ProjectRuleFile {
  filename: string;
  relativePath: string;
  content: string;
  source: string;
}

interface ProjectRulesModalProps {
  ruleFiles: ProjectRuleFile[];
  onClose: () => void;
}

export const ProjectRulesModal: React.FC<ProjectRulesModalProps> = ({ ruleFiles, onClose }) => {
  const [selectedFile, setSelectedFile] = React.useState<ProjectRuleFile | null>(ruleFiles[0] || null);

  return (
    <div className="modal-layer" onClick={onClose}>
      <div className="modal-card rules-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card-head" style={{ marginBottom: "12px" }}>
          <div>
            <div className="daemons-title-row">
              <BookOpen size={18} className="text-purple-400" />
              <h2 style={{ margin: 0, fontSize: "17px" }}>Project Rules & Guidelines</h2>
              <span className="daemons-count-badge running">
                {ruleFiles.length} file{ruleFiles.length === 1 ? "" : "s"} active
              </span>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#8a96a8" }}>
              Discovered from <code>.cursorrules</code>, <code>AGENT.md</code>, <code>CLAUDE.md</code>, or <code>.forgepilot/rules/</code> and automatically injected into system prompt.
            </p>
          </div>
          <button className="icon-plain" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="rules-modal-body">
          <div className="rules-sidebar">
            {ruleFiles.map((rf) => (
              <button
                key={rf.relativePath}
                className={`rules-nav-item ${selectedFile?.relativePath === rf.relativePath ? "active" : ""}`}
                onClick={() => setSelectedFile(rf)}
              >
                <FileCode size={14} />
                <div className="rules-nav-text">
                  <strong>{rf.filename}</strong>
                  <small>{rf.relativePath}</small>
                </div>
              </button>
            ))}
          </div>

          <div className="rules-content-area">
            {selectedFile ? (
              <div className="rules-markdown md" dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedFile.content) }} />
            ) : (
              <div className="monaco-empty-state">
                <p>Select a rule file on the left to view instructions.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
