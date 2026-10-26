/**
 * Interactive widget blocks — Nexus' take on OpenAI's "Intelligent UI"
 * (answers that stream as working tools: inputs, computed outputs, gauges,
 * tables, multi-series charts driven by formulas, and action buttons). The
 * model emits a ```widget fence in its chat answer; RichMarkdown renders it
 * as a live mini-tool that recomputes in-page as the user interacts — no
 * assistant round-trip.
 *
 * Pure module (no React, no DOM) so node tests cover the full format
 * contract the system prompt teaches, exactly like chart-blocks.
 *
 * Line grammar (order-insensitive, unknown lines ignored):
 *   title "Loan options"
 *   section-free; inputs first is conventional but not required
 *   input principal "Principal ($)" slider 0 100000 45000 step 1000
 *   input rate      "Annual rate (%)" slider 0 10 4.5 step 0.1
 *   input years     "Term" select 15 15 20 30
 *   input extra     "Include insurance" toggle on
 *   input bump      "Extra payment" number 0 min 0 max 2000
 *   stat "Monthly payment" formula "pmt(rate/100/12, years*12, principal)" prefix "$" decimals 2
 *         [when "<expr>"] [warn-above 30] [bad-above 40] [warn-below x] [bad-below x]
 *   gauge "Debt-to-income" formula "payment/gross*100" max "43" suffix "%" decimals 1
 *         (same decorations as stat; fill = value/max clamped 0..1, tone-colored)
 *   chart bar "Balance by year" x-axis "Year" y-axis "USD"
 *   series "Standard"          <- switches the point series (max 3, in order)
 *   point "Y1" formula "principal*0.95"
 *   chart line "Balance vs extra" ...   <- later chart lines start a new chart
 *   chart area|pie|donut ...            <- pie/donut use the FIRST series only
 *   table "Amortization schedule"
 *   columns "Year" "Interest" "Balance"
 *   row "1" "year*1" "pmt(rate/100/12,12*year,principal)*12" "principal*0.9"
 *   action copy "Copy monthly" formula "principal*2"
 *   action link "Docs" https://example.com/docs
 *   action ask "Recalculate at 20 years" text "What if years = 20 and principal = {principal}?"
 *   note "Assumes fixed rate, monthly compounding."
 *
 * Formulas reference input names as variables and support + - * / % ^,
 * parentheses, comparisons, and/or/not, plus functions: min max abs round
 * floor ceil sqrt pow ln log log2 exp clamp sign between sum avg hypot cbrt
 * sin cos tan asin acos atan atan2 radians degrees if(cond,a,b) — and
 * financial: pmt(r, n, pv) (level payment amortizing pv over n periods at
 * periodic rate r, positive) and fv(r, n, pmt, pv?) (future value; sign
 * follows cash flow — fv(r, n, -payment, principal) = remaining balance).
 * Constants: pi e. Evaluation is a hand-rolled parser — NEVER eval() — with
 * hard size caps so model output cannot DoS the page.
 */

export type WidgetInput = {
  name: string;
  label: string;
  kind: "slider" | "number" | "select" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  value: number;
  options?: number[];
};

/** KPI thresholds: bad wins over warn; `above`/`below` compare the raw value. */
export type WidgetTone = {
  warnAbove?: number;
  badAbove?: number;
  warnBelow?: number;
  badBelow?: number;
};

export type WidgetStat = {
  label: string;
  expr: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  when?: string;
  tone?: WidgetTone;
};

export type WidgetGauge = {
  label: string;
  expr: string;
  max: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  when?: string;
  tone?: WidgetTone;
};

export type WidgetChartSeries = {
  name: string;
  points: Array<{ label: string; expr: string }>;
};

export type WidgetChart = {
  variant: "bar" | "line" | "area" | "pie" | "donut";
  title: string;
  xLabel: string;
  yLabel: string;
  series: WidgetChartSeries[];
};

export type WidgetTable = {
  title: string;
  columns: string[];
  rows: Array<{ label: string; cells: string[] }>;
};

