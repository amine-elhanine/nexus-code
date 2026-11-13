import React, { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, Check, Maximize2, X, Image as ImageIcon, ZoomIn, ZoomOut, AlertCircle, RefreshCw, ExternalLink, BarChart2, Layers } from "lucide-react";
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
  type CategoryChartEntry,
} from "../../utils/chart-blocks.js";
import { WidgetBlock } from "../chat/WidgetBlock.js";

let mermaidSequence = 0;
let mermaidConfigured = false;
// Track which theme mermaid was last initialized with: diagrams were
// hardcoded to "dark" and ignored the app's light theme.
let mermaidTheme = "";

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
  const [pngBusy, setPngBusy] = useState(false);
  const [pngDone, setPngDone] = useState(false);

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

  const handleDownloadPng = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const svgEl = svgRef.current;
    if (!svgEl || pngBusy) return;
    setPngBusy(true);
    try {
      const svgXml = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([svgXml], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("SVG rasterization failed"));
        img.src = url;
      });
      URL.revokeObjectURL(url);
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, svgEl.clientWidth || 760) * scale;
      canvas.height = Math.max(1, svgEl.clientHeight || 420) * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable");
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#0b0f16";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${(title || "chart").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}.png`;
      a.click();
      setPngDone(true);
      setTimeout(() => setPngDone(false), 1800);
    } catch { /* best effort */ } finally {
      setPngBusy(false);
    }
  };

  return (
    <div className="rich-chart-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="rich-chart-btn"
        onClick={handleFullscreen}
        title="Fullscreen view (zoom, pan, inspect)"
        aria-label="Fullscreen view"
      >
        <Maximize2 size={12} />
        <span className="rich-chart-btn-label">Full</span>
      </button>
      {dataText && (
        <button
          type="button"
          className={`rich-chart-btn ${copiedData ? "saved" : ""}`}
          onClick={handleCopyData}
          title={copiedData ? "Copied CSV to clipboard" : "Copy chart data as CSV"}
          aria-label="Copy CSV data"
        >
          {copiedData ? <Check size={12} /> : <Copy size={12} />}
          <span className="rich-chart-btn-label">{copiedData ? "Copied" : "Data"}</span>
        </button>
      )}
      <button
        type="button"
        className={`rich-chart-btn ${downloaded ? "saved" : ""}`}
        onClick={handleDownloadSvg}
        title={downloaded ? "Saved SVG file" : "Download chart as SVG"}
        aria-label="Download SVG"
      >
        {downloaded ? <Check size={12} /> : <Download size={12} />}
        <span className="rich-chart-btn-label">{downloaded ? "Saved" : "SVG"}</span>
      </button>
      <button
        type="button"
        className={`rich-chart-btn ${pngDone ? "saved" : ""}`}
        onClick={handleDownloadPng}
        disabled={pngBusy}
        title={pngDone ? "Saved PNG image" : "Download chart as PNG (2x)"}
        aria-label="Download PNG image"
      >
        {pngDone ? <Check size={12} /> : <ImageIcon size={12} />}
        <span className="rich-chart-btn-label">{pngBusy ? "…" : pngDone ? "Saved" : "PNG"}</span>
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
        // (Re)initialize when the app theme flips: light theme gets mermaid's
        // "default" (light) palette instead of the previous hardcoded "dark".
        const theme = document.documentElement.classList.contains("theme-light") ? "default" as const : "dark" as const;
        if (!mermaidConfigured || mermaidTheme !== theme) {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
          mermaidConfigured = true;
          mermaidTheme = theme;
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
      <div className="chart-header-row">
        <span className="chart-header-title">{spec.title || "Scatter Plot"}</span>
        <ChartActions title={spec.title || "scatter-plot"} svgRef={svgRef} dataText={csv} />
      </div>
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
// Multi-series interactive category chart with live view switching
// (Bar | Line | Area | Table), series legend, smooth curves and CSV export.

const SERIES_PALETTE = ["#34d399", "#60a5fa", "#f59e0b", "#f472b6", "#a78bfa", "#f87171", "#22d3ee", "#facc15"];

/** Catmull-Rom spline → cubic Bezier path through the given points. */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return points.map((p) => `${p.x},${p.y}`).join(" ");
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x},${p2.y}`;
  }
  return d;
}

function CategoryChartBlock({ source, kind }: { source: string; kind: "bar" | "line" | "area" }) {
  const spec: CategoryChartSpec | null =
    kind === "bar" ? parseBarChart(source) : kind === "area" ? parseAreaChart(source) : parseLineChart(source);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<number | null>(null);
  const [view, setView] = useState<"bar" | "line" | "area" | "table">(kind);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const seriesCount = Math.max(1, spec.seriesNames.length, ...spec.entries.map((e) => e.values.length));
  const isMulti = seriesCount > 1;
  const activeView = view;
  const width = 760, height = 420, left = 62, right = 24, top = 42, bottom = 58;
  const plotW = width - left - right, plotH = height - top - bottom;
  const clamp = (value: number) => Math.min(spec.yMax, Math.max(spec.yMin, value));
  const py = (value: number) => top + plotH - ((clamp(value) - spec.yMin) / (spec.yMax - spec.yMin || 1)) * plotH;
  const baseline = py(spec.yMin);
  const ticks = [spec.yMin, spec.yMin + (spec.yMax - spec.yMin) / 2, spec.yMax];
  const slot = plotW / spec.entries.length;
  const mid = (i: number) => (spec.entries.length > 1 ? left + i * slot + slot / 2 : left + plotW / 2);
  const seriesName = (s: number) => spec.seriesNames[s] || `Series ${s + 1}`;
  const seriesColor = (s: number) => SERIES_PALETTE[s % SERIES_PALETTE.length];
  const entryValue = (entry: CategoryChartEntry, s: number) => (entry.values.length > s ? entry.values[s] : entry.values[entry.values.length - 1] ?? entry.value);
  const labelKind = kind === "bar" ? "Bar chart" : kind === "area" ? "Area chart" : "Line chart";

  const activeEntry = hoveredIndex !== null ? spec.entries[hoveredIndex] : null;
  const csv =
    [spec.xLabel || "Category", ...Array.from({ length: seriesCount }, (_, s) => spec.seriesNames[s] || `Series ${s + 1}`)].join(",") +
    "\n" +
    spec.entries.map((e) => `"${e.label}",` + Array.from({ length: seriesCount }, (_, s) => entryValue(e, s)).join(",")).join("\n");

  // Series-visibility for the active view: hovered series dims others.
  const seriesStyle = (s: number): React.CSSProperties =>
    hoveredSeries !== null && hoveredSeries !== s ? { opacity: 0.25, transition: "opacity 0.2s" } : { transition: "opacity 0.2s" };

  const renderBars = () => {
    const groupWidth = Math.min(slot * 0.68, 110);
    const singleWidth = Math.min(slot * 0.62, 80);
    return spec.entries.map((entry, index) => {
      const isHovered = hoveredIndex === index;
      const isDimmed = hoveredIndex !== null && !isHovered;
      const x = left + index * slot + (slot - (isMulti ? groupWidth : singleWidth)) / 2;
      const bars = [];
      if (isMulti && spec.stacked) {
        let cumulative = spec.yMin;
        const barWidth = groupWidth;
        for (let s = 0; s < seriesCount; s++) {
          const v = entryValue(entry, s);
          const y0 = py(cumulative);
          const y1 = py(cumulative + v);
          cumulative += v;
          bars.push(
            <rect key={s} x={x} y={y1} width={barWidth} height={Math.max(0, y0 - y1)} fill={seriesColor(s)} style={seriesStyle(s)} rx={2} />
          );
        }
        bars.push(
          <text key="total" x={x + barWidth / 2} y={py(cumulative) - 6} textAnchor="middle" className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>{fmt(cumulative)}</text>
        );
      } else if (isMulti) {
        const barWidth = groupWidth / seriesCount;
        for (let s = 0; s < seriesCount; s++) {
          const v = entryValue(entry, s);
          const bx = x + s * barWidth;
          const yTop = py(v);
          bars.push(
            <g key={s} style={seriesStyle(s)}>
              <rect x={bx} y={yTop} width={barWidth - 2} height={Math.max(0, baseline - yTop)} rx={2} fill={seriesColor(s)} />
              <text x={bx + (barWidth - 2) / 2} y={yTop - 5} textAnchor="middle" className="rich-chart-tick" fontSize={9}>{fmt(v)}</text>
            </g>
          );
        }
      } else {
        const yTop = py(entry.value);
        bars.push(
          <g key="single" style={seriesStyle(0)}>
            <rect x={x} y={yTop} width={singleWidth} height={Math.max(0, baseline - yTop)} rx={3} className={`rich-bar ${isHovered ? "active" : ""}`} />
            <text x={x + singleWidth / 2} y={yTop - 6} textAnchor="middle" className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>{fmt(entry.value)}</text>
          </g>
        );
      }
      return (
        <g
          key={`${entry.label}-${index}`}
          onMouseEnter={() => setHoveredIndex(index)}
          onMouseLeave={() => setHoveredIndex(null)}
          style={{ opacity: isDimmed ? 0.35 : 1, transition: "opacity 0.2s" }}
        >
          {bars}
          <text x={left + index * slot + slot / 2} y={baseline + 16} textAnchor="middle" className="rich-chart-label" fontWeight={isHovered ? "700" : "normal"}>{truncate(entry.label)}</text>
        </g>
      );
    });
  };

  const renderLines = (filled: boolean) => {
    const seriesIndices = Array.from({ length: seriesCount }, (_, s) => s);
    return seriesIndices.map((s) => {
      const points = spec.entries.map((entry, index) => ({ x: mid(index), y: py(entryValue(entry, s)) }));
      const pathD = smoothPath(points);
      const areaD = `${pathD} L ${points[points.length - 1]?.x ?? left},${baseline} L ${points[0]?.x ?? left},${baseline} Z`;
      return (
        <g key={s} style={seriesStyle(s)}>
          {filled && (
            <path d={areaD} fill={seriesColor(s)} opacity={seriesCount > 1 ? 0.12 : 0.18} stroke="none">
              <animate attributeName="opacity" from="0" to={seriesCount > 1 ? 0.12 : 0.18} dur="0.5s" fill="freeze" />
            </path>
          )}
          <path d={pathD} fill="none" stroke={seriesColor(s)} strokeWidth={2} strokeLinecap="round" className="rich-line-path" style={seriesStyle(s)} />
          {points.map((p, index) => {
            const isHovered = hoveredIndex === index;
            return (
              <g key={index} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)}>
                {isHovered && <circle cx={p.x} cy={p.y} r={12} fill="none" stroke={seriesColor(s)} strokeWidth={2} opacity={0.6} className="rich-halo-ring" />}
                <circle cx={p.x} cy={p.y} r={isHovered ? 6 : 4} fill={seriesColor(s)} className={`rich-line-point ${isHovered ? "active" : ""}`} />
              </g>
            );
          })}
        </g>
      );
    });
  };

  const xLabels = (
    <g>
      {spec.entries.map((entry, index) => (
        <text key={index} x={left + index * slot + slot / 2} y={baseline + 16} textAnchor="middle" className="rich-chart-label">{truncate(entry.label)}</text>
      ))}
    </g>
  );

  return (
    <div className="rich-chart" role="img" aria-label={spec.title || labelKind}>
      <div className="chart-header-row">
        <div className="chart-view-switcher" role="group" aria-label="Chart view">
          {(["bar", "line", "area", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`chart-view-btn ${activeView === v ? "active" : ""}`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <ChartActions title={spec.title || labelKind.toLowerCase().replace(/\s+/g, "-")} svgRef={svgRef} dataText={csv} />
      </div>
      {activeView === "table" ? (
        <div className="chart-table-view" style={{ overflowX: "auto", border: "1px solid var(--line, #24334a)", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "7px 10px", borderBottom: "1px solid var(--line, #24334a)", color: "var(--muted)", fontWeight: 600 }}>{spec.xLabel || "Category"}</th>
                {Array.from({ length: seriesCount }, (_, s) => (
                  <th key={s} style={{ textAlign: "right", padding: "7px 10px", borderBottom: "1px solid var(--line, #24334a)", color: seriesColor(s), fontWeight: 600 }}>{seriesName(s)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.entries.map((entry, index) => (
                <tr key={index} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} style={{ background: hoveredIndex === index ? "var(--panel2, #17202d)" : "transparent" }}>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--panel2, #17202d)" }}>{entry.label}</td>
                  {Array.from({ length: seriesCount }, (_, s) => (
                    <td key={s} style={{ padding: "6px 10px", borderBottom: "1px solid var(--panel2, #17202d)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(entryValue(entry, s))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
          <defs>
            {Array.from({ length: seriesCount }, (_, s) => (
              <linearGradient key={s} id={`area-grad-${s}-${seriesColor(s).slice(1)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={seriesColor(s)} stopOpacity={0.35} />
                <stop offset="100%" stopColor={seriesColor(s)} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          {spec.title && <text x={width / 2} y={22} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
          {spec.subtitle && <text x={width / 2} y={spec.title ? 36 : 22} textAnchor="middle" className="rich-chart-tick" fontSize={10} opacity={0.75}>{spec.subtitle}</text>}
          {ticks.map((tick, index) => (
            <g key={index}>
              <line x1={left} y1={py(tick)} x2={left + plotW} y2={py(tick)} className="rich-chart-axis" style={{ strokeOpacity: 0.15 }} />
              <text x={left - 8} y={py(tick) + 3} textAnchor="end" className="rich-chart-tick">{fmt(tick)}</text>
            </g>
          ))}
          <line x1={left} y1={top} x2={left} y2={top + plotH} className="rich-chart-axis" />
          <line x1={left} y1={baseline} x2={left + plotW} y2={baseline} className="rich-chart-axis" />

          {(activeView === "line" || activeView === "area") && hoveredIndex !== null && (
            <line x1={mid(hoveredIndex)} y1={top} x2={mid(hoveredIndex)} y2={baseline} className="rich-chart-guide" />
          )}

          {activeView === "bar" && renderBars()}

          {activeView === "area" && (
            <g>
              {renderLines(true)}
              {xLabels}
            </g>
          )}

          {activeView === "line" && (
            <g>
              {renderLines(false)}
              {xLabels}
            </g>
          )}

          <text x={left + plotW / 2} y={height - 12} textAnchor="middle" className="rich-chart-label">{spec.xLabel}</text>
          <text x="14" y={top + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${top + plotH / 2})`} className="rich-chart-label">{spec.yLabel}</text>

          {activeEntry && (
            <SvgTooltip
              x={activeView === "bar" ? left + (hoveredIndex! * slot) + slot / 2 : mid(hoveredIndex!)}
              y={py(entryValue(activeEntry, 0))}
              title={activeEntry.label}
              value={seriesCount > 1
                ? Array.from({ length: seriesCount }, (_, s) => `${spec.seriesNames[s] || `S${s + 1}`} ${fmt(entryValue(activeEntry, s))}`).join("  ·  ")
                : fmt(activeEntry.value)}
            />
          )}
        </svg>
      )}
      {isMulti && activeView !== "table" && (
        <div className="chart-series-legend" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6, padding: "0 4px" }}>
          {Array.from({ length: seriesCount }, (_, s) => (
            <button
              key={s}
              type="button"
              onMouseEnter={() => setHoveredSeries(s)}
              onMouseLeave={() => setHoveredSeries(null)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, border: 0, background: "transparent",
                color: hoveredSeries === null || hoveredSeries === s ? "var(--text, #dce1eb)" : "var(--muted, #7e8b9d)",
                fontSize: 10.5, cursor: "pointer", padding: "2px 4px", opacity: hoveredSeries !== null && hoveredSeries !== s ? 0.5 : 1,
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: seriesColor(s), flex: "none" }} />
              {seriesName(s)}
            </button>
          ))}
        </div>
      )}
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
      <div className="chart-header-row">
        <span className="chart-header-title">{spec.title || "Horizontal Bar Chart"}</span>
        <ChartActions title={spec.title || "hbar-chart"} svgRef={svgRef} dataText={csv} />
      </div>
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
      <div className="chart-header-row">
        <span className="chart-header-title">{spec.title || (isDonut ? "Donut Chart" : "Pie Chart")}</span>
        <ChartActions title={spec.title || (isDonut ? "donut-chart" : "pie-chart")} svgRef={svgRef} dataText={csv} />
      </div>
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
      <div className="chart-header-row">
        <span className="chart-header-title">{spec.title || "Radar Chart"}</span>
        <ChartActions title={spec.title || "radar-chart"} svgRef={svgRef} dataText={csv} />
      </div>
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
  const filename = cleanPath.split(/[\/\\]/).pop() || cleanPath;

  const rawTitle = alt?.trim()
    ? alt.trim()
    : filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");

  // Classify visual type for contextual badge and icon
  const isDataChart =
    /\b(chart|graph|plot|metric|analytics|trend|histogram|pie|bar|scatter|radar)\b/i.test(filename) ||
    /\b(plot|graph|metric|trend|histogram|pie chart|bar chart|line chart)\b/i.test(alt);

  const isDiagram =
    /\b(diagram|flowchart|architecture|workflow|schema|sequence|er-diagram|wireframe)\b/i.test(filename) ||
    /\b(diagram|flowchart|architecture|workflow|schema|sequence)\b/i.test(alt);

  const visualType: "chart" | "diagram" | "image" = isDataChart
    ? "chart"
    : isDiagram
    ? "diagram"
    : "image";

  const badgeText = visualType === "chart" ? "CHART" : visualType === "diagram" ? "DIAGRAM" : "IMAGE";
  const badgeIcon =
    visualType === "chart" ? (
      <BarChart2 size={11} />
    ) : visualType === "diagram" ? (
      <Layers size={11} />
    ) : (
      <ImageIcon size={11} />
    );

  // Clean auto-suffixed " Chart" when the visual is not an actual data chart (e.g. "Mha Deku Chart" -> "Mha Deku")
  const displayTitle =
    visualType !== "chart" && /\s+Chart$/i.test(rawTitle)
      ? rawTitle.replace(/\s+Chart$/i, "")
      : rawTitle;

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
      a.download = filename || "image.png";
      a.click();
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1800);
    }
  };

  return (
    <div className="rich-chart chat-inline-image-card" role="figure" aria-label={displayTitle}>
      <div className="chat-inline-image-header">
        <div className="chat-inline-image-title-group">
          <span className={`chat-inline-image-badge badge-${visualType}`}>
            {badgeIcon}
            <span>{badgeText}</span>
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
            <span>Loading {badgeText.toLowerCase()} {filename}…</span>
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
              onLoad={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(new CustomEvent("nexus:chat-image-loaded"));
                }
              }}
            />
            <div className="chat-inline-image-zoom-overlay">
              <ZoomIn size={16} />
              <span>Click to enlarge</span>
            </div>
          </div>
        )}
      </div>

      {alt && alt.trim() !== displayTitle && alt.trim() !== filename && alt.trim().replace(/\s+Chart$/i, "") !== displayTitle && (
        <div className="chat-inline-image-caption">
          {alt}
        </div>
      )}

{zoomed && dataUrl && createPortal(
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
            {alt && alt.trim() !== displayTitle && alt.trim().replace(/\s+Chart$/i, "") !== displayTitle && (
              <div className="chat-image-lightbox-caption">
                {alt}
              </div>
            )}
          </div>
        </div>,
        document.body
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

  // Portal to <body>: the overlay must always cover the viewport above all
  // content. Rendered inline inside a chat message, any ancestor stacking /
  // containing context (animations, blurs, transforms) can trap the
  // position:fixed overlay — the stacked-viewers bug.
  return createPortal(
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
    </div>,
    document.body
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
// ---- Inline video cards & source citations (ChatGPT-style) -----------------

const YT_VIDEO_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
const VIDEO_IMAGE_RE = /^Video:\s*(.+)$/i;

function youTubeId(value: string): string | null {
  const match = String(value || "").match(YT_VIDEO_RE);
  return match ? match[1] : null;
}

function ChatVideoBlock({ alt, src }: { alt: string; src: string }) {
  const videoId = youTubeId(src);
  const [playing, setPlaying] = useState(false);
  if (!videoId) return <ChatImageBlock alt={alt} src={src} />;
  const metaMatch = alt.match(VIDEO_IMAGE_RE);
  const metaParts = metaMatch ? metaMatch[1].split("|").map((x) => x.trim()) : [];
  const title = metaParts[0] || "Video";
  const channel = metaParts[1] || "";
  const duration = metaParts[2] || "";
  return (
    <div className="chat-video-card" style={{ maxWidth: 520, margin: "10px 0" }}>
      {playing ? (
        <div style={{ position: "relative", paddingBottom: "56.25%", borderRadius: 10, overflow: "hidden", background: "#000" }}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          style={{ position: "relative", display: "block", width: "100%", padding: 0, border: 0, borderRadius: 10, overflow: "hidden", cursor: "pointer", background: "#000" }}
          title={`Play: ${title}`}
        >
          <img
            src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
            alt={title}
            style={{ display: "block", width: "100%", aspectRatio: "16/9", objectFit: "cover" }}
            loading="lazy"
          />
          <span
            style={{
              position: "absolute", inset: 0, display: "grid", placeItems: "center",
              background: "rgba(0,0,0,0.25)", transition: "background 0.15s",
            }}
          >
            <span style={{ display: "grid", placeItems: "center", width: 52, height: 36, borderRadius: 10, background: "rgba(255,0,0,0.92)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
            </span>
          </span>
        </button>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 11.5, color: "var(--text, #dce1eb)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{title}</strong>
        {channel && <span style={{ fontSize: 10, color: "var(--muted, #8b98ab)", whiteSpace: "nowrap" }}>{channel}</span>}
        {duration && (
          <span style={{ fontSize: 9.5, fontFamily: "'DM Mono', monospace", color: "var(--muted, #8b98ab)", border: "1px solid var(--line, #24334a)", borderRadius: 4, padding: "0 5px" }}>
            {duration}
          </span>
        )}
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer noopener"
          style={{ fontSize: 10, color: "var(--nexus-green, #34d399)", whiteSpace: "nowrap" }}
        >
          YouTube ↗
        </a>
      </div>
    </div>
  );
}

function VideoGallery({ items }: { items: Array<{ alt: string; src: string }> }) {
  return (
    <div className="video-gallery-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, margin: "10px 0" }}>
      {items.map((item, index) => (
        <ChatVideoBlock key={index} alt={item.alt} src={item.src} />
      ))}
    </div>
  );
}

function SourceCitationsBar({ links }: { links: Array<{ url: string; label: string }> }) {
  const [expanded, setExpanded] = useState(false);
  if (!links.length) return null;
  const visible = expanded ? links : links.slice(0, 5);
  return (
    <div className="source-cards-strip" style={{ marginTop: 14, borderTop: "1px solid var(--line, #24334a)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted, #8b98ab)" }}>
          Sources · {links.length}
        </span>
        {links.length > 5 && (
          <button type="button" onClick={() => setExpanded((prev) => !prev)} style={{ border: 0, background: "transparent", color: "var(--nexus-green, #34d399)", fontSize: 10, cursor: "pointer" }}>
            {expanded ? "Show less" : `Show all ${links.length}`}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: expanded ? "wrap" : "nowrap", overflowX: expanded ? "visible" : "auto", paddingBottom: 4 }}>
        {visible.map((link, index) => {
          let domain = link.url;
          try { domain = new URL(link.url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
          return (
            <a
              key={index}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="source-citation-pill"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, flex: expanded ? undefined : "0 0 auto",
                maxWidth: 260, border: "1px solid var(--line, #24334a)", borderRadius: 8,
                padding: "5px 9px", background: "var(--panel2, #141c26)", textDecoration: "none",
              }}
              title={link.label || domain}
            >
              <img
                src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                alt=""
                width={14}
                height={14}
                style={{ borderRadius: 3, flex: "none" }}
                loading="lazy"
              />
              <span style={{ fontSize: 10.5, color: "var(--text, #dce1eb)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {link.label || domain}
              </span>
              <span style={{ fontSize: 9, color: "var(--muted, #8b98ab)", flex: "none" }}>{domain}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

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

// Pure derivation from `source`: block parsing, image/video extraction and
// the markdown pipeline. Memoized per source string in RichMarkdown so an
// unchanged message re-rendered by a streaming parent skips this whole body
// (it re-ran per streamed token before — every sibling transcript row paid
// the regex cost on every token).
function buildRichPieces(source: string): { pieces: React.ReactNode[]; citationLinks: Array<{ url: string; label: string }> } {
  const pieces: React.ReactNode[] = [];
  let renderSource = source;
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  // Video embeds (![Video: Title | Channel | Duration](youtube-url)) render
  // as inline player cards; 2+ become a gallery like the search image set.
  const videoPattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const videoMatches = [...renderSource.matchAll(videoPattern)]
    .filter((match) => youTubeId(match[2] || "") && VIDEO_IMAGE_RE.test(match[1] || ""));
  const videos: SearchImageItem[] = videoMatches.map((match) => ({ alt: match[1] || "", src: match[2] || "", sourceUrl: match[2] || "" }));
  if (videos.length > 1) {
    for (const item of videos.slice(1)) {
      const escaped = item.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      renderSource = renderSource.replace(new RegExp("^[^\n]*\(" + escaped.replace(/\$/g, "\$") + "\)[^\n]*\n?", "gim"), "");
    }
  }
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
      if (youTubeId(imgSrc) && VIDEO_IMAGE_RE.test(altText)) {
        if (videos.length > 1) {
          pieces.push(<VideoGallery key={`videos-${match.index}`} items={videos} />);
        } else {
          pieces.push(<ChatVideoBlock key={`video-${match.index}`} alt={altText} src={imgSrc} />);
        }
      } else if (isSearchImageUrl(imgSrc)) {
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

  const citationLinks: Array<{ url: string; label: string }> = [];
  {
    const seenDomains = new Set<string>();
    for (const match of (renderSource || "").matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) {
      const url = match[2];
      if (youTubeId(url)) continue;
      let domain = "";
      try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      citationLinks.push({ url, label: match[1] });
      if (citationLinks.length >= 12) break;
    }
  }
  return { pieces, citationLinks };
}

export function RichMarkdown({ source, className = "" }: { source: string; className?: string }) {
  const { pieces, citationLinks } = useMemo(() => buildRichPieces(source || ""), [source]);
  return (
    <div className={`rich-markdown md ${className}`}>
      {pieces}
      <SourceCitationsBar links={citationLinks} />
    </div>
  );
}
