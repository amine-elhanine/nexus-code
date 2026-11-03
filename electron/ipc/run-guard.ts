// Shared run-slot concurrency guard for agent:run and home:run.
//
// A second submit (e.g. Enter pressed while the first run is still in silent
// setup) must not start a twin agent that interleaves transcripts and
// clobbers checkpoints/memory. When the previous run was just cancelled we
// briefly wait for its slot to drain (awaitable — `releaseRunSlot` resolves
// waiters; a 1s poll fallback covers direct `delete()` release paths like the
// notebook routes) instead of failing the retry.

import { isCommandRunCancelled } from "../command-service.js";

const DRAIN_BUDGET_MS = 1000;
const DRAIN_POLL_INTERVAL_MS = 25;

const drainWaiters = new Map<string, Set<() => void>>();

function notifyDrain(sessionId: string) {
  const waiters = drainWaiters.get(sessionId);
  if (!waiters) return;
  drainWaiters.delete(sessionId);
  for (const resolve of waiters) resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Throws when `sessionId` already holds a run; otherwise reserves the slot by
 * adding it to `activeRunSessions`. Callers release via `releaseRunSlot` (or
 * endCommandRun + their own delete in the run finally-block).
 */
export async function acquireRunSlot(activeRunSessions: Set<string>, sessionId: string): Promise<void> {
  if (activeRunSessions.has(sessionId) && isCommandRunCancelled(sessionId)) {
    // Await the cancelled run's release: resolved via releaseRunSlot, with a
    // bounded poll fallback for slots released by a bare Set.delete().
    const drained = new Promise<void>((resolve) => {
      const waiters = drainWaiters.get(sessionId);
      if (waiters) waiters.add(resolve);
      else drainWaiters.set(sessionId, new Set([resolve]));
    });
    const timeout = sleep(DRAIN_BUDGET_MS);
    await Promise.race([drained, timeout]);
    drainWaiters.delete(sessionId);
    // Rare-gap re-check: still held after the budget → pending drain.
    if (activeRunSessions.has(sessionId)) {
      const waitStart = Date.now();
      while (activeRunSessions.has(sessionId) && Date.now() - waitStart < DRAIN_BUDGET_MS) {
        await sleep(DRAIN_POLL_INTERVAL_MS);
      }
    }
  }
  if (activeRunSessions.has(sessionId)) {
    throw new Error("An agent run is already in progress in this session.");
  }
  activeRunSessions.add(sessionId);
}

/**
 * Releases a previously acquired run slot and wakes any cancelled-retry
 * waiter. callers that already do `delete` + `endCommandRun` in a finally
 * block can switch to this no-op-safe helper.
 */
export function releaseRunSlot(activeRunSessions: Set<string>, sessionId: string): void {
  activeRunSessions.delete(sessionId);
  notifyDrain(sessionId);
}
