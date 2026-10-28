import React, { useEffect, useState, useRef } from "react";
import { Copy, Download, Check, Maximize2, X, Image as ImageIcon, ZoomIn, ZoomOut, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";
import { openVisualFullscreen } from "./VisualFullscreen.js";
import {
  parseBarChart,
  parseHBarChart,
  parseLineChart,
  parseAreaChart,
  parseScatterChart,
  parsePieChart,
  parseRadarChart,
  detectFenceKind,
  type CategoryChartSpec,
} from "../../utils/chart-blocks.js";
import { WidgetBlock } from "../chat/WidgetBlock.js";

let mermaidSequence = 0;
let mermaidConfigured = false;

const truncate = (label: string, maxLen = 12) =>
  label.length > maxLen ? `${label.slice(0, maxLen - 1)}…` : label;

const fmt = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);

const PIE_PALETTE = [
  "#7aa8d1",
  "#60c8b3",
  "#f6c177",
  "#ea9a97",
  "#c4a7e7",
  "#9ccfd8",
  "#eb6f92",
  "#8bd5ca",
];

function ChartActions({
  title,
  svgRef,
  dataText,
}: {
  title: string;
  svgRef: React.RefObject<SVGSVGElement | null>;
  dataText?: string;
}) {
  const [copiedData, setCopiedData] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const handleCopyData = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!dataText) return;
    try {
      await navigator.clipboard.writeText(dataText);
      setCopiedData(true);
      setTimeout(() => setCopiedData(false), 1800);
    } catch { /* best effort */ }
  };

  const handleDownloadSvg = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!svgRef.current) return;
    try {
      const svgXml = new XMLSerializer().serializeToString(svgRef.current);
      const blob = new Blob([svgXml], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(title || "chart").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1800);
    } catch { /* best effort */ }
  };

  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const svg = svgRef.current?.outerHTML;
    if (svg) openVisualFullscreen({ kind: "svg", svg, title: title || "Chart" });
  };

  return (
    <div className="rich-chart-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="rich-chart-btn"
        onClick={handleFullscreen}
        title="Open fullscreen with zoom"
      >
        <Maximize2 size={11} />
        <span>Full</span>
      </button>
      {dataText && (
        <button
          type="button"
          className="rich-chart-btn"
          onClick={handleCopyData}
          title="Copy chart data as CSV"
        >
          {copiedData ? <Check size={11} /> : <Copy size={11} />}
          <span>{copiedData ? "Copied" : "Data"}</span>
        </button>
      )}
      <button
        type="button"
        className="rich-chart-btn"
        onClick={handleDownloadSvg}
        title="Download chart as SVG"
      >
        {downloaded ? <Check size={11} /> : <Download size={11} />}
        <span>{downloaded ? "Saved" : "SVG"}</span>
      </button>
    </div>
  );
}

function SvgTooltip({
  x,
  y,
  title,
  value,
  secondary,
  svgWidth = 760,
}: {
  x: number;
  y: number;
  title: string;
  value: string;
  secondary?: string;
  svgWidth?: number;
}) {
  const fullText = secondary ? `${title}: ${value} (${secondary})` : `${title}: ${value}`;
  const width = Math.min(320, Math.max(110, fullText.length * 7.5 + 24));
  const height = 28;
  let boxX = x - width / 2;
  if (boxX < 12) boxX = 12;
  if (boxX + width > svgWidth - 12) boxX = svgWidth - 12 - width;
  let boxY = y - height - 10;
  if (boxY < 8) boxY = y + 14;

  return (
    <g pointerEvents="none" style={{ filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.6))" }}>
      <rect
        x={boxX}
        y={boxY}
        width={width}
        height={height}
        rx={5}
        fill="#141824"
        stroke="rgba(122,168,209,0.4)"
        strokeWidth={1}
      />
      <text
        x={boxX + width / 2}
        y={boxY + 18}
        textAnchor="middle"
        fill="#f0f6fc"
        fontSize="11"
        fontWeight="600"
        fontFamily="inherit"
      >
        <tspan fill="#7aa8d1">{title}</tspan>: {value}
        {secondary && <tspan fillOpacity="0.6"> ({secondary})</tspan>}
      </text>
    </g>
  );
}

