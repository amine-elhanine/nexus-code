import React from "react";
import { Copy } from "lucide-react";
import { computeChartSeries, chartToCsv, formatWidgetValue, type WidgetChart } from "../../utils/widget-blocks.js";
import { niceMax } from "../../utils/chart-blocks.js";

/**
 * SVG mini-chart for widget blocks. Supports multi-series bar (grouped),
 * line, area, pie and donut with gridlines, tick labels, a legend, native
 * <title> tooltips, and a CSV copy button. All series values are computed
 * by the pure widget-blocks helpers; this component only draws.
 */

export const WIDGET_SERIES_COLORS = ["#7aa8d1", "#34d399", "#e5aa64", "#c084fc"];

function compactTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`;
  if (abs >= 1_000) return `${Math.round((value / 1_000) * 10) / 10}k`;
  return String(Math.round(value * 100) / 100);
}

/** Annulus sector path for pie/donut slices. */
function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  if (r0 <= 0) {
    return `M ${cx} ${cy} L ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} Z`;
  }
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

export function WidgetChartView({
  chart,
  values,
  onCopyCsv,
}: {
  chart: WidgetChart;
  values: Record<string, number>;
  onCopyCsv?: (csv: string) => void;
}) {
  const series = computeChartSeries(chart, values);
  if (!series.length) return null;

  const colorFor = (index: number) => WIDGET_SERIES_COLORS[index % WIDGET_SERIES_COLORS.length];
  const title = chart.title || (chart.variant === "pie" || chart.variant === "donut" ? "Breakdown" : "Chart");

  if (chart.variant === "pie" || chart.variant === "donut") {
    const points = series[0].points;
    const total = points.reduce((acc, point) => acc + Math.max(0, point.value), 0);
    const size = 240;
    const cx = size / 2;
    const cy = size / 2;
    const r1 = size / 2 - 10;
    const r0 = chart.variant === "donut" ? r1 * 0.55 : 0;
    let angle = -Math.PI / 2;
    const slices = total > 0
      ? points.map((point, index) => {
          const sweep = (Math.max(0, point.value) / total) * Math.PI * 2;
          const path = arcPath(cx, cy, r0, r1, angle, angle + Math.min(sweep, Math.PI * 2 - 0.0001));
          const pct = (Math.max(0, point.value) / total) * 100;
          angle += sweep;
          return { key: point.label, path, pct, color: colorFor(index), label: point.label, value: point.value };
        })
      : [];
    return (
      <div className="widget-chart" role="img" aria-label={title}>
        <div className="widget-chart-head">
          <span className="widget-chart-title">{title}</span>
          {onCopyCsv && (
            <button type="button" className="rich-chart-btn" title="Copy data as CSV" onClick={() => onCopyCsv(chartToCsv(chart, values))}>
              <Copy size={11} />
            </button>
          )}
        </div>
        <div className="widget-pie-row">
          <svg viewBox={`0 0 ${size} ${size}`} className="widget-chart-svg" preserveAspectRatio="xMidYMid meet">
            {total <= 0 ? (
              <circle cx={cx} cy={cy} r={r1} fill="none" stroke="#27364b" strokeWidth="1" />
            ) : (
              slices.map((slice) => (
                <path key={slice.key} d={slice.path} fill={slice.color}>
                  <title>{`${slice.label}: ${formatWidgetValue(slice.value)} (${slice.pct.toFixed(1)}%)`}</title>
                </path>
              ))
            )}
            {chart.variant === "donut" && total > 0 && (
              <text x={cx} y={cy + 4} textAnchor="middle" className="widget-chart-donut-total">
                {compactTick(total)}
              </text>
            )}
          </svg>
          <div className="widget-legend">
            {slices.map((slice) => (
              <span key={slice.key} className="widget-legend-item">
                <span className="widget-legend-dot" style={{ background: slice.color }} />
                {slice.label}
                <span className="widget-legend-value">{slice.pct.toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Cartesian charts: grouped bars / lines / areas on shared gridlines.
  const width = 560;
  const height = 230;
  const padLeft = 46;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const labels: string[] = [];
  for (const s of series) for (const point of s.points) if (!labels.includes(point.label)) labels.push(point.label);
  const peak = Math.max(...series.flatMap((s) => s.points.map((p) => p.value)), 0.0001);
  const floor = Math.min(...series.flatMap((s) => s.points.map((p) => p.value)), 0);
  const yMax = niceMax(peak);
  const yMin = floor < 0 ? -niceMax(-floor) : 0;
  const yOf = (value: number) => padTop + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((step) => yMin + ((yMax - yMin) * step) / 4);
  const labelEvery = labels.length > 8 ? Math.ceil(labels.length / 8) : 1;
  const groupW = plotW / Math.max(labels.length, 1);

  return (
    <div className="widget-chart" role="img" aria-label={title}>
      <div className="widget-chart-head">
        <span className="widget-chart-title">{title}</span>
          {onCopyCsv && (
            <button type="button" className="rich-chart-btn" title="Copy data as CSV" onClick={() => onCopyCsv(chartToCsv(chart, values))}>
              <Copy size={11} />
            </button>
          )}
        </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="widget-chart-svg" preserveAspectRatio="xMidYMid meet">
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={padLeft} x2={width - padRight} y1={yOf(tick)} y2={yOf(tick)} stroke="#1c2635" strokeWidth="1" />
            <text x={padLeft - 6} y={yOf(tick) + 3} textAnchor="end" className="widget-chart-tick">
              {compactTick(tick)}
            </text>
          </g>
        ))}
        {chart.variant === "bar" &&
          labels.map((label, labelIndex) => {
            const groupX = padLeft + groupW * labelIndex;
            const barW = (groupW * 0.66) / series.length;
            return (
              <g key={label}>
                {series.map((s, seriesIndex) => {
                  const point = s.points.find((p) => p.label === label);
                  if (!point) return null;
                  const top = yOf(Math.max(point.value, 0));
                  const bottom = yOf(0);
                  const x = groupX + groupW * 0.17 + barW * seriesIndex;
                  return (
                    <rect key={s.name + seriesIndex} x={x} y={top} width={Math.max(barW - 2, 2)} height={Math.max(bottom - top, 1)} fill={colorFor(seriesIndex)} rx="1.5">
                      <title>{`${s.name ? s.name + " · " : ""}${label}: ${formatWidgetValue(point.value)}`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
        {(chart.variant === "line" || chart.variant === "area") &&
          series.map((s, seriesIndex) => {
            const points = labels
              .map((label) => s.points.find((p) => p.label === label))
              .filter((p): p is { label: string; value: number } => Boolean(p));
            if (points.length < 2 && chart.variant === "line") return null;
            const coords = points.map((point, index) => {
              const x = padLeft + groupW * (labels.indexOf(point.label) + 0.5);
              return `${x} ${yOf(point.value)}`;
            });
            const color = colorFor(seriesIndex);
            return (
              <g key={s.name + seriesIndex}>
                {chart.variant === "area" && coords.length >= 2 && (
                  <polygon points={`${coords[0].split(" ")[0]} ${yOf(0)}, ${coords.join(" ")} ${coords[coords.length - 1].split(" ")[0]} ${yOf(0)}`} fill={color} fillOpacity="0.16" />
                )}
                <polyline points={coords.join(" ")} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
                {points.map((point) => {
                  const x = padLeft + groupW * (labels.indexOf(point.label) + 0.5);
                  return (
                    <circle key={point.label} cx={x} cy={yOf(point.value)} r="2.6" fill={color}>
                      <title>{`${s.name ? s.name + " · " : ""}${point.label}: ${formatWidgetValue(point.value)}`}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
        {labels.map((label, index) =>
          index % labelEvery === 0 ? (
            <text
              key={label}
              x={padLeft + groupW * (index + 0.5)}
              y={height - padBottom + 14}
              textAnchor="middle"
              className="widget-chart-tick"
            >
              {label}
            </text>
          ) : null
        )}
      </svg>
      {series.length > 1 && (
        <div className="widget-legend widget-legend-row">
          {series.map((s, index) => (
            <span key={s.name + index} className="widget-legend-item">
              <span className="widget-legend-dot" style={{ background: colorFor(index) }} />
              {s.name || `series ${index + 1}`}
            </span>
          ))}
        </div>
      )}
      {(chart.xLabel || chart.yLabel) && (
        <div className="widget-chart-axes">
          <span>{chart.xLabel}</span>
          <span>{chart.yLabel}</span>
        </div>
      )}
    </div>
  );
}
