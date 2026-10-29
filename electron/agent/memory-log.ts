// Rolling memory-log helpers and their entry/char caps.
// Extracted verbatim from agent-service.ts; no behavior change.

// Memory entry cap (per-entry char bound for session memory items).
export const MEMORY_ENTRY_CAP = 600;
// Project memory log: newest 20 runs, char-capped as a second bound.
export const PROJECT_MEMORY_RUN_LOG_CAP = 20;
// Session memory log: newest 40 run summaries, 4000 chars.
export const SESSION_MEMORY_ENTRY_CAP = 40;
export const SESSION_MEMORY_CHAR_CAP = 4000;

// Project memory is a rolling log; keep the most recent entries so it cannot
// grow without bound across hundreds of runs.
// Rolling memory logs (project + session) keep WHOLE entries: char-slicing
// cut the oldest entry mid-sentence and left a misleading fragment at the
// top of what the model reads. Entries are separated by `separator`
// ("\n" for the one-line-per-run project log, "\n\n" for session memory).
export function appendEntryLog(
  existing: string | undefined,
  entry: string,
  opts: { maxEntries: number; maxChars: number; separator: string }
): string {
  const parts = (existing || "").split(opts.separator).map((p) => p.trim()).filter(Boolean);
  parts.push(entry.trim());
  let kept = parts.length > opts.maxEntries ? parts.slice(-opts.maxEntries) : parts;
  while (kept.length > 1 && kept.join(opts.separator).length > opts.maxChars) kept = kept.slice(1);
  return kept.join(opts.separator);
}