/** Y offset of a group's `translate(x, y)` transform, or null if it isn't a plain translate. */
function groupTranslateY(group: SVGGraphicsElement): number | null {
  const match = /translate\(\s*[-+]?[\d.eE]+\s*[ ,]\s*[-+]?[\d.eE]+/.exec(group.getAttribute("transform") || "");
  if (!match) return null;
  const y = Number(match[0].replace(/^translate\(\s*[-+]?[\d.eE]+\s*[ ,]\s*/, ""));
  return Number.isFinite(y) ? y : null;
}

/**
 * Mermaid's timeline renderer stretches EVERY period→events connector to the
 * GLOBAL maximum event-stack height plus a hardcoded 200px of padding
 * (y2 = masterY + maxTaskHeight + 100 + maxEventLineLength + 100), so tasks
 * with short events get dotted arrows dangling far below their event boxes.
 * No config knob controls this, so after render we re-measure each task's own
 * event boxes and snap its vertical dashed connector to end just below the
 * last one. The horizontal axis line and the (already-correct) vertical-layout
 * connectors are skipped: they don't match the vertical+dashed signature.
 */
function tightenTimelineConnectors(rootSvg: SVGSVGElement) {
  if (!rootSvg.querySelector("g.lineWrapper")) return;
  for (const wrapper of Array.from(rootSvg.querySelectorAll<SVGGElement>("g.lineWrapper"))) {
    const line = wrapper.querySelector("line");
    if (!line) continue;
    const x1 = Number(line.getAttribute("x1"));
    const x2 = Number(line.getAttribute("x2"));
    const y1 = Number(line.getAttribute("y1"));
    if (!line.getAttribute("stroke-dasharray") || x2 !== x1 || !Number.isFinite(x1)) continue;

    // This task's events are the eventWrapper siblings that follow its
    // lineWrapper, up to the next task/line wrapper (start of another task).
    const parent = wrapper.parentElement;
    if (!parent) continue;
    const siblings = Array.from(parent.children);
    const start = siblings.indexOf(wrapper);
    if (start < 0) continue;
    let bottom = -Infinity;
    for (let i = start + 1; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (!(sibling instanceof SVGGElement)) continue;
      const cls = sibling.getAttribute("class") || "";
      if (/eventWrapper/.test(cls)) {
        const ty = groupTranslateY(sibling);
        if (ty === null) continue;
        let box: DOMRect;
        try {
          box = sibling.getBBox();
        } catch {
          continue;
        }
        bottom = Math.max(bottom, ty + box.y + box.height);
      } else if (/taskWrapper|lineWrapper|section/.test(cls)) {
        break;
      }
    }
    if (!Number.isFinite(bottom) || bottom <= 0) continue;
    const end = Math.max(bottom, Number.isFinite(y1) ? y1 : -Infinity) + 6;
    const current = Number(line.getAttribute("y2"));
    if (Number.isFinite(current) && Math.abs(end - current) < 2) continue;
    line.setAttribute("y2", String(end));
  }
}

/**
 * Mermaid SVGs can be injected at any moment (settled message, streaming
 * answer, fullscreen clone), and component-level effects are not guaranteed
 * to see every one — so the connector fix is applied by a document-wide
 * MutationObserver whenever a new mermaid <svg> lands in the DOM. Idempotent:
 * already-tightened lines are within 2px of the target and are skipped.
 */
let timelineObserver: MutationObserver | null = null;
function ensureTimelineFixObserver() {
  if (typeof MutationObserver === "undefined" || timelineObserver) return;
  timelineObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof Element)) continue;
        const svg = node.matches?.("svg") ? node : node.querySelector?.("svg");
        if (svg instanceof SVGSVGElement) {
          // Synchronous on purpose: requestAnimationFrame doesn't run in
          // occluded windows, and getBBox works on freshly-inserted geometry.
          try {
            tightenTimelineConnectors(svg);
          } catch {
            /* a broken diagram must never throw into the observer */
          }
        }
      }
    }
  });
  timelineObserver.observe(document.body, { childList: true, subtree: true });
}
ensureTimelineFixObserver();

function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Ref on the diagram host itself: a container-wide querySelector("svg")
  // would return the Full button's lucide icon (it precedes the diagram).
  const diagramRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let alive = true;
    const id = `nexus-mermaid-${++mermaidSequence}`;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (!alive) return;
        if (!mermaidConfigured) {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
          mermaidConfigured = true;
        }
        const rendered = await mermaid.render(id, source.trim());
        if (alive) setSvg(rendered.svg);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [source]);

  // Post-render cleanup: snap timeline connectors to their own events (runs on
  // the live DOM so getBBox measures actual laid-out geometry).
  useEffect(() => {
    if (!svg) return;
    try {
      const rootSvg = diagramRef.current?.querySelector("svg");
      if (rootSvg instanceof SVGSVGElement) tightenTimelineConnectors(rootSvg);
    } catch {
      /* layout oddities in a malformed diagram must never break rendering */
    }
  }, [svg]);

  if (svg) {
    return (
      <div className="rich-mermaid">
        <button
          type="button"
          className="rich-mermaid-fullscreen"
          title="Open fullscreen with zoom"
          onClick={(event) => {
            event.stopPropagation();
            const inner = diagramRef.current?.querySelector("svg")?.outerHTML;
            if (inner) openVisualFullscreen({ kind: "svg", svg: inner, title: "Diagram" });
          }}
        >
          <Maximize2 size={11} />
          <span>Full</span>
        </button>
        <div ref={diagramRef} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    );
  }
  if (failed) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  return <div className="rich-mermaid-loading">Rendering diagram…</div>;
}

