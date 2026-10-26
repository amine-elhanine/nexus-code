// Unit tests for interactive widget blocks (parser + safe expression
// evaluator). Pure module imported directly from src (node strips types).
import assert from "node:assert/strict";
import {
  parseWidget,
  evalFormula,
  formatWidgetValue,
  interpolatePrompt,
  computeTone,
  conditionHolds,
  computeChartSeries,
  computeTableRows,
  chartToCsv,
} from "../src/utils/widget-blocks.ts";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    failed++;
  }
}

console.log("\n=== Widget Block Tests ===");

const LOAN_WIDGET = `
title "Loan calculator"
input principal "Loan amount ($)" slider 5000 100000 35000 step 5000
input rate "Annual rate (%)" slider 0.5 12 3.9 step 0.1
input years "Term" select 30 10 15 30
stat "Monthly payment" formula "principal*(rate/100/12)/(1-(1+rate/100/12)^(-years*12))" prefix "$" decimals 2
chart line "Balance share" x-axis "Year" y-axis "Fraction"
point "Y1" formula "1"
point "Y10" formula "0.7"
action copy "Copy monthly" formula "principal*2"
action link "Docs" https://example.com/docs
action ask "At 15 years?" text "Payment if years = 15 and principal = {principal}?"
note "Fixed rate."
`;

await test("parseWidget reads every section of the grammar", () => {
  const spec = parseWidget(LOAN_WIDGET);
  assert.ok(spec, "parses");
  assert.equal(spec.title, "Loan calculator");
  assert.equal(spec.inputs.length, 3);
  assert.equal(spec.inputs[0].name, "principal");
  assert.equal(spec.inputs[0].kind, "slider");
  assert.equal(spec.inputs[0].min, 5000);
  assert.equal(spec.inputs[0].max, 100000);
  assert.equal(spec.inputs[0].step, 5000);
  assert.equal(spec.inputs[0].value, 35000);
  assert.equal(spec.inputs[2].kind, "select");
  assert.deepEqual(spec.inputs[2].options, [30, 10, 15], "default leads the deduped option list");
  assert.equal(spec.inputs[2].value, 30);
  assert.equal(spec.stats[0].prefix, "$");
  assert.equal(spec.stats[0].decimals, 2);
  assert.equal(spec.charts.length, 1);
  assert.equal(spec.charts[0].variant, "line");
  assert.equal(spec.charts[0].xLabel, "Year");
  assert.equal(spec.charts[0].series[0].points.length, 2);
  assert.equal(spec.actions.length, 3);
  assert.equal(spec.actions[0].kind, "copy");
  assert.equal(spec.actions[1].kind, "link");
  assert.equal((spec.actions[1]).url, "https://example.com/docs");
  assert.equal(spec.actions[2].kind, "ask");
  assert.equal(spec.note, "Fixed rate.");
});

await test("parseWidget clamps slider defaults into range and enforces caps", () => {
  const spec = parseWidget(`
input a "A" slider 0 10 99
input b "B" slider 0 10 5
input c "C" slider 0 10 4
input d "D" slider 0 10 3
input e "E" slider 0 10 2
input f "F" slider 0 10 1
input g "G" slider 0 10 0
input h "H" slider 0 10 9
input i "I" slider 0 10 8
input j "J" slider 0 10 7
`);
  assert.ok(spec);
  assert.equal(spec.inputs.length, 8, "input cap of 8");
  assert.equal(spec.inputs[0].value, 10, "default clamped into [0,10]");
});

await test("parseWidget ignores duplicate names, malformed lines, and rejects empty bodies", () => {
  const spec = parseWidget(`
input a "A" slider 0 10 5
input a "Duplicate" slider 0 10 5
input bad name "space" slider 0 10 5
garbage line
input ok "OK" number 7
`);
  assert.ok(spec);
  assert.equal(spec.inputs.length, 2);
  assert.equal(spec.inputs[1].value, 7);
  assert.equal(parseWidget("nothing here"), null);
  assert.equal(parseWidget(""), null);
});

