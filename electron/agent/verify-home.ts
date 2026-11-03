// Home-mode verification DECISION core (extracted from agent-service.ts).
//
// This is the most safety-critical branch logic in the product: it decides
// whether a Home run may claim completion. Previously it lived inline in the
// verify node where the branch ORDER (chat-answer escape → chart-dump rule →
// structure repair → content repair → plan contract → pass/warnings) was only
// implicitly encoded across 140 lines of I/O. Here it is a pure, total
// function with a typed outcome — unit-testable without a model, a workspace,
// or an event bus.
//
// The verify NODE remains the caller: it owns all I/O (fresh-file discovery,
// structure validation, content inspection, chart-dump cleanup) and event
// emission, then asks this function what to do.

import { homeRequestNamesFileFormat } from "../agent-prompt.js";
import { planItemEvidence, type DeliverableInspection } from "../deliverable-inspect.js";
import type { PlanItem } from "../agent-types.js";

export type HomeVerifyDecisionInput = {
  request: string;
  /** Raw model response from the graph state. */
  response: string;
  currentRepairs: number;
  maxRepairs: number;
  wantsDeliverable: boolean;
  /** Fresh output files AFTER chart-dump cleanup. */
  freshFiles: string[];
  createdDeliverable: boolean;
  /** Structure validation result (home-artifact-service contract.valid). */
  artifactValid: boolean;
  invalidArtifacts: Array<{ path: string; error?: string }>;
  missingFormats: string[];
  contentInspections: DeliverableInspection[];
  /** Text files that contain chart fences (caller pre-scans). */
  mdFilesWithCharts: Array<{ path: string }>;
  planItems: PlanItem[] | null;
  /** Progressed journal action texts for the plan-evidence check. */
  evidenceActions: string[];
  homeReadOnlyStreak: number;
  failedSkillNames: string[];
};

export type HomeVerifyDecision =
  | { outcome: "chat-answer"; hasVisualBlocks: boolean; telemetry: string }
  | { outcome: "failed-charts"; repairs: number; verifyFeedback: string; telemetry: string }
  | { outcome: "failed-structure"; verifyFeedback: string; telemetry: string }
  | { outcome: "failed-content"; repairs: number; verifyFeedback: string; telemetry: string }
  | { outcome: "failed-plan"; repairs: number; verifyFeedback: string; telemetry: string }
  | { outcome: "passed"; telemetry: string }
  | { outcome: "passed-with-warnings"; contentWarnings: string[]; telemetry: string }
  | { outcome: "failed-terminal"; telemetry: string }
  | { outcome: "none"; telemetry: string };

