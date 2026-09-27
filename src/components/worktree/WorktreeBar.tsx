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
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [showConfirmDiscard, setShowConfirmDiscard] = useState(false);

  if (!isGit || !worktree) return null;

  const api = window.nexus || window.forgepilot;

  const handleMerge = async () => {
    try {
      setMerging(true);
      setMergeStatus(null);
      setConflictFiles([]);
      const result = await api.mergeWorktree(sessionId) as { success: boolean; error?: string; conflictFiles?: string[] };
      if (result.success) {
        setMergeStatus("Merged successfully!");
        onMergeSuccess?.();
        setTimeout(() => setMergeStatus(null), 3000);
      } else {
        setConflictFiles(result.conflictFiles || []);
        setMergeStatus(`Merge failed: ${result.error || "Conflict detected"}`);
      }
    } catch (err) {
      setMergeStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMerging(false);
    }
  };

  const handleAbortMerge = async () => {
    try {
      await (api as unknown as { abortWorktreeMerge: (sessionId?: string) => Promise<boolean> }).abortWorktreeMerge(sessionId);
      setConflictFiles([]);
      setMergeStatus("Merge aborted — worktree kept intact.");
    } catch (err) {
      setMergeStatus(`Abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleConfirmDiscard = async () => {
    setShowConfirmDiscard(false);
    try {
      setDiscarding(true);
      const ok = await api.discardWorktree(sessionId);
      if (ok) {
        onDiscardSuccess?.();
      }
    } catch (err) {
      setMergeStatus(`Discard failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <>
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
          {conflictFiles.length > 0 && (
            <button type="button" className="btn-worktree-discard" onClick={handleAbortMerge} title="Abort the failed merge, keep worktree intact">
              <AlertCircle size={13} /> Abort merge
            </button>
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
            onClick={() => setShowConfirmDiscard(true)}
            disabled={merging || discarding}
            title="Discard this isolated worktree"
          >
            {discarding ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            Discard
          </button>
        </div>
      </div>

      {conflictFiles.length > 0 && (
        <div className="worktree-conflicts" style={{ padding: "8px 12px", fontSize: "11px", color: "#f0a35e" }}>
          <strong style={{ display: "flex", alignItems: "center", gap: 6 }}><AlertCircle size={13} /> Conflicting files ({conflictFiles.length}) — resolve in Editor, then Merge again or Abort:</strong>
          <ul style={{ margin: "6px 0 0 18px", color: "#a6b2c2" }}>
            {conflictFiles.slice(0, 20).map((f) => (
              <li key={f}><code>{f}</code></li>
            ))}
          </ul>
          {conflictFiles.length > 20 && <small>…and {conflictFiles.length - 20} more</small>}
        </div>
      )}

      {showConfirmDiscard && (
        <div className="modal-layer confirm-layer" onClick={() => setShowConfirmDiscard(false)}>
          <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card-head" style={{ marginBottom: "10px" }}>
              <div>
                <span className="view-kicker" style={{ color: "var(--red)" }}>CONFIRM ACTION</span>
                <h2 style={{ fontSize: "16px", margin: "6px 0 4px" }}>Discard Worktree</h2>
              </div>
            </div>
            <p style={{ color: "#a6b2c2", fontSize: "11px", lineHeight: "1.5", margin: "0 0 18px" }}>
              Are you sure you want to discard this isolated worktree and all its changes? This action cannot be undone.
            </p>
            <div className="modal-actions" style={{ marginTop: "0" }}>
              <button className="secondary" onClick={() => setShowConfirmDiscard(false)}>Cancel</button>
              <button className="primary danger-confirm-btn" onClick={handleConfirmDiscard}>
                <Trash2 size={13} /> Discard Worktree
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
