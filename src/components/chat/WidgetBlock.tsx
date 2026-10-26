import React, { useMemo, useState } from "react";
import { Copy, ExternalLink, MessageCirclePlus, Maximize2, SlidersHorizontal, RotateCcw } from "lucide-react";
import {
  parseWidget,
  evalFormula,
  formatWidgetValue,
  interpolatePrompt,
  computeTone,
  conditionHolds,
  computeTableRows,
  type WidgetSpec,
} from "../../utils/widget-blocks.js";
import { WidgetChartView } from "./WidgetChart.js";
import { openVisualFullscreen } from "../common/VisualFullscreen.js";

/**
 * Interactive widget block — the "Intelligent UI" surface for Home and
 * Notebook answers: sliders/toggles/segmented controls drive formula-computed
 * stat cards, gauges, tables and multi-series charts, all recalculated
 * in-page as the user interacts. Parsed by the pure widget-blocks module;
 * malformed fences fall back to a code block (handled by the caller).
 */
export function WidgetBlock({ source }: { source: string }) {
  const spec = useMemo(() => parseWidget(source), [source]);
  const defaults = useMemo(
    () => Object.fromEntries((spec?.inputs || []).map((input) => [input.name, input.value])),
    [spec]
  );
  const [values, setValues] = useState<Record<string, number>>(defaults);
  const [copied, setCopied] = useState<string | null>(null);

  if (!spec) {
    return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  }

  const setValue = (name: string, value: number) => {
    setValues((current) => ({ ...current, [name]: value }));
  };
  const resetAll = () => setValues(defaults);
  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1600);
    }).catch(() => {});
  };

  const runAction = (index: number) => {
    const action = spec.actions[index];
    if (!action) return;
    if (action.kind === "copy") {
      const value = evalFormula(action.expr, values);
      if (Number.isFinite(value)) copyText(String(value), action.label);
    } else if (action.kind === "link") {
      // https-only; the app shell blocks non-http(s) window.open targets.
      window.open(action.url, "_blank", "noopener,noreferrer");
    } else if (action.kind === "ask") {
      window.dispatchEvent(new CustomEvent("nexus:widget-ask", { detail: interpolatePrompt(action.prompt, values) }));
    }
  };

  const visibleStats = spec.stats.filter((stat) => conditionHolds(stat.when, values));
  const visibleGauges = spec.gauges.filter((gauge) => conditionHolds(gauge.when, values));

  return (
    <div className="widget-block" role="group" aria-label={spec.title || "Interactive tool"}>
      {spec.title && (
        <div className="widget-head">
          <SlidersHorizontal size={13} />
          <span className="widget-title">{spec.title}</span>
          <button
            type="button"
            className="rich-chart-btn widget-fullscreen-btn"
            title="Open fullscreen with zoom (interactive)"
            onClick={(event) => {
              event.stopPropagation();
              openVisualFullscreen({ kind: "widget", source, title: spec.title || "Interactive tool" });
            }}
          >
            <Maximize2 size={11} />
          </button>
          <span className="widget-badge">INTERACTIVE</span>
        </div>
      )}

      {spec.inputs.length > 0 && (
        <div className="widget-inputs">
          {spec.inputs.map((input) => (
            <div key={input.name} className="widget-input-row">
              <label className="widget-input-label" htmlFor={`widget-${input.name}`}>
                {input.label || input.name}
                {input.kind !== "toggle" && (
                  <span className="widget-input-value">{formatWidgetValue(values[input.name])}</span>
                )}
              </label>
              {input.kind === "slider" && (
                <input
                  id={`widget-${input.name}`}
                  type="range"
                  min={input.min}
                  max={input.max}
                  step={input.step || (input.max! - input.min!) / 100}
                  value={values[input.name]}
                  onChange={(event) => setValue(input.name, Number(event.target.value))}
                />
              )}
              {input.kind === "number" && (
                <input
                  id={`widget-${input.name}`}
                  type="number"
                  value={values[input.name]}
                  min={input.min}
                  max={input.max}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) setValue(input.name, next);
                  }}
                />
              )}
              {input.kind === "select" && (
                <div className="widget-segmented" role="radiogroup" aria-label={input.label || input.name}>
                  {(input.options || []).map((option) => (
                    <button
                      key={String(option)}
                      type="button"
                      className={values[input.name] === option ? "active" : ""}
                      onClick={() => setValue(input.name, option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
              {input.kind === "toggle" && (
                <button
                  id={`widget-${input.name}`}
                  type="button"
                  role="switch"
                  aria-checked={values[input.name] === 1}
                  className={`widget-toggle ${values[input.name] === 1 ? "on" : ""}`}
                  onClick={() => setValue(input.name, values[input.name] === 1 ? 0 : 1)}
                >
                  <span className="widget-toggle-knob" />
                  <span className="widget-toggle-state">{values[input.name] === 1 ? "ON" : "OFF"}</span>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {visibleStats.length > 0 && (
        <div className="widget-stats">
          {visibleStats.map((stat) => {
            const value = evalFormula(stat.expr, values);
            return (
              <div key={stat.label} className={`widget-stat tone-${computeTone(stat.tone, value)}`}>
                <span className="widget-stat-label">{stat.label}</span>
                <span className="widget-stat-value">{formatWidgetValue(value, stat)}</span>
              </div>
            );
          })}
        </div>
      )}

      {visibleGauges.length > 0 && (
        <div className="widget-gauges">
          {visibleGauges.map((gauge) => {
            const value = evalFormula(gauge.expr, values);
            const max = evalFormula(gauge.max, values);
            const fraction = Number.isFinite(value) && Number.isFinite(max) && max > 0
              ? Math.min(1, Math.max(0, value / max))
              : Number.isFinite(value) && value < 0 ? 0 : 1;
            const tone = computeTone(gauge.tone, value);
            return (
              <div key={gauge.label} className={`widget-gauge tone-${tone}`}>
                <div className="widget-gauge-top">
                  <span className="widget-stat-label">{gauge.label}</span>
                  <span className="widget-stat-value">{formatWidgetValue(value, gauge)}</span>
                </div>
                <div className="widget-gauge-track">
                  <div className={`widget-gauge-fill tone-${tone}`} style={{ width: `${fraction * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {spec.charts.map((chart, index) => (
        <WidgetChartView key={`${chart.title}-${index}`} chart={chart} values={values} onCopyCsv={(csv) => copyText(csv, `chart-${index}`)} />
      ))}

      {spec.tables.map((table, tableIndex) => {
        const rows = computeTableRows(table, values);
        const columns = table.columns.length
          ? table.columns
          : ["", ...Array.from({ length: (table.rows[0]?.cells.length || 1) }, (_, i) => `col ${i + 1}`)];
        const csv = ["label," + columns.slice(1).map((c) => JSON.stringify(c)).join(","), ...rows.map((row) => [JSON.stringify(row.label), ...row.cells.map(String)].join(","))].join("\n");
        return (
          <div key={`${table.title}-${tableIndex}`} className="widget-table" role="group" aria-label={table.title || "table"}>
            <div className="widget-chart-head">
              <span className="widget-chart-title">{table.title}</span>
              <button type="button" className="rich-chart-btn" title="Copy table as CSV" onClick={() => copyText(csv, `table-${tableIndex}`)}>
                <Copy size={11} />
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th key={index}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td className="widget-table-row-label">{row.label}</td>
                    {row.cells.map((cell, index) => (
                      <td key={index}>{formatWidgetValue(cell, { decimals: 2 })}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {(spec.actions.length > 0 || spec.note || spec.inputs.length > 0) && (
        <div className="widget-footer">
          {spec.inputs.length > 0 && (
            <button type="button" className="widget-action" title="Reset every input to its default value" onClick={resetAll}>
              <RotateCcw size={12} />
              Reset
            </button>
          )}
          {spec.actions.map((action, index) => (
            <button
              key={`${action.kind}-${action.label}`}
              type="button"
              className="widget-action"
              onClick={() => runAction(index)}
              title={
                action.kind === "copy" ? "Copy the computed value to the clipboard"
                : action.kind === "link" ? action.url
                : "Send this follow-up to the assistant"
              }
            >
              {action.kind === "copy" ? <Copy size={12} /> : action.kind === "link" ? <ExternalLink size={12} /> : <MessageCirclePlus size={12} />}
              {action.kind === "copy" && copied === action.label ? "Copied!" : action.label}
            </button>
          ))}
          {spec.note && <span className="widget-note">{spec.note}</span>}
        </div>
      )}
    </div>
  );
}
