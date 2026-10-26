import assert from "node:assert/strict";
import { normalizeSvgForFullscreen } from "../src/utils/visual-svg.ts";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  FAIL - ${name}`);
    throw error;
  }
}

console.log("visual-svg: normalizeSvgForFullscreen");

check("injects viewBox derived from numeric width/height", () => {
  const out = normalizeSvgForFullscreen('<svg xmlns="http://www.w3.org/2000/svg" width="760" height="420"><g/></svg>');
  assert.match(out, /^<svg[^>]*viewBox="0 0 760 420">/);
  assert.ok(out.endsWith("<g/></svg>"));
});

check("keeps existing viewBox untouched", () => {
  const svg = '<svg viewBox="0 -61 1190 610" width="100%" style="max-width: 1190px;"><g/></svg>';
  assert.equal(normalizeSvgForFullscreen(svg), svg);
});

check("percentage width without viewBox stays unchanged", () => {
  const svg = '<svg width="100%" height="100%"><path d="M0 0"/></svg>';
  assert.equal(normalizeSvgForFullscreen(svg), svg);
});

check("non-svg string stays unchanged", () => {
  assert.equal(normalizeSvgForFullscreen("<div>not a chart</div>"), "<div>not a chart</div>");
});

check("px-unit dimensions are accepted", () => {
  const out = normalizeSvgForFullscreen("<svg width=\"300px\" height=\"150px\"></svg>");
  assert.match(out, /viewBox="0 0 300 150"/);
});

check("missing height leaves the tag alone", () => {
  const svg = '<svg width="300"><g/></svg>';
  assert.equal(normalizeSvgForFullscreen(svg), svg);
});

check("stroke-width on the root tag is not mistaken for width", () => {
  const out = normalizeSvgForFullscreen('<svg stroke-width="5" width="200" height="100"></svg>');
  assert.match(out, /viewBox="0 0 200 100"/);
  const unchanged = normalizeSvgForFullscreen('<svg stroke-width="5"></svg>');
  assert.equal(unchanged, '<svg stroke-width="5"></svg>');
});

console.log(`visual-svg: ${passed} passed`);