export type WidgetAction =
  | { kind: "copy"; label: string; expr: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "ask"; label: string; prompt: string };

export type WidgetSpec = {
  title: string;
  inputs: WidgetInput[];
  stats: WidgetStat[];
  gauges: WidgetGauge[];
  charts: WidgetChart[];
  tables: WidgetTable[];
  actions: WidgetAction[];
  note: string;
};

const MAX_INPUTS = 8;
const MAX_STATS = 8;
const MAX_GAUGES = 4;
const MAX_CHARTS = 3;
const MAX_TABLES = 2;
const MAX_ACTIONS = 4;
const MAX_POINTS = 24;
const MAX_SERIES = 3;
const MAX_TABLE_ROWS = 12;
const MAX_TABLE_COLS = 6;
const MAX_FORMULA_CHARS = 300;
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const TITLE_RE = /^title\s+"([\s\S]*)"$/i;
const INPUT_RE = /^input\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+"([\s\S]*)"\s+(slider|number|select|toggle)\s+(.+)$/i;
const STAT_RE = /^stat\s+"([\s\S]*?)"\s+formula\s+"([\s\S]*?)"(.*)$/i;
const GAUGE_RE = /^gauge\s+"([\s\S]*?)"\s+formula\s+"([\s\S]*?)"\s+max\s+"?([^"\s]+)"?(.*)$/i;
const CHART_RE = /^chart\s+(bar|line|area|pie|donut)\s+"([^"]*)"\s*(.*)$/i;
const SERIES_RE = /^series\s+"([^"]*)"$/i;
const X_AXIS_INLINE_RE = /^x-axis\s+"([^"]*)"/i;
const Y_AXIS_INLINE_RE = /y-axis\s+"([^"]*)"/i;
const POINT_RE = /^point\s+"([\s\S]*)"\s+formula\s+"([\s\S]*)"$/i;
const TABLE_RE = /^table\s+"([^"]*)"$/i;
const COLUMNS_RE = /^columns\s+(.+)$/i;
const ROW_RE = /^row\s+"([^"]*)"(\s+"[^"]*"\s*)+$/;
const ACTION_COPY_RE = /^action\s+copy\s+"([\s\S]*)"\s+formula\s+"([\s\S]*)"$/i;
const ACTION_LINK_RE = /^action\s+link\s+"([\s\S]*)"\s+(https:\/\/[^\s]+)$/i;
const ACTION_ASK_RE = /^action\s+ask\s+"([\s\S]*)"\s+text\s+"([\s\S]*)"$/i;
const NOTE_RE = /^note\s+"([\s\S]*)"$/i;
const STEP_RE = /\bstep\s+([+-]?[\d.]+)/i;
const AXIS_RE = /^x-axis\s+"([\s\S]*)"$|^y-axis\s+"([\s\S]*)"$/i;
const PREFIX_SUFFIX_RE = /\b(prefix|suffix)\s+"([^"]*)"/g;
const DECIMALS_RE = /\bdecimals\s+(\d)/;
const WHEN_RE = /\bwhen\s+"([^"]*)"/i;
const TONE_RE = /\b(warn|bad)-(above|below)\s+([+-]?[\d.]+)/gi;

function num(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
}

function parseDecorations(rest: string): Pick<WidgetStat, "prefix" | "suffix" | "decimals" | "when" | "tone"> {
  const out: Pick<WidgetStat, "prefix" | "suffix" | "decimals" | "when" | "tone"> = {};
  for (const match of rest.matchAll(PREFIX_SUFFIX_RE)) {
    if (match[1].toLowerCase() === "prefix") out.prefix = match[2];
    else out.suffix = match[2];
  }
  const decimals = rest.match(DECIMALS_RE);
  if (decimals) out.decimals = Math.min(6, Number(decimals[1]));
  const when = rest.match(WHEN_RE);
  if (when && when[1].length <= MAX_FORMULA_CHARS) out.when = when[1];
  const tone: WidgetTone = {};
  for (const match of rest.matchAll(TONE_RE)) {
    const key = (match[1].toLowerCase() === "warn" ? "warn" : "bad") + (match[2].toLowerCase() === "above" ? "Above" : "Below");
    (tone as Record<string, number>)[key] = num(match[3]);
  }
  if (Object.keys(tone).length) out.tone = tone;
  return out;
}

