// Incomplete-turn detector shared across Code and Home verification paths.
// Catches responses where the model stopped emitting tool calls while knowing
// the task is still unfinished (truncated output, unfinished write_todos plan,
// forward narration without executing tools, or deferring remaining work).
import type { AgentMode, PlanItem } from "../agent-types.js";

export type IncompleteTurnReason = "truncated" | "unfinished-plan" | "promise-only" | "deferred";

export type IncompleteTurnInput = {
  response: string;
  stopReason?: string;
  mode: AgentMode;
  isGeneral: boolean;
  expectsChanges: boolean;
  expectsOutput: boolean;
  changedFilesCount: number;
  createdDeliverable: boolean;
  planItems: PlanItem[] | null;
  toolCallCount?: number;
  continuationsUsed: number;
  maxContinuations: number;
};

export type IncompleteTurnDecision =
  | { incomplete: false }
  | { incomplete: true; reason: IncompleteTurnReason; nudge: string };

const GENUINE_BLOCKER_PATTERN =
  /\b(?:missing\s+(?:api\s+)?key|api\s+key\s+(?:not\s+set|is\s+missing|required)|credentials?\s+(?:missing|required|not\s+configured)|permission\s+denied|approval\s+(?:was\s+)?denied|denied\s+by\s+(?:the\s+)?user|sandbox\s+blocked|network\s+(?:is\s+)?blocked|cannot\s+access\s+(?:the\s+)?(?:network|repository|filesystem)|waiting\s+for\s+(?:your|the\s+user'?s)\s+(?:input|choice|confirmation|approval)|please\s+(?:provide|clarify|confirm|choose)\s+which)\b/i;

const PROMISE_TAIL_PATTERN =
  /(?:\b(?:let\s+me\s+(?!know\b)|(?:now\s+)?let'?s\s+(?:now\s+)?|i(?:'ll| will)\s+|now\s+i(?:'ll| will)\s+|next,?\s+i(?:'ll| will)\s+|i(?:'m| am)\s+going\s+to\s+|moving\s+on\s+to\s+)(?:start|begin|proceed|continue|check|read|inspect|search|locate|trace|find|fix|update|edit|patch|write|create|build|run|test|verify|implement|finish|complete|add|remove|refactor|open)\b(?:[^.!?\n]|\.(?=\S)){0,180}(?:\.\.\.|[:.])?\s*$|\b(?:moving\s+(?:on\s+)?to\s+(?:step\s+\d+|the\s+next\s+step)|i\s+have\s+completed\s+step\s+\d+[^.!?\n]{0,80}\bnext\b)(?:[^.!?\n]|\.(?=\S)){0,120}(?:\.\.\.|[:.])?\s*$)/i;

const DEFERRED_WORK_PATTERN =
  /\b(?:not\s+yet\s+(?:implemented|finished|completed|fixed|written)|haven'?t\s+(?:finished|completed|implemented|had\s+a\s+chance\s+to)|didn'?t\s+(?:finish|complete|get\s+to)|couldn'?t\s+finish|partially\s+(?:complete|completed|implemented)|still\s+needs?\s+(?:to\s+be\s+)?(?:implemented|updated|fixed|written|created)|remaining\s+(?:tasks?|work|items?|files?)\s*(?::|are|include)|to\s+(?:finish|complete)\s+this,?\s+you\s+(?:can|will\s+need\s+to|should)|as\s+(?:a\s+)?next\s+step,?\s+you\s+(?:can|should))\b/i;

const NEXT_STEPS_HEADING_PATTERN = /^#{1,4}\s+(?:next\s+steps?|remaining\s+(?:work|tasks?|items?|steps?)|what\s+remains|todo|to\s+do)\b(.*)$/im;
const OPTIONAL_HANDOFF_ONLY_PATTERN = /\b(?:git\s+commit|push|open\s+(?:a\s+)?pr|pull\s+request|merge|deploy|review\s+the\s+diff)\b/i;

export function detectIncompleteAgentTurn(input: IncompleteTurnInput): IncompleteTurnDecision {
  const {
    response,
    stopReason,
    mode,
    isGeneral,
    expectsChanges,
    expectsOutput,
    changedFilesCount,
    createdDeliverable,
    planItems,
    toolCallCount = 0,
    continuationsUsed,
    maxContinuations,
  } = input;

  const effectiveMax = Number.isFinite(maxContinuations) ? maxContinuations : Infinity;
  if (mode === "plan" || continuationsUsed >= effectiveMax) {
    return { incomplete: false };
  }

  const trimmed = String(response || "").trim();

  if (stopReason === "length") {
    return {
      incomplete: true,
      reason: "truncated",
      nudge:
        "Your previous response stopped because it hit the max output token limit (`length`) before finishing. Continue immediately from where you stopped — emit your next tool call or finish the remaining work without repeating what you already completed.",
    };
  }

  // Genuine external blockers must be surfaced cleanly rather than looped over.
  if (GENUINE_BLOCKER_PATTERN.test(trimmed)) {
    return { incomplete: false };
  }

  const unfinishedItems = (planItems || []).filter((item) => item && item.status !== "completed");
  if (unfinishedItems.length > 0) {
    const remaining = unfinishedItems
      .slice(0, 8)
      .map((item) => `- ${item.content} (${item.status})`)
      .join("\n");
    return {
      incomplete: true,
      reason: "unfinished-plan",
      nudge: `You stopped with unfinished items still in your execution plan:\n${remaining}\n\nDo NOT stop or hand back partial work. Execute the remaining steps now using tools, verify the result, mark the todos completed via \`write_todos\`, and only then present your final answer.`,
    };
  }

  const expectsAction = isGeneral ? expectsOutput : expectsChanges;
  const actionNotDone = isGeneral ? !createdDeliverable : changedFilesCount === 0;
  if ((expectsAction || toolCallCount > 0) && trimmed) {
    const tailWindow = trimmed.slice(-260);
    if (PROMISE_TAIL_PATTERN.test(tailWindow) && (expectsAction || actionNotDone || tailWindow.trimEnd().endsWith(":"))) {
      return {
        incomplete: true,
        reason: "promise-only",
        nudge:
          "You narrated what you plan to do next without calling a tool to actually do it. Execute that step now directly with tools, verify the result, and only give a final answer once the full task is complete.",
      };
    }

    const hasNextStepsHeading = NEXT_STEPS_HEADING_PATTERN.exec(trimmed);
    const headingFollowup = hasNextStepsHeading
      ? trimmed.slice(hasNextStepsHeading.index, hasNextStepsHeading.index + 350)
      : "";
    const isDeferredHeading =
      Boolean(hasNextStepsHeading) &&
      (expectsAction || actionNotDone) &&
      !OPTIONAL_HANDOFF_ONLY_PATTERN.test(headingFollowup);

    if (DEFERRED_WORK_PATTERN.test(trimmed) || isDeferredHeading) {
      return {
        incomplete: true,
        reason: "deferred",
        nudge:
          "You indicated that part of the task is still unfinished or left remaining steps for the user, even though you are not blocked. Finish the remaining work autonomously using your tools now, run verification, and present your final answer only after the job is complete.",
      };
    }
  }

  return { incomplete: false };
}