function ScatterBlock({ source }: { source: string }) {
  const spec = parseScatterChart(source);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const width = 760, height = 420, left = 62, right = 24, top = 42, bottom = 58;
  const plotW = width - left - right, plotH = height - top - bottom;
  const px = (value: number) => left + ((value - spec.xMin) / (spec.xMax - spec.xMin || 1)) * plotW;
  const py = (value: number) => top + plotH - ((value - spec.yMin) / (spec.yMax - spec.yMin || 1)) * plotH;
  const activePoint = hoveredIndex !== null ? spec.points[hoveredIndex] : null;

  const csv =
    `Name,${spec.xLabel || "X"},${spec.yLabel || "Y"}\n` +
    spec.points.map((p) => `"${p.name}",${p.x},${p.y}`).join("\n");

  return (
    <div className="rich-scatter" role="img" aria-label={spec.title || "Scatter plot"}>
      <ChartActions title={spec.title || "scatter-plot"} svgRef={svgRef} dataText={csv} />
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {spec.title && <text x={width / 2} y={22} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
        <line x1={left} y1={top} x2={left} y2={top + plotH} className="rich-chart-axis" />
        <line x1={left} y1={top + plotH} x2={left + plotW} y2={top + plotH} className="rich-chart-axis" />
        {spec.points.map((point, index) => {
          const isHovered = hoveredIndex === index;
          const isDimmed = hoveredIndex !== null && !isHovered;
          const cx = px(point.x);
          const cy = py(point.y);
          return (
            <g
              key={`${point.name}-${point.x}-${point.y}`}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s" }}
            >
              {isHovered && <circle cx={cx} cy={cy} r={12} fill="none" stroke="#7aa8d1" strokeWidth={2} opacity={0.6} className="rich-halo-ring" />}
              <circle cx={cx} cy={cy} r={isHovered ? 7 : 5} className="rich-scatter-point" />
            </g>
          );
        })}
        <text x={left + plotW / 2} y={height - 12} textAnchor="middle" className="rich-chart-label">{spec.xLabel}</text>
        <text x="14" y={top + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${top + plotH / 2})`} className="rich-chart-label">{spec.yLabel}</text>
        {activePoint && (
          <SvgTooltip
            x={px(activePoint.x)}
            y={py(activePoint.y)}
            title={activePoint.name}
            value={`${spec.xLabel || "X"}: ${activePoint.x}, ${spec.yLabel || "Y"}: ${activePoint.y}`}
          />
        )}
      </svg>
    </div>
  );
}

// Bar/line/area share one frame: axes, three y ticks, category labels below
function CategoryChartBlock({ source, kind }: { source: string; kind: "bar" | "line" | "area" }) {
  const spec: CategoryChartSpec | null =
    kind === "bar" ? parseBarChart(source) : kind === "area" ? parseAreaChart(source) : parseLineChart(source);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const width = 760, height = 420, left = 62, right = 24, top = 42, bottom = 58;
  const plotW = width - left - right, plotH = height - top - bottom;
  const clamp = (value: number) => Math.min(spec.yMax, Math.max(spec.yMin, value));
  const py = (value: number) => top + plotH - ((clamp(value) - spec.yMin) / (spec.yMax - spec.yMin || 1)) * plotH;
  const baseline = py(spec.yMin);
  const ticks = [spec.yMin, spec.yMin + (spec.yMax - spec.yMin) / 2, spec.yMax];
  const slot = plotW / spec.entries.length;
  const mid = (i: number) => (spec.entries.length > 1 ? left + i * slot + slot / 2 : left + plotW / 2);
  const labelKind = kind === "bar" ? "Bar chart" : kind === "area" ? "Area chart" : "Line chart";

  const activeEntry = hoveredIndex !== null ? spec.entries[hoveredIndex] : null;
  const csv =
    [spec.xLabel || "Category", spec.yLabel || "Value"].join(",") +
    "\n" +
    spec.entries.map((e) => `"${e.label}",${e.value}`).join("\n");

  return (
    <div className="rich-chart" role="img" aria-label={spec.title || labelKind}>
      <ChartActions title={spec.title || labelKind.toLowerCase().replace(/\s+/g, "-")} svgRef={svgRef} dataText={csv} />
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {spec.title && <text x={width / 2} y={22} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={left} y1={py(tick)} x2={left + plotW} y2={py(tick)} className="rich-chart-axis" style={{ strokeOpacity: 0.15 }} />
            <text x={left - 8} y={py(tick) + 3} textAnchor="end" className="rich-chart-tick">{fmt(tick)}</text>
          </g>
        ))}
        <line x1={left} y1={top} x2={left} y2={top + plotH} className="rich-chart-axis" />
        <line x1={left} y1={baseline} x2={left + plotW} y2={baseline} className="rich-chart-axis" />

        {/* Hover crosshair guide line for line/area */}
        {(kind === "line" || kind === "area") && hoveredIndex !== null && (
          <line
            x1={mid(hoveredIndex)}
            y1={top}
            x2={mid(hoveredIndex)}
            y2={baseline}
            className="rich-chart-guide"
          />
        )}

        {kind === "bar" && spec.entries.map((entry, index) => {
          const barWidth = Math.min(slot * 0.62, 80);
          const x = left + index * slot + (slot - barWidth) / 2;
          const yTop = py(entry.value);
          const isHovered = hoveredIndex === index;
          const isDimmed = hoveredIndex !== null && !isHovered;
          return (
            <g
              key={`${entry.label}-${index}`}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s" }}
            >
              <rect
                x={x}
                y={yTop}
                width={barWidth}
                height={Math.max(0, baseline - yTop)}
                rx={3}
                className={`rich-bar ${isHovered ? "active" : ""}`}
              />
              <text x={x + barWidth / 2} y={yTop - 6} textAnchor="middle" className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>{fmt(entry.value)}</text>
              <text x={x + barWidth / 2} y={baseline + 16} textAnchor="middle" className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{truncate(entry.label)}</text>
            </g>
          );
        })}

        {kind === "area" && (
          <g>
            <polygon
              points={`${mid(0)},${baseline} ${spec.entries.map((entry, index) => `${mid(index)},${py(entry.value)}`).join(" ")} ${mid(spec.entries.length - 1)},${baseline}`}
              className="rich-area-fill"
            />
            <polyline
              points={spec.entries.map((entry, index) => `${mid(index)},${py(entry.value)}`).join(" ")}
              className="rich-line-path"
            />
            {spec.entries.map((entry, index) => {
              const isHovered = hoveredIndex === index;
              const isDimmed = hoveredIndex !== null && !isHovered;
              const mx = mid(index);
              const my = py(entry.value);
              return (
                <g
                  key={`${entry.label}-${index}`}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s" }}
                >
                  {isHovered && <circle cx={mx} cy={my} r={12} fill="none" stroke="#7aa8d1" strokeWidth={2} opacity={0.6} className="rich-halo-ring" />}
                  <circle cx={mx} cy={my} r={isHovered ? 7 : 4} className={`rich-line-point ${isHovered ? "active" : ""}`} />
                  <text x={mx} y={baseline + 16} textAnchor="middle" className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{truncate(entry.label)}</text>
                </g>
              );
            })}
          </g>
        )}

        {kind === "line" && (
          <g>
            <polyline
              points={spec.entries.map((entry, index) => `${mid(index)},${py(entry.value)}`).join(" ")}
              className="rich-line-path"
            />
            {spec.entries.map((entry, index) => {
              const isHovered = hoveredIndex === index;
              const isDimmed = hoveredIndex !== null && !isHovered;
              const mx = mid(index);
              const my = py(entry.value);
              return (
                <g
                  key={`${entry.label}-${index}`}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s" }}
                >
                  {isHovered && <circle cx={mx} cy={my} r={12} fill="none" stroke="#7aa8d1" strokeWidth={2} opacity={0.6} className="rich-halo-ring" />}
                  <circle cx={mx} cy={my} r={isHovered ? 7 : 4} className={`rich-line-point ${isHovered ? "active" : ""}`} />
                  <text x={mx} y={baseline + 16} textAnchor="middle" className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{truncate(entry.label)}</text>
                </g>
              );
            })}
          </g>
        )}

        <text x={left + plotW / 2} y={height - 12} textAnchor="middle" className="rich-chart-label">{spec.xLabel}</text>
        <text x="14" y={top + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${top + plotH / 2})`} className="rich-chart-label">{spec.yLabel}</text>

        {activeEntry && (
          <SvgTooltip
            x={kind === "bar" ? left + (hoveredIndex! * slot) + slot / 2 : mid(hoveredIndex!)}
            y={py(activeEntry.value)}
            title={activeEntry.label}
            value={fmt(activeEntry.value)}
          />
        )}
      </svg>
    </div>
  );
}

