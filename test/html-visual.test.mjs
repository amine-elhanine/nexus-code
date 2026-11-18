import test from "node:test";
import assert from "node:assert/strict";
import {
  isVisualHtmlFence,
  clampVisualHeight,
  extractVisualTitle,
  buildVisualSrcDoc,
  VISUAL_MIN_HEIGHT,
  VISUAL_MAX_HEIGHT,
  VISUAL_DEFAULT_HEIGHT,
} from "../src/utils/html-visual.ts";

const { responseHasVisualBlocks, hasChartFences, matchChartFences } = await import(
  "../dist-electron/agent/verify-home.js"
);

test("isVisualHtmlFence recognizes dedicated visual fences and leaves plain html as code", () => {
  assert.equal(isVisualHtmlFence("visual"), true);
  assert.equal(isVisualHtmlFence("html-visual"), true);
  assert.equal(isVisualHtmlFence("interactive"), true);
  assert.equal(isVisualHtmlFence("VISUAL"), true);
  assert.equal(isVisualHtmlFence("html"), false);
  assert.equal(isVisualHtmlFence("javascript"), false);
  assert.equal(isVisualHtmlFence(""), false);
});

test("clampVisualHeight clamps to bounds and falls back on invalid values", () => {
  assert.equal(clampVisualHeight(400), 400);
  assert.equal(clampVisualHeight(40), VISUAL_MIN_HEIGHT);
  assert.equal(clampVisualHeight(4000), VISUAL_MAX_HEIGHT);
  assert.equal(clampVisualHeight(NaN), VISUAL_DEFAULT_HEIGHT);
  assert.equal(clampVisualHeight(-10), VISUAL_DEFAULT_HEIGHT);
});

test("extractVisualTitle prefers <title>, then comment, then heading, then fallback", () => {
  assert.equal(extractVisualTitle("<title>Bubble Sort</title><div>x</div>"), "Bubble Sort");
  assert.equal(extractVisualTitle("<!-- title: Binary Search -->\n<div>x</div>"), "Binary Search");
  assert.equal(extractVisualTitle("<h2>Wave Interference</h2><canvas></canvas>"), "Wave Interference");
  assert.equal(extractVisualTitle("<div>plain</div>"), "Interactive visual");
});

test("buildVisualSrcDoc wraps fragments with strict CSP, theme vars, and token bridge", () => {
  const doc = buildVisualSrcDoc("<div id='app'>Hi</div><script>console.log(1)</script>", {
    token: "tok-123",
    isLight: false,
  });
  assert.match(doc, /<!doctype html>/i);
  assert.match(doc, /Content-Security-Policy/i);
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /color-scheme:\s*dark/);
  assert.match(doc, /"tok-123"/);
  assert.match(doc, /nexus-visual-height/);
});

test("buildVisualSrcDoc strips author CSP meta tags and injects strict CSP into full HTML docs", () => {
  const malicious = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><p>ok</p></body></html>`;
  const doc = buildVisualSrcDoc(malicious, { token: "t2", isLight: true });
  assert.equal(doc.includes("default-src *"), false);
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /color-scheme:\s*light/);
  assert.match(doc, /"t2"/);
});

test("verify-home recognizes ```visual, ```html-visual, ```interactive, and ```widget fences", () => {
  const sample = "Here is an animation:\n\n```visual\n<!-- title: Demo -->\n<div>Hi</div>\n```";
  assert.equal(responseHasVisualBlocks(sample), true);
  assert.equal(hasChartFences(sample), true);
  assert.equal(matchChartFences(sample).length, 1);
  assert.equal(responseHasVisualBlocks("```interactive\n<div>x</div>\n```"), true);
  assert.equal(responseHasVisualBlocks("```html-visual\n<div>x</div>\n```"), true);
  assert.equal(responseHasVisualBlocks("```widget\ntitle \"Test\"\n```"), true);
});