/** All quoted strings after a keyword: `row "a" "b" "c"` -> ["a","b","c"]. */
function quotedAll(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"/g)) out.push(match[1]);
  return out;
}

/**
 * Parses a ```widget fence body into a spec. Returns null when the body has
 * no usable content (RichMarkdown then falls back to a plain code block).
 */
export function parseWidget(source: string): WidgetSpec | null {
  const spec: WidgetSpec = { title: "", inputs: [], stats: [], gauges: [], charts: [], tables: [], actions: [], note: "" };
  const seen = new Set<string>();
  let chartPending: WidgetChart | null = null;
  let seriesPending: WidgetChartSeries | null = null;
  let tablePending: WidgetTable | null = null;

  for (const rawLine of (source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let match: RegExpMatchArray | null;

    if ((match = line.match(TITLE_RE))) {
      spec.title = match[1];
      continue;
    }
    if ((match = line.match(NOTE_RE))) {
      spec.note = match[1];
      continue;
    }
    if ((match = line.match(INPUT_RE))) {
      if (spec.inputs.length >= MAX_INPUTS) continue;
      const name = match[1];
      if (!NAME_RE.test(name) || seen.has(name)) continue;
      const kind = match[3].toLowerCase() as WidgetInput["kind"];
      const rest = match[4].trim();
      if (kind === "toggle") {
        const on = /^on\b/i.test(rest);
        seen.add(name);
        spec.inputs.push({ name, label: match[2], kind, value: on ? 1 : 0 });
        continue;
      }
      if (kind === "select") {
        const options = rest.split(/\s+/).map(num).filter((v) => Number.isFinite(v));
        // `select <default> <option…>` — the default leads the deduped option
        // list so it is always selectable back.
        const unique = options.filter((value, index, all) => all.indexOf(value) === index);
        if (unique.length < 2) continue;
        seen.add(name);
        spec.inputs.push({ name, label: match[2], kind, value: unique[0], options: unique.slice(0, 8) });
        continue;
      }
      if (kind === "slider") {
        const parts = rest.split(/\s+/);
        if (parts.length < 3) continue;
        const min = num(parts[0]);
        const max = num(parts[1]);
        const value = num(parts[2]);
        if (![min, max, value].every((v) => Number.isFinite(v)) || max <= min) continue;
        const stepMatch = rest.match(STEP_RE);
        const step = stepMatch ? num(stepMatch[1]) : undefined;
        seen.add(name);
        spec.inputs.push({
          name,
          label: match[2],
          kind,
          min,
          max,
          step: step && step > 0 ? step : undefined,
          value: Math.min(max, Math.max(min, value)),
        });
        continue;
      }
      // number: default [min a] [max b]
      const value = num(rest.split(/\s+/)[0]);
      if (!Number.isFinite(value)) continue;
      const minMatch = rest.match(/\bmin\s+([+-]?[\d.]+)/i);
      const maxMatch = rest.match(/\bmax\s+([+-]?[\d.]+)/i);
      seen.add(name);
      spec.inputs.push({
        name,
        label: match[2],
        kind,
        min: minMatch ? num(minMatch[1]) : undefined,
        max: maxMatch ? num(maxMatch[1]) : undefined,
        value,
      });
      continue;
    }
    if ((match = line.match(STAT_RE))) {
      if (spec.stats.length >= MAX_STATS || match[2].length > MAX_FORMULA_CHARS) continue;
      spec.stats.push({ label: match[1], expr: match[2], ...parseDecorations(match[3]) });
      continue;
    }
    if ((match = line.match(GAUGE_RE))) {
      if (spec.gauges.length >= MAX_GAUGES || match[2].length > MAX_FORMULA_CHARS || match[3].length > MAX_FORMULA_CHARS) continue;
      spec.gauges.push({ label: match[1], expr: match[2], max: match[3], ...parseDecorations(match[4]) });
      continue;
    }
    if ((match = line.match(CHART_RE))) {
      if (spec.charts.length >= MAX_CHARTS) continue;
      const chart: WidgetChart = {
        variant: match[1].toLowerCase() as WidgetChart["variant"],
        title: match[2],
        xLabel: "",
        yLabel: "",
        series: [{ name: "", points: [] }],
      };
      const rest = match[3] || "";
      const xAxis = rest.match(X_AXIS_INLINE_RE);
      const yAxis = rest.match(Y_AXIS_INLINE_RE);
      if (xAxis) chart.xLabel = xAxis[1];
      if (yAxis) chart.yLabel = yAxis[1];
      spec.charts.push(chartPending = chart);
      seriesPending = chart.series[0];
      tablePending = null;
      continue;
    }
    if ((match = line.match(SERIES_RE)) && chartPending && chartPending.series.length < MAX_SERIES) {
      seriesPending = { name: match[1], points: [] };
      chartPending.series.push(seriesPending);
      continue;
    }
    if ((match = line.match(POINT_RE))) {
      const series = seriesPending || chartPending?.series[0] || null;
      if (series && series.points.length < MAX_POINTS && match[2].length <= MAX_FORMULA_CHARS) {
        series.points.push({ label: match[1], expr: match[2] });
      }
      continue;
    }
    if ((match = line.match(TABLE_RE))) {
      if (spec.tables.length >= MAX_TABLES) continue;
      spec.tables.push(tablePending = { title: match[1], columns: [], rows: [] });
      chartPending = null;
      seriesPending = null;
      continue;
    }
    if ((match = line.match(COLUMNS_RE)) && tablePending) {
      tablePending.columns = quotedAll(match[1]).slice(0, MAX_TABLE_COLS);
      continue;
    }
    if (line.match(ROW_RE) && tablePending) {
      if (tablePending.rows.length >= MAX_TABLE_ROWS) continue;
      const cells = quotedAll(line);
      const label = cells.shift() || "";
      const formulas = cells.filter((expr) => expr.length <= MAX_FORMULA_CHARS).slice(0, MAX_TABLE_COLS - 1);
      if (formulas.length) tablePending.rows.push({ label, cells: formulas });
      continue;
    }
    if ((match = line.match(ACTION_COPY_RE))) {
      if (spec.actions.length < MAX_ACTIONS && match[2].length <= MAX_FORMULA_CHARS) {
        spec.actions.push({ kind: "copy", label: match[1], expr: match[2] });
      }
      continue;
    }
    if ((match = line.match(ACTION_LINK_RE))) {
      if (spec.actions.length < MAX_ACTIONS) spec.actions.push({ kind: "link", label: match[1], url: match[2] });
      continue;
    }
    if ((match = line.match(ACTION_ASK_RE))) {
      if (spec.actions.length < MAX_ACTIONS && match[2].length <= 400) {
        spec.actions.push({ kind: "ask", label: match[1], prompt: match[2] });
      }
      continue;
    }
    // Standalone axis lines after a chart header
    if (chartPending && (match = line.match(AXIS_RE))) {
      if (match[1] !== undefined) chartPending.xLabel = match[1];
      else chartPending.yLabel = match[2];
      continue;
    }
  }

  spec.charts = spec.charts.filter((chart) => chart.series.some((series) => series.points.length > 0));
  spec.tables = spec.tables.filter((table) => table.rows.length > 0);
  if (
    !spec.inputs.length && !spec.stats.length && !spec.gauges.length &&
    !spec.charts.length && !spec.tables.length && !spec.actions.length
  ) {
    return null;
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Safe expression evaluator: tokenizer + recursive-descent parser + AST eval.
// No eval/new Function anywhere; formula size is capped by the parser above.

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

/** Level-payment amortization: payment (positive) that clears pv over n periods at periodic rate r. */
function financialPmt(args: number[]): number {
  const [r, n, pv] = args;
  if (![r, n, pv].every((v) => Number.isFinite(v)) || n <= 0) return NaN;
  if (r === 0) return pv / n;
  const growth = Math.pow(1 + r, n);
  return (pv * growth * r) / (growth - 1);
}

/** Future value (positive) of pmt per period plus pv, at periodic rate r over n periods. */
function financialFv(args: number[]): number {
  const [r, n, pmt, pv = 0] = args;
  if (![r, n, pmt, pv].every((v) => Number.isFinite(v)) || n < 0) return NaN;
  if (r === 0) return pv + pmt * n;
  const growth = Math.pow(1 + r, n);
  return pv * growth + pmt * ((growth - 1) / r);
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: (a) => Math.abs(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  sqrt: (a) => Math.sqrt(a[0]),
  cbrt: (a) => Math.cbrt(a[0]),
  pow: (a) => Math.pow(a[0], a[1]),
  ln: (a) => Math.log(a[0]),
  log: (a) => Math.log10(a[0]),
  log2: (a) => Math.log2(a[0]),
  exp: (a) => Math.exp(a[0]),
  hypot: (a) => Math.hypot(a[0], a[1]),
  clamp: (a) => Math.min(a[2], Math.max(a[1], a[0])),
  sign: (a) => Math.sign(a[0]),
  between: (a) => (a[0] >= a[1] && a[0] <= a[2] ? 1 : 0),
  sum: (a) => a.reduce((acc, v) => acc + v, 0),
  avg: (a) => (a.length ? a.reduce((acc, v) => acc + v, 0) / a.length : NaN),
  sin: (a) => Math.sin(a[0]),
  cos: (a) => Math.cos(a[0]),
  tan: (a) => Math.tan(a[0]),
  asin: (a) => Math.asin(a[0]),
  acos: (a) => Math.acos(a[0]),
  atan: (a) => Math.atan(a[0]),
  atan2: (a) => Math.atan2(a[0], a[1]),
  radians: (a) => (a[0] * Math.PI) / 180,
  degrees: (a) => (a[0] * 180) / Math.PI,
  pmt: financialPmt,
  fv: financialFv,
  round: (a) => {
    const factor = Math.pow(10, a[1] ?? 0);
    return Math.round(a[0] * factor) / factor;
  },
  if: (a) => (a[0] ? a[1] : a[2]),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type ExprNode =
  | { type: "num"; value: number }
  | { type: "var"; name: string }
  | { type: "call"; name: string; args: ExprNode[] }
  | { type: "unary"; op: string; operand: ExprNode }
  | { type: "bin"; op: string; left: ExprNode; right: ExprNode };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j])) j++;
      const value = Number(input.slice(i, j).replace(/_/g, ""));
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      const word = input.slice(i, j).toLowerCase();
      // Logical keywords behave as operators in the precedence chain.
      if (word === "and" || word === "or" || word === "not") {
        tokens.push({ kind: "op", value: word });
      } else {
        tokens.push({ kind: "name", value: word });
      }
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (["<=", ">=", "==", "!="].includes(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%^()<>,!".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    return null; // any other character — refuse the formula
  }
  return tokens;
}

type Parser = { tokens: Token[]; pos: number };

function peek(parser: Parser): Token | undefined {
  return parser.tokens[parser.pos];
}
function eat(parser: Parser): Token | undefined {
  return parser.tokens[parser.pos++];
}
function expectOp(parser: Parser, op: string): boolean {
  const token = peek(parser);
  if (token && token.kind === "op" && token.value === op) {
    parser.pos++;
    return true;
  }
  return false;
}

// precedence chain: or -> and -> comparison -> additive -> multiplicative -> power -> unary -> primary
function parsePrimary(parser: Parser): ExprNode | null {
  const token = eat(parser);
  if (!token) return null;
  if (token.kind === "num") return { type: "num", value: token.value };
  if (token.kind === "name") {
    if (expectOp(parser, "(")) {
      const args: ExprNode[] = [];
      if (!expectOp(parser, ")")) {
        for (;;) {
          const arg = parseExpr(parser);
          if (!arg) return null;
          args.push(arg);
          if (expectOp(parser, ",")) continue;
          if (expectOp(parser, ")")) break;
          return null;
        }
      }
      return { type: "call", name: token.value, args };
    }
    return { type: "var", name: token.value };
  }
  if (token.kind === "op" && token.value === "(") {
    const inner = parseExpr(parser);
    if (!inner || !expectOp(parser, ")")) return null;
    return inner;
  }
  return null;
}

function parseUnary(parser: Parser): ExprNode | null {
  const token = peek(parser);
  if (token && token.kind === "op" && (token.value === "-" || token.value === "+" || token.value === "!" || token.value === "not")) {
    eat(parser);
    const operand = parseUnary(parser);
    if (!operand) return null;
    return { type: "unary", op: token.value === "not" ? "!" : token.value, operand };
  }
  return parsePrimary(parser);
}

function parsePower(parser: Parser): ExprNode | null {
  const base = parseUnary(parser);
  if (!base) return null;
  if (expectOp(parser, "^")) {
    // Right-associative chain: 2^3^2 = 2^(3^2) = 512.
    const exponent = parsePower(parser);
    if (!exponent) return null;
    return { type: "bin", op: "^", left: base, right: exponent };
  }
  return base;
}

function binaryLevel(parser: Parser, ops: string[], next: (p: Parser) => ExprNode | null): ExprNode | null {
  let left = next(parser);
  if (!left) return null;
  for (;;) {
    const token = peek(parser);
    if (!token || token.kind !== "op" || !ops.includes(token.value)) break;
    eat(parser);
    const right = next(parser);
    if (!right) return null;
    left = { type: "bin", op: token.value, left, right };
  }
  return left;
}

const parseMultiplicative = (p: Parser) => binaryLevel(p, ["*", "/", "%"], parsePower);
const parseAdditive = (p: Parser) => binaryLevel(p, ["+", "-"], parseMultiplicative);
const parseComparison = (p: Parser) => binaryLevel(p, ["<", "<=", ">", ">=", "==", "!="], parseAdditive);
const parseAnd = (p: Parser) => binaryLevel(p, ["and"], parseComparison);
const parseOr = (p: Parser) => binaryLevel(p, ["or"], parseAnd);
const parseExpr = parseOr;

function parseFormula(input: string): ExprNode | null {
  const trimmed = (input || "").trim();
  if (!trimmed || trimmed.length > MAX_FORMULA_CHARS) return null;
  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length > 120) return null;
  const parser: Parser = { tokens, pos: 0 };
  const node = parseExpr(parser);
  if (!node || parser.pos !== tokens.length) return null; // trailing garbage
  return node;
}

function evalNode(node: ExprNode, values: Record<string, number>): number {
  switch (node.type) {
    case "num":
      return node.value;
    case "var":
      if (node.name in values) return values[node.name];
      if (node.name in CONSTANTS) return CONSTANTS[node.name];
      return NaN;
    case "unary": {
      const operand = evalNode(node.operand, values);
      return node.op === "-" ? -operand : node.op === "!" ? (operand ? 0 : 1) : operand;
    }
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) return NaN;
      return fn(node.args.map((arg) => evalNode(arg, values)));
    }
    case "bin": {
      const left = evalNode(node.left, values);
      const right = evalNode(node.right, values);
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right === 0 ? NaN : left / right;
        case "%": return right === 0 ? NaN : left % right;
        case "^": return Math.pow(left, right);
        case "<": return left < right ? 1 : 0;
        case "<=": return left <= right ? 1 : 0;
        case ">": return left > right ? 1 : 0;
        case ">=": return left >= right ? 1 : 0;
        case "==": return left === right ? 1 : 0;
        case "!=": return left !== right ? 1 : 0;
        case "and": return left && right ? 1 : 0;
        case "or": return left || right ? 1 : 0;
        default: return NaN;
      }
    }
  }
}

