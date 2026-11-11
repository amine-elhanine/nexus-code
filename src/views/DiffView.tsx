import React, { useState, useMemo } from "react";
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  GitBranch,
} from "lucide-react";
import type { WorkspaceDiffFile, SplitDiffRow } from "../types.js";
import { fileIcon } from "../utils/format.js";

export interface GitDiffParsedLine {
  type: "context" | "added" | "deleted" | "hunk";
  lineNum?: number;
  sign: string;
  text: string;
}

export function parseUnifiedGitDiff(patch: string): GitDiffParsedLine[] {
  if (!patch) return [];
  const rawLines = patch.split(/\r?\n/);
  const parsed: GitDiffParsedLine[] = [];

  let curOldLine = 1;
  let curNewLine = 1;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // Skip git metadata header lines
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }

    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        curOldLine = Number(match[1]);
        curNewLine = Number(match[2]);
      }
      if (parsed.length > 0) {
        parsed.push({
          type: "hunk",
          sign: " ",
          text: line,
        });
      }
      continue;
    }

    if (line.startsWith("+")) {
      parsed.push({
        type: "added",
        lineNum: curNewLine++,
        sign: "+",
        text: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      parsed.push({
        type: "deleted",
        lineNum: curOldLine++,
        sign: "-",
        text: line.slice(1),
      });
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      parsed.push({
        type: "context",
        lineNum: curNewLine++,
        sign: " ",
        text: content,
      });
      curOldLine++;
    }
  }

  return parsed;
}

// Retain legacy parseDiffPatch export for compatibility
export function parseDiffPatch(patch: string): SplitDiffRow[] {
  return [];
}

export function DiffPatch({
  patch,
}: {
  patch: string;
  filePath?: string;
  viewMode?: "inline" | "split";
  onRevertHunk?: (filePath: string, hunkHeader: string) => void;
}) {
  const lines = parseUnifiedGitDiff(patch);
  if (!lines.length) {
    return <div className="git-diff-no-patch">No patch available for this file.</div>;
  }
  return (
    <div className="git-diff-code-panel">
      {lines.map((line, idx) => (
        <div key={idx} className={`git-diff-code-line ${line.type}`}>
          <span className="git-diff-line-num">
            {line.type === "hunk" ? "…" : (line.lineNum ?? "")}
          </span>
          <code className="git-diff-line-text">{line.text || " "}</code>
        </div>
      ))}
    </div>
  );
}

export function DiffView({
  diff,
  onRefresh,
}: {
  diff: WorkspaceDiffFile[];
  checkpointId?: string;
  undoing?: boolean;
  onUndoRun?: (checkpointId: string) => void;
  onRefresh: () => void;
  onRevertFile?: (path: string) => void;
  onRevertAll?: () => void;
  onInspectFile?: (file: WorkspaceDiffFile) => void;
  onRevertHunk?: (path: string, hunkHeader: string) => void;
}) {
  // All files start collapsed by default, exactly matching ZCode Image 1
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<string>("unstaged");

  const toggleFile = (filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (expandedFiles.size > 0) {
      setExpandedFiles(new Set());
    } else {
      setExpandedFiles(new Set(diff.map((f) => f.path)));
    }
  };

  const filteredDiff = useMemo(() => {
    if (scope === "staged") {
      const staged = diff.filter((f) => f.status && f.status !== "?" && f.status !== "U");
      return staged.length > 0 ? staged : diff;
    }
    return diff;
  }, [diff, scope]);

  return (
    <div className="git-diff-view" role="region" aria-label="Git Diff Review">
      {/* Top Scope and Action Toolbar matching ZCode Image 1 & 2 */}
      <div className="git-diff-toolbar">
        <div className="git-diff-scope-dropdown">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Diff scope"
            className="git-diff-scope-select"
          >
            <option value="unstaged">Unstaged</option>
            <option value="staged">Staged</option>
            <option value="all">All Changes</option>
          </select>
        </div>

        <div className="git-diff-toolbar-actions">
          {diff.length > 1 && (
            <button
              type="button"
              className="git-diff-action-btn"
              onClick={toggleAll}
              title={expandedFiles.size > 0 ? "Collapse all files" : "Expand all files"}
            >
              {expandedFiles.size > 0 ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              <span>{expandedFiles.size > 0 ? "Collapse all" : "Expand all"}</span>
            </button>
          )}

          <button
            type="button"
            className="git-diff-action-btn"
            onClick={onRefresh}
            title="Refresh Git Diff"
          >
            <RefreshCw size={12} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Changed Files List matching ZCode Image 1 & 2 */}
      <div className="git-diff-file-list">
        {filteredDiff.map((file) => {
          const isExpanded = expandedFiles.has(file.path);
          const fileName = file.name || (file.path ? file.path.split("/").pop() || file.path : "file");
          const dirDisplay = file.directory
            ? file.directory.endsWith("/")
              ? file.directory
              : `${file.directory}/`
            : file.path && file.path.includes("/")
            ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
            : "";

          return (
            <div
              key={file.path}
              className={`git-diff-file-item ${isExpanded ? "expanded" : ""}`}
            >
              {/* File Row Header */}
              <div
                className="git-diff-file-row"
                onClick={() => toggleFile(file.path)}
                title={`${file.path} (+${file.additions} -${file.deletions})`}
              >
                <div className="git-diff-file-left">
                  <span className="git-diff-file-icon">{fileIcon(fileName)}</span>
                  <span className="git-diff-file-name">{fileName}</span>
                  {dirDisplay && <span className="git-diff-file-dir">{dirDisplay}</span>}
                </div>
                <div className="git-diff-file-right">
                  <span className="git-diff-stat-add">+{file.additions}</span>
                  <span className="git-diff-stat-del">−{file.deletions}</span>
                  <span className="git-diff-chevron">
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                </div>
              </div>

              {/* Inline Code Diff Panel matching Image 2 */}
              {isExpanded && (
                <DiffPatch patch={file.patch} />
              )}
            </div>
          );
        })}

        {!diff.length && (
          <div className="git-diff-empty">
            <GitBranch size={18} style={{ color: "#6b7280" }} />
            <span>The working tree is clean.</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default DiffView;