const VISUAL_FENCE = /```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)\b/i;
const VISUAL_IMAGE = /!\[[^\]]*\]\([^)]+\.(png|jpe?g|svg|webp|gif)\)/i;
const CHART_FENCE_GLOBAL = /```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)[\s\S]*?```/gi;
/** Cheap pre-scan helper shared with the node's chart-dump cleanup. */
export function hasChartFences(content: string): boolean {
  return VISUAL_FENCE.test(content || "");
}
export function matchChartFences(content: string): string[] {
  return (content || "").match(CHART_FENCE_GLOBAL) || [];
}
/** Visual-block detection on the model response (chat-answer escape input). */
export function responseHasVisualBlocks(response: string): boolean {
  const text = String(response || "").trimEnd();
  return VISUAL_FENCE.test(text) || VISUAL_IMAGE.test(text);
}

/**
 * Total decision function — branch order IS the contract (pinned by tests):
 * 1. chat-answer escape (sentinel + substance + no-named-format)
 * 2. chart-dump rule (charts belong in chat, not .md files)
 * 3. structure validation repair
 * 4. content-inspection repair (targeted, per-file)
 * 5. plan-as-hard-contract (pending + unevidenced items block)
 * 6. pass (with honest content warnings when repairs are exhausted)
 * 7. terminal failed (wants deliverable, got nothing usable) / none
 */
export function decideHomeVerification(input: HomeVerifyDecisionInput): HomeVerifyDecision {
  const {
    request, response, currentRepairs, maxRepairs, wantsDeliverable,
    freshFiles, createdDeliverable, artifactValid, invalidArtifacts, missingFormats,
    contentInspections, mdFilesWithCharts, planItems, evidenceActions,
    homeReadOnlyStreak, failedSkillNames,
  } = input;

  const responseTextTrimmed = String(response || "").trimEnd();
  const hasVisualBlocks = VISUAL_FENCE.test(responseTextTrimmed) || VISUAL_IMAGE.test(responseTextTrimmed);
  const repairsLeft = currentRepairs < maxRepairs;

  // 1. Chat-answer escape: a genuinely chat-shaped request (poem,
  // explanation, email text) that names no file format may be answered
  // directly in chat, marked with [[answer-in-chat]].
  const chatAnswerDeclared =
    wantsDeliverable &&
    !homeRequestNamesFileFormat(request) &&
    (hasVisualBlocks || (!createdDeliverable && responseTextTrimmed.length >= 200 && /\[\[answer-in-chat\]\]\s*$/i.test(responseTextTrimmed)));
  if (chatAnswerDeclared) {
    return {
      outcome: "chat-answer",
      hasVisualBlocks,
      telemetry: hasVisualBlocks ? "Verification passed · visual charts rendered in chat" : "Verification passed · answered in chat (request names no file format)",
    };
  }

  // 2. Chart-dump rule: charts must be rendered in the chat response.
  if (!hasVisualBlocks && mdFilesWithCharts.length > 0 && repairsLeft) {
    return {
      outcome: "failed-charts",
      repairs: currentRepairs + 1,
      telemetry: "Verification · graphs must be in the chat response, not inside an .md file",
      verifyFeedback: `You placed charts/graphs inside ${mdFilesWithCharts.map((f) => f.path).join(", ")}, but graphs must be included DIRECTLY in your chat response so the user can see them rendered on screen! The chat interface natively renders \`\`\`bar, \`\`\`line, \`\`\`scatter, and \`\`\`mermaid blocks, as well as image charts via ![Caption](filename.png). Do not offload them to an .md file. Deliver the complete visual answer with the charts directly in chat now.`,
    };
  }

  // 3. Structure validation: output missing or structurally invalid.
  if (wantsDeliverable && (!createdDeliverable || !artifactValid) && repairsLeft) {
    const validationDetails = [
      ...invalidArtifacts.map((check) => `${check.path} (${check.error || "invalid"})`),
      ...(missingFormats.length ? [`missing requested format${missingFormats.length > 1 ? "s" : ""}: ${missingFormats.map((format) => `.${format}`).join(", ")}`] : []),
    ];
    const validationNote = validationDetails.length ? ` Output validation failed: ${validationDetails.join("; ")}.` : " No new workspace output was created.";
    const failedSkillsNote = failedSkillNames.length
      ? ` Skills already loaded this run — do NOT re-read any SKILL.md (${failedSkillNames.join(", ")}): go straight to write_file + execute.`
      : "";
    return {
      outcome: "failed-structure",
      telemetry: `Verification · output check failed.${validationNote}`,
      verifyFeedback: `The request has an observable output contract, but the output is missing or failed validation.${validationNote} You are in AUTO mode: do NOT stop to talk or narrate future steps.${homeReadOnlyStreak >= 7 ? " The supervisor detected a prolonged read-only/research streak. Change strategy now and use the evidence already collected." : ""}${failedSkillsNote} Create or repair the requested result now, then inspect the created path and confirm it is readable. Do not perform another research/read-only action unless it is required to unblock creation.`,
    };
  }

  const contentProblems = contentInspections.filter((inspection) => !inspection.ok);

  // 4. Content inspection: targeted per-file repair round.
  if (contentProblems.length > 0 && repairsLeft) {
    const details = contentProblems.flatMap((inspection) => inspection.problems.map((problem) => `- ${inspection.path}: ${problem}`));
    return {
      outcome: "failed-content",
      repairs: currentRepairs + 1,
      telemetry: `Verification · content check failed on ${contentProblems.length} deliverable${contentProblems.length === 1 ? "" : "s"}`,
      verifyFeedback: `The requested output exists but fails content inspection:\n${details.join("\n")}\n\nRepair exactly these problems now — do not restart research and do not re-read skills. Fix the files in place (or regenerate if faster), then finish.`,
    };
  }

  // 5. Plan-as-hard-contract: unfinished items and unevidenced "completed"
  // items block completion (weak models mark everything done to escape).
  if (wantsDeliverable && repairsLeft && (planItems?.length || 0) > 0) {
    const deliverableReady = createdDeliverable && artifactValid && contentProblems.length === 0 && missingFormats.length === 0;
    const pendingItems = planItems!.filter((item) => {
      if (item.status === "completed") return false;
      if (deliverableReady && /\b(qa|quality|inspect|verify|check|review|deliver|summary|convert)\b/i.test(item.content)) {
        return false;
      }
      return true;
    });
    const unevidencedItems = planItems!.filter(
      (item) => item.status === "completed" && !planItemEvidence(item.content, freshFiles, evidenceActions)
    );
    if (pendingItems.length + unevidencedItems.length > 0) {
      const lines = [
        ...pendingItems.map((item) => `- still ${item.status}: ${item.content}`),
        ...unevidencedItems.map((item) => `- marked completed but no evidence found (no matching output file or recorded step): ${item.content}`),
      ];
      return {
        outcome: "failed-plan",
        repairs: currentRepairs + 1,
        telemetry: `Verification · plan not satisfied (${pendingItems.length} unfinished, ${unevidencedItems.length} completed without evidence)`,
        verifyFeedback: `The execution plan is not satisfied:\n${lines.join("\n")}\n\nContinue with the remaining plan items now. Only mark an item completed when its output actually exists — the runtime checks every completed item for evidence (a produced file or a recorded completed step).`,
      };
    }
  }

  // 6. Pass — with honest content warnings when repairs were exhausted thin.
  if (createdDeliverable && artifactValid) {
    if (contentProblems.length > 0) {
      const warnings = contentProblems.flatMap((inspection) => inspection.problems.map((problem) => `${inspection.path}: ${problem}`));
      return {
        outcome: "passed-with-warnings",
        contentWarnings: warnings,
        telemetry: `Verification passed with content warnings · ${warnings.join("; ")}`,
      };
    }
    const summaries = contentInspections.map((inspection) => `${inspection.path} (${inspection.summary})`).join(", ");
    return { outcome: "passed", telemetry: `Verification passed · Deliverable created: ${summaries || freshFiles.join(", ")}` };
  }

  // 7. Terminal states.
  return wantsDeliverable
    ? { outcome: "failed-terminal", telemetry: "Verification failed · no usable deliverable" }
    : { outcome: "none", telemetry: "Verification not applicable" };
}
