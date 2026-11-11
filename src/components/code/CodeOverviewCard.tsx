import React, { useState, useEffect, useRef } from "react";
import {
  GitBranch,
  GitCommit,
  ChevronDown,
  MoreHorizontal,
  Maximize2,
  CheckCircle2,
  Circle,
  Loader2,
} from "lucide-react";

export interface CodeOverviewCardProps {
  diffTotals: { add: number; del: number };
  gitBranch?: string | null;
  tasksCount?: number;
  goalsCount?: number;
  planItems?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  onOpenDiff: () => void;
  onOpenEditor?: () => void;
  onOpenTerminal?: () => void;
  onOpenExtensions?: () => void;
  onOpenInspector?: (section?: "tasks" | "goals") => void;
}

export const FileDiffIcon: React.FC<{ size?: number; className?: string; style?: React.CSSProperties }> = ({
  size = 14,
  className,
  style,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
  >
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="12" x2="13" y2="12" />
    <line x1="11" y1="10" x2="11" y2="14" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

export const CodeOverviewCard: React.FC<CodeOverviewCardProps> = ({
  diffTotals,
  gitBranch = "main",
  planItems,
  onOpenDiff,
  onOpenInspector,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on clicks outside
  useEffect(() => {
    if (!isExpanded) return;
    const handleOutsideClick = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (wrapperRef.current && !wrapperRef.current.contains(target)) {
        setIsExpanded(false);
      }
    };
    window.addEventListener("pointerdown", handleOutsideClick);
    return () => window.removeEventListener("pointerdown", handleOutsideClick);
  }, [isExpanded]);

  const defaultItems = [
    { text: "Code sidebar: Task list header + search, relative times, Show more", status: "completed" as const },
    { text: "Code composer: ZCode layout (model right, quick links row, shorter placeholder)", status: "completed" as const },
    { text: "Typecheck + build verify", status: "completed" as const },
  ];

  const itemsToDisplay = planItems && planItems.length > 0
    ? planItems.map((p) => ({ text: p.content, status: p.status }))
    : defaultItems;

  const completedCount = itemsToDisplay.filter((i) => i.status === "completed").length;
  const totalCount = itemsToDisplay.length;

  return (
    <div className="code-overview-wrapper" ref={wrapperRef}>
      {/* Changes pill in the top header */}
      <button
        type="button"
        className={`code-overview-pill ${isExpanded ? "active" : ""}`}
        onClick={() => setIsExpanded((prev) => !prev)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        title="Git tools & changes"
      >
        {isHovered ? (
          <Maximize2 size={13} className="code-overview-icon code-overview-icon-hover" />
        ) : (
          <FileDiffIcon size={14} className="code-overview-icon code-overview-icon-normal" />
        )}
        <span className="code-overview-pill-label">Changes</span>
        <span className="code-overview-pill-stats">
          <span className="diff-add">+{diffTotals.add}</span>
          <span className="diff-del">-{diffTotals.del}</span>
        </span>
      </button>

      {/* Expanded Git tools popover card */}
      {isExpanded && (
        <div className="git-tools-card" role="dialog" aria-label="Git tools">
          {/* Header */}
          <div className="git-tools-header">
            <span className="git-tools-title">Git tools</span>
            <div className="git-tools-actions">
              <button
                type="button"
                className="git-tools-action-btn"
                onClick={() => {
                  setIsExpanded(false);
                  onOpenInspector?.();
                }}
                title="Inspector / More options"
              >
                <MoreHorizontal size={14} />
              </button>
              <button
                type="button"
                className="git-tools-action-btn"
                onClick={() => {
                  setIsExpanded(false);
                  onOpenDiff();
                }}
                title="Expand Review Diff in sidebar"
              >
                <Maximize2 size={13} />
              </button>
            </div>
          </div>

          {/* Changes Row */}
          <div
            role="button"
            tabIndex={0}
            className="git-tools-row git-tools-changes-row"
            onClick={() => {
              setIsExpanded(false);
              onOpenDiff();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                setIsExpanded(false);
                onOpenDiff();
              }
            }}
            title="Review code changes"
          >
            <div className="git-tools-row-left">
              <FileDiffIcon size={14} style={{ color: "#9ca3af" }} />
              <span className="git-tools-row-text">Changes</span>
            </div>
            <div className="git-tools-row-right">
              <span className="diff-add">+{diffTotals.add}</span>
              <span className="diff-del">-{diffTotals.del}</span>
            </div>
          </div>

          {/* Git Branch Row */}
          <div className="git-tools-row git-tools-branch-row">
            <div className="git-tools-row-left">
              <GitBranch size={13} style={{ color: "#9ca3af" }} />
              <span className="git-tools-branch-name" title={gitBranch || "main"}>
                {gitBranch || "main"}
              </span>
            </div>
            <ChevronDown size={12} className="git-tools-chevron" />
          </div>

          {/* Commit or push Row */}
          <div
            role="button"
            tabIndex={0}
            className="git-tools-row git-tools-commit-row"
            onClick={() => {
              setIsExpanded(false);
              onOpenDiff();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                setIsExpanded(false);
                onOpenDiff();
              }
            }}
            title="Commit or push changes"
          >
            <div className="git-tools-row-left">
              <GitCommit size={13} style={{ color: "#9ca3af" }} />
              <span className="git-tools-row-text">Commit or push</span>
            </div>
          </div>

          <div className="git-tools-divider" />

          {/* Progress Section */}
          <div className="git-tools-progress-header">
            <span className="git-tools-progress-label">Progress</span>
            <span className="git-tools-progress-stat">
              {completedCount}/{totalCount}
            </span>
          </div>

          <div className="git-tools-progress-list">
            {itemsToDisplay.map((item, idx) => {
              const isDone = item.status === "completed";
              const isInProgress = item.status === "in_progress";
              return (
                <div key={idx} className="git-tools-progress-item">
                  {isDone ? (
                    <CheckCircle2 size={14} className="git-tools-check-icon completed" />
                  ) : isInProgress ? (
                    <Loader2 size={14} className="git-tools-check-icon in-progress animate-spin" />
                  ) : (
                    <Circle size={14} className="git-tools-check-icon pending" />
                  )}
                  <span className={`git-tools-item-text ${isDone ? "completed" : ""}`}>
                    {item.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
