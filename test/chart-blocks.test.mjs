import assert from "node:assert/strict";
import {
  parseBarChart,
  parseHBarChart,
  parseLineChart,
  parseAreaChart,
  parseScatterChart,
  parsePieChart,
  parseRadarChart,
  niceMax,
} from "../src/utils/chart-blocks.ts";

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

console.log("\n=== Chart Block Parser Tests ===");

await test("parseBarChart reads bars and auto-scales the y axis", () => {
  const spec = parseBarChart(`
    title "Quarterly revenue"
    y-axis "USD (millions)"
    bar "Q1" 320
    bar "Q2" 410
    bar "Q3" 480
  `);
  assert.ok(spec, "spec parsed");
  assert.equal(spec.title, "Quarterly revenue");
  assert.equal(spec.yLabel, "USD (millions)");
  assert.equal(spec.entries.length, 3);
  assert.deepEqual(spec.entries[1], { label: "Q2", value: 410 });
  assert.equal(spec.yMin, 0);
  assert.equal(spec.yMax, 500, "auto max rounds 480 up to a nice 500");
});

await test("parseBarChart honors explicit y-axis bounds and ignores noise", () => {
  const spec = parseBarChart(`
    some prose the model added
    x-axis "Quarter"
    y-axis "Score %" 0 100
    bar "A" 87.5
    bar "B" 92
    random text without a value
  `);
  assert.ok(spec, "spec parsed");
  assert.equal(spec.xLabel, "Quarter");
  assert.equal(spec.yMin, 0);
  assert.equal(spec.yMax, 100);
  assert.equal(spec.entries[0].value, 87.5);
});

await test("parseBarChart rejects empty or contradictory specs", () => {
  assert.equal(parseBarChart('title "nothing"\n'), null, "no bars");
  assert.equal(parseBarChart('bar "A" 5\ny-axis "v" 10 0\n'), null, "yMax <= yMin");
  assert.equal(parseBarChart('bar "A" abc\n'), null, "non-numeric value only");
});

await test("parseLineChart reads an ordered series", () => {
  const spec = parseLineChart(`
    title "Monthly active users"
    x-axis "Month"
    y-axis "Users"
    point "Jan" 1200
    point "Feb" 1350
    point "Mar" 1310
  `);
  assert.ok(spec, "spec parsed");
  assert.equal(spec.entries.length, 3);
  assert.deepEqual(spec.entries.map((e) => e.label), ["Jan", "Feb", "Mar"]);
  assert.equal(spec.yMax, 2000, "auto max is the nice ceiling above 1350");
  assert.equal(parseLineChart('title "no points"\n'), null);
});

await test("parseScatterChart keeps the original fence semantics", () => {
  const spec = parseScatterChart(`
    title "Study hours vs exam score"
    x-axis "Hours" 0 12
    y-axis "Score" 0 100
    point "Ana" 4 71
    point "Ben" 9 88
  `);
  assert.ok(spec, "spec parsed");
  assert.equal(spec.xMin, 0);
  assert.equal(spec.xMax, 12);
  assert.equal(spec.points.length, 2);
  assert.deepEqual(spec.points[0], { name: "Ana", x: 4, y: 71 });
  assert.equal(parseScatterChart('title "no points"\nx-axis "a" 0 1\n'), null);
});

await test("niceMax rounds up to readable 1/2/5 steps", () => {
  assert.equal(niceMax(410), 500);
  assert.equal(niceMax(480), 500);
  assert.equal(niceMax(550), 1000);
  assert.equal(niceMax(1200), 2000);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
});

await test("parseAreaChart reads ordered points like line chart", () => {
  const spec = parseAreaChart(`
    title "Network bandwidth"
    x-axis "Hour"
    y-axis "Mbps"
    point "08:00" 45
    point "12:00" 80
    point "16:00" 65
  `);
  assert.ok(spec, "spec parsed");
  assert.equal(spec.title, "Network bandwidth");
  assert.equal(spec.entries.length, 3);
  assert.equal(spec.yMax, 100);
});

await test("parseHBarChart reads horizontal bars", () => {
  const spec = parseHBarChart(`
    title "Top languages"
    x-axis "Stars"
    bar "TypeScript" 95000
    bar "Python" 88000
    bar "Rust" 72000
  `);
  assert.ok(spec, "spec parsed");
  assert.equal(spec.title, "Top languages");
  assert.equal(spec.entries.length, 3);
  assert.equal(spec.entries[0].label, "TypeScript");
  assert.equal(spec.entries[0].value, 95000);
});

await test("parsePieChart calculates totals and percentages for pie and donut", () => {
  const pieSpec = parsePieChart(`
    title "Browser market share"
    slice "Chrome" 65
    slice "Safari" 20
    slice "Edge" 15
  `);
  assert.ok(pieSpec, "pie spec parsed");
  assert.equal(pieSpec.title, "Browser market share");
  assert.equal(pieSpec.donut, false);
  assert.equal(pieSpec.total, 100);
  assert.equal(pieSpec.slices.length, 3);
  assert.equal(pieSpec.slices[0].percent, 65);
  assert.equal(pieSpec.slices[1].percent, 20);

  const donutSpec = parsePieChart(`
    title "Budget distribution"
    type "donut"
    slice "R&D" 40
    slice "Marketing" 30
    slice "Ops" 30
  `);
  assert.ok(donutSpec, "donut spec parsed");
  assert.equal(donutSpec.donut, true);
  assert.equal(donutSpec.total, 100);
});

await test("parseRadarChart parses multi-axis polygon vertices", () => {
  const spec = parseRadarChart(`
    title "AI Evaluation"
    max 100
    axis "Reasoning" 90
    axis "Coding" 85
    axis "Math" 80
    axis "Speed" 75
    axis "Context" 95
  `);
  assert.ok(spec, "radar spec parsed");
  assert.equal(spec.title, "AI Evaluation");
  assert.equal(spec.max, 100);
  assert.equal(spec.axes.length, 5);
  assert.equal(spec.axes[0].label, "Reasoning");
  assert.equal(spec.axes[0].value, 90);

  // Less than 3 axes is invalid for radar
  assert.equal(parseRadarChart('axis "A" 10\naxis "B" 20\n'), null);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
