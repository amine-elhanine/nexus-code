import React, { useState, type ReactNode } from "react";
import { RotateCcw, RefreshCw, ChevronDown, ChevronRight, Columns, AlignJustify, GitBranch, Undo2 } from "lucide-react";
import type { WorkspaceDiffFile, SplitDiffRow, DiffSide } from "../types.js";
import { fileIcon } from "../utils/format.js";

export function parseDiffPatch(patch: string): SplitDiffRow[] {
  let oldLine = 0;
  let newLine = 0;
  const rows: SplitDiffRow[] = [];
  let deleted: DiffSide[] = [];
  let added: DiffSide[] = [];

  const flushChanges = () => {
    const count = Math.max(deleted.length, added.length);
    for (let index = 0; index < count; index++) {
      const old = deleted[index];
      const next = added[index];
      rows.push({
        kind: old && next ? "change" : old ? "deleted" : "added",
        old,
        new: next,
      });
    }
    deleted = [];
    added = [];
  };

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flushChanges();
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (
      !line ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("\\\\ No newline")
    )
      continue;

    if (line.startsWith("+")) {
      added.push({ number: newLine++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-")) {
      deleted.push({ number: oldLine++, text: line.slice(1) });
      continue;
    }
    flushChanges();
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      kind: "context",
      old: { number: oldLine++, text },
      new: { number: newLine++, text },
    });
  }
  flushChanges();
  return rows;
}

export function DiffLineView({
  side,
  kind,
}: {
  side?: DiffSide;
  kind: "context" | "added" | "deleted";
}) {
  return (
    <div className={`diff-line-view ${kind}`}>
      <span className="diff-line-number">{side?.number ?? ""}</span>
      <span className="diff-line-bar" />
      <code>{side?.text || "\u00a0"}</code>
    </div>
  );
}

export function DiffPatch({
  patch,
  filePath,
  viewMode = "inline",
  onRevertHunk,
}: {
  patch: string;
  filePath?: string;
  viewMode?: "inline" | "split";
  onRevertHunk?: (filePath: string, hunkHeader: string) => void;
}) {
  const rows = parseDiffPatch(patch);
  if (!rows.length) {
    return (
      <div className="diff-code-panel">
        <div className="diff-code-empty">No patch available for this file.</div>
      </div>
    );
  }

  if (viewMode === "split") {
    return (
      <div className="diff-code-panel diff-split-container">
        {rows.map((row, index) => {
          if (row.kind === "hunk") {
            const header = row.text || null;
            return (
              <div className="diff-split-hunk-bar" key={`${index}-hunk`}>
                <span>{row.text}</span>
                {filePath && header && onRevertHunk && (
                  <button
                    className="diff-hunk-discard"
                    onClick={() => onRevertHunk(filePath, header)}
                    title="Discard only this hunk, keep the rest of the file"
                  >
                    Discard hunk
                  </button>
                )}
              </div>
            );
          }
          const hasOld = Boolean(row.old);
          const hasNew = Boolean(row.new);
          const oldClass = row.kind === "deleted" || row.kind === "change" ? "is-del" : "";
          const newClass = row.kind === "added" || row.kind === "change" ? "is-add" : "";

          return (
            <div className="diff-split-row" key={`${index}-split`}>
              <span className="diff-split-ln">{row.old?.number ?? ""}</span>
              <code className={`diff-split-code side-old ${hasOld ? oldClass : "is-empty"}`}>
                {row.old ? row.old.text || "\u00a0" : "\u00a0"}
              </code>
              <span className="diff-split-ln">{row.new?.number ?? ""}</span>
              <code className={`diff-split-code side-new ${hasNew ? newClass : "is-empty"}`}>
                {row.new ? row.new.text || "\u00a0" : "\u00a0"}
              </code>
            </div>
          );
        })}
      </div>
    );
  }

  const rendered: ReactNode[] = [];
  let currentHunk: string | null = null;
  rows.forEach((row, index) => {
    if (row.kind === "hunk") {
      currentHunk = row.text || null;
      const header = currentHunk;
      rendered.push(
        <div className="diff-hunk-row" key={`${index}-hunk`}>
          <span>{row.text}</span>
          {filePath && header && onRevertHunk && (
            <button
              className="diff-hunk-discard"
              onClick={() => onRevertHunk(filePath, header)}
              title="Discard only this hunk, keep the rest of the file"
            >
              Discard hunk
            </button>
          )}
        </div>,
      );
    } else if (row.kind === "context") {
      rendered.push(<DiffLineView key={`${index}-context`} side={row.new} kind="context" />);
    } else {
      if (row.old) rendered.push(<DiffLineView key={`${index}-old`} side={row.old} kind="deleted" />);
      if (row.new) rendered.push(<DiffLineView key={`${index}-new`} side={row.new} kind="added" />);
    }
  });
  return <div className="diff-code-panel">{rendered}</div>;
}

