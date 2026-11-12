// Shared continue-resume steering note builder. Extracted from
// ipc/agent-routes.ts and ipc/home-run-routes.ts, which duplicated the
// plan/error/assistant/diff collection and note assembly verbatim and had
// begun to drift (different final-instruction paragraphs).

import { summarizeCompletedSteps } from "./agent-service.js";
import { getWorkspaceDiffFiles } from "./diff-service.js";
import type { ChatMessage } from "./agentcore/messages.js";

export type ResumePlanItem = { content: string; status: "pending" | "in_progress" | "completed" };

type ResumeSourceMessage = { role: string; kind?: string; text: string; plan?: ResumePlanItem[] };

export type ResumeContext = {
  lastPlan: ResumePlanItem[] | null;
  lastError: string | null;
  lastAssistant: string | null;
  diffSummary: string;
};

/** Collect the transcript signals (plan/error/last assistant/diff) a resume note is built from. */
export async function collectResumeContext(sessionMessages: ResumeSourceMessage[], workspaceRoot: string): Promise<ResumeContext> {
  const planEvents = sessionMessages.filter((m) => m.role === "event" && m.kind === "plan" && m.plan?.length);
  const lastPlan = planEvents.length ? planEvents[planEvents.length - 1].plan! : null;
  const errorEvents = sessionMessages.filter((m) => m.role === "event" && m.kind === "error");
  const lastError = errorEvents.length ? errorEvents[errorEvents.length - 1].text : null;
  const assistants = sessionMessages.filter((m) => m.role === "assistant");
  const lastAssistant = assistants.length ? assistants[assistants.length - 1].text.slice(-1500) : null;
  let diffSummary = "";
  try {
    const diffs = await getWorkspaceDiffFiles(workspaceRoot);
    if (diffs.length) diffSummary = `\nFiles already changed:\n${diffs.slice(0, 20).map((d) => `- ${d.path} (+${d.additions}/-${d.deletions})`).join("\n")}`;
  } catch { /* diff is best-effort */ }
  return { lastPlan, lastError, lastAssistant, diffSummary };
}

/** Assemble the [System Note: ...] resume note. `finalInstructions` differs
 *  between code runs (verification-aware steps) and home runs (free-form). */
export function buildResumeNote(
  sessionMessages: ResumeSourceMessage[],
  context: ResumeContext,
  stored: { planItems?: ResumePlanItem[] | null; messages?: ChatMessage[] } | null | undefined,
  finalInstructions: string,
): string {
  const planSummary = (stored?.planItems ?? context.lastPlan)?.length
    ? `\nWorking plan status:\n${(stored?.planItems ?? context.lastPlan)!.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content} (${p.status})`).join("\n")}`
    : "";
  // Explicit done-list: weak models re-do finished steps from prose
  // instructions alone; a concrete ledger survives where they don't.
  const ledger = stored?.messages?.length ? summarizeCompletedSteps(stored.messages) : [];
  const ledgerSummary = ledger.length
    ? `\nSteps already DONE (never repeat — results are in history):\n${ledger.map((s) => `- ${s}`).join("\n")}`
    : "";
  return `[System Note: The user asked to continue the previous interrupted run. All preceding tool executions and results ${stored ? `(${stored.messages!.length} checkpointed messages) ` : ""}are already complete.${planSummary}${ledgerSummary}${context.lastError ? `\nLast stop reason: ${context.lastError.slice(0, 500)}` : ""}${context.lastAssistant ? `\nLast assistant summary: ${context.lastAssistant}` : ""}${context.diffSummary}\n\n${finalInstructions}]`;
}
