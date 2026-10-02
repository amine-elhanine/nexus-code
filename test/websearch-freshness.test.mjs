import assert from "node:assert/strict";
import { freshnessToDateFilter, createWebSearchTools } from "../dist-electron/websearch-tool.js";

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

console.log("\n=== Web Search Freshness Tests ===");

await test("freshness maps to the DuckDuckGo Lite date filter", () => {
  assert.equal(freshnessToDateFilter("day"), "d");
  assert.equal(freshnessToDateFilter("week"), "w");
  assert.equal(freshnessToDateFilter("month"), "m");
  assert.equal(freshnessToDateFilter("year"), "y");
  assert.equal(freshnessToDateFilter("YEAR"), "y", "case-insensitive");
});

await test("missing or unknown freshness yields no filter", () => {
  assert.equal(freshnessToDateFilter(undefined), null);
  assert.equal(freshnessToDateFilter(""), null);
  assert.equal(freshnessToDateFilter("decade"), null);
});

await test("web_search schema exposes the freshness parameter", () => {
  const [tool] = createWebSearchTools();
  assert.equal(tool.name, "web_search");
  const parsed = tool.schema.safeParse({ query: "latest ai models", freshness: "month" });
  assert.equal(parsed.success, true, "freshness accepted by schema");
  const without = tool.schema.safeParse({ query: "python-pptx add image" });
  assert.equal(without.success, true, "freshness stays optional");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
