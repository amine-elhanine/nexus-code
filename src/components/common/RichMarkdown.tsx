import React, { useEffect, useState, useRef } from "react";
import { Copy, Download, Check } from "lucide-react";
import { renderMarkdown } from "../../markdown.js";
import {
  parseBarChart,
  parseHBarChart,
  parseLineChart,
  parseAreaChart,
  parseScatterChart,
  parsePieChart,
  parseRadarChart,
  type CategoryChartSpec,
} from "../../utils/chart-blocks.js";

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

  return (
    <div className="rich-chart-actions" onClick={(e) => e.stopPropagation()}>
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

function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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

  if (svg) return <div className="rich-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
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
  const svgRef = useRef<SVGSVGElement>(null);

  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const width = 760, height = 430;
  const cx = 380, cy = 225, radius = 135;
  const n = spec.axes.length;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;

  const rings = [0.25, 0.5, 0.75, 1.0];
  const ringPolygons = rings.map((factor) => {
    const r = radius * factor;
    return spec.axes.map((_, i) => `${cx + r * Math.cos(angle(i))},${cy + r * Math.sin(angle(i))}`).join(" ");
  });

  const dataPoints = spec.axes.map((axis, i) => {
    const r = (Math.min(spec.max, Math.max(0, axis.value)) / spec.max) * radius;
    return {
      x: cx + r * Math.cos(angle(i)),
      y: cy + r * Math.sin(angle(i)),
      label: axis.label,
      value: axis.value,
    };
  });
  const dataPolyStr = dataPoints.map((p) => `${p.x},${p.y}`).join(" ");
  const activeAxis = hoveredIndex !== null ? dataPoints[hoveredIndex] : null;

  const csv =
    "Metric,Value,Max\n" +
    spec.axes.map((a) => `"${a.label}",${a.value},${spec.max}`).join("\n");

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
        <polygon points={dataPolyStr} className="rich-radar-poly" />
        {dataPoints.map((p, i) => {
          const isHovered = hoveredIndex === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {isHovered && <circle cx={p.x} cy={p.y} r={12} fill="none" stroke="#7aa8d1" strokeWidth={2} opacity={0.6} className="rich-halo-ring" />}
              <circle cx={p.x} cy={p.y} r={isHovered ? 7 : 4} className={`rich-scatter-point ${isHovered ? "active" : ""}`} />
            </g>
          );
        })}
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
              <text x={lx} y={ly + 12} textAnchor={anchor} className="rich-chart-tick" fontWeight={isHovered ? "700" : "normal"}>{fmt(axis.value)}</text>
            </g>
          );
        })}
        {activeAxis && (
          <SvgTooltip
            x={activeAxis.x}
            y={activeAxis.y}
            title={activeAxis.label}
            value={`${fmt(activeAxis.value)} / ${fmt(spec.max)}`}
          />
        )}
      </svg>
    </div>
  );
}

const FENCE_PATTERN = /```(mermaid|scatter|bar|hbar|line|area|pie|donut|radar)\s*\n([\s\S]*?)```/gi;

export function RichMarkdown({ source, className = "" }: { source: string; className?: string }) {
  const pieces: React.ReactNode[] = [];
  const pattern = FENCE_PATTERN;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source || ""))) {
    if (match.index > cursor) {
      pieces.push(<div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(source.slice(cursor, match.index)) }} />);
    }
    const kind = match[1].toLowerCase();
    const blockSource = match[2];
    if (kind === "scatter") pieces.push(<ScatterBlock key={`scatter-${match.index}`} source={blockSource} />);
    else if (kind === "bar") pieces.push(<CategoryChartBlock key={`bar-${match.index}`} source={blockSource} kind="bar" />);
    else if (kind === "hbar") pieces.push(<HBarBlock key={`hbar-${match.index}`} source={blockSource} />);
    else if (kind === "line") pieces.push(<CategoryChartBlock key={`line-${match.index}`} source={blockSource} kind="line" />);
    else if (kind === "area") pieces.push(<CategoryChartBlock key={`area-${match.index}`} source={blockSource} kind="area" />);
    else if (kind === "pie") pieces.push(<PieBlock key={`pie-${match.index}`} source={blockSource} donut={false} />);
    else if (kind === "donut") pieces.push(<PieBlock key={`donut-${match.index}`} source={blockSource} donut={true} />);
    else if (kind === "radar") pieces.push(<RadarBlock key={`radar-${match.index}`} source={blockSource} />);
    else pieces.push(<MermaidBlock key={`mermaid-${match.index}`} source={blockSource} />);
    cursor = match.index + match[0].length;
  }
  if (cursor < (source || "").length || !pieces.length) {
    pieces.push(<div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown((source || "").slice(cursor)) }} />);
  }
  return <div className={`rich-markdown md ${className}`}>{pieces}</div>;
}
