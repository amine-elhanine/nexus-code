// Provider rate limits (especially free tiers) surface as 429 errors, and long
// agent streams occasionally die on dropped connections or server overload.
// Neither should abort an in-flight run and lose completed work: this bounded
// exponential-backoff retry rides out the failure instead. Two rules keep it
// honest for long runs:
//   - only transient errors (rate limits, network blips, overload) are
//     retried; everything else propagates at once;
//   - the attempt counter tracks failures WITHOUT progress. An attempt that
//     completed supersteps before dying counts as a fresh incident and
//     restarts the countdown, so a long healthy run that hits an occasional
//     error doesn't creep toward exhaustion. maxProgressResets caps the
//     restarts so a stream that always fails right after making progress
//     still terminates.
const RATE_LIMIT_PATTERN = /\b(429|rate.?limit|too many requests|quota exceeded|overloaded)\b/i;
const TRANSIENT_PATTERN =
  /\b(econnreset|econnaborted|econnrefused|etimedout|esockettimedout|epipe|enotfound|ehostunreach|enetunreach|socket hang up|network error|network timeout|fetch failed|connection error|connection reset|connection terminated|terminated|connection closed|connection dropped|connection refused|connection timeout|request timeout|request timed out|timed out|timeout|service unavailable|temporarily unavailable|please try again|please retry|other side closed|bad gateway|gateway timeout|internal server error|apiconnectionerror|apiconnectiontimeouterror|502|503|504|529)\b/i;
// Tool-level timeouts look transient to the pattern above but must fail the
// run like before — retrying them would just re-run the same slow command.
const TOOL_TIMEOUT_PATTERN = /\b(command|process|execution|script)\s+(timed?\s?out|timeout)\b/i;

function errorParts(error: unknown): string[] {
  return [
    error instanceof Error ? error.message : String(error),
    String((error as any)?.name ?? ""),
    String((error as any)?.code ?? ""),
    String((error as any)?.status ?? ""),
  ];
}

export function isRateLimitError(error: unknown): boolean {
  return RATE_LIMIT_PATTERN.test(errorParts(error).join(" "));
}

/** Rate limits, connection failures and server overload — worth another attempt. */
export function isTransientError(error: unknown): boolean {
  const text = errorParts(error).join(" ");
  if (TOOL_TIMEOUT_PATTERN.test(text)) return false;
  return RATE_LIMIT_PATTERN.test(text) || TRANSIENT_PATTERN.test(text);
}

/** One-line, length-capped error text for user-facing retry statuses. */
export function errorSummary(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return message ? (message.length > 90 ? `${message.slice(0, 90)}…` : message) : "unknown error";
}

/**
 * Providers advertise the wait window for rate limits via the Retry-After
 * header (seconds or an HTTP date). When present it beats exponential
 * backoff — the server told us exactly when to come back. Capped so a
 * nonsense header cannot stall a run indefinitely.
 */
export function parseRetryAfterMs(error: unknown): number | null {
  const headers = (error as any)?.headers ?? (error as any)?.response?.headers ?? (error as any)?.cause?.headers;
  if (!headers) return null;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw === undefined || raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const date = Date.parse(String(raw));
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 120_000);
  return null;
}

/**
 * A stream can die after the model emitted tool calls but before the tools ran;
 * replaying that state makes providers reject the resumed request. Keep the
 * checkpoint at the last complete superstep by dropping trailing unanswered
 * tool calls. Supersteps are atomic in LangGraph, so tool results always
 * arrive complete — only the model's final, unexecuted calls need pruning.
 */
export function sanitizeResumeCheckpoint(messages: any[]): any[] {
  const checkpoint = [...messages];
  while (checkpoint.length > 0) {
    const last = checkpoint[checkpoint.length - 1];
    if (Array.isArray(last?.tool_calls) && last.tool_calls.length > 0) checkpoint.pop();
    else break;
  }
  return checkpoint;
}

/**
 * Tracks whether an attempt produced observable progress (completed agent
 * supersteps or finished tool calls). A failure after progress is a new
 * incident: withRateLimitRetry restarts the attempt counter instead of
 * counting it against the previous failure.
 */
export function createProgressTracker() {
  let baseline = Infinity;
  let progressed = false;
  return {
    /** Call at the start of every attempt; `messageCount` is the checkpoint size being replayed. */
    beginAttempt: (messageCount: number) => {
      baseline = messageCount;
      progressed = false;
    },
    /** Call with the state message count of every "values" stream payload. */
    noteSuperstep: (messageCount: number) => {
      if (messageCount > baseline) progressed = true;
    },
    /** Call when a tool result message is observed. */
    noteToolResult: () => {
      progressed = true;
    },
    /** True if progress was observed since the last beginAttempt; clears the marker. */
    madeProgress: () => {
      const result = progressed;
      progressed = false;
      return result;
    },
  };
}

export type RetryKind = "rate-limit" | "transient";

export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    /** Cap on progress-based counter resets, so a stream that fails right after each burst of progress still terminates. */
    maxProgressResets?: number;
    /** Runs before each attempt (including the first); may throw to abort the run. */
    prepareAttempt?: () => void;
    /**
     * Probe consulted after a retryable failure (from the second failure on):
     * return true if the previous attempt made observable progress. The probe
     * both checks and consumes the progress marker — clear it inside.
     */
    madeProgress?: () => boolean;
    onRetry?: (info: {
      delayMs: number;
      attempt: number;
      maxAttempts: number;
      kind: RetryKind;
      reason: string;
      /** True when the counter was reset because the failed attempt had made progress. */
      reset: boolean;
    }) => void;
  } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 15_000;
  const maxProgressResets = options.maxProgressResets ?? 8;
  let attempt = 1;
  let progressResets = 0;
  for (;;) {
    options.prepareAttempt?.();
    try {
      return await operation();
    } catch (error) {
      if (!isTransientError(error)) throw error;
      // A failure that happened after observable progress is a fresh incident,
      // not a continuation of the previous one: restart the countdown (and with
      // it the backoff delay) so one scattered 429 in a long, otherwise healthy
      // run doesn't bring it closer to dying.
      let reset = false;
      if (attempt > 1 && progressResets < maxProgressResets && options.madeProgress?.()) {
        attempt = 1;
        progressResets++;
        reset = true;
      }
      if (attempt >= maxAttempts) throw error;
      const retryAfterMs = isRateLimitError(error) ? parseRetryAfterMs(error) : null;
      const delayMs = retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.({
        delayMs,
        attempt: attempt + 1,
        maxAttempts,
        kind: isRateLimitError(error) ? "rate-limit" : "transient",
        reason: errorSummary(error),
        reset,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt++;
    }
  }
}