await test("toggle inputs parse on/off to 1/0", () => {
  const spec = parseWidget(`
input a "Feature" toggle on
input b "Other" toggle off
input c "Broken" toggle maybe
stat "S" formula "a*10 + b"
`);
  assert.ok(spec);
  const toggleA = spec.inputs.find((i) => i.name === "a");
  const toggleB = spec.inputs.find((i) => i.name === "b");
  assert.equal(toggleA.kind, "toggle");
  assert.equal(toggleA.value, 1);
  assert.equal(toggleB.value, 0);
  assert.equal(spec.inputs.length, 3, "unknown toggle value falls back to off");
  assert.equal(evalFormula(spec.stats[0].expr, { a: 1, b: 0 }), 10);
});

await test("stats/gauges pick up when, tone thresholds, and decorations", () => {
  const spec = parseWidget(`
input x "X" slider 0 100 50
stat "Hot" formula "x" suffix "%" when "x > 80" warn-above 90 bad-above 120
gauge "Load" formula "x" max "100" prefix "" warn-below 10
`);
  assert.ok(spec);
  assert.equal(spec.stats[0].when, "x > 80");
  assert.deepEqual(spec.stats[0].tone, { warnAbove: 90, badAbove: 120 });
  assert.equal(spec.gauges.length, 1);
  assert.equal(spec.gauges[0].max, "100");
  assert.deepEqual(spec.gauges[0].tone, { warnBelow: 10 });
});

await test("gauge max can be a formula expression", () => {
  const spec = parseWidget(`
input x "X" slider 0 100 30
input scale "Scale" number 2
gauge "Ratio" formula "x" max "50*scale"
`);
  assert.ok(spec);
  assert.equal(evalFormula(spec.gauges[0].max, { x: 30, scale: 2 }), 100);
});

await test("charts: multiple charts, series switching, and variant coverage", () => {
  const spec = parseWidget(`
input x "X" slider 0 100 50
chart bar "First" x-axis "A"
point "p1" formula "x"
point "p2" formula "x*2"
series "Second series"
point "p1" formula "x/2"
point "p2" formula "x/4"
chart donut "Breakdown"
point "a" formula "x"
point "b" formula "100-x"
chart area "Third"
point "t1" formula "x"
`);
  assert.ok(spec);
  assert.equal(spec.charts.length, 3, "chart cap is 3, all present");
  const first = spec.charts[0];
  assert.equal(first.variant, "bar");
  assert.equal(first.series.length, 2);
  assert.equal(first.series[0].name, "");
  assert.equal(first.series[1].name, "Second series");
  assert.equal(first.series[1].points.length, 2);
  assert.equal(spec.charts[1].variant, "donut");
  assert.equal(spec.charts[1].series.length, 1, "points after a new chart header start a new chart");
  assert.equal(spec.charts[2].series[0].points.length, 1);
});

await test("tables parse columns and quoted formula cells with caps", () => {
  const spec = parseWidget(`
input r "Rate (%)" slider 0 20 5
table "Compounding"
columns "Years" "Growth"
row "1" "1 + r/100"
row "2" "(1 + r/100)^2"
row "3" "(1 + r/100)^3"
`);
  assert.ok(spec);
  assert.equal(spec.tables.length, 1);
  assert.deepEqual(spec.tables[0].columns, ["Years", "Growth"]);
  assert.equal(spec.tables[0].rows.length, 3);
  assert.equal(spec.tables[0].rows[1].cells[0], "(1 + r/100)^2");
  const computed = computeTableRows(spec.tables[0], { r: 10 });
  assert.ok(Math.abs(computed[1].cells[0] - 1.21) < 1e-9);
});

await test("chart without points is dropped; orphan points ignored before a chart", () => {
  assert.equal(parseWidget('chart bar "Empty"\ninput x "X" slider 0 10 5')?.charts.length ?? 0, 0);
  const noChart = parseWidget('input x "X" slider 0 10 5\npoint "orphan" formula "x"');
  assert.equal(noChart?.charts.length ?? 0, 0);
});

await test("computeChartSeries evaluates series and pie uses only the first", () => {
  const spec = parseWidget(`
input x "X" slider 0 100 40
chart pie "Mix"
point "a" formula "x"
point "b" formula "100-x"
series "ignored"
point "c" formula "50"
`);
  assert.ok(spec);
  const pie = spec.charts[0];
  assert.equal(pie.series.length, 2);
  const computed = computeChartSeries(pie, { x: 40 });
  assert.equal(computed.length, 1, "pie takes the first series only");
  assert.deepEqual(computed[0].points.map((p) => p.value), [40, 60]);
});

