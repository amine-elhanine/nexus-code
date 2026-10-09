/**
 * Parsers for the chart fence blocks the Home agent can emit in chat answers
 * (```bar / ```line / ```scatter). RichMarkdown renders the specs as SVG;
 * these functions are pure so node tests can cover the format contract the
 * system prompt teaches the model.
 *
 * Shared line grammar (order-insensitive, unknown lines ignored):
 *   title "…"                       — optional chart title
 *   x-axis "…" [min max]            — label; min/max only for scatter
 *   y-axis "…" [min max]            — label; min/max optional for bar/line
 * Data lines per block type:
 *   bar:    bar "Label" value
 *   line:   point "Label" value     — ordered series
 *   scatter: point "Name" x y
 */

export type ScatterSpec = {
  title: string;
  xLabel: string;
  yLabel: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  points: Array<{ name: string; x: number; y: number }>;
};

export type CategoryChartSpec = {
  title: string;
  xLabel: string;
  yLabel: string;
  yMin: number;
  yMax: number;
  entries: Array<{ label: string; value: number }>;
};

const TITLE = /^title\s+"([\s\S]*)"$/i;
const X_AXIS = /^x-axis\s+"([\s\S]*)"(?:\s+([-+\d.]+)\s+([-+\d.]+))?$/i;
const Y_AXIS = /^y-axis\s+"([\s\S]*)"(?:\s+([-+\d.]+)\s+([-+\d.]+))?$/i;

/** Rounds an axis maximum up to a readable 1/2/5×10^k value. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(value)));
  const scaled = value / base;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * base;
}

function lines(source: string): string[] {
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseScatterChart(source: string): ScatterSpec | null {
  const spec: ScatterSpec = { title: "", xLabel: "", yLabel: "", xMin: 0, xMax: 1, yMin: 0, yMax: 1, points: [] };
  for (const line of lines(source)) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(TITLE))) spec.title = match[1];
    else if ((match = line.match(X_AXIS)) && match[2] !== undefined) {
      spec.xLabel = match[1];
      spec.xMin = Number(match[2]);
      spec.xMax = Number(match[3]);
    } else if ((match = line.match(Y_AXIS)) && match[2] !== undefined) {
      spec.yLabel = match[1];
      spec.yMin = Number(match[2]);
      spec.yMax = Number(match[3]);
    } else if ((match = line.match(/^point\s+"([\s\S]*)"\s+([-+\d.]+)\s+([-+\d.]+)$/i))) {
      spec.points.push({ name: match[1], x: Number(match[2]), y: Number(match[3]) });
    }
  }
  const axesFinite = [spec.xMin, spec.xMax, spec.yMin, spec.yMax].every(Number.isFinite);
  if (!spec.points.length || !axesFinite || !spec.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
    return null;
  }
  return spec;
}

function parseCategoryChart(source: string, dataPattern: RegExp): CategoryChartSpec | null {
  const spec: CategoryChartSpec = { title: "", xLabel: "", yLabel: "", yMin: 0, yMax: 0, entries: [] };
  let explicitMax: number | null = null;
  for (const line of lines(source)) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(TITLE))) spec.title = match[1];
    else if ((match = line.match(X_AXIS))) spec.xLabel = match[1];
    else if ((match = line.match(Y_AXIS))) {
      spec.yLabel = match[1];
      if (match[2] !== undefined && match[3] !== undefined) {
        const min = Number(match[2]);
        const max = Number(match[3]);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
        spec.yMin = min;
        explicitMax = max;
      }
    } else if ((match = line.match(dataPattern))) {
      const value = Number(match[2]);
      if (!Number.isFinite(value)) continue;
      spec.entries.push({ label: match[1], value });
    }
  }
  if (!spec.entries.length) return null;
  spec.yMax = explicitMax ?? niceMax(Math.max(...spec.entries.map((e) => e.value), spec.yMin, 0));
  if (spec.yMax <= spec.yMin) return null;
  return spec;
}

/** ```bar fence: one `bar "Label" value` line per category. */
export function parseBarChart(source: string): CategoryChartSpec | null {
  return parseCategoryChart(source, /^(?:bar)\s+"([\s\S]*)"\s+([-+\d.]+)$/i);
}

/** ```hbar fence: horizontal bars for categories with long labels. */
export function parseHBarChart(source: string): CategoryChartSpec | null {
  return parseCategoryChart(source, /^(?:bar|hbar)\s+"([\s\S]*)"\s+([-+\d.]+)$/i);
}

/** ```line fence: ordered `point "Label" value` lines. */
export function parseLineChart(source: string): CategoryChartSpec | null {
  return parseCategoryChart(source, /^(?:point)\s+"([\s\S]*)"\s+([-+\d.]+)$/i);
}

/** ```area fence: ordered `point "Label" value` lines with filled area. */
export function parseAreaChart(source: string): CategoryChartSpec | null {
  return parseCategoryChart(source, /^(?:point|area)\s+"([\s\S]*)"\s+([-+\d.]+)$/i);
}

export type PieSlice = { label: string; value: number; percent: number };
export type PieSpec = {
  title: string;
  donut: boolean;
  total: number;
  slices: PieSlice[];
};

/** ```pie and ```donut fences: `slice "Label" value` lines. */
export function parsePieChart(source: string, forceDonut = false): PieSpec | null {
  const spec: PieSpec = { title: "", donut: forceDonut, total: 0, slices: [] };
  for (const line of lines(source)) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(TITLE))) {
      spec.title = match[1];
    } else if (/^type\s+"?donut"?/i.test(line) || /^donut\b/i.test(line)) {
      spec.donut = true;
    } else if ((match = line.match(/^(?:slice|entry|point|bar|part)\s+"([\s\S]*)"\s+([-+\d.]+)$/i))) {
      const val = Number(match[2]);
      if (Number.isFinite(val) && val > 0) {
        spec.slices.push({ label: match[1], value: val, percent: 0 });
      }
    }
  }
  if (!spec.slices.length) return null;
  spec.total = spec.slices.reduce((sum, s) => sum + s.value, 0);
  if (spec.total <= 0) return null;
  for (const s of spec.slices) {
    s.percent = Math.round((s.value / spec.total) * 1000) / 10;
  }
  return spec;
}

export type RadarAxis = { label: string; value: number };
export type RadarSpec = {
  title: string;
  max: number;
  axes: RadarAxis[];
};

/** ```radar fence: multivariate spider web with `axis "Dimension" value`. */
export function parseRadarChart(source: string): RadarSpec | null {
  const spec: RadarSpec = { title: "", max: 0, axes: [] };
  let explicitMax: number | null = null;
  for (const line of lines(source)) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(TITLE))) {
      spec.title = match[1];
    } else if ((match = line.match(/^max\s+([-+\d.]+)$/i))) {
      const m = Number(match[1]);
      if (Number.isFinite(m) && m > 0) explicitMax = m;
    } else if ((match = line.match(/^(?:axis|point|metric|item)\s+"([\s\S]*)"\s+([-+\d.]+)$/i))) {
      const val = Number(match[2]);
      if (Number.isFinite(val) && val >= 0) {
        spec.axes.push({ label: match[1], value: val });
      }
    }
  }
  if (spec.axes.length < 3) return null;
  spec.max = explicitMax ?? niceMax(Math.max(...spec.axes.map((a) => a.value), 0));
  if (spec.max <= 0) return null;
  return spec;
}
