import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { renderMarkdown } from "../src/markdown.ts";

test("Markdown image rendering produces clean <img> tags", () => {
  const input = "Here is the evidence:\n\n![Fed Funds Rate 2020-2025](chart_fed_rate.png)\n\nAs shown above, rates rose.";
  const rendered = renderMarkdown(input);

  assert.ok(
    rendered.includes('<img src="chart_fed_rate.png" alt="Fed Funds Rate 2020-2025" class="md-image" loading="lazy" />'),
    `Expected rendered <img> tag, got: ${rendered}`
  );
  assert.ok(rendered.includes("Here is the evidence:"));
  assert.ok(rendered.includes("As shown above, rates rose."));
});

test("Markdown image rendering supports various image formats", () => {
  const formats = [
    { src: "plot_distribution.svg", alt: "SVG Vector Plot" },
    { src: "scan_results.jpg", alt: "JPEG Photo" },
    { src: "heatmap.webp", alt: "WebP Heatmap" },
    { src: "diagram.png", alt: "PNG Diagram" },
  ];

  for (const { src, alt } of formats) {
    const rendered = renderMarkdown(`![${alt}](${src})`);
    assert.ok(
      rendered.includes(`<img src="${src}" alt="${alt}" class="md-image" loading="lazy" />`),
      `Expected ${src} to render properly, got: ${rendered}`
    );
  }
});

test("Visual block detection regex detects markdown image charts", () => {
  const VISUAL_BLOCK_REGEX =
    /(?:```(?:bar|hbar|line|area|pie|donut|scatter|radar|mermaid)\b)|(?:!\[[^\]]*\]\([^)]+\.(png|jpe?g|svg|webp|gif)\))/i;

  // Code fences
  assert.ok(VISUAL_BLOCK_REGEX.test("```bar\nbar A 10\n```"), "Bar fence should match");
  assert.ok(VISUAL_BLOCK_REGEX.test("```line\npoint A 10\n```"), "Line fence should match");
  assert.ok(VISUAL_BLOCK_REGEX.test("```mermaid\ngraph TD\nA-->B\n```"), "Mermaid fence should match");

  // Markdown image embeds
  assert.ok(VISUAL_BLOCK_REGEX.test("![Market Trends](chart_market_trends.png)"), "PNG image should match");
  assert.ok(VISUAL_BLOCK_REGEX.test("![Interest Rates](rates_2025.svg)"), "SVG image should match");
  assert.ok(VISUAL_BLOCK_REGEX.test("![Inflation](inflation.jpg)"), "JPG image should match");
  assert.ok(VISUAL_BLOCK_REGEX.test("See chart: ![Performance](./charts/perf.webp)"), "WebP relative image should match");

  // Non-visual responses
  assert.ok(!VISUAL_BLOCK_REGEX.test("Here is a regular text explanation with no graphs."), "Plain text should not match");
  assert.ok(!VISUAL_BLOCK_REGEX.test("```python\nprint('hello')\n```"), "Python code should not match");
  assert.ok(!VISUAL_BLOCK_REGEX.test("[Download report](report.pdf)"), "Non-image link should not match");
});

test("RichMarkdown block regex matches both code fences and markdown image embeds", () => {
  const BLOCK_PATTERN = /(```([\w-]*)\s*\n([\s\S]*?)```)|(!\[([^\]]*)\]\(([^)]+)\))/gi;

  const sample = [
    "Intro text.",
    "```bar",
    "bar Q1 100",
    "```",
    "Middle text.",
    "![Market Share Chart](chart_market_share.png)",
    "Closing text.",
  ].join("\n\n");

  const matches = [...sample.matchAll(BLOCK_PATTERN)];
  assert.equal(matches.length, 2, "Should match 1 code fence and 1 image embed");

  // First match: code fence
  assert.equal(matches[0][2], "bar");
  assert.ok(matches[0][3].includes("bar Q1 100"));

  // Second match: image embed
  assert.equal(matches[1][5], "Market Share Chart");
  assert.equal(matches[1][6], "chart_market_share.png");
});

test("Auto-embedder embeds unreferenced fresh images with humanized titles", () => {
  const homeFreshFiles = ["chart_fed_rate_hikes.png", "analysis_notes.txt"];
  let response = "Based on our research, the Fed increased interest rates sharply during 2022-2023.";

  const freshImages = homeFreshFiles.filter((f) => /\.(png|jpe?g|svg|webp|gif)$/i.test(f));
  assert.equal(freshImages.length, 1);

  const unreferencedImages = [];
  for (const img of freshImages) {
    const basename = path.basename(img);
    const isEmbedded =
      response.includes(`](${img})`) ||
      response.includes(`](${basename})`) ||
      response.includes(`](./${basename})`) ||
      response.includes(`](/${basename})`);
    if (!isEmbedded) {
      unreferencedImages.push(img);
    }
  }

  assert.equal(unreferencedImages.length, 1);

  const imageEmbeds = unreferencedImages.map((img) => {
    const base = path.basename(img);
    const rawName = base.replace(/\.[^/.]+$/, "");
    const cleanTitle = rawName.replace(/[_-]+/g, " ").replace(/^(chart|plot|graph)\s+/i, "").trim();
    const title = cleanTitle
      ? cleanTitle.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") + " Chart"
      : "Visual Evidence";
    return `![${title}](${img})`;
  }).join("\n\n");

  response = `${response.trim()}\n\n### Visual Evidence & Charts\n\n${imageEmbeds}`;

  assert.ok(response.includes("### Visual Evidence & Charts"));
  assert.ok(response.includes("![Fed Rate Hikes Chart](chart_fed_rate_hikes.png)"));
});

test("Auto-embedder does not duplicate already embedded images", () => {
  const homeFreshFiles = ["chart_gdp.png"];
  let response = "Here is the GDP growth:\n\n![GDP Growth](chart_gdp.png)\n\nAs we can see, GDP grew.";

  const freshImages = homeFreshFiles.filter((f) => /\.(png|jpe?g|svg|webp|gif)$/i.test(f));
  const unreferencedImages = [];
  for (const img of freshImages) {
    const basename = path.basename(img);
    const isEmbedded =
      response.includes(`](${img})`) ||
      response.includes(`](${basename})`) ||
      response.includes(`](./${basename})`) ||
      response.includes(`](/${basename})`);
    if (!isEmbedded) {
      unreferencedImages.push(img);
    }
  }

  assert.equal(unreferencedImages.length, 0, "Already embedded image should not be marked as unreferenced");
});
