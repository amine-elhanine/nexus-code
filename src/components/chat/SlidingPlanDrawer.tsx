import React, { useState, useEffect, useRef } from "react";
import {
  ListTodo,
  Check,
  Loader2,
  Circle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Play,
  PauseCircle,
} from "lucide-react";
import type { PlanItem, ChatItem } from "../../types.js";

const CONTINUE_PHRASES = [
  "continue",
  "resume",
  "keep going",
  "keep working",
  "proceed",
  "ok",
  "okay",
  "sure",
  "go ahead",
  "yes",
  "do it",
  "please do it",
  "proceed please",
];

export function isContinuePhrase(text?: string): boolean {
  if (!text) return false;
  const clean = text.trim().replace(/[.!…]+$/g, "").trim().toLowerCase();
  if (!clean) return false;
  const bare = clean.startsWith("please ") ? clean.slice("please ".length).trim() : clean;
  const core = bare.endsWith(" please") ? bare.slice(0, -" please".length).trim() : bare;
  if ((CONTINUE_PHRASES as string[]).includes(core)) return true;
  if (/^(?:continue|resume|pick\s+up)\s+(?:from\s+)?where\b.{0,60}$/i.test(core)) return true;
  if (/^(?:continue|resume|keep\s+going|keep\s+working|go\s+ahead)\b.{0,40}$/i.test(core)) return true;
  if (/^(?:ok|okay|sure|yes|do\s+it|proceed)\b.{0,20}$/i.test(core)) return true;
  return false;
}

export type PlanExtractionResult = {
  plan: PlanItem[];
  createdAt?: string;
  isInterrupted?: boolean;
  isFinished?: boolean;
};

/**
 * Extracts the latest active or persisted plan from liveEvents or messages.
 * When a task is finished (all steps completed or run finished cleanly), returns null so the plan disappears.
 * When a task is interrupted (incomplete steps and not running), returns the plan with isInterrupted=true.
 */
export function extractLatestPlan(
  liveEvents?: ChatItem[],
  messages?: ChatItem[],
  running = false
): PlanExtractionResult | null {
  // 1. If currently running, check liveEvents first for active plan updates
  if (liveEvents && liveEvents.length > 0) {
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      const ev = liveEvents[i];
      if (ev.kind === "plan" && ev.plan && ev.plan.length > 0) {
        const total = ev.plan.length;
        const completedCount = ev.plan.filter((p) => p.status === "completed").length;
        const allCompleted = total > 0 && completedCount === total;
        // If not running and all finished, disappear
        if (!running && allCompleted) return null;
        return {
          plan: ev.plan,
          createdAt: ev.createdAt,
          isInterrupted: !running && !allCompleted,
          isFinished: !running && allCompleted,
        };
      }
    }
  }

  // 2. Otherwise inspect persisted messages
  if (!messages || messages.length === 0) return null;

  // Locate the last user prompt turn
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // If no user message was found, scan backward through all messages
  if (lastUserIdx === -1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.kind === "plan" && msg.plan && msg.plan.length > 0) {
        const total = msg.plan.length;
        const completedCount = msg.plan.filter((p) => p.status === "completed").length;
        const allCompleted = total > 0 && completedCount === total;
        if (!running && allCompleted) return null;
        return {
          plan: msg.plan,
          createdAt: msg.createdAt,
          isInterrupted: !running && !allCompleted,
          isFinished: !running && allCompleted,
        };
      }
    }
    return null;
  }

  // Check the current turn (from lastUserIdx onwards)
  let foundPlan: PlanItem[] | null = null;
  let planCreatedAt: string | undefined;

  for (let i = messages.length - 1; i >= lastUserIdx; i--) {
    const msg = messages[i];
    if (msg.kind === "plan" && msg.plan && msg.plan.length > 0) {
      foundPlan = msg.plan;
      planCreatedAt = msg.createdAt;
      break;
    }
  }

  // If the current turn has no plan yet, but the user sent a continuation request ("continue"),
  // look at the preceding turn to pick up the interrupted plan.
  const lastUserText = messages[lastUserIdx]?.text || "";
  if (!foundPlan && isContinuePhrase(lastUserText)) {
    for (let i = lastUserIdx - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.kind === "plan" && msg.plan && msg.plan.length > 0) {
        foundPlan = msg.plan;
        planCreatedAt = msg.createdAt;
        break;
      }
    }
  }

  if (!foundPlan || foundPlan.length === 0) return null;

  const total = foundPlan.length;
  const completedCount = foundPlan.filter((p) => p.status === "completed").length;
  const allCompleted = total > 0 && completedCount === total;

  // When task is finished (all done and not running), disappear!
  if (!running && allCompleted) {
    return null;
  }

  return {
    plan: foundPlan,
    createdAt: planCreatedAt,
    isInterrupted: !running && !allCompleted,
    isFinished: !running && allCompleted,
  };
}