/**
 * Evaluates a widget formula against input values. Returns NaN for anything
 * malformed, unknown names, or non-finite results — the UI shows "—" then.
 */
export function evalFormula(expr: string, values: Record<string, number>): number {
  const node = parseFormula(expr);
  if (!node) return NaN;
  const result = evalNode(node, values);
  return Number.isFinite(result) ? result : NaN;
}

/** KPI tone for a computed value: bad beats warn beats neutral. */
export function computeTone(tone: WidgetTone | undefined, value: number): "neutral" | "warn" | "bad" {
  if (!tone || !Number.isFinite(value)) return "neutral";
  if (
    (tone.badAbove !== undefined && value > tone.badAbove) ||
    (tone.badBelow !== undefined && value < tone.badBelow)
  ) {
    return "bad";
  }
  if (
    (tone.warnAbove !== undefined && value > tone.warnAbove) ||
    (tone.warnBelow !== undefined && value < tone.warnBelow)
  ) {
    return "warn";
  }
  return "neutral";
}

/** True when an element's `when` condition holds (missing condition = always). */
export function conditionHolds(when: string | undefined, values: Record<string, number>): boolean {
  if (!when) return true;
  const result = evalFormula(when, values);
  return Number.isFinite(result) && result !== 0;
}

/** Evaluates a chart's series (pie/donut use the first series only). */
export function computeChartSeries(
  chart: WidgetChart,
  values: Record<string, number>
): Array<{ name: string; points: Array<{ label: string; value: number }> }> {
  const source = chart.variant === "pie" || chart.variant === "donut" ? chart.series.slice(0, 1) : chart.series;
  return source
    .map((series) => ({
      name: series.name,
      points: series.points
        .map((point) => ({ label: point.label, value: evalFormula(point.expr, values) }))
        .filter((point) => Number.isFinite(point.value)),
    }))
    .filter((series) => series.points.length > 0);
}

