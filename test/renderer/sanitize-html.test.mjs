import assert from "node:assert/strict";
import { sanitizeHtml } from "../../src/utils/sanitizeHtml.js";

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

await test("sanitizeHtml strips scripts, iframes, svgs, event handlers, and javascript URLs", () => {
  const dirty = [
    `<table><tr><td onclick="alert(1)">Cell 1</td>`,
    `<td><a href="javascript:alert(2)" onmouseover="evil()">BadLink</a></td>`,
    `<td><a href="https://example.com">GoodLink</a></td></tr></table>`,
    `<script>window.pwned = true;</script>`,
    `<iframe src="https://evil.test"></iframe>`,
    `<svg onload="alert(3)"><circle /></svg>`,
  ].join("");
  const clean = sanitizeHtml(dirty);
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /<iframe/i);
  assert.doesNotMatch(clean, /<svg/i);
  assert.doesNotMatch(clean, /onclick|onmouseover|onload/i);
  assert.doesNotMatch(clean, /javascript:/i);
  assert.match(clean, /Cell 1/);
  assert.match(clean, /href="https:\/\/example\.com\/?"/);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
