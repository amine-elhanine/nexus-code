import React, { useRef, useState, useMemo } from "react";
import {
  Bot,
  Terminal,
  Activity,
  X,
  Brain,
  Check,
  Copy,
  Lightbulb,
  Loader2,
  ChevronDown,
  ChevronRight,
  FileText,
  FileCode,
  FileEdit,
  Search,
  Sparkles,
  Globe,
  AlertCircle,
} from "lucide-react";
import { RichMarkdown } from "../common/RichMarkdown.js";
import { timeLabel } from "../../utils/format.js";
import { isImageAttachment, formatAttachmentSize } from "../../utils/attachments.js";
import { PlanCard } from "./PlanCard.js";
import { SubagentCardView } from "./SubagentCard.js";
import { ArtifactCard } from "./ArtifactCard.js";
import type { ChatAttachment, ChatItem, ArtifactItem, PlanItem, SubagentItem } from "../../types.js";

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (permissions / non-secure context) — fallback.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  if (!text) return null;
  return (
    <button
      className="pane-action"
      style={{ display: "inline-flex", alignItems: "center" }}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={copied ? "Copied!" : "Copy to clipboard"}
      aria-label={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

export type StepStatus = "pending" | "running" | "completed" | "error";

export type StepCategory =
  | "read"
  | "write"
  | "run"
  | "search"
  | "skill"
  | "browse"
  | "plan"
  | "thinking"
  | "subagent"
  | "artifact"
  | "status"
  | "error";

export interface ParsedStepMeta {
  category: StepCategory;
  badgeLabel: string;
  title: string;
  target?: string;
  command?: string;
  query?: string;
  skill?: string;
}

export interface NormalizedStep {
  id: string;
  category: StepCategory;
  badgeLabel: string;
  title: string;
  target?: string;
  command?: string;
  query?: string;
  skill?: string;
  detail?: string;
  status: StepStatus;
  timestamp: string;
  plan?: PlanItem[];
  subagent?: SubagentItem;
  artifact?: ArtifactItem;
}

export function parseEventText(text: string, kind?: string): ParsedStepMeta {
  const clean = (text || "").trim();

  // 0. Reasoning deltas — a Claude-Code-style thinking step. Checked first so
  // thinking prose that happens to contain "·" or "✓" is never mis-parsed as
  // a tool call. The full reasoning text travels as the step's detail.
  if (kind === "thinking") {
    return {
      category: "thinking",
      badgeLabel: "THINKING",
      title: "Thinking",
    };
  }

  // 1. Skill loading or consulting
  if (/^Consulting skill:\s*(.+)$/i.test(clean) || /^Skill loaded:\s*(.+?)(?:\s*✓)?$/i.test(clean)) {
    const skill = clean.replace(/^(?:Consulting skill:\s*|Skill loaded:\s*)/i, "").replace(/✓$/, "").trim();
    return {
      category: "skill",
      badgeLabel: "SKILL",
      title: "Consult skill",
      skill,
    };
  }

  // 2. Tool calls formatted as "tool_name · arg_summary"
  const toolDotMatch = clean.match(/^([a-zA-Z0-9_-]+)\s*·\s*(.+)$/);
  if (toolDotMatch) {
    const tool = toolDotMatch[1];
    const arg = toolDotMatch[2].trim();

    switch (tool) {
      case "read_file":
      case "read_file_range":
        return {
          category: "read",
          badgeLabel: "READ",
          title: "Read file",
          target: arg,
        };
      case "write_file":
        return {
          category: "write",
          badgeLabel: "WRITE",
          title: "Create file",
          target: arg,
        };
      case "edit_file":
        return {
          category: "write",
          badgeLabel: "EDIT",
          title: "Edit file",
          target: arg,
        };
      case "apply_patch":
        return {
          category: "write",
          badgeLabel: "PATCH",
          title: "Apply patch",
          target: arg,
        };
      case "execute":
        return {
          category: "run",
          badgeLabel: "BASH",
          title: "Execute command",
          command: arg,
        };
      case "grep":
      case "grep_search":
        return {
          category: "search",
          badgeLabel: "GREP",
          title: "Search code",
          query: arg,
        };
      case "glob":
        return {
          category: "search",
          badgeLabel: "GLOB",
          title: "Find files",
          query: arg,
        };
      case "ls":
        return {
          category: "search",
          badgeLabel: "LIST",
          title: "List directory",
          target: arg,
        };
      case "find_symbol_definition":
      case "find_symbol_references":
      case "get_symbol_outline":
        return {
          category: "search",
          badgeLabel: "LSP",
          title: "Inspect symbol",
          target: arg,
        };
      case "web_search":
        return {
          category: "browse",
          badgeLabel: "WEB",
          title: "Web search",
          query: arg,
        };
      case "browser_inspect":
      case "browser_fetch_api":
        return {
          category: "browse",
          badgeLabel: "BROWSE",
          title: "Inspect page",
          target: arg,
        };
      case "ask_user":
        return {
          category: "status",
          badgeLabel: "ASK",
          title: "Ask user",
          query: arg.replace(/^needs input:\s*/i, ""),
        };
      case "delegate_task": {
        const roleMatch = arg.match(/^\[([^\]]+)\]\s*(.*)$/);
        return {
          category: "subagent",
          badgeLabel: "AGENT",
          title: roleMatch ? `Subagent [${roleMatch[1]}]` : "Subagent task",
          query: roleMatch ? roleMatch[2] : arg,
        };
      }
      default:
        return {
          category: "run",
          badgeLabel: tool.toUpperCase().slice(0, 7),
          title: tool,
          target: arg,
        };
    }
  }

  // 3. Simple tool completion marker like "tool_name ✓"
  const doneMatch = clean.match(/^([a-zA-Z0-9_-]+)\s*✓$/);
  if (doneMatch) {
    const tool = doneMatch[1];
    return {
      category: "run",
      badgeLabel: tool.toUpperCase().slice(0, 7),
      title: `${tool} completed`,
    };
  }

  // 4. Notebook steps
  if (/^working:\s*(.+)$/i.test(clean)) {
    const desc = clean.replace(/^working:\s*/i, "");
    return {
      category: "search",
      badgeLabel: "RERANK",
      title: desc,
    };
  }

  if (/^searching\s+/i.test(clean)) {
    return {
      category: "search",
      badgeLabel: "SEARCH",
      title: clean,
    };
  }

  if (/^synthesizing|^generating/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "STUDIO",
      title: clean,
    };
  }

  if (/^starting the (?:notebook )?agent/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "INIT",
      title: "Starting the agent…",
    };
  }

  if (/^starting home assistant/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "INIT",
      title: "Starting Home Assistant…",
    };
  }

  if (/^starting agent\s*·/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "INIT",
      title: "Starting agent",
      query: clean.replace(/^starting agent\s*·\s*/i, ""),
    };
  }

  if (/^preparing context/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "CTX",
      title: "Preparing context",
      query: clean.replace(/^preparing context\s*·?\s*/i, ""),
    };
  }

  if (/^agent is working on the task$/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "WORK",
      title: "Working on the task",
    };
  }

  if (/^writing response/i.test(clean)) {
    return {
      category: "status",
      badgeLabel: "STREAM",
      title: "Synthesizing response…",
    };
  }

  if (kind === "error") {
    return {
      category: "error",
      badgeLabel: "ERROR",
      title: clean || "Execution error",
    };
  }

  if (kind === "plan") {
    return {
      category: "plan",
      badgeLabel: "PLAN",
      title: clean || "Working plan",
    };
  }

  if (kind === "subagent") {
    return {
      category: "subagent",
      badgeLabel: "AGENT",
      title: clean || "Subagent task",
    };
  }

  return {
    category: "status",
    badgeLabel: "STEP",
    title: clean || "Agent step",
  };
}