await test("chartToCsv emits one row per label and one column per series", () => {
  const spec = parseWidget(`
input x "X" slider 0 100 10
chart line "Two series"
point "a" formula "x"
point "b" formula "x*2"
series "Half"
point "a" formula "x/2"
`);
  const chart = spec.charts[0];
  const csv = chartToCsv(chart, { x: 10 });
  const lines = csv.split("\n");
  assert.equal(lines[0], "label,series1,Half");
  assert.equal(lines[1], '"a",10,5');
  assert.equal(lines[2], '"b",20,');
});

await test("computeTone: bad beats warn; missing tone is neutral", () => {
  assert.equal(computeTone(undefined, 999), "neutral");
  assert.equal(computeTone({ warnAbove: 30, badAbove: 50 }, 45), "warn");
  assert.equal(computeTone({ warnAbove: 30, badAbove: 50 }, 60), "bad");
  assert.equal(computeTone({ warnAbove: 30, badAbove: 50 }, 10), "neutral");
  assert.equal(computeTone({ warnBelow: 10 }, 5), "warn");
  assert.equal(computeTone({ badBelow: 10, warnBelow: 20 }, 8), "bad");
});

await test("conditionHolds drives visibility", () => {
  assert.equal(conditionHolds(undefined, { x: 0 }), true);
  assert.equal(conditionHolds("x > 80", { x: 90 }), true);
  assert.equal(conditionHolds("x > 80", { x: 10 }), false);
  assert.equal(conditionHolds("bad +++", {}), false, "malformed condition hides safely");
});

await test("evalFormula: precedence, powers, unary minus, parentheses", () => {
  assert.equal(evalFormula("1+2*3", {}), 7);
  assert.equal(evalFormula("(1+2)*3", {}), 9);
  assert.equal(evalFormula("2^3^2", {}), 512, "right-assoc power");
  assert.equal(evalFormula("-3+5", {}), 2);
  assert.equal(evalFormula("10/4", {}), 2.5);
  assert.equal(evalFormula("7%3", {}), 1);
});

await test("evalFormula: variables, constants, and the function library", () => {
  assert.equal(evalFormula("a+b", { a: 2, b: 3 }), 5);
  assert.equal(evalFormula("pi", {}), Math.PI);
  assert.equal(evalFormula("min(3, 1, 2)", {}), 1);
  assert.equal(evalFormula("max(3, 1, 2)", {}), 3);
  assert.equal(evalFormula("abs(-4)", {}), 4);
  assert.equal(evalFormula("round(2.567, 2)", {}), 2.57);
  assert.equal(evalFormula("floor(2.9)", {}), 2);
  assert.equal(evalFormula("ceil(2.1)", {}), 3);
  assert.equal(evalFormula("sqrt(16)", {}), 4);
  assert.equal(evalFormula("pow(2, 10)", {}), 1024);
  assert.equal(evalFormula("if(5 > 3, 10, 20)", {}), 10);
  assert.equal(evalFormula("if(5 < 3, 10, 20)", {}), 20);
  assert.equal(evalFormula("1 < 2 and 2 < 3", {}), 1);
  assert.equal(evalFormula("1 > 2 or 2 < 3", {}), 1);
  assert.equal(evalFormula("not 0", {}), 1);
});

await test("evalFormula: Widget 2.0 functions (clamp, between, sum, avg, trig, log2)", () => {
  assert.equal(evalFormula("clamp(15, 0, 10)", {}), 10);
  assert.equal(evalFormula("clamp(5, 0, 10)", {}), 5);
  assert.equal(evalFormula("between(5, 1, 10)", {}), 1);
  assert.equal(evalFormula("between(50, 1, 10)", {}), 0);
  assert.equal(evalFormula("sum(1, 2, 3, 4)", {}), 10);
  assert.equal(evalFormula("avg(2, 4, 6)", {}), 4);
  assert.ok(Math.abs(evalFormula("sin(pi/2)", {}) - 1) < 1e-12);
  assert.ok(Math.abs(evalFormula("degrees(pi)", {}) - 180) < 1e-12);
  assert.equal(evalFormula("log2(1024)", {}), 10);
  assert.ok(Math.abs(evalFormula("hypot(3, 4)", {}) - 5) < 1e-12);
  assert.ok(Number.isNaN(evalFormula("avg()", {})));
});

