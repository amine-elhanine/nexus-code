import React from "react";
import { Check, Loader2, CircleDot } from "lucide-react";
import type { PlanItem } from "../../types.js";
import { timeLabel } from "../../utils/format.js";

export function PlanCard({
  plan,
  createdAt,
}: {
  plan: PlanItem[];
  createdAt: string;
}) {
  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <span className="view-kicker">WORKING PLAN</span>
        <time>{timeLabel(createdAt)}</time>
      </div>
      {plan.map((item, index) => (
        <div className={`plan-item ${item.status}`} key={index}>
          <span className="plan-status">
            {item.status === "completed" ? (
              <Check size={12} />
            ) : item.status === "in_progress" ? (
              <Loader2 size={12} className="spin" />
            ) : (
              <CircleDot size={12} />
            )}
          </span>
          <span>{item.content}</span>
        </div>
      ))}
    </div>
  );
}
