import React from "react";
import { GitBranch, FileCode2, Terminal, Puzzle, ChevronRight, MoreHorizontal } from "lucide-react";

export interface CodeOverviewCardProps {
  diffTotals: { add: number; del: number };
  tasksCount: number;
  goalsCount: number;
  onOpenDiff: () => void;
  onOpenEditor: () => void;
  onOpenTerminal: () => void;
  onOpenExtensions: () => void;
  onOpenInspector: (section?: "tasks" | "goals") => void;
}

export const CodeOverviewCard: React.FC<CodeOverviewCardProps> = ({
  diffTotals,
  tasksCount,
  goalsCount,
  onOpenDiff,
  onOpenEditor,
  onOpenTerminal,
  onOpenExtensions,
  onOpenInspector,
}) => {
  return (
    <div className="code-overview-card" role="region" aria-label="Workbench Overview">
      <div className="code-overview-header">
        <span className="code-overview-title">Overview</span>
        <button
          type="button"
          className="code-overview-menu-btn"
          onClick={() => onOpenInspector()}
          title="Open Inspector Sidebar"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      <div className="code-overview-section">
        {/* Review row */}
        <button
          type="button"
          className="code-overview-row"
          onClick={onOpenDiff}
          title="Review code diff"
        >
          <div className="code-overview-row-left">
            <GitBranch size={13} className="code-overview-icon" />
            <span>Review</span>
          </div>
          <div className="code-overview-diff-badge">
            <span className="diff-add">+{diffTotals.add}</span>
            <span className="diff-del">-{diffTotals.del}</span>
          </div>
        </button>

        {/* Files row */}
        <button
          type="button"
          className="code-overview-row"
          onClick={onOpenEditor}
          title="Open Files & Editor"
        >
          <div className="code-overview-row-left">
            <FileCode2 size={13} className="code-overview-icon" />
            <span>Files</span>
          </div>
        </button>

        {/* Terminal row */}
        <button
          type="button"
          className="code-overview-row"
          onClick={onOpenTerminal}
          title="Open Terminal"
        >
          <div className="code-overview-row-left">
            <Terminal size={13} className="code-overview-icon" />
            <span>Terminal</span>
          </div>
        </button>

        {/* Extensions row */}
        <button
          type="button"
          className="code-overview-row"
          onClick={onOpenExtensions}
          title="Browse Extensions & Skills"
        >
          <div className="code-overview-row-left">
            <Puzzle size={13} className="code-overview-icon" />
            <span>Extensions</span>
          </div>
          <ChevronRight size={13} className="code-overview-chevron" />
        </button>
      </div>

      <div className="code-overview-divider" />

      {/* Background Tasks summary row */}
      <button
        type="button"
        className="code-overview-row code-overview-summary-row"
        onClick={() => onOpenInspector("tasks")}
        title="View Background Tasks"
      >
        <div className="code-overview-row-left">
          <span>Background Tasks</span>
        </div>
        <span className="code-overview-count">{tasksCount}</span>
      </button>

      <div className="code-overview-divider" />

      {/* Goals summary row */}
      <button
        type="button"
        className="code-overview-row code-overview-summary-row"
        onClick={() => onOpenInspector("goals")}
        title="View Goals"
      >
        <div className="code-overview-row-left">
          <span>Goals</span>
        </div>
        <span className="code-overview-count">{goalsCount}</span>
      </button>
    </div>
  );
};
