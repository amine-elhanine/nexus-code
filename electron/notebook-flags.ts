// Feature flags for Notebook Mode enhancements. Each flag is independently
// removable: the base pipeline never depends on a flagged path. Override with
// NEXUS_NOTEBOOK_<NAME>=0|1 (e.g. NEXUS_NOTEBOOK_LLM_ROUTER=1).

function envFlag(name: string, fallback: boolean): boolean {
  const raw = (process.env[`NEXUS_NOTEBOOK_${name}`] || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return fallback;
}

export const notebookFlags = {
  /** One small structured-output LLM call to route chat (else heuristics). */
  get llmRouter() {
    // Notebook chat is agent-led by default. The model interprets intent,
    // while heuristics remain the offline fallback if no provider is usable.
    return envFlag("LLM_ROUTER", true);
  },
  /** Generate "questions this chunk answers" per chunk (search-only enrichment). */
  get synthQuestions() {
    return envFlag("SYNTH_QUESTIONS", false);
  },
  /** Build a session digest (outline + topics) when all files are ready. */
  get sessionDigest() {
    return envFlag("SESSION_DIGEST", true);
  },
  /** Use a configured cloud parser for hard formats (local fallback). */
  get cloudParser() {
    return envFlag("CLOUD_PARSER", false);
  },
};