function getCategoryIcon(category: StepCategory, size = 11) {
  switch (category) {
    case "read":
      return <FileText size={size} />;
    case "write":
      return <FileEdit size={size} />;
    case "run":
      return <Terminal size={size} />;
    case "search":
      return <Search size={size} />;
    case "skill":
      return <Sparkles size={size} />;
    case "browse":
      return <Globe size={size} />;
    case "plan":
      return <Brain size={size} />;
    case "thinking":
      return <Lightbulb size={size} />;
    case "subagent":
      return <Bot size={size} />;
    case "artifact":
      return <FileCode size={size} />;
    case "error":
      return <AlertCircle size={size} />;
    default:
      return <Activity size={size} />;
  }
}

function formatTarget(target: string): string {
  if (target.length <= 42) return target;
  const parts = target.split("/");
  if (parts.length > 2) {
    return `${parts[0]}/…/${parts[parts.length - 1]}`;
  }
  return target.slice(0, 40) + "…";
}

function getActionVerb(title: string, isRunning: boolean): string {
  if (!isRunning) {
    switch (title) {
      case "Execute command":
        return "Executed command";
      case "Read file":
        return "Read file";
      case "Create file":
        return "Created file";
      case "Edit file":
        return "Edited file";
      case "Apply patch":
        return "Applied patch";
      case "Search code":
        return "Searched code";
      case "Find files":
        return "Found files";
      case "List directory":
        return "Listed directory";
      case "Inspect symbol":
        return "Inspected symbol";
      case "Web search":
        return "Web search";
      case "Inspect page":
        return "Inspected page";
      case "Consult skill":
        return "Consulted skill";
      case "Thinking":
        return "Thought";
      default:
        return title;
    }
  }

  switch (title) {
    case "Execute command":
      return "Executing command";
    case "Read file":
      return "Reading file";
    case "Create file":
      return "Creating file";
    case "Edit file":
      return "Editing file";
    case "Apply patch":
      return "Applying patch";
    case "Search code":
      return "Searching code";
    case "Find files":
      return "Finding files";
    case "List directory":
      return "Listing directory";
    case "Inspect symbol":
      return "Inspecting symbol";
    case "Web search":
      return "Searching web";
    case "Inspect page":
      return "Inspecting page";
    case "Consult skill":
      return "Consulting skill";
    case "Thinking":
      return "Thinking";
    default:
      return title;
  }
}

