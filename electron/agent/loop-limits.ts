// LangGraph recursion budgets and loop/repair limits.
// Extracted verbatim from agent-service.ts; no behavior change.

import type { AgentMode } from "../agent-types.js";

// Internal-only marker: a superstep boundary was reached with real usage data
// showing the NEXT model call would overfill the context window. Threading it
// up lets streamDeepAgent condense the transcript and relaunch the stream
// instead of losing the run to a provider context-length 4xx.
export class AgentContextRelaunch extends Error {
  constructor(reason: string) {
    super(`Agent context relaunch: ${reason}`);
    this.name = "AgentContextRelaunch";
  }
}

// LangGraph recursion budgets per mode. Lowered from the previous
// 60/160/300: unbounded budgets let the model wander on trivial tasks.
// Simple tasks get a tight budget via SIMPLE_TASK_LIMIT instead.
export const MODE_LIMITS: Record<AgentMode, number> = { plan: 40, ask: 100, auto: 150, full: 200 };
// Fast-path budget for single-lookup / single-edit tasks: enough to
// read 1-2 files and write. Note this feeds LangGraph's recursionLimit,
// where one tool call costs several supersteps — keep it >= 50 or trivial
// tasks die with GraphRecursionError instead of finishing.
export const SIMPLE_TASK_LIMIT = 50;
// Self-healing passes per stream: how many times a still-failing run injects
// the error back into the conversation and continues, before honestly pausing
// with the checkpointed partial result.
export const MAX_AGENT_ERROR_RECOVERIES = 3;
export const MAX_REPAIRS: Record<AgentMode, number> = { plan: 0, ask: 3, auto: 5, full: 5 };

export function isRecursionLimitError(error: unknown): boolean {
  const text = [error instanceof Error ? error.message : String(error), String((error as any)?.name ?? "")].join(" ");
  return /recursion\s*limit|GRAPH_RECURSION_LIMIT/i.test(text);
}
