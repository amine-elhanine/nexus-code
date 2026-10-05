import React, { useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { GitBranch, X, Columns, Rows, RotateCcw, Check, WrapText, Map, FileCode } from "lucide-react";
import "../../utils/monaco-setup.js";

interface MonacoDiffModalProps {
  fileName: string;
  filePath: string;
  patch: string;
  additions: number;
  deletions: number;
  onClose: () => void;
  onRevertFile?: (filePath: string) => void;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
      return "javascript";
    case "json":
      return "json";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "html":
      return "html";
    case "css":
      return "css";
    case "md":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function parseOriginalAndModified(patch: string, currentContent: string): { original: string; modified: string } {
  if (!patch) return { original: currentContent, modified: currentContent };

  const lines = patch.split("\n");
  const origLines: string[] = [];
  const modLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) continue;
    if (line.startsWith("-")) {
      origLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      origLines.push(line.slice(1));
      modLines.push(line.slice(1));
    }
  }

  const original = origLines.length ? origLines.join("\n") : currentContent;
  const modified = modLines.length ? modLines.join("\n") : currentContent;

  return { original, modified };
}

export const MonacoDiffModal: React.FC<MonacoDiffModalProps> = ({
  fileName,
  filePath,
  patch,
  additions,
  deletions,
  onClose,
  onRevertFile,
}) => {
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [originalCode, setOriginalCode] = useState("");
  const [modifiedCode, setModifiedCode] = useState("");
  const [loading, setLoading] = useState(true);

  const language = detectLanguage(filePath);

  useEffect(() => {
    let active = true;
    async function loadCurrent() {
      try {
        const api = window.nexus || window.forgepilot;
        const [fileData, headContent] = await Promise.all([
          api.readFile(filePath).catch(() => ({ content: "" })),
          api.readHead ? api.readHead(filePath).catch(() => "") : Promise.resolve(""),
        ]);
        if (active) {
          if (headContent) {
            setOriginalCode(headContent);
            setModifiedCode(fileData.content || "");
          } else {
            const { original, modified } = parseOriginalAndModified(patch, fileData.content || "");
            setOriginalCode(original);
            setModifiedCode(modified);
          }
          setLoading(false);
        }
      } catch {
        if (active) {
          setOriginalCode("");
          setModifiedCode("");
          setLoading(false);
        }
      }
    }
    void loadCurrent();
    return () => {
      active = false;
    };
  }, [filePath, patch]);

  return (
    <div className="modal-layer" onClick={onClose}>
      <div
        className="modal-card monaco-diff-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-card-head monaco-diff-card-head">
          <div className="daemons-title-row">
            <GitBranch size={16} className="text-purple-400" />
            <h3 style={{ margin: 0, fontSize: "15px" }}>{fileName}</h3>
            <span className="diff-stats-pill">
              <b className="text-emerald-400">+{additions}</b> / <em className="text-rose-400">−{deletions}</em>
            </span>
            <span className="monaco-lang-badge">{language}</span>
          </div>

          <div className="monaco-diff-controls">
            <button
              className={`monaco-tool-btn ${renderSideBySide ? "active" : ""}`}
              onClick={() => setRenderSideBySide(true)}
              title="Side-by-side Diff"
            >
              <Columns size={14} />
              <span>Side-by-Side</span>
            </button>
            <button
              className={`monaco-tool-btn ${!renderSideBySide ? "active" : ""}`}
              onClick={() => setRenderSideBySide(false)}
              title="Inline Diff"
            >
              <Rows size={14} />
              <span>Inline</span>
            </button>
            <button
              className={`monaco-tool-btn ${wordWrap === "on" ? "active" : ""}`}
              onClick={() => setWordWrap((w) => (w === "on" ? "off" : "on"))}
              title="Toggle Word Wrap"
            >
              <WrapText size={14} />
            </button>

            {onRevertFile && (
              <button
                className="secondary danger-btn"
                onClick={() => {
                  onRevertFile(filePath);
                  onClose();
                }}
                title="Discard changes in this file"
              >
                <RotateCcw size={12} />
                <span>Revert file</span>
              </button>
            )}

            <button className="icon-plain" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Monaco Diff Viewer */}
        <div className="monaco-diff-body-pane">
          {!loading ? (
            <DiffEditor
              height="100%"
              original={originalCode}
              modified={modifiedCode}
              language={language}
              theme="vs-dark"
              options={{
                renderSideBySide,
                wordWrap,
                readOnly: true,
                smoothScrolling: true,
                fontFamily: "'JetBrains Mono', 'DM Mono', Consolas, monospace",
                fontSize: 13,
                lineHeight: 20,
                renderLineHighlight: "all",
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          ) : (
            <div className="monaco-empty-state">
              <FileCode size={28} className="spin text-purple-400" />
              <span>Loading visual diff...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
