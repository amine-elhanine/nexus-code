// Shared serialized journal persistence (RunProfile deep migration — journals).
//
// Both agent lanes keep a task journal (Code: CodeTaskJournal, Home:
// HomeTaskJournal) and persist it through an ordered, non-blocking write
// chain so the hot tool-event loop never awaits disk I/O while lines still
// land in order. The two private implementations were shape-identical
// (`.then(save).catch(→undefined)` chain over a snapshot); this is the one
// machine.

export type JournalSaver<J> = ((journal: J) => void) & {
  /** Resolves when every enqueued write has settled (run-end flush). */
  flush: () => Promise<void>;
};

export function createJournalSaver<J>(options: {
  /** Whether writes persist at all (mode gate: Home persists when isGeneral, Code when !isGeneral). */
  gate: () => boolean;
  /** The lane's own save function (saveCodeTaskJournal / saveHomeTaskJournal). */
  save: (journal: J) => Promise<unknown>;
}): JournalSaver<J> {
  let tail: Promise<void> = Promise.resolve();
  const saver = ((journal: J) => {
    if (!options.gate()) return;
    // Snapshot semantics: the journal passed here is the caller's current
    // record; the chain serializes writes and swallows failures (journals are
    // advisory context, never run-critical).
    tail = tail.then(async () => {
      await options.save(journal);
    }).catch(() => undefined);
  }) as JournalSaver<J>;
  saver.flush = () => tail.then(() => undefined);
  return saver;
}
