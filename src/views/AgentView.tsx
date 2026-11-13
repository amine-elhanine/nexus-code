import React, { useEffect, useMemo, useRef, useState, useCallback, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, GitBranch, RotateCcw, Check, FileCode2,
  Paperclip, FileText, Plus, Square, ArrowUp, ShieldCheck, ChevronDown, X,
  Bug, Code2, CheckCircle2, Compass, MessageSquare, Zap, Flame, Terminal, Cpu, Brain,
  Search, Settings
} from "lucide-react";
import { WorktreeBar } from "../components/worktree/WorktreeBar.js";
import { SlashCommandPopup, filterSlashCommands, DEFAULT_SLASH_COMMANDS, type SlashCommand } from "../components/chat/SlashCommandPopup.js";
import { ChatItemView, ActivityGroupView, StreamingAssistantMessage } from "../components/chat/ChatMessageItem.js";
import { fileIcon } from "../utils/format.js";
import { ATTACHMENT_ACCEPT, formatAttachmentSize, isImageAttachment, openChatAttachment } from "../utils/attachments.js";
import { insertAtCursor } from "../utils/textarea.js";
import { useAutosizeTextarea } from "../state/useComposer.js";
import { ChatShell } from "../components/chat/ChatShell.js";
import { formatCost } from "../types.js";
import type { ChatItem, FileEntry, ProviderConfig, ProviderDefinition, AgentUsage, AgentContextUsageSnapshot, ArtifactItem, ChatAttachment, SkillInfo, WorkspaceDiffFile } from "../types.js";
import { SlidingPlanDrawer, extractLatestPlan } from "../components/chat/SlidingPlanDrawer.js";
import { resolveModelEfforts, formatEffortLabel, resolveModelContextWindow, resolveModelMaxOutput, formatContextWindow, formatTokenCount, computeCompactionThreshold } from "../utils/modelEfforts.js";

const AGENT_STARTERS = [
  { icon: <Sparkles size={14} style={{ color: "#60a5fa" }} />, label: "Review changes & test", desc: "Inspect git diff, run test suites, and fix any failures", prompt: "Review all recent Git changes, run the test suites, and fix any failing tests or type errors." },
  { icon: <Bug size={14} style={{ color: "#f87171" }} />, label: "Fix bug or regression", desc: "Locate error stacktraces and repair broken logic", prompt: "Debug and fix the issue where " },
  { icon: <Code2 size={14} style={{ color: "#34d399" }} />, label: "Add feature or endpoint", desc: "Design and implement new functionality with full type safety", prompt: "Add a feature to " },
  { icon: <Compass size={14} style={{ color: "#a78bfa" }} />, label: "Explore architecture", desc: "Map out project modules, symbol references, and flow", prompt: "Analyze the workspace architecture, list the main entry points, and summarize the key design patterns used." },
];

const CODE_ACTION_PILLS = [
  { id: "diff", label: "Review Diff", icon: <GitBranch size={13} />, prefix: "Review current git diff and changes: ", placeholder: "Ask to review git diff, inspect modified files, or explain changes..." },
  { id: "test", label: "Run Tests", icon: <CheckCircle2 size={13} />, prefix: "Run workspace tests and fix any failures: ", placeholder: "Ask to run unit or integration tests, fix broken suites, or check coverage..." },
  { id: "inspect", label: "Inspect Code", icon: <Search size={13} />, prefix: "Inspect and trace codebase architecture for: ", placeholder: "Ask to trace functions, inspect dependencies, or map symbols in the workspace..." },
  { id: "terminal", label: "Terminal Run", icon: <Terminal size={13} />, prefix: "Run build or terminal command: ", placeholder: "Describe a terminal command, dev server check, or build task to execute..." },
];

