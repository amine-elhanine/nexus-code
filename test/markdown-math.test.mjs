import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown.ts";

console.log("=== Markdown & Math Parsing Tests ===");

// 1. Programming identifiers in backticks must remain inline <code>, never KaTeX
const testCasesCode = [
  "create_agent",
  "create_deep_agent",
  "get_weather",
  "model_name",
  "my_custom_variable",
  "requirements.txt",
  "--output_dir",
  "test_fn(x, y)",
];

for (const code of testCasesCode) {
  const rendered = renderMarkdown(`Using \`${code}\` in the project`);
  assert.ok(
    rendered.includes(`<code>${code}</code>`),
    `Expected "${code}" to be rendered as <code>${code}</code>, but got: ${rendered}`
  );
  assert.ok(
    !rendered.includes("katex"),
    `Expected "${code}" NOT to contain katex markup, but got: ${rendered}`
  );
  console.log(`  ✓ \`${code}\` correctly rendered as <code>`);
}

// 2. Headings with code snippets containing underscores
const headingMd = "## Deep Agent Creation (using `create_deep_agent`)";
const renderedHeading = renderMarkdown(headingMd);
assert.ok(
  renderedHeading.includes("<h2>Deep Agent Creation (using <code>create_deep_agent</code>)</h2>"),
  `Heading did not render expected HTML, got: ${renderedHeading}`
);
assert.ok(
  !renderedHeading.includes("katex"),
  `Heading should not contain KaTeX math, got: ${renderedHeading}`
);
console.log("  ✓ Headings with inline code containing underscores render cleanly as <h2>...<code>");

// 3. Genuine math expressions must still render with KaTeX
const testCasesMath = [
  "\\frac{1}{2}",
  "\\sum_{i=1}^N x_i",
  "\\sigma(W x + b)",
  "e^{-x}",
  "ReLU(W x + b)",
  "x_{ij} = y_{ij}",
];

for (const math of testCasesMath) {
  const rendered = renderMarkdown(`Equation: \`${math}\``);
  assert.ok(
    rendered.includes("katex"),
    `Expected math formula "${math}" to render as KaTeX, got: ${rendered}`
  );
  console.log(`  ✓ Genuine math \`${math}\` rendered as KaTeX`);
}

// 4. Standard $...$ and $$...$$ math syntax still works
const dollarMath = renderMarkdown("The loss is $\\mathcal{L}(y, \\hat{y})$ here.");
assert.ok(dollarMath.includes("katex"), "Dollar delimited math should render as KaTeX");
console.log("  ✓ Dollar math $...$ renders as KaTeX");

console.log("\nAll markdown & math rendering tests passed successfully!");