function computeStepsSummary(steps: NormalizedStep[]): string {
  let reads = 0;
  let writes = 0;
  let runs = 0;
  let searches = 0;
  let skills = 0;

  for (const s of steps) {
    if (s.category === "read") reads++;
    else if (s.category === "write") writes++;
    else if (s.category === "run") runs++;
    else if (s.category === "search") searches++;
    else if (s.category === "skill") skills++;
  }

  const parts: string[] = [];
  if (reads) parts.push(`read ${reads} file${reads > 1 ? "s" : ""}`);
  if (writes) parts.push(`edited ${writes} file${writes > 1 ? "s" : ""}`);
  if (runs) parts.push(`ran ${runs} command${runs > 1 ? "s" : ""}`);
  if (searches) parts.push(`searched ${searches} time${searches > 1 ? "s" : ""}`);
  if (skills) parts.push(`used ${skills} skill${skills > 1 ? "s" : ""}`);

  if (parts.length === 0) return "";
  return parts.slice(0, 2).join(", ");
}

function normalizeActivityEvents(
  events: ChatItem[],
  running: boolean,
  currentText?: string
): NormalizedStep[] {
  const steps: NormalizedStep[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    // Plans are rendered in the sliding plan drawer above the text area, not in the steps timeline
    if (event.kind === "plan") {
      continue;
    }
    // Telemetry-only events never render as steps: context snapshots and
    // usage rows have no user-facing action (context snapshots even carry
    // empty text, which used to surface as junk "Agent step" rows).
    if (event.kind === "context" || event.kind === "usage" || event.kind === "stream-reset") {
      continue;
    }
    const isError = event.kind === "error";
    const isSubagent = event.kind === "subagent" && Boolean(event.subagent);
    const isArtifact = Boolean(event.artifact);
    const isDoneMarker = Boolean(event.text && /✓$/.test(event.text.trim()));

    // Merge matching completion markers (e.g. "execute ✓", "read_file ✓") into previous tool step
    if (isDoneMarker && steps.length > 0) {
      const prev = steps[steps.length - 1];
      const doneTool = (event.text || "").replace(/✓$/, "").trim();
      const prevDesc = events[i - 1]?.text || "";
      const matches =
        (Boolean(doneTool) && prevDesc.startsWith(doneTool)) ||
        (doneTool.startsWith("Skill loaded:") && prev.category === "skill") ||
        (prev.status === "running" && prev.category !== "thinking");

      if (matches) {
        prev.status = "completed";
        if (!prev.detail && (event.detail || event.text)) {
          prev.detail = event.detail || event.text;
        }
        continue;
      }
    }

    // Consecutive subagent events for the SAME subagent merge into ONE step
    // card: progress/thinking deltas (which re-send the full item) update the
    // existing card in place instead of spawning a noisy row per event.
    if (isSubagent && steps.length > 0) {
      const prev = steps[steps.length - 1];
      if (prev.category === "subagent" && prev.subagent?.id && prev.subagent.id === event.subagent?.id) {
        prev.subagent = event.subagent;
        if (running && i === events.length - 1) {
          prev.status = event.subagent?.status === "failed" ? "error" : event.subagent?.status === "completed" ? "completed" : "running";
        } else if (event.subagent?.status === "failed") {
          prev.status = "error";
        }
        continue;
      }
    }

    const parsed = parseEventText(event.text, event.kind);

    let category: StepCategory = parsed.category;
    let badgeLabel = parsed.badgeLabel;
    if (isError) {
      category = "error";
      badgeLabel = "ERROR";
    } else if (isSubagent) {
      category = "subagent";
      badgeLabel = "AGENT";
    } else if (isArtifact) {
      category = "artifact";
      badgeLabel = "ARTIFACT";
    }

    const isLastEvent = i === events.length - 1;
    let status: StepStatus = "completed";
    if (isError) {
      status = "error";
    } else if (running && isLastEvent && !isDoneMarker && !currentText?.startsWith("Writing response")) {
      status = "running";
    }

    // Expandable detail rules: only attach detail that ADDS information.
    //   - structured detail (tool result excerpts, subagent reports) wins
    //     unless it just repeats the row's own text;
    //   - thinking/artifact/subagent/error rows fall back to the event text
    //     (that text IS their content);
    //   - plain status/tool rows get NO fallback detail — expanding to read
    //     the exact same line again is noise, and without a fake detail the
    //     ✓ merge can still fill the real result excerpt in afterwards.
    const cleanText = (event.text || "").trim();
    const rawDetail = (event.detail || "").trim();
    const structuredDetail = rawDetail && rawDetail !== cleanText ? event.detail : undefined;
    const keepTextFallback =
      category === "thinking" || isError || isArtifact;

    steps.push({
      id: `${event.createdAt}-${i}`,
      category,
      badgeLabel,
      title: parsed.title,
      target: parsed.target,
      command: parsed.command,
      query: parsed.query,
      skill: parsed.skill,
      detail: structuredDetail ?? (keepTextFallback ? cleanText || undefined : undefined),
      status,
      timestamp: event.createdAt,
      plan: event.plan,
      subagent: event.subagent,
      artifact: event.artifact,
    });
  }

  // If running and no events arrived yet, provide an initial active thinking step
  if (running && steps.length === 0) {
    steps.push({
      id: "initial-working-step",
      category: "status",
      badgeLabel: "INIT",
      title: "Starting the agent",
      query: currentText || "Preparing workspace context and tools…",
      status: "running",
      timestamp: new Date().toISOString(),
    });
  }

  return steps;
}