export function ModelContextLine({
  providerId,
  model,
  provider,
  definition,
  sessionUsage,
  contextUsage,
  activeSessionId,
}: {
  providerId: string;
  model: string;
  provider?: ProviderConfig;
  definition?: ProviderDefinition;
  sessionUsage?: AgentUsage | null;
  contextUsage?: AgentContextUsageSnapshot | null;
  activeSessionId?: string;
}) {
  const [detectedContext, setDetectedContext] = useState<{ contextWindow?: number; maxOutput?: number } | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    arrowLeft: number;
    placement: "above" | "below";
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const cancelPendingHide = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const updateTooltipPos = useCallback(() => {
    if (!lineRef.current) return;
    const rect = lineRef.current.getBoundingClientRect();
    const tooltipWidth = 340;
    const pillCenter = rect.left + rect.width / 2;
    let left = pillCenter - tooltipWidth / 2;
    left = Math.max(16, Math.min(window.innerWidth - tooltipWidth - 16, left));
    const arrowLeft = Math.max(20, Math.min(tooltipWidth - 20, pillCenter - left));

    const spaceAbove = rect.top;
    if (spaceAbove >= 280) {
      setTooltipPos({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        arrowLeft,
        placement: "above",
      });
    } else {
      setTooltipPos({
        left,
        top: Math.max(8, rect.bottom + 8),
        arrowLeft,
        placement: "below",
      });
    }
  }, []);

  const withinHoverRegion = (x: number, y: number) => {
    const pad = 12;
    const rects = [lineRef.current?.getBoundingClientRect(), tooltipRef.current?.getBoundingClientRect()];
    return rects.some((rect) => rect && x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad);
  };

  const hideIfPointerLeft = () => {
    hoverTimerRef.current = null;
    const point = lastPointerRef.current;
    if (point && withinHoverRegion(point.x, point.y)) {
      hoverTimerRef.current = setTimeout(hideIfPointerLeft, 350);
      return;
    }
    setIsHovered(false);
  };

  const scheduleHide = () => {
    cancelPendingHide();
    hoverTimerRef.current = setTimeout(hideIfPointerLeft, 200);
  };

  const handleMouseEnter = (event?: React.MouseEvent) => {
    if (event) lastPointerRef.current = { x: event.clientX, y: event.clientY };
    cancelPendingHide();
    updateTooltipPos();
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    scheduleHide();
  };

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isHovered) return;
    const onPointerMove = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      if (withinHoverRegion(event.clientX, event.clientY)) {
        cancelPendingHide();
      } else if (!hoverTimerRef.current) {
        hoverTimerRef.current = setTimeout(hideIfPointerLeft, 200);
      }
    };
    const onScrollOrResize = () => {
      updateTooltipPos();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [isHovered, updateTooltipPos]);

  useEffect(() => {
    setDetectedContext(null);
    if (!providerId || !model) return;

    const savedCtx = provider?.modelContextWindows?.[model];
    if (savedCtx === undefined) {
      const api = typeof window !== "undefined" ? (window.nexus) : undefined;
      if (api?.detectProviderModelContext) {
        void api.detectProviderModelContext(providerId, model).then((res) => {
          if (res && res.contextWindow) {
            setDetectedContext({ contextWindow: res.contextWindow, maxOutput: res.maxOutput });
          }
        }).catch(() => {});
      }
    }
  }, [providerId, model, provider?.id]);

  const contextWindow =
    contextUsage?.contextWindow ??
    provider?.modelContextWindows?.[model] ??
    detectedContext?.contextWindow ??
    resolveModelContextWindow(providerId, model, provider, definition);

  const maxOutput =
    provider?.modelMaxOutputs?.[model] ??
    detectedContext?.maxOutput ??
    resolveModelMaxOutput(providerId, model, provider, definition);

  const compactionThreshold = contextUsage?.compactionThreshold ?? computeCompactionThreshold(contextWindow, maxOutput);
  const thresholdPct = Math.min(95, Math.max(5, (compactionThreshold / contextWindow) * 100));

  const ctxLabel = formatContextWindow(contextWindow);
  const usedTokens = contextUsage?.usedTokens || contextUsage?.inputTokens || contextUsage?.totalTokens || sessionUsage?.inputTokens || sessionUsage?.totalTokens || 0;
  const pct = Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100));
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  const tokensToThreshold = Math.max(0, compactionThreshold - usedTokens);

  // Per-category prompt composition
  const breakdownRows = contextUsage?.breakdown?.length ? contextUsage.breakdown : null;
  const breakdownTotal = breakdownRows ? breakdownRows.reduce((sum, entry) => sum + entry.tokens, 0) : 0;

  // Prompt-cache hit rate for the run / session
  const cacheInput = contextUsage?.cacheInputTokens ?? sessionUsage?.inputTokens ?? 0;
  const cacheRead = contextUsage?.cacheReadTokens ?? sessionUsage?.cacheReadTokens ?? 0;
  const cacheRate = cacheInput > 0 ? (cacheRead / cacheInput) * 100 : 0;

  const isNearThreshold = usedTokens >= compactionThreshold * 0.85;
  const isAtThreshold = usedTokens >= compactionThreshold;

  let statusTone: "normal" | "warning" | "critical" = "normal";
  if (isAtThreshold || pct >= 90) statusTone = "critical";
  else if (isNearThreshold || pct >= 70) statusTone = "warning";

  let badgeLabel = "CTX";
  let badgeClass = "context-badge";
  if (isAtThreshold) {
    badgeLabel = "AUTO-COMPACT";
    badgeClass = "context-badge critical";
  } else if (isNearThreshold) {
    badgeLabel = "NEAR COMPACT";
    badgeClass = "context-badge warning";
  }

  const handleCompactNow = async () => {
    const api = typeof window !== "undefined" ? (window.nexus) : undefined;
    if (!api?.compactSession) return;
    setIsCompacting(true);
    setCompactNotice(null);
    try {
      const res = await api.compactSession({ sessionId: activeSessionId });
      if (res?.freedTokens) {
        setCompactNotice(`Freed ${formatTokenCount(res.freedTokens)} tokens`);
      } else if (res?.notice) {
        setCompactNotice(res.notice);
      } else {
        setCompactNotice("Context compacted successfully.");
      }
    } catch (err) {
      setCompactNotice(err instanceof Error ? err.message : "Compaction failed");
    } finally {
      setIsCompacting(false);
    }
  };

  return (
    <div
      ref={lineRef}
      className={`model-context-line status-${statusTone}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="group"
      aria-label={`Context window ${ctxLabel} — retained context ${usedTokens.toLocaleString()} of ${formatTokenCount(contextWindow)} tokens. Auto-compacts at ${thresholdPct.toFixed(0)}%`}
    >
      <span className={badgeClass}>{badgeLabel}</span>
      <span className="context-value">{ctxLabel}</span>
      <div
        className="context-meter-track"
        title={`Retained context: ${usedTokens.toLocaleString()} / ${formatTokenCount(contextWindow)} tokens (${pct.toFixed(1)}%) • Auto-compacts at ${thresholdPct.toFixed(0)}% (${formatTokenCount(compactionThreshold)} tokens)`}
      >
        <div
          className="context-meter-threshold"
          style={{ left: `${thresholdPct}%` }}
          title={`Auto-compaction threshold: ${formatTokenCount(compactionThreshold)} tokens (${thresholdPct.toFixed(0)}%)`}
        />
        <div
          className={`context-meter-fill status-${statusTone}`}
          style={{ width: `${usedTokens > 0 ? Math.max(pct, 4) : 0}%` }}
        />
      </div>

      {isHovered && tooltipPos && typeof document !== "undefined" && createPortal(
        <div
          ref={tooltipRef}
          className={`context-info-tooltip placement-${tooltipPos.placement}`}
          style={{
            position: "fixed",
            left: `${tooltipPos.left}px`,
            top: tooltipPos.top !== undefined ? `${tooltipPos.top}px` : undefined,
            bottom: tooltipPos.bottom !== undefined ? `${tooltipPos.bottom}px` : undefined,
            zIndex: 99999,
            transform: "none",
            ["--arrow-left" as any]: `${tooltipPos.arrowLeft}px`,
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="ctx-tip-header">
            <div className="ctx-tip-title-wrap">
              <span className="ctx-tip-title">Context Window</span>
              <span className="ctx-tip-model-pill" title={model}>
                {model}
              </span>
            </div>
            <span
              className="ctx-total"
              title={`${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
            >
              {formatTokenCount(usedTokens)}
              <span className="ctx-total-dim"> / {ctxLabel} ({pct.toFixed(1)}%)</span>
            </span>
          </div>

          <div className="ctx-bar-wrap">
            <div className="ctx-bar-track">
              <div
                className="ctx-bar-threshold-mark"
                style={{ left: `${thresholdPct}%` }}
                title={`Auto-compacts at ${thresholdPct.toFixed(0)}% (${formatTokenCount(compactionThreshold)} tokens)`}
              />
              <div
                className={`ctx-bar-fill status-${statusTone}`}
                style={{ width: `${usedTokens > 0 ? Math.max(pct, 3) : 0}%` }}
              />
            </div>
          </div>

          {breakdownRows && (
            <div className="ctx-breakdown-section">
              <div className="ctx-breakdown-grid">
                {breakdownRows.map((entry, index) => (
                  <div
                    key={entry.label}
                    className="ctx-breakdown-item"
                    title={`${entry.label}: ~${entry.tokens.toLocaleString()} tokens`}
                  >
                    <span className="ctx-breakdown-dot" style={{ opacity: Math.max(0.4, 1 - index * 0.12) }} />
                    <span className="ctx-breakdown-label">{entry.label}</span>
                    <span className="ctx-breakdown-pct">
                      {breakdownTotal > 0 ? ((entry.tokens / breakdownTotal) * 100).toFixed(1) : "0.0"}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="ctx-stats-grid">
            <div
              className={`ctx-stat-card${cacheRead > 0 ? " highlight-success" : ""}`}
              title={
                cacheInput > 0
                  ? `${formatTokenCount(cacheRead)} (${cacheRead.toLocaleString()}) of ${formatTokenCount(cacheInput)} (${cacheInput.toLocaleString()}) input tokens served from prompt cache`
                  : "Prompt cache accounting for this session"
              }
            >
              <span className="ctx-stat-label">Cache Hit</span>
              <span className="ctx-stat-val">
                {cacheRead > 0
                  ? `${cacheRate.toFixed(cacheRate < 10 ? 1 : 0)}% (${formatTokenCount(cacheRead)})`
                  : cacheInput > 0
                  ? "0% (0 cached)"
                  : "0% (fresh)"}
              </span>
            </div>

            <div className="ctx-stat-card" title={`${contextWindow.toLocaleString()} tokens total context limit`}>
              <span className="ctx-stat-label">Context Limit</span>
              <span className="ctx-stat-val">
                {formatTokenCount(contextWindow)} <span className="ctx-stat-sub">({contextWindow.toLocaleString()})</span>
              </span>
            </div>

            <div className="ctx-stat-card" title={`${usedTokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens used (${pct.toFixed(1)}%)`}>
              <span className="ctx-stat-label">Retained Context</span>
              <span className="ctx-stat-val">
                {formatTokenCount(usedTokens)} <span className="ctx-stat-sub">({pct.toFixed(1)}%)</span>
              </span>
            </div>

            <div
              className="ctx-stat-card highlight-warning"
              title={`Auto-compaction threshold: ${compactionThreshold.toLocaleString()} tokens (${thresholdPct.toFixed(1)}%)`}
            >
              <span className="ctx-stat-label">Auto-Compact At</span>
              <span className="ctx-stat-val">
                {formatTokenCount(compactionThreshold)} <span className="ctx-stat-sub">({thresholdPct.toFixed(0)}%)</span>
              </span>
            </div>

            <div className="ctx-stat-card" title={`${tokensToThreshold.toLocaleString()} tokens remaining before auto-compaction triggers`}>
              <span className="ctx-stat-label">Headroom</span>
              <span className="ctx-stat-val">{formatTokenCount(tokensToThreshold)} tokens</span>
            </div>

            <div className="ctx-stat-card" title={maxOutput ? `${maxOutput.toLocaleString()} tokens max completion limit` : "Default max output"}>
              <span className="ctx-stat-label">Max Output</span>
              <span className="ctx-stat-val">{maxOutput ? `${formatTokenCount(maxOutput)}` : "Default"}</span>
            </div>

            <div className="ctx-stat-card" title={`Input: ${(sessionUsage?.inputTokens ?? 0).toLocaleString()} • Output: ${(sessionUsage?.outputTokens ?? 0).toLocaleString()} tokens`}>
              <span className="ctx-stat-label">Session In / Out</span>
              <span className="ctx-stat-val">
                {formatTokenCount(sessionUsage?.inputTokens ?? 0)} / {formatTokenCount(sessionUsage?.outputTokens ?? 0)}
              </span>
            </div>

            <div className="ctx-stat-card" title="Estimated cost for current session">
              <span className="ctx-stat-label">Est. Cost</span>
              <span className="ctx-stat-val">
                {sessionUsage?.estimatedCost != null && sessionUsage.estimatedCost > 0
                  ? formatCost(sessionUsage.estimatedCost)
                  : "$0.00"}
              </span>
            </div>
          </div>

          <div className="ctx-actions">
            <button
              type="button"
              className="ctx-compact-btn"
              disabled={isCompacting || usedTokens < 1000}
              onClick={(e) => {
                e.stopPropagation();
                void handleCompactNow();
              }}
              title={usedTokens < 1000 ? "Session is fresh, compaction not needed yet" : "Compact context now (like Claude Code /compact)"}
            >
              <Sparkles size={11} />
              {isCompacting ? "Compacting History…" : "Compact Context Now"}
            </button>
            {compactNotice && (
              <div className="ctx-compact-notice">
                <span>{compactNotice}</span>
              </div>
            )}
          </div>

          <div className="ctx-tip-footer">
            <span>Auto-compacts near context window limit like Claude Code & Codex</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export function ModelSelect({
  selectedProviderId,
  selectedModel,
  selectedEffort,
  providers,
  definitions,
  switchModel,
  switchEffort,
  onOpenProviders,
  sessionUsage,
  contextUsage,
  activeSessionId,
}: {
  selectedProviderId: string;
  selectedModel: string;
  selectedEffort?: string;
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  switchModel: (providerId: string, model: string, effort?: string) => void;
  switchEffort?: (effort: string) => void;
  onOpenProviders: () => void;
  sessionUsage?: AgentUsage | null;
  contextUsage?: AgentContextUsageSnapshot | null;
  activeSessionId?: string;
}) {
  const provider = providers.find((item) => item.id === selectedProviderId);
  const def = definitions.find((d) => d.id === (provider?.provider || selectedProviderId));
  const modelExists = provider?.models.includes(selectedModel);

  const [discoveredEfforts, setDiscoveredEfforts] = useState<string[] | null>(null);
  const [isModelOpen, setIsModelOpen] = useState(false);
  const [isEffortOpen, setIsEffortOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelMenuPos, setModelMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    placement: "above" | "below";
  } | null>(null);
  const [effortMenuPos, setEffortMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    placement: "above" | "below";
  } | null>(null);

  const modelBtnRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const effortBtnRef = useRef<HTMLButtonElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const updateModelMenuPos = useCallback(() => {
    if (!modelBtnRef.current) return;
    const rect = modelBtnRef.current.getBoundingClientRect();
    const menuWidth = 290;
    let left = rect.left;
    left = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, left));

    const spaceAbove = rect.top;
    if (spaceAbove >= 280) {
      setModelMenuPos({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        placement: "above",
      });
    } else {
      setModelMenuPos({
        left,
        top: Math.max(8, rect.bottom + 6),
        placement: "below",
      });
    }
  }, []);

  const updateEffortMenuPos = useCallback(() => {
    if (!effortBtnRef.current) return;
    const rect = effortBtnRef.current.getBoundingClientRect();
    const menuWidth = 180;
    let left = rect.left;
    left = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, left));

    const spaceAbove = rect.top;
    if (spaceAbove >= 220) {
      setEffortMenuPos({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        placement: "above",
      });
    } else {
      setEffortMenuPos({
        left,
        top: Math.max(8, rect.bottom + 6),
        placement: "below",
      });
    }
  }, []);

  // Click outside & Escape for model menu
  useEffect(() => {
    if (!isModelOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(target) &&
        modelBtnRef.current &&
        !modelBtnRef.current.contains(target)
      ) {
        setIsModelOpen(false);
      }
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsModelOpen(false);
      }
    };
    const handleResizeOrScroll = () => {
      updateModelMenuPos();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleResizeOrScroll, true);
    window.addEventListener("resize", handleResizeOrScroll);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleResizeOrScroll, true);
      window.removeEventListener("resize", handleResizeOrScroll);
    };
  }, [isModelOpen, updateModelMenuPos]);

  // Click outside & Escape for effort menu
  useEffect(() => {
    if (!isEffortOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        effortMenuRef.current &&
        !effortMenuRef.current.contains(target) &&
        effortBtnRef.current &&
        !effortBtnRef.current.contains(target)
      ) {
        setIsEffortOpen(false);
      }
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsEffortOpen(false);
      }
    };
    const handleResizeOrScroll = () => {
      updateEffortMenuPos();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleResizeOrScroll, true);
    window.addEventListener("resize", handleResizeOrScroll);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleResizeOrScroll, true);
      window.removeEventListener("resize", handleResizeOrScroll);
    };
  }, [isEffortOpen, updateEffortMenuPos]);

  // Background auto-discover efforts for selected model if not cached yet
  useEffect(() => {
    setDiscoveredEfforts(null);
    if (!selectedProviderId || !selectedModel || !provider || !modelExists) return;

    if (!provider.modelEfforts || provider.modelEfforts[selectedModel] === undefined) {
      const api = typeof window !== "undefined" ? (window.nexus) : undefined;
      if (api?.detectProviderModelEfforts) {
        void api.detectProviderModelEfforts(selectedProviderId, selectedModel).then((detected) => {
          if (detected && detected.length > 0) {
            setDiscoveredEfforts(detected);
          }
        }).catch(() => {});
      }
    }
  }, [selectedProviderId, selectedModel, provider?.id, modelExists]);

  const supportedEfforts = resolveModelEfforts(selectedProviderId, selectedModel, provider, def);

  // Display detected efforts if available, else standard reasoning levels
  const displayEfforts = useMemo(() => {
    if (supportedEfforts.length > 0) return supportedEfforts;
    if (discoveredEfforts && discoveredEfforts.length > 0) return discoveredEfforts;
    return ["low", "medium", "high", "max"];
  }, [supportedEfforts, discoveredEfforts]);

  const hasSelectedModel = Boolean(selectedModel);

  const totalModelsCount = useMemo(() => {
    return providers.reduce((sum, p) => sum + (p.enabled !== false ? p.models.length : 0), 0);
  }, [providers]);

  const filteredProviders = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const enabled = providers.filter((p) => p.enabled !== false);
    if (!q) return enabled;
    return enabled
      .map((p) => {
        const matchesProvider = p.label.toLowerCase().includes(q);
        const matchingModels = p.models.filter(
          (m) => matchesProvider || m.toLowerCase().includes(q)
        );
        return {
          ...p,
          models: matchingModels,
        };
      })
      .filter((p) => p.models.length > 0);
  }, [providers, modelSearch]);

  return (
    <div className="model-select-wrapper">
      <button
        ref={modelBtnRef}
        type="button"
        className={`model-select${isModelOpen ? " active" : ""}`}
        onClick={() => {
          if (!isModelOpen) {
            updateModelMenuPos();
            setIsEffortOpen(false);
            setModelSearch("");
            setIsModelOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 60);
          } else {
            setIsModelOpen(false);
          }
        }}
        title={selectedModel ? `Model: ${selectedModel}` : "Select model"}
        aria-haspopup="dialog"
        aria-expanded={isModelOpen}
      >
        <Cpu size={12} className="model-select-icon" />
        <span className="model-select-text">
          {selectedModel || (providers.length ? "Select model…" : "Configure provider…")}
        </span>
        <ChevronDown size={11} className={`model-select-chevron${isModelOpen ? " open" : ""}`} />
      </button>

      {isModelOpen && modelMenuPos && typeof document !== "undefined" && createPortal(
        <div
          ref={modelMenuRef}
          className={`model-menu-popover placement-${modelMenuPos.placement}`}
          style={{
            position: "fixed",
            left: `${modelMenuPos.left}px`,
            top: modelMenuPos.top !== undefined ? `${modelMenuPos.top}px` : undefined,
            bottom: modelMenuPos.bottom !== undefined ? `${modelMenuPos.bottom}px` : undefined,
            zIndex: 99999,
          }}
          role="dialog"
          aria-label="Select Model"
        >
          {totalModelsCount > 4 && (
            <div className="model-menu-search-box">
              <Search size={12} className="model-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                className="model-search-input"
                placeholder="Search models…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setIsModelOpen(false);
                  }
                }}
              />
              {modelSearch && (
                <button
                  type="button"
                  className="model-search-clear"
                  onClick={() => setModelSearch("")}
                  title="Clear search"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          )}

          <div className="model-menu-list">
            {filteredProviders.length === 0 ? (
              <div className="model-menu-empty">No matching models found</div>
            ) : (
              filteredProviders.map((item) => (
                <div key={item.id} className="model-menu-group">
                  <div className="model-menu-group-header">
                    <span>{item.label}</span>
                  </div>
                  {item.models.map((m) => {
                    const isSelected = item.id === selectedProviderId && m === selectedModel;
                    return (
                      <button
                        key={`${item.id}-${m}`}
                        type="button"
                        className={`model-menu-item${isSelected ? " selected" : ""}`}
                        onClick={() => {
                          switchModel(item.id, m);
                          setIsModelOpen(false);
                        }}
                        title={m}
                      >
                        <span className="model-item-name">{m}</span>
                        {isSelected && <Check size={12} className="model-item-check" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="model-menu-footer">
            <button
              type="button"
              className="model-menu-action-btn"
              onClick={() => {
                setIsModelOpen(false);
                onOpenProviders();
              }}
            >
              <Settings size={12} />
              <span>Configure Providers…</span>
            </button>
          </div>
        </div>,
        document.body
      )}

      <button
        ref={effortBtnRef}
        type="button"
        disabled={!hasSelectedModel}
        className={`effort-select${isEffortOpen ? " active" : ""}${!hasSelectedModel ? " disabled" : ""}`}
        onClick={() => {
          if (!hasSelectedModel) return;
          if (!isEffortOpen) {
            updateEffortMenuPos();
            setIsModelOpen(false);
            setIsEffortOpen(true);
          } else {
            setIsEffortOpen(false);
          }
        }}
        title={hasSelectedModel ? `Reasoning effort for ${selectedModel}` : "Select a model to set reasoning effort"}
        aria-haspopup="dialog"
        aria-expanded={isEffortOpen}
      >
        <span className="effort-badge">EFFORT</span>
        <span className="effort-select-text">{formatEffortLabel(selectedEffort || "auto")}</span>
        <ChevronDown size={11} className={`effort-select-chevron${isEffortOpen ? " open" : ""}`} />
      </button>

      {isEffortOpen && effortMenuPos && typeof document !== "undefined" && createPortal(
        <div
          ref={effortMenuRef}
          className={`effort-menu-popover placement-${effortMenuPos.placement}`}
          style={{
            position: "fixed",
            left: `${effortMenuPos.left}px`,
            top: effortMenuPos.top !== undefined ? `${effortMenuPos.top}px` : undefined,
            bottom: effortMenuPos.bottom !== undefined ? `${effortMenuPos.bottom}px` : undefined,
            zIndex: 99999,
          }}
          role="dialog"
          aria-label="Reasoning Effort"
        >
          <div className="effort-menu-header">
            <span>Reasoning Effort</span>
          </div>

          <div className="effort-menu-list">
            <button
              type="button"
              className={`effort-menu-item${!selectedEffort ? " selected" : ""}`}
              onClick={() => {
                if (switchEffort) switchEffort("");
                else switchModel(selectedProviderId, selectedModel, "");
                setIsEffortOpen(false);
              }}
            >
              <div className="effort-item-text">
                <span className="effort-item-name">Auto</span>
                <span className="effort-item-badge">Default</span>
              </div>
              {!selectedEffort && <Check size={12} className="effort-item-check" />}
            </button>

            {displayEfforts.map((eff) => {
              const isSelected = selectedEffort?.toLowerCase() === eff.toLowerCase();
              return (
                <button
                  key={eff}
                  type="button"
                  className={`effort-menu-item${isSelected ? " selected" : ""}`}
                  onClick={() => {
                    if (switchEffort) switchEffort(eff);
                    else switchModel(selectedProviderId, selectedModel, eff);
                    setIsEffortOpen(false);
                  }}
                >
                  <span className="effort-item-name">{formatEffortLabel(eff)}</span>
                  {isSelected && <Check size={12} className="effort-item-check" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}

      {hasSelectedModel && (
        <ModelContextLine
          providerId={selectedProviderId}
          model={selectedModel}
          provider={provider}
          definition={def}
          sessionUsage={sessionUsage}
          contextUsage={contextUsage}
          activeSessionId={activeSessionId}
        />
      )}
    </div>
  );
}

export function AgentView({
  hasProject,
  activeFile,
  messages,
  draft,
  setDraft,
  submit,
  running,
  onStop,
  streamingText,
  liveEvents,
  mode,
  setMode,
  selectedProviderId,
  selectedModel,
  selectedEffort,
  providers,
  definitions,
  files,
  checkpointId,
  diffCount,
  diffFiles,
  undoLevels,
  onUndoRun,
  onKeepChanges,
  switchModel,
  switchEffort,
  onOpenProviders,
  onAttachFile,
  onAttachDiff,
  sessionUsage,
  contextUsage,
  activeSessionId,
  worktreeStatus,
  onOpenArtifact,
  onOpenImage,
  onOpenAttachment,
  onOpenDiff,
  onMergeSuccess,
  onDiscardSuccess,
  attachedImages,
  setAttachedImages,
  attachments,
  setAttachments,
  customCommands,
  skills,
  onRefreshSkills,
  onTruncateSession,
  onForkSession,
  codeRightSidebarOpen,
  onOpenInspector,
  onOpenEditor,
  onOpenTerminal,
  onOpenExtensions,
  tasksCount,
  goalsCount,
}: {
  hasProject: boolean;
  activeFile: string;
  messages: ChatItem[];
  draft: string;
  setDraft: (value: string) => void;
  submit: (override?: string) => void;
  running: boolean;
  onStop: () => void;
  streamingText: string;
  liveEvents: ChatItem[];
  mode: string;
  setMode: (value: string) => void;
  selectedProviderId: string;
  selectedModel: string;
  selectedEffort?: string;
  providers: ProviderConfig[];
  definitions: ProviderDefinition[];
  files: FileEntry[];
  checkpointId?: string;
  diffCount: number;
  diffFiles?: WorkspaceDiffFile[];
  undoLevels?: number;
  onUndoRun: (id: string) => void;
  onKeepChanges: () => void;
  switchModel: (providerId: string, model: string, effort?: string) => void;
  switchEffort?: (effort: string) => void;
  onOpenProviders: () => void;
  onAttachFile: () => void;
  onAttachDiff: () => void;
  sessionUsage?: AgentUsage;
  contextUsage?: AgentUsage | null;
  activeSessionId?: string;
  worktreeStatus?: { isGit: boolean; worktree: { worktreePath: string; branch: string } | null } | null;
  onOpenArtifact?: (artifact: ArtifactItem) => void;
  onOpenImage?: (src: string) => void;
  onOpenAttachment?: (attachment: ChatAttachment) => void;
  onOpenDiff?: () => void;
  onMergeSuccess?: () => void;
  onDiscardSuccess?: () => void;
  attachedImages: string[];
  setAttachedImages: React.Dispatch<React.SetStateAction<string[]>>;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  customCommands?: SlashCommand[];
  skills?: SkillInfo[];
  onRefreshSkills?: () => void;
  onTruncateSession?: (fromIndex: number) => Promise<any>;
  onForkSession?: (fromIndex: number) => Promise<any>;
  codeRightSidebarOpen?: boolean;
  onOpenInspector?: (section?: "tasks" | "goals") => void;
  onOpenEditor?: () => void;
  onOpenTerminal?: () => void;
  onOpenExtensions?: () => void;
  tasksCount?: number;
  goalsCount?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // Stick to the bottom only while the user is already there; reading history
  // mid-run must not be yanked around by every streamed token.
  const stickToBottomRef = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = transcriptRef.current;
    if (!el) return;
    if (smooth) {
      bottomAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const api = window.nexus;
  const [showComposerMenu, setShowComposerMenu] = useState(false);
  const [activeCodePill, setActiveCodePill] = useState<string | null>(null);

  // Auto-resize textarea (shared composer hook, Code-tuned 28-180px)
  useAutosizeTextarea(textareaRef, draft, { min: 28, max: 180 });

  // ZCode-style change summary: collapsed "N files changed +a −d" row whose
  // file list expands underneath.
  const [showDiffList, setShowDiffList] = useState(false);
  const diffTotals = useMemo(
    () =>
      (diffFiles || []).reduce(
        (acc, file) => ({ add: acc.add + (file.additions || 0), del: acc.del + (file.deletions || 0) }),
        { add: 0, del: 0 }
      ),
    [diffFiles]
  );


  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  const matchingCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return filterSlashCommands(slashQuery, customCommands, DEFAULT_SLASH_COMMANDS);
  }, [slashQuery, customCommands]);

  const latestPlan = useMemo(() => extractLatestPlan(liveEvents, messages, running), [liveEvents, messages, running]);

  const transcriptNodes: ReactNode[] = [];
  let pendingActivity: ChatItem[] = [];
  let pendingArtifacts: ArtifactItem[] = [];
  const flushActivity = () => {
    if (pendingActivity.length) {
      transcriptNodes.push(
        <ActivityGroupView
          key={`activity-${pendingActivity[0].createdAt}-${transcriptNodes.length}`}
          events={pendingActivity}
          running={false}
          onOpenArtifact={onOpenArtifact}
          onOpenImage={onOpenImage}
          onOpenAttachment={onOpenAttachment}
        />
      );
      pendingActivity = [];
    }
  };
  function openAttachment(attachment: ChatAttachment) {
    openChatAttachment(attachment, onOpenAttachment, onOpenImage);
  }
  messages.forEach((message, index) => {
    if (message.role === "event") {
      pendingActivity.push(message);
      if (message.artifact) {
        pendingArtifacts.push(message.artifact);
      }
    } else {
      flushActivity();
      const turnArtifacts = message.role === "assistant" && pendingArtifacts.length > 0 ? [...pendingArtifacts] : undefined;
      pendingArtifacts = [];
      transcriptNodes.push(
        <ChatItemView
          key={`${message.createdAt}-${index}`}
          message={message}
          index={index}
          artifacts={turnArtifacts}
          onOpenArtifact={onOpenArtifact}
          onOpenImage={onOpenImage}
          onOpenAttachment={onOpenAttachment}
          onEditMessage={running ? undefined : (idx, text) => {
            setDraft(text);
            void onTruncateSession?.(idx);
          }}
          onForkChat={running ? undefined : (idx) => {
            void onForkSession?.(idx);
          }}
          onRegenerate={running ? undefined : (idx) => {
            let userIdx = idx;
            for (let i = idx - 1; i >= 0; i--) {
              if (messages[i]?.role === "user") {
                userIdx = i;
                break;
              }
            }
            const promptText = messages[userIdx]?.text || "";
            if (promptText) {
              void Promise.resolve(onTruncateSession?.(userIdx)).then(() => {
                submit(promptText);
              });
            }
          }}
        />
      );
    }
  });
  flushActivity();

  const [localSkills, setLocalSkills] = useState<SkillInfo[] | null>(null);
  const effectiveSkills = localSkills || skills || [];

  const mentionItems = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    const matchingSkills = effectiveSkills
      .filter((s) => {
        if (s.modes && s.modes.length > 0 && !s.modes.includes("code")) return false;
        return (
          s.name.toLowerCase().includes(query) ||
          (query.length >= 2 && s.description.toLowerCase().includes(query))
        );
      })
      .slice(0, 5)
      .map((s) => ({ kind: "skill" as const, name: s.name, description: s.description }));

    const matchingFileList = files
      .filter((f) => f.kind === "file" && f.path.toLowerCase().includes(query))
      .slice(0, 8)
      .map((f) => ({ kind: "file" as const, path: f.path }));

    return [...matchingSkills, ...matchingFileList];
  }, [mentionQuery, effectiveSkills, files]);

  function updateCursorTriggers(value: string, cursorPosition: number) {
    const beforeCursor = value.slice(0, cursorPosition);
    const mentionMatch = beforeCursor.match(/@([a-zA-Z0-9_./-]*)$/);
    if (mentionMatch) {
      setMentionQuery(mentionMatch[1]);
      setMentionIndex(0);
      setSlashQuery(null);
      onRefreshSkills?.();
      api?.listSkills?.().then((list) => {
        if (Array.isArray(list)) setLocalSkills(list);
      }).catch(() => {});
      return;
    } else {
      setMentionQuery(null);
    }

    const slashMatch = beforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setSlashIndex(0);
    } else {
      setSlashQuery(null);
    }
  }

  function handleDraftChange(value: string, cursorPosition: number) {
    setDraft(value);
    updateCursorTriggers(value, cursorPosition);
  }

  function insertMentionItem(item: { kind: "skill"; name: string } | { kind: "file"; path: string }) {
    const textToInsert = item.kind === "skill" ? `@${item.name} ` : `@${item.path} `;
    const result = insertAtCursor(textareaRef.current, draft, /@([a-zA-Z0-9_./-]*)$/, textToInsert);
    if (!result) return;
    setDraft(result.nextDraft);
    setMentionQuery(null);
    setTimeout(() => textareaRef.current?.focus(), 10);
  }

  function handleSlashSelect(cmd: SlashCommand) {
    if (cmd.mode) {
      setMode(cmd.mode === "plan" ? "Plan" : cmd.mode === "auto" ? "Auto" : cmd.mode === "full" ? "Full" : "Ask");
    }
    const result = insertAtCursor(textareaRef.current, draft, /(?:^|\s)\/([a-zA-Z0-9_-]*)$/, (match) => {
      const leadingWhitespace = match.match(/^\s/)?.[0] || "";
      return `${leadingWhitespace}${cmd.command} `;
    });
    if (!result) return;
    setDraft(result.nextDraft);
    setSlashQuery(null);
    setSlashIndex(0);

    const newCursor = result.cursor;
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCursor, newCursor);
      }
    }, 0);
  }

  function handleSendMessage(overrideText?: string) {
    const text = (overrideText ?? draft).trim();
    if (text === "/diff") {
      setDraft("");
      onOpenDiff?.();
      return;
    }
    if (text === "/help") {
      setDraft("");
      stickToBottomRef.current = true;
      submit("What tools, commands, and skills are available in this project?");
      setTimeout(() => scrollToBottom(true), 60);
      return;
    }
    if (text === "/checkpoint") {
      setDraft("");
      stickToBottomRef.current = true;
      submit("Create checkpoint and review workspace state");
      setTimeout(() => scrollToBottom(true), 60);
      return;
    }
    if (text === "/test") {
      setDraft("");
      stickToBottomRef.current = true;
      submit("Run project verification and tests");
      setTimeout(() => scrollToBottom(true), 60);
      return;
    }
    stickToBottomRef.current = true;
    submit(overrideText);
    setTimeout(() => scrollToBottom(true), 60);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = async (loadEvt) => {
            const rawUrl = loadEvt.target?.result as string;
            if (rawUrl) {
              if (api?.saveAttachment) {
                try {
                  const saved = await api.saveAttachment(rawUrl, file.name || "pasted-image.png");
                  setAttachments((current) => [...current, { url: saved.url, name: file.name || "pasted-image.png", mimeType: file.type || "image/png", size: file.size }]);
                  setAttachedImages((current) => [...current, saved.url]);
                  return;
                } catch { /* ignore fallback */ }
              }
              setAttachments((current) => [...current, { url: rawUrl, name: file.name || "pasted-image.png", mimeType: file.type || "image/png", size: file.size }]);
              setAttachedImages((current) => [...current, rawUrl]);
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }
  }

  function handleImageFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList) return;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.type || file.name) {
        const mimeType = file.type || "application/octet-stream";
        const isImage = mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
        const reader = new FileReader();
        reader.onload = async (loadEvt) => {
          const rawUrl = loadEvt.target?.result as string;
          if (rawUrl) {
            if (api?.saveAttachment) {
              try {
                const saved = await api.saveAttachment(rawUrl, file.name);
                setAttachments((current) => [...current, { url: saved.url, name: file.name, mimeType, size: file.size }]);
                if (isImage) setAttachedImages((current) => [...current, saved.url]);
                return;
              } catch { /* ignore fallback */ }
            }
            setAttachments((current) => [...current, { url: rawUrl, name: file.name, mimeType, size: file.size }]);
            if (isImage) setAttachedImages((current) => [...current, rawUrl]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
    event.target.value = "";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && mentionItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % mentionItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMentionItem(mentionItems[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }

    if (slashQuery !== null && matchingCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((c) => (c + 1) % matchingCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((c) => (c - 1 + matchingCommands.length) % matchingCommands.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashQuery(null);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          const selected = matchingCommands[((slashIndex % matchingCommands.length) + matchingCommands.length) % matchingCommands.length];
          if (selected) {
            handleSlashSelect(selected);
          }
          return;
        }
      }
    }

    if (event.key === "Enter") {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const target = event.currentTarget;
          const start = target.selectionStart || 0;
          const end = target.selectionEnd || 0;
          const val = draft;
          const nextVal = val.substring(0, start) + "\n" + val.substring(end);
          setDraft(nextVal);
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 1;
            }
          }, 0);
        }
        return;
      }
      event.preventDefault();
      const pillObj = CODE_ACTION_PILLS.find((p) => p.id === activeCodePill);
      if (pillObj && draft.trim() && !draft.startsWith(pillObj.prefix)) {
        handleSendMessage(`${pillObj.prefix}${draft.trim()}`);
      } else {
        handleSendMessage();
      }
      setActiveCodePill(null);
    }
  }

  return (
    <div className="agent-view" style={{ position: "relative" }}>
      {activeSessionId && worktreeStatus?.isGit && worktreeStatus.worktree && (
        <WorktreeBar
          sessionId={activeSessionId}
          isGit={worktreeStatus.isGit}
          worktree={worktreeStatus.worktree}
          onMergeSuccess={onMergeSuccess}
          onDiscardSuccess={onDiscardSuccess}
        />
      )}
      {!messages.length && (
        <div className="agent-view-head">
          <div>
            <span className="view-kicker">CODING AGENT</span>
            <h1>
              {running
                ? "Working on your task"
                : hasProject
                ? "Ready for your task"
                : "Open a project to begin"}
            </h1>
            <p>
              {running
                ? "The agent is using the selected project context."
                : hasProject
                ? "Describe the outcome. Nexus will inspect, plan, implement and validate."
                : "Create or open a local project. Nothing is preloaded."}
            </p>
          </div>
        </div>
      )}
      <ChatShell
        className="agent-transcript"
        transcriptRef={transcriptRef}
        stickRef={stickToBottomRef}
        scrollKey={`${messages.length}:${liveEvents.length}:${streamingText}:${running}`}
      >
        {!messages.length && (
          <div className="empty-agent codex-hero">
            <div className="empty-agent-icon codex-hero-icon">
              <Terminal size={22} />
            </div>
            <div className="codex-hero-badge">OPENAI CODEX ENGINE · {mode.toUpperCase()} MODE</div>
            <h2>What should we build or fix today?</h2>
            <p>
              Autonomous software engineering with live diffs, sandboxed terminal execution, and instant checkpoints. Reference files with <code>@</code> or run commands with <code>/</code>.
            </p>
            <div className="starter-prompts codex-starter-grid">
              {AGENT_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  className="codex-starter-card"
                  onClick={() => {
                    setDraft(starter.prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="codex-starter-icon">{starter.icon}</span>
                    <span className="codex-starter-card-title">{starter.label}</span>
                  </div>
                  <span className="codex-starter-card-desc">{starter.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {transcriptNodes}
        {running && (
          <ActivityGroupView
            events={liveEvents}
            running={true}
            currentText={streamingText ? "Writing response…" : undefined}
            onOpenArtifact={onOpenArtifact}
            onOpenImage={onOpenImage}
            onOpenAttachment={openAttachment}
          />
        )}
        {running && streamingText && (
          <StreamingAssistantMessage text={streamingText} onOpenArtifact={onOpenArtifact} />
        )}
        <div ref={bottomAnchorRef} className="transcript-bottom-anchor" style={{ height: 1, minHeight: 1, flexShrink: 0 }} />
      </ChatShell>
      {checkpointId && !running && (diffCount > 0 || (undoLevels || 0) > 0) && (
        <div className="rollback-anchor">
          <div className="rollback-card">
            <button
              className="rollback-summary"
              onClick={() => setShowDiffList((v) => !v)}
              disabled={!diffFiles?.length}
              title={diffFiles?.length ? "Show the changed files" : undefined}
            >
              <ChevronDown size={14} className={`rollback-chev${showDiffList ? " open" : ""}`} />
              <GitBranch size={14} />
              <span>
                <strong>{diffCount} file{diffCount === 1 ? "" : "s"} changed</strong>
                {diffTotals.add > 0 && <b className="diff-stat add"> +{diffTotals.add.toLocaleString()}</b>}
                {diffTotals.del > 0 && <b className="diff-stat del"> −{diffTotals.del.toLocaleString()}</b>}
                {(undoLevels || 0) > 1 && <span> · {undoLevels} levels</span>}
              </span>
            </button>
            <div className="rollback-actions">
              {onOpenDiff && (
                <button
                  type="button"
                  className="btn-review"
                  onClick={onOpenDiff}
                  title="Open the full Git diff inspection panel"
                >
                  <GitBranch size={12} /> Review
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => onUndoRun(checkpointId)}
                title="Restore pre-run files and roll back Nexus-only session commits"
              >
                <RotateCcw size={12} /> {(undoLevels || 0) > 1 ? `Undo (${undoLevels})` : "Undo"}
              </button>
              <button type="button" className="primary" onClick={onKeepChanges} title="Accept and clear all undo history for this session">
                <Check size={12} /> Keep changes
              </button>
            </div>
          </div>
          {showDiffList && diffFiles?.length ? (
            <div className="rollback-files">
              {diffFiles.map((file) => (
                <button
                  key={file.path}
                  className="rollback-file-row"
                  onClick={() => onOpenDiff?.()}
                  title={`${file.path} — open the diff panel`}
                >
                  {fileIcon(file.name)}
                  <span className="rollback-file-path">{file.directory ? `${file.directory}/${file.name}` : file.name}</span>
                  <b className="diff-stat add">+{file.additions || 0}</b>
                  <b className="diff-stat del">−{file.deletions || 0}</b>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      <div className="code-composer-wrapper home-composer-wrapper">
        <input
          type="file"
          ref={imageInputRef}
          style={{ display: "none" }}
          accept={ATTACHMENT_ACCEPT}
          multiple
          onChange={handleImageFileSelect}
        />
        <SlidingPlanDrawer
          plan={latestPlan?.plan}
          running={running}
          isInterrupted={latestPlan?.isInterrupted}
          onContinue={() => submit("continue")}
        />
        <div className="code-composer-box home-composer-box" style={{ position: "relative" }}>
          {mentionQuery !== null && mentionItems.length > 0 && (
            <div className="mention-dropdown">
              {mentionItems.map((item, idx) => (
                <button
                  key={item.kind === "skill" ? `skill-${item.name}` : `file-${item.path}`}
                  className={`mention-item ${idx === mentionIndex ? "active" : ""}`}
                  onClick={() => insertMentionItem(item)}
                >
                  {item.kind === "skill" ? (
                    <>
                      <Sparkles size={12} style={{ color: "#a496ff", flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: "#e1dbff" }}>@{item.name}</span>
                      <span className="mention-badge">Skill</span>
                      {item.description && <span className="mention-desc">— {item.description}</span>}
                    </>
                  ) : (
                    <>
                      {fileIcon(item.path)}
                      <span>{item.path}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
          {slashQuery !== null && matchingCommands.length > 0 && (
            <SlashCommandPopup
              filter={slashQuery}
              items={matchingCommands}
              customCommands={customCommands}
              selectedIndex={slashIndex}
              onSelect={handleSlashSelect}
            />
          )}
          {attachments.length > 0 && (
            <div className="home-composer-attachments">
              {attachments.map((attachment, idx) => (
                <div className="home-attachment-pill" key={`${attachment.url}-${idx}`}>
                  <button
                    type="button"
                    className="attachment-chip-main"
                    onClick={() => openAttachment(attachment)}
                    title={`${attachment.name} — click to preview`}
                  >
                    {isImageAttachment(attachment)
                      ? <img src={attachment.url} alt={attachment.name} className="image-preview-thumb" />
                      : <FileText size={13} />}
                    <span className="attachment-file-name">{attachment.name}</span>
                    <small>{formatAttachmentSize(attachment.size)}</small>
                  </button>
                  <button
                    type="button"
                    className="image-preview-remove"
                    onClick={() => {
                      setAttachments((current) => current.filter((_, i) => i !== idx));
                      setAttachedImages((current) => current.filter((image) => image !== attachment.url));
                    }}
                    title={`Remove ${attachment.name}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="home-composer-textarea code-composer-textarea"
            value={draft}
            onFocus={() => {
              onRefreshSkills?.();
              api?.listSkills?.().then((list) => {
                if (Array.isArray(list)) setLocalSkills(list);
              }).catch(() => {});
            }}
            onChange={(event) =>
              handleDraftChange(
                event.target.value,
                event.target.selectionStart || event.target.value.length
              )
            }
            onSelect={(event) => {
              const target = event.currentTarget;
              updateCursorTriggers(target.value, target.selectionStart || target.value.length);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              CODE_ACTION_PILLS.find((p) => p.id === activeCodePill)?.placeholder ||
              (messages.length ? "Ask for follow-up changes…" : "Ask Nexus to inspect, edit, test, or review your project… (Ctrl+V images, @ files, / commands)")
            }
          />
          <div className="code-composer-toolbar home-composer-toolbar">
            <div className="code-composer-tools-group home-composer-tools-group">
              <div className="composer-more-wrap">
                <button
                  type="button"
                  className="attach-button composer-tool-btn"
                  onClick={() => setShowComposerMenu(!showComposerMenu)}
                  title="Attach context (Current file, Git diff, files, images)"
                >
                  <Plus size={14} />
                </button>
                {showComposerMenu && (
                  <div className="composer-menu">
                    <button disabled={!activeFile} onClick={onAttachFile}>
                      <FileCode2 size={13} /> Attach current file {activeFile ? `(${activeFile.split("/").pop()})` : ""}
                    </button>
                    <button onClick={onAttachDiff}>
                      <GitBranch size={13} /> Attach Git diff
                    </button>
                    <button
                      onClick={() => {
                        imageInputRef.current?.click();
                        setShowComposerMenu(false);
                      }}
                    >
                      <Paperclip size={13} /> Attach file (image, PDF, Word, Excel, …)
                    </button>
                  </div>
                )}
              </div>
              <div className="mode-select" role="radiogroup" aria-label="Execution autonomy mode">
                {([
                  { id: "Plan", icon: <Compass size={12} />, hint: "Plan mode — design architecture & step-by-step plan before editing" },
                  { id: "Ask", icon: <MessageSquare size={12} />, hint: "Ask mode — read-only codebase Q&A and explanations" },
                  { id: "Auto", icon: <Zap size={12} />, hint: "Auto mode — autonomous coding with standard command safety checks" },
                  { id: "Full", icon: <Flame size={12} />, hint: "Full Access — every command runs without approval prompts (destructive guardrails still enforced)" },
                ] as const).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === item.id}
                    className={`mode-pill-btn ${mode === item.id ? "active" : ""}${item.id === "Full" ? " mode-full" : ""}`}
                    onClick={() => setMode(item.id)}
                    title={item.hint}
                  >
                    <span className="mode-pill-icon">{item.icon}</span>
                    <span>{item.id}</span>
                  </button>
                ))}
              </div>
              <ModelSelect
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                selectedEffort={selectedEffort}
                providers={providers}
                definitions={definitions}
                switchModel={switchModel}
                switchEffort={switchEffort}
                onOpenProviders={onOpenProviders}
                sessionUsage={sessionUsage}
                contextUsage={contextUsage}
                activeSessionId={activeSessionId}
              />
            </div>
            <button
              type="button"
              className={`composer-send-btn ${running ? "composer-stop-btn" : ""}`}
              disabled={!running && !draft.trim() && attachments.length === 0}
              onClick={running ? onStop : () => {
                const pillObj = CODE_ACTION_PILLS.find((p) => p.id === activeCodePill);
                if (pillObj && draft.trim() && !draft.startsWith(pillObj.prefix)) {
                  handleSendMessage(`${pillObj.prefix}${draft.trim()}`);
                } else {
                  handleSendMessage();
                }
                setActiveCodePill(null);
              }}
              title={running ? "Stop agent execution" : "Send message (Enter)"}
            >
              {running ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
          <div className="code-quick-links">
            {CODE_ACTION_PILLS.map((pill) => (
              <button
                key={pill.id}
                type="button"
                className={`composer-tool-btn ${activeCodePill === pill.id ? "active" : ""}`}
                onClick={() => {
                  if (activeCodePill === pill.id) {
                    setActiveCodePill(null);
                  } else {
                    setActiveCodePill(pill.id);
                  }
                  textareaRef.current?.focus();
                }}
                title={pill.placeholder}
              >
                {pill.icon}
                <span>{pill.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="input-note">
          <ShieldCheck size={12} /> Nexus Coding Agent · Review live diffs and terminal execution before keeping changes
        </div>
      </div>
    </div>
  );
}
