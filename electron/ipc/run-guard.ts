// Shared run-slot concurrency guard for agent:run and home:run.
//
// A second submit (e.g. Enter pressed while the first run is still in silent
// setup) must not start a twin agent that interleaves transcripts and
// clobbers checkpoints/memory. When the previous run was just cancelled we
// briefly wait for its slot to drain (polling — there is no awaitable signal)
// instead of failing the retry.

import { isCommandRunCancelled } from "../command-service.js";

/**
 * Throws when `sessionId` already holds a run; otherwise reserves the slot by
 * adding it to `activeRunSessions`. Callers release via endCommandRun +
 * their own delete in the run finally-block.
 */
export async function acquireRunSlot(activeRunSessions: Set<string>, sessionId: string): Promise<void> {
  if (activeRunSessions.has(sessionId)) {
    if (isCommandRunCancelled(sessionId)) {
      const waitStart = Date.now();
      while (activeRunSessions.has(sessionId) && Date.now() - waitStart < 1000) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (activeRunSessions.has(sessionId)) {
      throw new Error("An agent run is already in progress in this session.");
    }
  }
  activeRunSessions.add(sessionId);
}
