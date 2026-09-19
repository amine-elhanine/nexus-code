import React, { useState } from "react";
import { Search, Terminal, Code2, Loader2, Check, X, ChevronDown, ChevronRight, CheckCircle2, Shield, Compass, CheckCheck, Wrench, Sparkles, Database, TestTube2 } from "lucide-react";
import type { SubagentItem, SubagentRole } from "../../types.js";
import { timeLabel } from "../../utils/format.js";

const ROLE_META: Record<SubagentRole, { label: string; icon: React.ReactNode }> = {
  researcher: { label: "Researcher", icon: <Search size={11} /> },
  tester: { label: "Tester", icon: <Terminal size={11} /> },
  coder: { label: "Coder", icon: <Code2 size={11} /> },
  architect: { label: "Architect", icon: <Compass size={11} /> },
  "code-reviewer": { label: "Code Reviewer", icon: <CheckCheck size={11} /> },
  "security-reviewer": { label: "Security Reviewer", icon: <Shield size={11} /> },
  "tdd-guide": { label: "TDD Guide", icon: <TestTube2 size={11} /> },
  "build-error-resolver": { label: "Build Fixer", icon: <Wrench size={11} /> },
  "refactor-cleaner": { label: "Refactorer", icon: <Sparkles size={11} /> },
  "database-reviewer": { label: "DB Reviewer", icon: <Database size={11} /> },
};

function formatRoleName(role: string): string {
  return (role || "Agent")
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function pickRoleIcon(role: string): React.ReactNode {
  const r = (role || "").toLowerCase();
  if (r.includes("review") || r.includes("eval")) return <CheckCheck size={11} />;
  if (r.includes("security") || r.includes("shield") || r.includes("guard")) return <Shield size={11} />;
  if (r.includes("architect") || r.includes("plan")) return <Compass size={11} />;
  if (r.includes("test") || r.includes("tdd")) return <TestTube2 size={11} />;
  if (r.includes("build") || r.includes("resolver") || r.includes("fix")) return <Wrench size={11} />;
  if (r.includes("clean") || r.includes("refactor") || r.includes("simplify")) return <Sparkles size={11} />;
  if (r.includes("data") || r.includes("sql") || r.includes("db") || r.includes("postgres")) return <Database size={11} />;
  if (r.includes("search") || r.includes("explore") || r.includes("lookup") || r.includes("research")) return <Search size={11} />;
  if (r.includes("terminal") || r.includes("shell") || r.includes("cmd") || r.includes("cli")) return <Terminal size={11} />;
  return <Code2 size={11} />;
}

export function SubagentCardView({ subagent, timestamp }: { subagent: SubagentItem; timestamp: string }) {
  const [expanded, setExpanded] = useState(false);
  const meta = ROLE_META[subagent.role] || { label: formatRoleName(subagent.role), icon: pickRoleIcon(subagent.role) };
  const roleLabel = meta.label;
  const roleIcon = meta.icon;

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
