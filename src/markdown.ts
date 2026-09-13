// Minimal, dependency-free markdown renderer for chat messages.
// Escape-first: every character with HTML meaning is escaped before any
// transformation, so model output can never inject markup into the Electron
// renderer. Only http(s) links become anchors; javascript:, data:, etc. stay literal text.
import katex from "katex";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(text: string) { return text.replace(/[&<>"']/g, (char) => ESCAPES[char]); }

function mathHtml(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression.trim(), {
      displayMode,
      throwOnError: false,
      // The notebook transcript is rendered inside a sanitized HTML surface.
      // Use KaTeX's visual HTML layer directly; the combined MathML output can
      // be exposed as flattened text by Electron's selection/accessibility
      // handling, making fractions and roots appear as `1N` and `sqrt(...)`.
      output: "html",
      strict: "ignore",
    });
  } catch {
    // Keep malformed model output visible instead of making the whole answer
    // disappear when a formula is incomplete.
    return `<code>${escapeHtml(expression)}</code>`;
  }
}

function looksLikeMath(expression: string): boolean {
  const value = expression.trim();
  // Many educational models emit equations inside backticks instead of using
  // $...$ delimiters. Only promote code spans with unmistakable math markers;
  // ordinary snippets such as `npm run test` remain code.
  return /(?:\\[A-Za-z]+|[_^]|\b(?:ReLU|softmax|sigmoid|argmax|RMSE|MSE)\b)/.test(value)
    && (/[=_^]/.test(value) || /\\[A-Za-z]+/.test(value));
}

function protectMath(source: string): { source: string; math: Array<{ expression: string; display: boolean }> } {
  const math: Array<{ expression: string; display: boolean }> = [];
  // Temporarily protect fenced code so dollar signs inside code are never
  // interpreted as mathematics.
  const fences: string[] = [];
  let protectedSource = source.replace(/```[\s\S]*?```/g, (block) => {
    const token = `\u0000F${fences.length}\u0000`;
    fences.push(block);
    return token;
  });
  const add = (expression: string, display: boolean) => {
    const token = `\u0000M${math.length}\u0000`;
    math.push({ expression, display });
    return token;
  };
  protectedSource = protectedSource
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, expression: string) => add(expression, true))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, expression: string) => add(expression, true))
    .replace(/\\\(([^\n]*?)\\\)/g, (_m, expression: string) => add(expression, false))
    // Avoid treating currency such as "$5" as math; inline math must contain
    // a closing dollar on the same line and at least one non-space character.
    .replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (_m, expression: string) => add(expression, false));
  protectedSource = protectedSource.replace(/\u0000F(\d+)\u0000/g, (_m, index: string) => fences[Number(index)] || "");
  return { source: protectedSource, math };
}

function inline(escaped: string) {
  const codeSpans: string[] = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(looksLikeMath(code) ? mathHtml(code, false) : `<code>${code}</code>`);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(>])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[\s(>])_([^_\n]+)_/g, "$1<em>$2</em>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  text = text.replace(/\u0000C(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
  return text;
}

function renderTableRow(line: string, head = false) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => inline(cell.trim()));
  const tag = head ? "th" : "td";
  return cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("");
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{2,}[-: |]*\|?\s*$/.test(line) && line.includes("|") || /^\s*[-:|]+\s*$/.test(line) && line.includes("-");
}

function renderList(lines: string[], ordered: boolean, start: number): { html: string; next: number } {
  const items: string[] = [];
  let index = start;
  const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
  while (index < lines.length) {
    const match = lines[index].match(pattern);
    if (!match) break;
    let content = inline(match[1].replace(/^\[x\]\s*/i, "✓ ").replace(/^\[ \]\s*/, "○ "));
    // Continuation lines indented under the item belong to it.
    while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1]) && !pattern.test(lines[index + 1])) {
      content += `<br>${inline(lines[index + 1].trim())}`;
      index++;
    }
    items.push(`<li>${content}</li>`);
    index++;
  }
  return { html: ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`, next: index };
}

export function renderMarkdown(source: string): string {
  const protectedMath = protectMath(source ?? "");
  const lines = escapeHtml(protectedMath.source).split(/\r?\n/);
  const html: string[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) { html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`); paragraph = []; }
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index++; }
      index++;
      html.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${code.join("\n")}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      html.push("<hr>");
      index++;
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*&gt;\s?/.test(lines[index])) { quote.push(lines[index].replace(/^\s*&gt;\s?/, "")); index++; }
      html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const head = renderTableRow(line, true);
      index += 2;
      const body: string[] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { body.push(`<tr>${renderTableRow(lines[index])}</tr>`); index++; }
      html.push(`<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const list = renderList(lines, false, index);
      html.push(list.html);
      index = list.next;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      const list = renderList(lines, true, index);
      html.push(list.html);
      index = list.next;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      index++;
      continue;
    }
    paragraph.push(line);
    index++;
  }
  flushParagraph();
  return html.join("\n").replace(/\u0000M(\d+)\u0000/g, (_match, index: string) => {
    const item = protectedMath.math[Number(index)];
    return item ? mathHtml(item.expression, item.display) : "";
  });
}
