// Usage accounting for streamed agent runs.
// Extracted verbatim from agent-service.ts; no behavior change.

import type { AgentUsage } from "../agent-types.js";
import { StreamUsageTracker } from "../context-service.js";
import { calculateAgentUsage } from "../subagent-service.js";

// Chunk-level extraction and per-invocation deduplication live in
// StreamUsageTracker; totals must be summed across all model invocations,
// not overwritten by the latest one.
export class UsageAccumulator {
  private tracker = new StreamUsageTracker();

  noteChunk(chunk: any) {
    this.tracker.noteChunk(chunk);
  }

  /** Largest single model-call input seen so far — the live context size. */
  get observedInputTokens(): number {
    return this.tracker.lastObservedInputTokens;
  }

  get hasObservedInputTokens(): boolean {
    return this.tracker.sawExactInput && this.tracker.lastObservedInputTokens > 0;
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
    return calculateAgentUsage(finalInput, finalOutput, modelName);
  }
}