function HBarBlock({ source }: { source: string }) {
  const spec = parseHBarChart(source);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const barSpacing = Math.max(34, Math.min(50, 320 / spec.entries.length));
  const top = 42, bottom = 44, left = 160, right = 60;
  const height = top + bottom + spec.entries.length * barSpacing;
  const width = 760;
  const plotW = width - left - right;
  const plotH = spec.entries.length * barSpacing;
  const px = (val: number) => left + ((Math.min(spec.yMax, Math.max(spec.yMin, val)) - spec.yMin) / (spec.yMax - spec.yMin || 1)) * plotW;
  const ticks = [spec.yMin, spec.yMin + (spec.yMax - spec.yMin) / 2, spec.yMax];
  const barHeight = Math.max(16, barSpacing * 0.62);

  const activeEntry = hoveredIndex !== null ? spec.entries[hoveredIndex] : null;
  const csv =
    [spec.yLabel || "Category", spec.xLabel || "Value"].join(",") +
    "\n" +
    spec.entries.map((e) => `"${e.label}",${e.value}`).join("\n");

  return (
    <div className="rich-chart" role="img" aria-label={spec.title || "Horizontal bar chart"}>
      <ChartActions title={spec.title || "hbar-chart"} svgRef={svgRef} dataText={csv} />
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {spec.title && <text x={width / 2} y={22} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={px(tick)} y1={top} x2={px(tick)} y2={top + plotH} className="rich-chart-axis" style={{ strokeOpacity: 0.15 }} />
            <text x={px(tick)} y={top + plotH + 18} textAnchor="middle" className="rich-chart-tick">{fmt(tick)}</text>
          </g>
        ))}
        <line x1={left} y1={top} x2={left} y2={top + plotH} className="rich-chart-axis" />
        <line x1={left} y1={top + plotH} x2={left + plotW} y2={top + plotH} className="rich-chart-axis" />
        {spec.entries.map((entry, index) => {
          const y = top + index * barSpacing + (barSpacing - barHeight) / 2;
          const barW = Math.max(2, px(entry.value) - left);
          const isHovered = hoveredIndex === index;
          const isDimmed = hoveredIndex !== null && !isHovered;
          return (
            <g
              key={`${entry.label}-${index}`}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s" }}
            >
              <text x={left - 12} y={y + barHeight / 2 + 4} textAnchor="end" className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{truncate(entry.label, 20)}</text>
              <rect x={left} y={y} width={barW} height={barHeight} rx={3} className={`rich-hbar ${isHovered ? "active" : ""}`} />
              <text x={left + barW + 8} y={y + barHeight / 2 + 4} textAnchor="start" className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>{fmt(entry.value)}</text>
            </g>
          );
        })}
        {spec.xLabel && <text x={left + plotW / 2} y={height - 8} textAnchor="middle" className="rich-chart-label">{spec.xLabel}</text>}
        {activeEntry && (
          <SvgTooltip
            x={px(activeEntry.value)}
            y={top + hoveredIndex! * barSpacing + (barSpacing - barHeight) / 2}
            title={activeEntry.label}
            value={fmt(activeEntry.value)}
          />
        )}
      </svg>
    </div>
  );
}

