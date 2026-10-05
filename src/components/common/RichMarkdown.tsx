import React, { useEffect, useState } from "react";
import mermaid from "mermaid";
import { renderMarkdown } from "../../markdown.js";
import { parseBarChart, parseLineChart, parseScatterChart, type CategoryChartSpec } from "../../utils/chart-blocks.js";

let mermaidSequence = 0;
let mermaidConfigured = false;

function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const id = `nexus-mermaid-${++mermaidSequence}`;
    void (async () => {
      try {
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
  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const width = 760, height = 420, left = 62, right = 24, top = 42, bottom = 58;
  const plotW = width - left - right, plotH = height - top - bottom;
  const px = (value: number) => left + ((value - spec.xMin) / (spec.xMax - spec.xMin || 1)) * plotW;
  const py = (value: number) => top + plotH - ((value - spec.yMin) / (spec.yMax - spec.yMin || 1)) * plotH;
  return <div className="rich-scatter" role="img" aria-label={spec.title || "Scatter plot"}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      {spec.title && <text x={width / 2} y={22} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
      <line x1={left} y1={top} x2={left} y2={top + plotH} className="rich-chart-axis" />
      <line x1={left} y1={top + plotH} x2={left + plotW} y2={top + plotH} className="rich-chart-axis" />
      {spec.points.map((point) => <g key={`${point.name}-${point.x}-${point.y}`}>
        <circle cx={px(point.x)} cy={py(point.y)} r="5" className="rich-scatter-point" />
        <title>{`${point.name}: ${point.x}, ${point.y}`}</title>
      </g>)}
      <text x={left + plotW / 2} y={height - 12} textAnchor="middle" className="rich-chart-label">{spec.xLabel}</text>
      <text x="14" y={top + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${top + plotH / 2})`} className="rich-chart-label">{spec.yLabel}</text>
    </svg>
  </div>;
}

// Bar/line share one frame: axes, three y ticks, category labels below and a
// value label per bar (line values live in the hover tooltip only).
function CategoryChartBlock({ source, kind }: { source: string; kind: "bar" | "line" }) {
  const spec: CategoryChartSpec | null = kind === "bar" ? parseBarChart(source) : parseLineChart(source);
  if (!spec) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  const width = 760, height = 420, left = 62, right = 24, top = 42, bottom = 58;
  const plotW = width - left - right, plotH = height - top - bottom;
  const clamp = (value: number) => Math.min(spec.yMax, Math.max(spec.yMin, value));
  const py = (value: number) => top + plotH - ((clamp(value) - spec.yMin) / (spec.yMax - spec.yMin || 1)) * plotH;
  const baseline = py(spec.yMin);
  const fmt = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));
  const truncate = (label: string) => (label.length > 12 ? `${label.slice(0, 11)}…` : label);
  const ticks = [spec.yMin, spec.yMin + (spec.yMax - spec.yMin) / 2, spec.yMax];
  const slot = plotW / spec.entries.length;
  const mid = (i: number) => (spec.entries.length > 1 ? left + i * slot + slot / 2 : left + plotW / 2);
  return (
    <div className="rich-chart" role="img" aria-label={spec.title || (kind === "bar" ? "Bar chart" : "Line chart")}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {spec.title && <text x={width / 2} y={22} textAnchor="middle" className="rich-chart-title">{spec.title}</text>}
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={left} y1={py(tick)} x2={left + plotW} y2={py(tick)} className="rich-chart-axis" style={{ strokeOpacity: 0.15 }} />
            <text x={left - 8} y={py(tick) + 3} textAnchor="end" className="rich-chart-tick">{fmt(tick)}</text>
          </g>
        ))}
        <line x1={left} y1={top} x2={left} y2={top + plotH} className="rich-chart-axis" />
        <line x1={left} y1={baseline} x2={left + plotW} y2={baseline} className="rich-chart-axis" />
        {kind === "bar" && spec.entries.map((entry, index) => {
          const barWidth = Math.min(slot * 0.62, 80);
          const x = left + index * slot + (slot - barWidth) / 2;
          const yTop = py(entry.value);
          return (
            <g key={`${entry.label}-${index}`}>
              <rect x={x} y={yTop} width={barWidth} height={Math.max(0, baseline - yTop)} className="rich-bar">
                <title>{`${entry.label}: ${fmt(entry.value)}`}</title>
              </rect>
              <text x={x + barWidth / 2} y={yTop - 6} textAnchor="middle" className="rich-chart-tick">{fmt(entry.value)}</text>
              <text x={x + barWidth / 2} y={baseline + 16} textAnchor="middle" className="rich-chart-label">{truncate(entry.label)}</text>
            </g>
          );
        })}
        {kind === "line" && (
          <g>
            <polyline
              points={spec.entries.map((entry, index) => `${mid(index)},${py(entry.value)}`).join(" ")}
              className="rich-line-path"
            />
            {spec.entries.map((entry, index) => (
              <g key={`${entry.label}-${index}`}>
                <circle cx={mid(index)} cy={py(entry.value)} r="4" className="rich-line-point">
                  <title>{`${entry.label}: ${fmt(entry.value)}`}</title>
                </circle>
                <text x={mid(index)} y={baseline + 16} textAnchor="middle" className="rich-chart-label">{truncate(entry.label)}</text>
              </g>
            ))}
          </g>
        )}
        <text x={left + plotW / 2} y={height - 12} textAnchor="middle" className="rich-chart-label">{spec.xLabel}</text>
        <text x="14" y={top + plotH / 2} textAnchor="middle" transform={`rotate(-90 14 ${top + plotH / 2})`} className="rich-chart-label">{spec.yLabel}</text>
      </svg>
    </div>
  );
}

const FENCE_PATTERN = /```(mermaid|scatter|bar|line)\s*\n([\s\S]*?)```/gi;

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
    else if (kind === "line") pieces.push(<CategoryChartBlock key={`line-${match.index}`} source={blockSource} kind="line" />);
    else pieces.push(<MermaidBlock key={`mermaid-${match.index}`} source={blockSource} />);
    cursor = match.index + match[0].length;
  }
  if (cursor < (source || "").length || !pieces.length) {
    pieces.push(<div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown((source || "").slice(cursor)) }} />);
  }
  return <div className={`rich-markdown md ${className}`}>{pieces}</div>;
}