export function DiffView({
  diff,
  checkpointId,
  undoing,
  onUndoRun,
  onRefresh,
  onRevertFile,
  onRevertAll,
  onInspectFile,
  onRevertHunk,
}: {
  diff: WorkspaceDiffFile[];
  checkpointId?: string;
  undoing?: boolean;
  onUndoRun?: (checkpointId: string) => void;
  onRefresh: () => void;
  onRevertFile: (path: string) => void;
  onRevertAll: () => void;
  onInspectFile?: (file: WorkspaceDiffFile) => void;
  onRevertHunk?: (path: string, hunkHeader: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"inline" | "split">("inline");

  const toggle = (file: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(file) ? next.delete(file) : next.add(file);
      return next;
    });

  const additions = diff.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="artifact-view diff-artifact-view">
      <div className="artifact-head">
        <div>
          <span className="view-kicker">REVIEW ARTIFACT</span>
          <h2>Changed files</h2>
          <p>
            {diff.length
              ? `${diff.length} changed file${diff.length === 1 ? "" : "s"} in the active project`
              : "No changes in the active project"}
          </p>
        </div>
        <div className="diff-head-actions">
          <div className="diff-mode-toggle" role="group" aria-label="Diff display mode">
            <button
              type="button"
              className={viewMode === "inline" ? "active" : ""}
              onClick={() => setViewMode("inline")}
              title="Unified inline diff view"
            >
              <AlignJustify size={11} />
              <span>Inline</span>
            </button>
            <button
              type="button"
              className={viewMode === "split" ? "active" : ""}
              onClick={() => setViewMode("split")}
              title="Side-by-side split diff view"
            >
              <Columns size={11} />
              <span>Split</span>
            </button>
          </div>
          <select className="diff-scope-select" value="unstaged" aria-label="Diff scope">
            <option value="unstaged">Unstaged</option>
          </select>
          <span className="diff-total-add">+{additions}</span>
          <span className="diff-total-del">−{deletions}</span>
          {checkpointId && onUndoRun && (
            <button
              className="secondary"
              disabled={Boolean(undoing)}
              onClick={() => onUndoRun(checkpointId)}
              title="Undo latest run — restore pre-run files and roll back Nexus-only session commits"
            >
              <Undo2 size={13} /> {undoing ? "Undoing…" : "Undo"}
            </button>
          )}
          {diff.length > 0 && (
            <button className="secondary danger-btn" onClick={onRevertAll} title="Discard all workspace changes">
              <RotateCcw size={13} /> Discard all
            </button>
          )}
          <button className="secondary" onClick={onRefresh}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>
      <div className="diff-file-list">
        {diff.map((file) => (
          <div className="diff-file" key={file.path}>
            <button className="diff-file-row" onClick={() => toggle(file.path)}>
              <span className="diff-file-icon">{fileIcon(file.name)}</span>
              <span className="diff-file-name">{file.name}</span>
              <span className="diff-file-directory">{file.directory}</span>
              <span className="diff-file-stats">
                <b>+{file.additions}</b>
                <em>−{file.deletions}</em>
              </span>
              {onInspectFile && (
                <i
                  className="diff-revert-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    onInspectFile(file);
                  }}
                  title="Inspect in Monaco Side-by-Side Diff"
                >
                  <Columns size={12} />
                </i>
              )}
              <i
                className="diff-revert-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onRevertFile(file.path);
                }}
                title="Discard changes in this file"
              >
                <RotateCcw size={12} />
              </i>
              {expanded.has(file.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expanded.has(file.path) && (
              <DiffPatch patch={file.patch} filePath={file.path} viewMode={viewMode} onRevertHunk={onRevertHunk} />
            )}
          </div>
        ))}
        {!diff.length && (
          <div className="diff-empty">
            <GitBranch size={18} />
            <span>The working tree is clean.</span>
          </div>
        )}
      </div>
    </div>
  );
}