/** Evaluates a table's cell formulas against current values. */
export function computeTableRows(
  table: WidgetTable,
  values: Record<string, number>
): Array<{ label: string; cells: number[] }> {
  return table.rows.map((row) => ({
    label: row.label,
    cells: row.cells.map((expr) => evalFormula(expr, values)),
  }));
}

/** CSV export of a computed chart (one row per label, one column per series). */
export function chartToCsv(chart: WidgetChart, values: Record<string, number>): string {
  const series = computeChartSeries(chart, values);
  if (!series.length) return "";
  const labels: string[] = [];
  for (const s of series) for (const point of s.points) if (!labels.includes(point.label)) labels.push(point.label);
  const header = ["label", ...series.map((s, i) => s.name || `series${i + 1}`)];
  const lines = [header.join(",")];
  for (const label of labels) {
    const cells = series.map((s) => {
      const point = s.points.find((p) => p.label === label);
      return point ? String(point.value) : "";
    });
    lines.push([JSON.stringify(label), ...cells].join(","));
  }
  return lines.join("\n");
}

/** Formats a computed value for stat/gauge cards (decimals + prefix/suffix). */
export function formatWidgetValue(value: number, stat?: { prefix?: string; suffix?: string; decimals?: number }): string {
  if (!Number.isFinite(value)) return "—";
  const decimals = stat?.decimals ?? (Math.abs(value) >= 100 ? 0 : 2);
  // Fixed en-US grouping keeps the DM Mono look stable across host locales.
  const fixed = value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${stat?.prefix || ""}${fixed}${stat?.suffix || ""}`;
}

/** Interpolates {name} placeholders in an ask-action prompt with current values. */
export function interpolatePrompt(prompt: string, values: Record<string, number>): string {
  return (prompt || "").replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, name: string) => {
    const value = values[name];
    return Number.isFinite(value) ? String(value) : whole;
  });
}
