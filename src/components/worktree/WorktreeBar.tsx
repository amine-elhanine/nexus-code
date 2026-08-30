import React, { useState } from "react";
import { GitBranch, GitMerge, Trash2, Check, AlertCircle, Loader2 } from "lucide-react";

interface WorktreeBarProps {
  sessionId: string;
  isGit: boolean;
  worktree: { worktreePath: string; branch: string } | null;
  onMergeSuccess?: () => void;
  onDiscardSuccess?: () => void;
}

export const WorktreeBar: React.FC<WorktreeBarProps> = ({
  sessionId,
  isGit,
  worktree,
  onMergeSuccess,
  onDiscardSuccess,
}) => {
  const [merging, setMerging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<string | null>(null);

  if (!isGit || !worktree) return null;

  const handleMerge = async () => {
    try {
      setMerging(true);
      setMergeStatus(null);
      const result = await window.forgepilot.mergeWorktree(sessionId);
      if (result.success) {
        setMergeStatus("Merged successfully!");
        onMergeSuccess?.();
        setTimeout(() => setMergeStatus(null), 3000);
      } else {
        setMergeStatus(`Merge failed: ${result.error || "Conflict detected"}`);
      }
    } catch (err) {
      setMergeStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMerging(false);
    }
  };

  const handleDiscard = async () => {
    if (!window.confirm("Are you sure you want to discard this worktree and all its changes?")) return;
    try {
      setDiscarding(true);
      const ok = await window.forgepilot.discardWorktree(sessionId);
      if (ok) {
        onDiscardSuccess?.();
      }
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className="worktree-status-bar">
      <div className="worktree-info">
        <GitBranch size={14} className="text-emerald-400" />
        <span className="worktree-badge">Isolated Worktree</span>
        <span className="worktree-branch-name">{worktree.branch}</span>
      </div>

      <div className="worktree-actions">
        {mergeStatus && (
          <span className={`worktree-status-msg ${mergeStatus.includes("failed") || mergeStatus.includes("Error") ? "text-rose-400" : "text-emerald-400"}`}>
            {mergeStatus}
          </span>
        )}
        <button
          type="button"
          className="btn-worktree-merge"
          onClick={handleMerge}
          disabled={merging || discarding}
          title="Merge isolated session changes into the main working tree"
        >
          {merging ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
          Merge to Main
        </button>
        <button
          type="button"
          className="btn-worktree-discard"
          onClick={handleDiscard}
          disabled={merging || discarding}
          title="Discard this isolated worktree"
        >
          {discarding ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          Discard
        </button>
      </div>
    </div>
  );
};
