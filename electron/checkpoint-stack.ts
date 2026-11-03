// Checkpoint stack helpers (shared Undo bookkeeping).
// Extracted from the old main.ts IPC mega-file; no behavior change.
// Used by workspace checkpoint routes and by the agent run route.

import { deleteWorkspaceCheckpoint } from "./diff-service.js";
import { getSession, updateSession } from "./store.js";

// Checkpoints left over from deleted/kept runs would keep the Undo card
// clickable forever; this clears the whole stack when a run's changes are
// accepted (Keep) or when rotating history.
const MAX_UNDO_LEVELS = 20;

export async function clearCheckpoint(projectId: string, sessionId: string, root: string, checkpointId?: string) {
  const session = await getSession(projectId, sessionId).catch(() => null);
  const stack: string[] = (session as unknown as { checkpointIds?: string[] } | null)?.checkpointIds || [];
  const ids = new Set([...stack, ...(checkpointId ? [checkpointId] : [])]);
  for (const id of ids) {
    try { await deleteWorkspaceCheckpoint(root, id); } catch { /* best effort */ }
  }
  await updateSession(projectId, sessionId, { checkpointId: undefined, checkpointIds: [] });
}

export async function pushCheckpoint(projectId: string, sessionId: string, root: string, checkpointId: string) {
  const session = await getSession(projectId, sessionId).catch(() => null);
  const prev: string[] = (session as unknown as { checkpointIds?: string[] } | null)?.checkpointIds
    || (session?.checkpointId ? [session.checkpointId] : []);
  const next = [...prev, checkpointId].slice(-MAX_UNDO_LEVELS);
  const pruned = prev.filter((id) => !next.includes(id));
  for (const id of pruned) {
    try { await deleteWorkspaceCheckpoint(root, id); } catch { /* best effort */ }
  }
  await updateSession(projectId, sessionId, { checkpointId, checkpointIds: next });
}

export async function popCheckpoint(projectId: string, sessionId: string, root: string, checkpointId: string) {
  // Restore pops the id (or the top when the id is stale) so Undo is
  // multi-level: each click steps one run further back.
  const session = await getSession(projectId, sessionId).catch(() => null);
  const stack: string[] = (session as unknown as { checkpointIds?: string[] } | null)?.checkpointIds
    || (session?.checkpointId ? [session.checkpointId] : []);
  const idx = stack.lastIndexOf(checkpointId);
  const target = idx >= 0 ? checkpointId : stack[stack.length - 1];
  if (!target) return;
  const next = stack.filter((id, i) => (idx >= 0 ? i !== idx : i !== stack.length - 1));
  try { await deleteWorkspaceCheckpoint(root, target); } catch { /* best effort */ }
  await updateSession(projectId, sessionId, {
    checkpointId: next.length ? next[next.length - 1] : undefined,
    checkpointIds: next,
  });
}
