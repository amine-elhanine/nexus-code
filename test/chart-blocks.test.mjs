import assert from "node:assert/strict";
import { parseBarChart, parseLineChart, parseScatterChart, niceMax } from "../src/utils/chart-blocks.ts";

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

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
