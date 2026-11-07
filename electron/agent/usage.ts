// Usage accounting for streamed agent runs.
// Extracted verbatim from agent-service.ts; no behavior change.

import type { AgentUsage } from "../agent-types.js";
import { StreamUsageTracker } from "../context-service.js";
import { calculateAgentUsage } from "../subagent-service.js";

// Invocation-level usage objects come from the protocol adapters via the
// agent loop's "usage" event; StreamUsageTracker sums them across model
// invocations, never overwriting with the latest one.
export class UsageAccumulator {
  private tracker = new StreamUsageTracker();

  noteUsage(usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null) {
    this.tracker.noteUsage(usage);
  }

  /** Largest single model-call input seen so far — the live context size. */
  get observedInputTokens(): number {
    return this.tracker.lastObservedInputTokens;
  }

  get hasObservedInputTokens(): boolean {
    return this.tracker.sawExactInput && this.tracker.lastObservedInputTokens > 0;
  }

  /** Sum of exact input totals across all model invocations in this run. */
  get cumulativeInputTokens(): number {
    return this.tracker.inputTokens;
  }

  // Prompt-cache totals across the run (see StreamUsageTracker) — the
  // hover-card cache hit rate divides these by the exact input total.
  get cacheReadTokens(): number {
    return this.tracker.cacheReadTokens;
  }

  get cacheCreationTokens(): number {
    return this.tracker.cacheCreationTokens;
  }

  addSubagent(usage?: AgentUsage) {
    if (!usage) return;
    // Subagent input/output are complete invocation totals, so they are added
    // directly on top of the parent run's own usage.
    this.tracker.addTotals(usage.inputTokens || 0, usage.outputTokens || 0);
  }

  finalize(modelName: string, fallbackInputEstimate = 0, fallbackOutputEstimate = 0): AgentUsage {
    const inputTokens = this.tracker.inputTokens;
    const outputTokens = this.tracker.outputTokens;
    const sawExactInput = this.tracker.sawExactInput;
    const sawExactOutput = this.tracker.sawExactOutput;
    const finalInput = !sawExactInput && inputTokens === 0 && fallbackInputEstimate > 0 ? fallbackInputEstimate : inputTokens;
    const finalOutput = !sawExactOutput && outputTokens === 0 && fallbackOutputEstimate > 0 ? fallbackOutputEstimate : outputTokens;
    const usage = calculateAgentUsage(finalInput, finalOutput, modelName);
    // Provider-reported prompt-cache totals (only meaningful alongside exact
    // input totals); omitted entirely when the provider reports none, so old
    // persisted sessions stay shape-compatible.
    const cacheReadTokens = this.tracker.cacheReadTokens;
    const cacheCreationTokens = this.tracker.cacheCreationTokens;
    if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
      usage.cacheReadTokens = cacheReadTokens;
      usage.cacheCreationTokens = cacheCreationTokens;
    }
    return usage;
  }
}