await test("evalFormula: financial pmt/fv match the amortization identity", () => {
  const i = 3.9 / 100 / 12;
  const n = 30 * 12;
  const p = 350000;
  const identity = (p * i) / (1 - Math.pow(1 + i, -n));
  const viaPmt = evalFormula("pmt(rate/100/12, years*12, principal)", { rate: 3.9, years: 30, principal: 350000 });
  assert.ok(Math.abs(viaPmt - identity) < 0.01, `pmt ${viaPmt} vs ${identity}`);
  assert.equal(evalFormula("pmt(0, 12, 1200)", {}), 100, "zero-rate pmt is a straight split");
  // fv of the (negative) payment stream is minus the grown principal — sign
  // follows cash-flow convention; fv(r, n, -payment, principal) is the
  // remaining-balance pattern the prompt teaches.
  const fvStream = evalFormula("fv(r, n, -pmt(r, n, principal))", { r: i, n, principal: p });
  assert.ok(Math.abs(fvStream + p * Math.pow(1 + i, n)) < 0.5);
  const balance = evalFormula("fv(r, 60, -pmt(r, n, principal), principal)", { r: i, n, principal: p });
  const expectedBalance = p * Math.pow(1 + i, 60) - identity * ((Math.pow(1 + i, 60) - 1) / i);
  assert.ok(Math.abs(balance - expectedBalance) < 0.5, "remaining balance pattern");
  assert.ok(Number.isNaN(evalFormula("pmt(0.01, 0, 1000)", {})), "n<=0 rejected");
});

await test("evalFormula: monthly-payment style nested formula matches the amortization identity", () => {
  const values = { principal: 350000, rate: 3.9, years: 30 };
  const monthly = evalFormula("principal*(rate/100/12)/(1-(1+rate/100/12)^(-years*12))", values);
  // 350k at 3.9%/yr over 30y: M = P·i/(1−(1+i)^−n) with i=0.00325, n=360 ≈ 1650.8
  assert.ok(Math.abs(monthly - 1650.84) < 0.5, `got ${monthly}`);
});

await test("evalFormula refuses malformed or unknown input with NaN (never throws)", () => {
  assert.ok(Number.isNaN(evalFormula("1 +", {})));
  assert.ok(Number.isNaN(evalFormula("foo(3)", {})));
  assert.ok(Number.isNaN(evalFormula("1 $ 2", {})));
  assert.ok(Number.isNaN(evalFormula("unknownvar + 1", {})));
  assert.ok(Number.isNaN(evalFormula("1/0", {})));
  assert.ok(Number.isNaN(evalFormula("2 == 2", {})) === false, "comparisons are legal");
  assert.ok(Number.isNaN(evalFormula(")", {})));
  assert.ok(Number.isNaN(evalFormula("", {})));
});

await test("evalFormula enforces the formula size cap", () => {
  assert.ok(Number.isNaN(evalFormula("1+".repeat(400) + "1", {})));
});

await test("formatWidgetValue applies decimals, prefix, suffix, and NaN dash", () => {
  assert.equal(formatWidgetValue(1234.567, { decimals: 2 }), "1,234.57");
  assert.equal(formatWidgetValue(0.35, { prefix: "$", decimals: 2 }), "$0.35");
  assert.equal(formatWidgetValue(4, { suffix: "%" }), "4.00%");
  assert.equal(formatWidgetValue(NaN), "—");
});

await test("interpolatePrompt fills {name} placeholders with current values", () => {
  assert.equal(
    interpolatePrompt("Payment if principal = {principal} and years = {years}?", { principal: 35000, years: 30 }),
    "Payment if principal = 35000 and years = 30?"
  );
  assert.equal(interpolatePrompt("keep {unknown} as-is", { known: 1 }), "keep {unknown} as-is");
});

console.log(`\nwidget-blocks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
