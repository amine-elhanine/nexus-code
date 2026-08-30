import React, { useState } from "react";
import { Search, Terminal, Code2, Loader2, Check, X, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";
import type { SubagentItem } from "../../types.js";
import { timeLabel } from "../../utils/format.js";

export function SubagentCardView({ subagent, timestamp }: { subagent: SubagentItem; timestamp: string }) {
  const [expanded, setExpanded] = useState(false);
  const roleLabel = subagent.role === "researcher" ? "Researcher" : subagent.role === "tester" ? "Tester" : "Coder";
  const roleIcon = subagent.role === "researcher" ? <Search size={11} /> : subagent.role === "tester" ? <Terminal size={11} /> : <Code2 size={11} />;

  return (
    <div className={`subagent-card ${subagent.status}`}>
      <div className="subagent-card-head" onClick={() => setExpanded(!expanded)}>
        <div className="subagent-card-left">
          <span className={`subagent-role-pill ${subagent.role}`}>
            {roleIcon} {roleLabel}
          </span>
          <span className="subagent-task-title">{subagent.task}</span>
        </div>
        <div className="subagent-card-right">
          <span className={`subagent-status-badge ${subagent.status}`}>
            {subagent.status === "running" ? <Loader2 size={11} className="spin" /> : subagent.status === "completed" ? <Check size={11} /> : <X size={11} />}
            {subagent.status}
          </span>
          <time style={{ fontSize: "10px", color: "#6b5f9e" }}>{timeLabel(timestamp)}</time>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </div>
      {expanded && (
        <div className="subagent-body">
          {subagent.steps.length > 0 && (
            <>
              <div className="subagent-steps-head">
                <span>Tool Execution Steps ({subagent.steps.length})</span>
              </div>
              <div className="subagent-steps-list">
                {subagent.steps.map((step, idx) => (
                  <div className="subagent-step-item" key={idx}>
                    <CheckCircle2 size={10} />
                    <span>{step.toolName}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {subagent.output && (
            <div className="subagent-output-block">
              {subagent.output}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