function PieBlock({ source, donut = false }: { source: string; donut?: boolean }) {
  const spec = parsePieChart(source, donut);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const isDonut = donut || spec.donut;
  const width = 760, height = 400;
  const cx = 230, cy = 205, radius = 135, innerRadius = isDonut ? 72 : 0;

  let currentAngle = -Math.PI / 2;
  const slicesWithAngles = spec.slices.map((slice, i) => {
    const angleDelta = (slice.value / spec.total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angleDelta;
    currentAngle = endAngle;
    const color = PIE_PALETTE[i % PIE_PALETTE.length];
    return { ...slice, startAngle, endAngle, angleDelta, color };
  });

  const activeSlice = hoveredIndex !== null ? slicesWithAngles[hoveredIndex] : null;
  const csv =
    "Category,Value,Percent\n" +
    spec.slices.map((s) => `"${s.label}",${s.value},${s.percent}%`).join("\n");

  return (
    <div className="rich-chart" role="img" aria-label={spec.title || (isDonut ? "Donut chart" : "Pie chart")}>
      <ChartActions title={spec.title || (isDonut ? "donut-chart" : "pie-chart")} svgRef={svgRef} dataText={csv} />
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {spec.title && <text x={width / 2} y={24} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
        <g>
          {spec.slices.length === 1 ? (
            <g
              onMouseEnter={() => setHoveredIndex(0)}
              onMouseLeave={() => setHoveredIndex(null)}
              className="rich-pie-slice"
            >
              <circle cx={cx} cy={cy} r={radius} fill={PIE_PALETTE[0]} />
              {isDonut && <circle cx={cx} cy={cy} r={innerRadius} fill="var(--bg, #1a1b26)" />}
            </g>
          ) : (
            slicesWithAngles.map((slice, idx) => {
              const isHovered = hoveredIndex === idx;
              const isDimmed = hoveredIndex !== null && !isHovered;
              const x1 = cx + radius * Math.cos(slice.startAngle);
              const y1 = cy + radius * Math.sin(slice.startAngle);
              const x2 = cx + radius * Math.cos(slice.endAngle);
              const y2 = cy + radius * Math.sin(slice.endAngle);
              const largeArc = slice.angleDelta > Math.PI ? 1 : 0;

              let d: string;
              if (isDonut) {
                const ix1 = cx + innerRadius * Math.cos(slice.startAngle);
                const iy1 = cy + innerRadius * Math.sin(slice.startAngle);
                const ix2 = cx + innerRadius * Math.cos(slice.endAngle);
                const iy2 = cy + innerRadius * Math.sin(slice.endAngle);
                d = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1} Z`;
              } else {
                d = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
              }

              return (
                <path
                  key={`${slice.label}-${idx}`}
                  d={d}
                  fill={slice.color}
                  stroke="var(--bg, #1a1b26)"
                  strokeWidth="1.5"
                  className={`rich-pie-slice ${isHovered ? "active" : ""}`}
                  style={{ opacity: isDimmed ? 0.35 : 1 }}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              );
            })
          )}
        </g>
        {isDonut && (
          <g pointerEvents="none">
            {activeSlice ? (
              <>
                <text x={cx} y={cy - 6} textAnchor="middle" className="rich-chart-tick" style={{ fontSize: "11px" }}>{truncate(activeSlice.label, 14)}</text>
                <text x={cx} y={cy + 16} textAnchor="middle" className="rich-chart-title" style={{ fontSize: "15px", fill: activeSlice.color }}>{activeSlice.percent}%</text>
              </>
            ) : (
              <>
                <text x={cx} y={cy - 6} textAnchor="middle" className="rich-chart-tick" style={{ fontSize: "11px" }}>Total</text>
                <text x={cx} y={cy + 16} textAnchor="middle" className="rich-chart-title" style={{ fontSize: "15px" }}>{fmt(spec.total)}</text>
              </>
            )}
          </g>
        )}
        {/* Interactive Legend */}
        <g transform="translate(430, 60)">
          {slicesWithAngles.map((slice, idx) => {
            const isHovered = hoveredIndex === idx;
            const isDimmed = hoveredIndex !== null && !isHovered;
            return (
              <g
                key={`legend-${slice.label}-${idx}`}
                transform={`translate(0, ${idx * 30})`}
                className="rich-legend-item"
                style={{ opacity: isDimmed ? 0.4 : 1 }}
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <circle cx={6} cy={6} r={isHovered ? 8 : 6} fill={slice.color} />
                <text x={20} y={10} className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{slice.label}</text>
                <text x={290} y={10} textAnchor="end" className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>
                  {slice.percent}% <tspan fillOpacity="0.5">({fmt(slice.value)})</tspan>
                </text>
              </g>
            );
          })}
        </g>
        {activeSlice && !isDonut && (
          <SvgTooltip
            x={cx + (radius * 0.7) * Math.cos(activeSlice.startAngle + activeSlice.angleDelta / 2)}
            y={cy + (radius * 0.7) * Math.sin(activeSlice.startAngle + activeSlice.angleDelta / 2)}
            title={activeSlice.label}
            value={fmt(activeSlice.value)}
            secondary={`${activeSlice.percent}%`}
          />
        )}
      </svg>
    </div>
  );
}

function RadarBlock({ source }: { source: string }) {
  const spec = parseRadarChart(source);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const width = 760, height = 430;
  const cx = 380, cy = 225, radius = 135;
  const n = spec.axes.length;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  // One polyline/polygon + color per series; single-value charts are series of one.
  const seriesCount = Math.max(1, spec.axes[0]?.values.length || 1);
  const colors = ["#7aa8d1", "#e0915e", "#b58fd6", "#6dc287", "#d17a9e"];

  const rings = [0.25, 0.5, 0.75, 1.0];
  const ringPolygons = rings.map((factor) => {
    const r = radius * factor;
    return spec.axes.map((_, i) => `${cx + r * Math.cos(angle(i))},${cy + r * Math.sin(angle(i))}`).join(" ");
  });

  const seriesPoints = (s: number) =>
    spec.axes.map((axis, i) => {
      const value = Math.min(spec.max, Math.max(0, axis.values[s] ?? 0));
      const r = (value / spec.max) * radius;
      return {
        x: cx + r * Math.cos(angle(i)),
        y: cy + r * Math.sin(angle(i)),
        label: axis.label,
        value: axis.values[s] ?? 0,
      };
    });
  const activeAxis = hoveredIndex !== null ? spec.axes[hoveredIndex] : null;

  const header =
    "Metric," +
    spec.seriesNames.slice(0, seriesCount).map((nm) => `"${nm}"`).join(",") +
    ",Max\n";
  const csv =
    header +
    spec.axes.map((a) => `"${a.label}",${a.values.slice(0, seriesCount).join(",")},${spec.max}`).join("\n");

  return (
    <div className="rich-chart" role="img" aria-label={spec.title || "Radar chart"}>
      <ChartActions title={spec.title || "radar-chart"} svgRef={svgRef} dataText={csv} />
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {spec.title && <text x={width / 2} y={24} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
        {ringPolygons.map((pts, idx) => (
          <polygon key={idx} points={pts} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth="1" />
        ))}
        {spec.axes.map((_, i) => {
          const ex = cx + radius * Math.cos(angle(i));
          const ey = cy + radius * Math.sin(angle(i));
          return <line key={i} x1={cx} y1={cy} x2={ex} y2={ey} className="rich-chart-axis" style={{ strokeOpacity: 0.2 }} />;
        })}
        {Array.from({ length: seriesCount }, (_, s) => {
          const points = seriesPoints(s);
          const polyStr = points.map((p) => `${p.x},${p.y}`).join(" ");
          const dimmed = hoveredSeries !== null && hoveredSeries !== s;
          return (
            <g key={s} opacity={dimmed ? 0.25 : 1}
               onMouseEnter={() => setHoveredSeries(s)}
               onMouseLeave={() => setHoveredSeries(null)}
               style={{ cursor: "default" }}>
              <polygon points={polyStr} className="rich-radar-poly" style={{ fill: colors[s % colors.length], stroke: colors[s % colors.length] }} />
              {points.map((p, i) => {
                const isHovered = hoveredIndex === i;
                return (
                  <g
                    key={i}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {isHovered && <circle cx={p.x} cy={p.y} r={12} fill="none" stroke={colors[s % colors.length]} strokeWidth={2} opacity={0.6} className="rich-halo-ring" />}
                    <circle cx={p.x} cy={p.y} r={isHovered ? 7 : 4} className={`rich-scatter-point ${isHovered ? "active" : ""}`} style={{ fill: colors[s % colors.length] }} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* Series legend (multi-series radar only), top-right under the title. */}
        {seriesCount > 1 && (
          <g>
            {spec.seriesNames.slice(0, seriesCount).map((name, s) => {
              const swatchX = width - 34 - spec.seriesNames.slice(0, seriesCount).length * 118 + s * 118;
              return (
                <g key={s}>
                  <circle cx={swatchX} cy={44} r={6} fill={colors[s % colors.length]} />
                  <text x={swatchX + 12} y={48} className="rich-chart-label">{name}</text>
                </g>
              );
            })}
          </g>
        )}
        {spec.axes.map((axis, i) => {
          const a = angle(i);
          const isHovered = hoveredIndex === i;
          const lx = cx + (radius + 22) * Math.cos(a);
          const ly = cy + (radius + 22) * Math.sin(a);
          const anchor = Math.abs(Math.cos(a)) < 0.2 ? "middle" : Math.cos(a) > 0 ? "start" : "end";
          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{ cursor: "pointer" }}
            >
              <text x={lx} y={ly} textAnchor={anchor} className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{axis.label}</text>
              <text x={lx} y={ly + 12} textAnchor={anchor} className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>{axis.values.slice(0, seriesCount).map(fmt).join(" / ")}</text>
            </g>
          );
        })}
        {activeAxis && (
          <SvgTooltip
            x={seriesPoints(hoveredSeries ?? 0)[hoveredIndex ?? 0].x}
            y={seriesPoints(hoveredSeries ?? 0)[hoveredIndex ?? 0].y}
            title={activeAxis.label}
            value={activeAxis.values.slice(0, seriesCount).map((v, s) => `${spec.seriesNames[s]} ${fmt(v)}`).join("  ·  ")}
            secondary={`max ${fmt(spec.max)}`}
          />
        )}
      </svg>
    </div>
  );
}

function ChatImageBlock({ alt, src }: { alt: string; src: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [lightboxScale, setLightboxScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const rawPath = (src || "").trim();
  const cleanPath = rawPath.replace(/^file:\/\/\/?/, "").replace(/^\/+/, "").replace(/^\.\//, "");
  const filename = cleanPath.split(/[/\\]/).pop() || cleanPath;

  const displayTitle = alt?.trim()
    ? alt.trim()
    : filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");

  const loadCounterRef = useRef(0);

  const loadImage = async () => {
    const currentRun = ++loadCounterRef.current;
    if (!rawPath) {
      setError("No image path provided");
      setLoading(false);
      return;
    }

    if (rawPath.startsWith("data:") || rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
      setDataUrl(rawPath);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const ext = filename.split(".").pop()?.toLowerCase() || "png";
    const mime =
      ext === "svg"
        ? "image/svg+xml"
        : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
        ? "image/webp"
        : ext === "gif"
        ? "image/gif"
        : "image/png";

    try {
      const api = typeof window !== "undefined" ? (window as any).nexus : undefined;
      // 1. Try home file
      if (api?.readHomeFile) {
        try {
          const file = await api.readHomeFile(cleanPath);
          if (currentRun !== loadCounterRef.current) return;
          if (file?.base64) {
            setDataUrl(`data:${mime};base64,${file.base64}`);
            setLoading(false);
            return;
          }
        } catch {
          if (filename !== cleanPath) {
            try {
              const file = await api.readHomeFile(filename);
              if (currentRun !== loadCounterRef.current) return;
              if (file?.base64) {
                setDataUrl(`data:${mime};base64,${file.base64}`);
                setLoading(false);
                return;
              }
            } catch { /* proceed */ }
          }
        }
      }

      // 2. Try workspace file
      if (api?.readWorkspaceFileBase64) {
        try {
          const file = await api.readWorkspaceFileBase64(cleanPath);
          if (currentRun !== loadCounterRef.current) return;
          if (file?.base64) {
            setDataUrl(`data:${mime};base64,${file.base64}`);
            setLoading(false);
            return;
          }
        } catch {
          if (filename !== cleanPath) {
            try {
              const file = await api.readWorkspaceFileBase64(filename);
              if (currentRun !== loadCounterRef.current) return;
              if (file?.base64) {
                setDataUrl(`data:${mime};base64,${file.base64}`);
                setLoading(false);
                return;
              }
            } catch { /* proceed */ }
          }
        }
      }

      if (currentRun !== loadCounterRef.current) return;
      setError(`Could not locate image file "${filename}"`);
      setLoading(false);
    } catch (err) {
      if (currentRun !== loadCounterRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  useEffect(() => {
    loadImage();
  }, [src]);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const api = typeof window !== "undefined" ? (window as any).nexus : undefined;
    if (api?.downloadHomeFile) {
      try {
        const res = await api.downloadHomeFile(cleanPath);
        if (res) {
          setDownloaded(true);
          setTimeout(() => setDownloaded(false), 1800);
          return;
        }
      } catch { /* proceed */ }
    }

    if (api?.downloadWorkspaceFile) {
      try {
        const res = await api.downloadWorkspaceFile(cleanPath);
        if (res) {
          setDownloaded(true);
          setTimeout(() => setDownloaded(false), 1800);
          return;
        }
      } catch { /* proceed */ }
    }

    if (dataUrl) {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = filename || "chart.png";
      a.click();
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1800);
    }
  };

  return (
    <div className="rich-chart chat-inline-image-card" role="figure" aria-label={displayTitle}>
      <div className="chat-inline-image-header">
        <div className="chat-inline-image-title-group">
          <span className="chat-inline-image-badge">
            <ImageIcon size={11} />
            <span>GRAPH EVIDENCE</span>
          </span>
          <span className="chat-inline-image-title" title={displayTitle}>
            {displayTitle}
          </span>
        </div>
        <div className="rich-chart-actions" style={{ position: "static", opacity: 1 }}>
          {dataUrl && (
              <button
              type="button"
              className="rich-chart-btn"
              onClick={() => { setZoomed(true); setLightboxScale(1); }}
              title="Expand / Zoom image"
            >
              <Maximize2 size={11} />
              <span>Zoom</span>
            </button>
          )}
          <button
            type="button"
            className="rich-chart-btn"
            onClick={handleDownload}
            title="Download image"
          >
            {downloaded ? <Check size={11} /> : <Download size={11} />}
            <span>{downloaded ? "Saved" : "Download"}</span>
          </button>
        </div>
      </div>

      <div className="chat-inline-image-body">
        {loading ? (
          <div className="chat-inline-image-loading">
            <div className="chat-inline-image-spinner" />
            <span>Loading graph {filename}…</span>
          </div>
        ) : error ? (
          <div className="chat-inline-image-error">
            <AlertCircle size={16} />
            <div className="chat-inline-image-error-text">
              <span>{error}</span>
              <button type="button" className="rich-chart-btn" onClick={loadImage}>
                <RefreshCw size={10} />
                <span>Retry</span>
              </button>
            </div>
          </div>
        ) : (
          <div
            className="chat-inline-image-preview-wrap"
            onClick={() => { setZoomed(true); setLightboxScale(1); }}
            title="Click to view full size"
          >
            <img
              src={dataUrl!}
              alt={displayTitle}
              className="chat-inline-image-img"
              loading="lazy"
            />
            <div className="chat-inline-image-zoom-overlay">
              <ZoomIn size={16} />
              <span>Click to enlarge</span>
            </div>
          </div>
        )}
      </div>

      {alt && alt !== filename && (
        <div className="chat-inline-image-caption">
          {alt}
        </div>
      )}

      {zoomed && dataUrl && (
        <div className="chat-image-lightbox-overlay" onClick={() => setZoomed(false)}>
          <div className="chat-image-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="chat-image-lightbox-header">
              <div className="chat-image-lightbox-title-wrap">
                <ImageIcon size={14} />
                <span className="chat-image-lightbox-title">{displayTitle}</span>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  type="button"
                  className="rich-chart-btn"
                  onClick={() => setLightboxScale((s) => Math.max(0.25, s / 1.25))}
                  title="Zoom out"
                >
                  <ZoomOut size={12} />
                </button>
                <span className="visual-fullscreen-zoom-label">{Math.round(lightboxScale * 100)}%</span>
                <button
                  type="button"
                  className="rich-chart-btn"
                  onClick={() => setLightboxScale((s) => Math.min(8, s * 1.25))}
                  title="Zoom in"
                >
                  <ZoomIn size={12} />
                </button>
                <button
                  type="button"
                  className="rich-chart-btn"
                  onClick={handleDownload}
                  title="Download image"
                >
                  {downloaded ? <Check size={12} /> : <Download size={12} />}
                  <span>{downloaded ? "Saved" : "Download"}</span>
                </button>
                <button
                  type="button"
                  className="rich-chart-btn"
                  onClick={() => setZoomed(false)}
                  title="Close preview"
                >
                  <X size={12} />
                  <span>Close</span>
                </button>
              </div>
            </div>
            <div
              className="chat-image-lightbox-body"
              onWheel={(event) => {
                event.preventDefault();
                setLightboxScale((s) => Math.min(8, Math.max(0.25, event.deltaY < 0 ? s * 1.15 : s / 1.15)));
              }}
              onDoubleClick={() => setLightboxScale(1)}
            >
              <img
                src={dataUrl}
                alt={displayTitle}
                className="chat-image-lightbox-img"
                style={{ transform: `scale(${lightboxScale})`, cursor: lightboxScale > 1 ? "zoom-out" : "default" }}
                onClick={() => (lightboxScale > 1 ? setLightboxScale(1) : setZoomed(false))}
              />
            </div>
            {alt && (
              <div className="chat-image-lightbox-caption">
                {alt}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type SearchImageItem = { alt: string; src: string; sourceUrl?: string };

function isSearchImageUrl(value: string): boolean {
  try {
    const { hostname, protocol } = new URL(value);
    const host = hostname.toLowerCase();
    return protocol === "https:" && (host === "external-content.duckduckgo.com" || host === "mm.bing.net" || host.endsWith(".mm.bing.net"));
  } catch {
    return false;
  }
}

/**
 * Zoomable popup for web image results. Unlike the ChatImageBlock lightbox
 * this one never downloads — images are served straight from the web — and it
 * can step through every result of the gallery (←/→) plus hand out the
 * original web page via the Source button.
 */
function SearchImageLightbox({
  items,
  index,
  onClose,
  onNavigate,
}: {
  items: SearchImageItem[];
  index: number;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
}) {
  const [scale, setScale] = useState(1);
  const item = items[index];

  useEffect(() => {
    setScale(1);
  }, [index]);

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (items.length > 1 && event.key === "ArrowRight") onNavigate((index + 1) % items.length);
      else if (items.length > 1 && event.key === "ArrowLeft") onNavigate((index - 1 + items.length) % items.length);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [index, items.length, onClose, onNavigate]);

  if (!item) return null;

  return (
    <div className="chat-image-lightbox-overlay" onClick={onClose}>
      <div className="chat-image-lightbox-content web-image-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="chat-image-lightbox-header">
          <div className="chat-image-lightbox-title-wrap">
            <ImageIcon size={14} />
            <span className="chat-image-lightbox-title">{item.alt || "Web image"}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              className="rich-chart-btn"
              onClick={() => setScale((s) => Math.max(0.25, s / 1.25))}
              title="Zoom out"
            >
              <ZoomOut size={12} />
            </button>
            <span className="visual-fullscreen-zoom-label">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="rich-chart-btn"
              onClick={() => setScale((s) => Math.min(8, s * 1.25))}
              title="Zoom in"
            >
              <ZoomIn size={12} />
            </button>
            {item.sourceUrl && (
              <a
                className="rich-chart-btn"
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer"
                title={`Open the source page: ${item.sourceUrl}`}
              >
                <ExternalLink size={11} />
                <span>Source</span>
              </a>
            )}
            <button type="button" className="rich-chart-btn" onClick={onClose} title="Close preview">
              <X size={12} />
              <span>Close</span>
            </button>
          </div>
        </div>
        <div
          className="chat-image-lightbox-body"
          onWheel={(event) => {
            event.preventDefault();
            setScale((s) => Math.min(8, Math.max(0.25, event.deltaY < 0 ? s * 1.15 : s / 1.15)));
          }}
          onDoubleClick={() => setScale(1)}
        >
          <img
            src={item.src}
            alt={item.alt || "Web image result"}
            className="chat-image-lightbox-img"
            style={{ transform: `scale(${scale})`, cursor: scale > 1 ? "zoom-out" : "default" }}
            onClick={() => (scale > 1 ? setScale(1) : onClose())}
          />
        </div>
        <div className="chat-image-lightbox-caption">
          {items.length > 1 ? `${index + 1} / ${items.length} — use ←/→ to browse` : "Scroll to zoom"}
        </div>
      </div>
    </div>
  );
}

function SearchImageGallery({ items }: { items: SearchImageItem[] }) {
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const rowCount = Math.max(1, Math.ceil((items.length - 1) / 2));
  return (
    <>
      <div
        className={`search-image-gallery${items.length === 2 ? " two-images" : ""}`}
        style={{ gridTemplateRows: `repeat(${rowCount}, minmax(90px, 1fr))` }}
        role="group"
        aria-label="Web image results"
      >
        {items.map((item, index) => failed.has(index) ? null : (
          <button
            type="button"
            className={`search-image-tile${index === 0 ? " featured" : ""}`}
            key={`${item.src}-${index}`}
            onClick={() => setOpenIndex(index)}
            title={item.alt || "View image in a popup (use the Source button to open the web page)"}
          >
            <img
              src={item.src}
              alt={item.alt || "Web image result"}
              loading={index > 2 ? "lazy" : "eager"}
              onError={() => setFailed((current) => new Set(current).add(index))}
            />
            <span className="search-image-caption">{item.alt || "View image"}</span>
          </button>
        ))}
      </div>
      {openIndex !== null && (
        <SearchImageLightbox
          items={items}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onNavigate={setOpenIndex}
        />
      )}
    </>
  );
}

const CHART_KINDS = new Set(["mermaid", "scatter", "bar", "hbar", "line", "area", "pie", "donut", "radar"]);
const BLOCK_PATTERN = /(```([\w-]*)\s*\n([\s\S]*?)```)|(!\[([^\]]*)\]\(([^)]+)\))/gi;

/** Shared fence-kind → component mapping, used by known-language fences and by
 * untagged fences whose content was sniffed via detectFenceKind. */
function chartPiece(kind: string, blockSource: string, key: string): React.ReactNode {
  switch (kind) {
    case "scatter": return <ScatterBlock key={key} source={blockSource} />;
    case "bar": return <CategoryChartBlock key={key} source={blockSource} kind="bar" />;
    case "hbar": return <HBarBlock key={key} source={blockSource} />;
    case "line": return <CategoryChartBlock key={key} source={blockSource} kind="line" />;
    case "area": return <CategoryChartBlock key={key} source={blockSource} kind="area" />;
    case "pie": return <PieBlock key={key} source={blockSource} donut={false} />;
    case "donut": return <PieBlock key={key} source={blockSource} donut={true} />;
    case "radar": return <RadarBlock key={key} source={blockSource} />;
    default: return <MermaidBlock key={key} source={blockSource} />;
  }
}

export function RichMarkdown({ source, className = "" }: { source: string; className?: string }) {
  const pieces: React.ReactNode[] = [];
  let renderSource = source || "";
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const searchImageMatches = [...renderSource.matchAll(imagePattern)]
    .filter((match) => isSearchImageUrl(match[2] || ""));
  const searchImages: SearchImageItem[] = searchImageMatches.map((match, index) => {
    const nextStart = searchImageMatches[index + 1]?.index ?? Math.min(renderSource.length, (match.index || 0) + match[0].length + 500);
    const nearbyText = renderSource.slice((match.index || 0) + match[0].length, nextStart);
    const sourceUrl = nearbyText.match(/(?:Source:\s*)?\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i)?.[1];
    return { alt: match[1] || "", src: match[2] || "", sourceUrl };
  });

  // Search images may be separated by source citations or short explanations.
  // Gather them once per answer so they form a single gallery like a search
  // result set. Keep the surrounding answer text and remove the citations
  // that are now represented by clickable source-linked tiles.
  if (searchImages.length > 1) {
    const sourceUrls = searchImages.map((item) => item.sourceUrl).filter((url): url is string => Boolean(url));
    for (const url of sourceUrls) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      renderSource = renderSource.replace(new RegExp(`^[^\\n]*\\(${escaped}\\)[^\\n]*\\n?`, "gim"), "");
    }
    const laterMatches = [...renderSource.matchAll(imagePattern)]
      .filter((match) => isSearchImageUrl(match[2] || ""))
      .slice(1)
      .reverse();
    for (const match of laterMatches) {
      const start = match.index || 0;
      renderSource = `${renderSource.slice(0, start)}${renderSource.slice(start + match[0].length)}`;
    }
  }
  const pattern = new RegExp(BLOCK_PATTERN.source, "gi");
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(renderSource))) {
    if (match.index > cursor) {
      const textChunk = renderSource.slice(cursor, match.index);
      if (textChunk.trim()) {
        pieces.push(
          <div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textChunk) }} />
        );
      }
    }

    if (match[1]) {
      const kind = (match[2] || "").toLowerCase();
      const blockSource = match[3];

      if (kind === "widget") {
        pieces.push(<WidgetBlock key={`widget-${match.index}`} source={blockSource} />);
      } else {
        // Known kind renders directly; a missing or unrecognized language tag
        // gets sniffed against the chart spec / mermaid grammar — the model
        // sometimes forgets the tag and the content would end up as a code
        // box. Anything the sniff doesn't recognize stays a code block.
        const resolved = CHART_KINDS.has(kind) ? kind : detectFenceKind(blockSource);
        if (resolved) {
          pieces.push(chartPiece(resolved, blockSource, `${resolved}-${match.index}`));
        } else {
          pieces.push(
            <div key={`code-${match.index}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(match[1]) }} />
          );
        }
      }
    } else if (match[4]) {
      const altText = match[5] || "";
      const imgSrc = match[6] || "";
      if (isSearchImageUrl(imgSrc)) {
        if (searchImages.length > 1) {
          pieces.push(<SearchImageGallery key={`gallery-${match.index}`} items={searchImages} />);
        } else {
          pieces.push(<ChatImageBlock key={`img-${match.index}`} alt={altText} src={imgSrc} />);
        }
      } else {
        pieces.push(<ChatImageBlock key={`img-${match.index}`} alt={altText} src={imgSrc} />);
      }
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < renderSource.length || !pieces.length) {
    const remaining = renderSource.slice(cursor);
    if (remaining.trim() || !pieces.length) {
      pieces.push(
        <div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(remaining) }} />
      );
    }
  }

  return <div className={`rich-markdown md ${className}`}>{pieces}</div>;
}