function StepItemView({
  step,
  isExpanded,
  onToggle,
  onOpenArtifact,
}: {
  step: NormalizedStep;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
}) {
  const isRunning = step.status === "running";
  const isError = step.status === "error";
  const displayTitle = getActionVerb(step.title, isRunning);

  const hasDetail = Boolean(
    (step.detail && step.detail.trim().length > 0) ||
    step.artifact ||
    step.subagent ||
    (step.plan && step.plan.length > 0)
  );

  return (
    <div className={`agent-timeline-step ${step.status}`}>
      <div className={`step-timeline-node ${step.status}`}>
        {isRunning ? (
          <Loader2 size={10} className="spin" />
        ) : isError ? (
          <X size={10} />
        ) : (
          <Check size={9} />
        )}
      </div>

      <div className={`step-card ${step.status} ${isExpanded ? "expanded" : ""}`}>
        <div
          className={`step-card-header ${hasDetail ? "" : "static"}`}
          onClick={hasDetail ? onToggle : undefined}
          title={hasDetail ? (isExpanded ? "Click to collapse" : "Click to view output") : undefined}
        >
          <div className="step-badge-and-title">
            <span className={`step-category-pill ${step.category}`}>
              {getCategoryIcon(step.category, 9)}
              <span>{step.badgeLabel}</span>
            </span>

            <span className="step-title-text">
              <span className="step-verb">{displayTitle}</span>

              {step.target && (
                <code className="step-code-target" title={step.target}>
                  {formatTarget(step.target)}
                </code>
              )}

              {step.command && (
                <code className="step-command-target" title={step.command}>
                  $ {step.command}
                </code>
              )}

              {step.query && (
                <span className="step-query-target" title={step.query}>
                  "{step.query}"
                </span>
              )}

              {step.skill && (
                <span className="step-skill-target" title={step.skill}>
                  {step.skill}
                </span>
              )}
            </span>
          </div>

          <div className="step-meta">
            {isRunning && (
              <span className="step-live-pill">
                <span className="live-dot" />
                Working
              </span>
            )}

            <time className="step-time">{timeLabel(step.timestamp)}</time>

            {hasDetail && (
              <span className={`step-expand-icon ${isExpanded ? "open" : ""}`}>
                <ChevronRight size={12} />
              </span>
            )}
          </div>
        </div>

        {isExpanded && hasDetail && (
          <div className="step-card-details">
            {step.artifact && (
              <div className="step-embed-card">
                <ArtifactCard
                  artifact={step.artifact}
                  onClick={() => onOpenArtifact?.(step.artifact!)}
                />
              </div>
            )}

            {step.subagent && (
              <div className="step-embed-card">
                <SubagentCardView subagent={step.subagent} timestamp={step.timestamp} />
              </div>
            )}

            {step.plan && step.plan.length > 0 && (
              <div className="step-embed-card">
                <PlanCard plan={step.plan} createdAt={step.timestamp} />
              </div>
            )}

            {step.detail && step.detail.trim().length > 0 && (
              <div className={`step-detail-container ${isError ? "error-detail" : ""} ${step.category === "thinking" ? "thinking-detail" : ""}`}>
                <div className="step-detail-header">
                  <span className="step-detail-label">
                    {step.category === "thinking" ? (
                      <Lightbulb size={10} />
                    ) : step.category === "run" ? (
                      <Terminal size={10} />
                    ) : isError ? (
                      <AlertCircle size={10} />
                    ) : (
                      <FileText size={10} />
                    )}
                    {isError ? "Error trace" : step.category === "thinking" ? "Reasoning" : "Output"}
                  </span>
                  <CopyTextButton text={step.detail} />
                </div>
                <pre className={`step-detail-pre ${step.category === "thinking" ? "thinking-detail-pre" : ""}`}>{step.detail}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ActivityGroupView({
  events,
  running,
  currentText,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
}: {
  events: ChatItem[];
  running: boolean;
  currentText?: string;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
}) {
  const steps = useMemo(
    () => normalizeActivityEvents(events, running, currentText),
    [events, running, currentText]
  );

  const hasError = useMemo(
    () => events.some((e) => e.kind === "error") || steps.some((s) => s.status === "error"),
    [events, steps]
  );

  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const isGroupExpanded = userExpanded !== null ? userExpanded : (running || hasError);

  const [expandedStepIds, setExpandedStepIds] = useState<Record<string, boolean>>({});

  const toggleStep = (id: string) => {
    setExpandedStepIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const activeStep = steps.find((s) => s.status === "running") || steps[steps.length - 1];

  // ZCode-style collapsed summary: "Worked for 2m 36s" computed from the
  // first to last step timestamps. Detailed counts stay in the tooltip.
  const workedLabel = useMemo(() => {
    if (running || !steps.length) return null;
    const start = Date.parse(steps[0].timestamp);
    const end = Date.parse(steps[steps.length - 1].timestamp);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
    if (totalSeconds < 8) return "Worked for a few seconds";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `Worked for ${minutes}m ${seconds}s` : `Worked for ${seconds}s`;
  }, [running, steps]);

  let headerTitle = "Completed agent activity";
  if (running) {
    if (currentText) {
      headerTitle = currentText;
    } else if (activeStep) {
      const verb = getActionVerb(activeStep.title, true);
      const target = activeStep.target || activeStep.command || activeStep.skill || activeStep.query;
      headerTitle = target ? `${verb}: ${formatTarget(target)}` : verb;
    } else {
      headerTitle = "Agent working on task…";
    }
  } else if (workedLabel) {
    headerTitle = workedLabel;
  } else if (hasError) {
    headerTitle = "Agent encountered an issue";
  } else {
    const summarySuffix = computeStepsSummary(steps);
    const count = steps.length;
    headerTitle = `Completed ${count} agent ${count === 1 ? "step" : "steps"}${
      summarySuffix ? ` (${summarySuffix})` : ""
    }`;
  }

  const isWritingResponse = running && Boolean(currentText?.startsWith("Writing response"));

  return (
    <div
      className={`activity-group ${
        running ? "running" : hasError ? "error" : "completed"
      }`}
    >
      <button
        className="activity-group-summary"
        onClick={() => setUserExpanded(!isGroupExpanded)}
        title={
          running
            ? undefined
            : (() => {
                const summarySuffix = computeStepsSummary(steps);
                return summarySuffix ? `${steps.length} steps — ${summarySuffix}` : `${steps.length} steps`;
              })()
        }
      >
        <span className="activity-group-icon">
          {running ? (
            <div className="step-beacon-wrap">
              <span className="step-beacon-core" />
              <span className="step-beacon-ring" />
            </div>
          ) : hasError ? (
            <AlertCircle size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>

        <span className="activity-group-title">
          <span className={running ? "running-label" : ""}>{headerTitle}</span>
        </span>

        {running && (
          <span className="activity-group-count">
            <span className="beacon-live-dot" />
            {steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "Working"}
          </span>
        )}

        <span className={`activity-group-chevron ${isGroupExpanded ? "open" : ""}`}>
          <ChevronDown size={14} />
        </span>
      </button>

      {isGroupExpanded && (
        <div className="activity-group-body">
          <div className="agent-stepper-timeline">
            {steps.map((step, index) => {
              // All steps start COLLAPSED — the user opens exactly what they
              // want to inspect (Claude-Code-style). The explicit boolean
              // fallback below also makes the first click reliably toggle:
              // previously auto-opened steps needed two clicks to close
              // because the toggle flipped an undefined default.
              const isStepExpanded = Boolean(expandedStepIds[step.id]);

              return (
                <StepItemView
                  key={step.id}
                  step={step}
                  isExpanded={isStepExpanded}
                  onToggle={() => toggleStep(step.id)}
                  onOpenArtifact={onOpenArtifact}
                />
              );
            })}
          </div>

          {isWritingResponse && (
            <div className="agent-working-bar">
              <Loader2 size={12} className="spin" />
              <span>Synthesizing final response…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatItemView({
  message,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
}: {
  message: ChatItem;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
}) {
  if (message.artifact) {
    return (
      <ArtifactCard
        artifact={message.artifact}
        onClick={() => onOpenArtifact?.(message.artifact!)}
      />
    );
  }
  if (message.role === "event" && message.kind === "subagent" && message.subagent) {
    return <SubagentCardView subagent={message.subagent} timestamp={message.createdAt} />;
  }
  if (message.role === "event" && message.kind === "plan") {
    return null;
  }
  // Telemetry-only events (context snapshots, usage rows, stream resets) are
  // machinery, not activity — never render them as transcript rows.
  if (message.role === "event" && (message.kind === "context" || message.kind === "usage" || message.kind === "stream-reset")) {
    return null;
  }
  if (message.role === "event" && message.kind === "thinking") {
    // Reasoning block (Claude-Code-style): italic reasoning prose only — the
    // accumulated text already lives in detail, so skip the plain-text body.
    return (
      <div className="chat-event-row thinking">
        <span className="step-category-pill mini thinking">
          <Lightbulb size={10} />
          THINKING
        </span>
        <div className="chat-event-body">
          {(message.detail || message.text) && (
            <pre className="chat-event-detail thinking-detail-pre">{message.detail || message.text}</pre>
          )}
        </div>
        <time>{timeLabel(message.createdAt)}</time>
      </div>
    );
  }
  if (message.role === "event") {
    const parsed = parseEventText(message.text, message.kind);
    return (
      <div className={`chat-event-row ${message.kind || parsed.category}`}>
        <span className={`step-category-pill mini ${parsed.category}`}>
          {getCategoryIcon(parsed.category, 10)}
          {parsed.badgeLabel}
        </span>
        <div className="chat-event-body">
          <p>
            {message.text}
          </p>
          {message.detail && (
            <pre className="chat-event-detail">{message.detail}</pre>
          )}
        </div>
        <time>{timeLabel(message.createdAt)}</time>
      </div>
    );
  }
  return (
    <div className={`chat-message ${message.role}`}>
      <div className="chat-author">
        {message.role === "assistant" ? (
          <>
            <span className="agent-avatar">
              <Bot size={13} />
            </span>{" "}
            Nexus
          </>
        ) : (
          <>
            <span className="you-avatar">ME</span> You
          </>
        )}
        <time>{timeLabel(message.createdAt)}</time>
      </div>
      {message.images && message.images.length > 0 && (
        <div className="chat-message-images">
          {message.images.map((img, idx) => (
            <button key={idx} className="chat-attached-image-button" onClick={() => onOpenImage?.(img)} title="Open attached image">
              <img src={img} alt="Attached screenshot" className="chat-attached-img" />
            </button>
          ))}
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className="chat-message-images">
          {message.attachments
            .filter((attachment) => !isImageAttachment(attachment))
            .map((attachment, idx) => (
              <button
                key={`${attachment.name}-${idx}`}
                className="chat-attached-file-button"
                onClick={() => onOpenAttachment?.(attachment)}
                title={`${attachment.name} — click to preview`}
              >
                <FileText size={13} />
                <span className="chat-attached-file-name">{attachment.name}</span>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </button>
            ))}
        </div>
      )}
      <RichMarkdown source={message.text} className="chat-message-text" />
      {message.role === "assistant" && Boolean(message.text?.trim()) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <CopyTextButton text={message.text} />
        </div>
      )}
    </div>
  );
}

export function StreamingAssistantMessage({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="chat-message assistant streaming">
      <div className="chat-author">
        <span className="agent-avatar">
          <Bot size={13} />
        </span>{" "}
        Nexus
        <time>{timeLabel(new Date().toISOString())}</time>
      </div>
      <RichMarkdown source={text} className="chat-message-text" />
    </div>
  );
}