export function SlidingPlanDrawer({
  plan,
  running = false,
  isInterrupted = false,
  onContinue,
}: {
  plan?: PlanItem[] | null;
  running?: boolean;
  isInterrupted?: boolean;
  onContinue?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const prevPlanLengthRef = useRef(0);
  const prevFirstItemRef = useRef("");

  // When a new plan is generated (different task or initial plan), auto-expand
  useEffect(() => {
    if (plan && plan.length > 0) {
      const firstContent = plan[0]?.content || "";
      if (
        prevPlanLengthRef.current === 0 ||
        (prevFirstItemRef.current !== firstContent && prevPlanLengthRef.current !== plan.length)
      ) {
        setIsExpanded(true);
      }
      prevPlanLengthRef.current = plan.length;
      prevFirstItemRef.current = firstContent;
    } else {
      prevPlanLengthRef.current = 0;
      prevFirstItemRef.current = "";
    }
  }, [plan]);

  if (!plan || plan.length === 0) return null;

  const total = plan.length;
  const completedCount = plan.filter((p) => p.status === "completed").length;
  const inProgressItem = plan.find((p) => p.status === "in_progress") || plan.find((p) => p.status === "pending");
  const allCompleted = completedCount === total && total > 0;
  const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  // When the task is finished (all done and not running), the plan disappears!
  if (!running && allCompleted) {
    return null;
  }

  const interrupted = !running && (!allCompleted || isInterrupted);

  // When collapsed: show sleek, compact bar above the text area
  if (!isExpanded) {
    return (
      <div
        className="sliding-plan-collapsed"
        onClick={() => setIsExpanded(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setIsExpanded(true);
        }}
        title="Click to expand plan"
      >
        <div className="sliding-plan-collapsed-left">
          <ListTodo size={13} className="text-nexus-green" />
          <strong style={{ color: "var(--text, #e2e8f0)" }}>Working Plan</strong>
          <span className={`sliding-plan-badge${interrupted ? " interrupted" : ""}`}>
            {interrupted ? <PauseCircle size={10} style={{ marginRight: 3 }} /> : null}
            {interrupted ? `Paused (${completedCount}/${total})` : `${completedCount}/${total} completed`}
          </span>
          {running && inProgressItem ? (
            <span className="sliding-plan-collapsed-status in-progress">
              <Loader2 size={11} className="spin" />
              <span>{inProgressItem.content}</span>
            </span>
          ) : interrupted && inProgressItem ? (
            <span className="sliding-plan-collapsed-status interrupted">
              <span>Paused at: {inProgressItem.content}</span>
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {interrupted && onContinue && (
            <button
              type="button"
              className="sliding-plan-continue-btn"
              onClick={(e) => {
                e.stopPropagation();
                onContinue();
              }}
              title="Continue task from where it stopped"
            >
              <Play size={11} fill="currentColor" />
              <span>Continue</span>
            </button>
          )}
          <button
            type="button"
            className="sliding-plan-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(true);
            }}
            title="Reopen plan"
          >
            <ChevronUp size={13} />
            <span>View Plan</span>
          </button>
        </div>
      </div>
    );
  }

  // When expanded: show full sliding drawer with progress and all steps
  return (
    <div className="sliding-plan-drawer">
      {/* Header */}
      <div className="sliding-plan-header">
        <div className="sliding-plan-header-left">
          <ListTodo size={14} className="text-nexus-green" />
          <span className="sliding-plan-title">Working Plan</span>
          <span className={`sliding-plan-badge${interrupted ? " interrupted" : ""}`}>
            {interrupted ? (
              <>
                <PauseCircle size={11} style={{ marginRight: 4 }} />
                Paused at step {completedCount + 1} of {total} ({percent}%)
              </>
            ) : (
              `${completedCount} of ${total} completed (${percent}%)`
            )}
          </span>
          <div className="sliding-plan-progress-track">
            <div
              className="sliding-plan-progress-fill"
              style={{
                width: `${percent}%`,
                background: interrupted ? "#fbbf24" : "var(--nexus-green, #34d399)",
              }}
            />
          </div>
          {allCompleted && (
            <span className="sliding-plan-all-done">
              <CheckCircle2 size={12} /> Done
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {interrupted && onContinue && (
            <button
              type="button"
              className="sliding-plan-continue-btn"
              onClick={onContinue}
              title="Continue task from where it stopped"
            >
              <Play size={12} fill="currentColor" />
              <span>Continue Task</span>
            </button>
          )}
          <button
            type="button"
            className="sliding-plan-action-btn"
            onClick={() => setIsExpanded(false)}
            title="Close plan preview (reopen anytime)"
          >
            <ChevronDown size={14} />
            <span>Close</span>
          </button>
        </div>
      </div>

      {/* Steps List */}
      <div className="sliding-plan-list">
        {plan.map((item, index) => {
          const isDone = item.status === "completed";
          const isWorking = item.status === "in_progress";
          const isPaused = interrupted && (isWorking || (index === completedCount && item.status === "pending"));
          return (
            <div
              key={index}
              className={`sliding-plan-item ${item.status}${isPaused ? " paused" : ""}`}
            >
              <span className="sliding-plan-item-icon">
                {isDone ? (
                  <Check size={12} strokeWidth={2.5} />
                ) : isWorking && running ? (
                  <Loader2 size={12} className="spin" />
                ) : isPaused ? (
                  <PauseCircle size={12} />
                ) : (
                  <Circle size={8} />
                )}
              </span>
              <span className="sliding-plan-item-text">
                {item.content}
                {isWorking && running && (
                  <span className="sliding-plan-working-tag">
                    In progress…
                  </span>
                )}
                {isPaused && (
                  <span className="sliding-plan-working-tag paused">
                    Paused here
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
