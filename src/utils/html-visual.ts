/**
 * Pure helpers for sandboxed HTML/CSS/JS interactive visual blocks (` ```visual `,
 * ` ```html-visual `, ` ```interactive `). Builds a self-contained `srcDoc`
 * with a strict Content-Security-Policy, Nexus theme variables, and a
 * token-scoped ResizeObserver height bridge.
 */

export const VISUAL_HTML_KINDS = new Set(["visual", "html-visual", "interactive"]);

export const VISUAL_MIN_HEIGHT = 160;
export const VISUAL_MAX_HEIGHT = 760;
export const VISUAL_DEFAULT_HEIGHT = 320;

export function isVisualHtmlFence(kind: string): boolean {
  return VISUAL_HTML_KINDS.has(kind.trim().toLowerCase());
}

export function clampVisualHeight(raw: unknown, fallback = VISUAL_DEFAULT_HEIGHT): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(VISUAL_MIN_HEIGHT, Math.min(VISUAL_MAX_HEIGHT, Math.round(n)));
}

export function extractVisualTitle(source: string): string {
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) {
    return titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 80);
  }
  const commentMatch = source.match(/<!--\s*(?:title\s*:\s*)?([^-\n][^\n]*?)\s*-->/i);
  if (commentMatch?.[1]?.trim()) {
    const cleaned = commentMatch[1].replace(/\s+/g, " ").trim();
    if (cleaned.length > 0 && cleaned.length <= 80) return cleaned;
  }
  const headingMatch = source.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (headingMatch?.[1]) {
    const text = headingMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 80);
  }
  return "Interactive visual";
}

export interface BuildVisualSrcDocOptions {
  token: string;
  isLight?: boolean;
}

const STRICT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none';";

function buildThemeStyle(isLight: boolean): string {
  const palette = isLight
    ? {
        scheme: "light",
        bg: "#f8fafc",
        panel: "#ffffff",
        surface: "#f1f5f9",
        text: "#0f172a",
        muted: "#475569",
        border: "#cbd5e1",
        accent: "#059669",
        accentSoft: "rgba(5, 150, 105, 0.12)",
      }
    : {
        scheme: "dark",
        bg: "#0b1017",
        panel: "#111824",
        surface: "#16202e",
        text: "#e2e8f0",
        muted: "#94a3b8",
        border: "#263447",
        accent: "#34d399",
        accentSoft: "rgba(52, 211, 153, 0.14)",
      };

  return `<style id="nexus-visual-theme">
:root {
  color-scheme: ${palette.scheme};
  --nexus-bg: ${palette.bg};
  --nexus-panel: ${palette.panel};
  --nexus-surface: ${palette.surface};
  --nexus-text: ${palette.text};
  --nexus-muted: ${palette.muted};
  --nexus-border: ${palette.border};
  --nexus-accent: ${palette.accent};
  --nexus-accent-soft: ${palette.accentSoft};
  --nexus-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
  --nexus-font-mono: "DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --bg: var(--nexus-bg);
  --panel: var(--nexus-panel);
  --surface: var(--nexus-surface);
  --text: var(--nexus-text);
  --muted: var(--nexus-muted);
  --border: var(--nexus-border);
  --accent: var(--nexus-accent);
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--nexus-bg);
  color: var(--nexus-text);
  font-family: var(--nexus-font-sans);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
body { padding: 14px; overflow-x: hidden; }
button, input, select { font-family: inherit; }
</style>`;
}

function buildBridgeScript(token: string): string {
  const safeToken = JSON.stringify(token);
  return `<script id="nexus-visual-bridge">
(function () {
  var TOKEN = ${safeToken};
  var lastHeight = 0;
  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    if (!doc || !body) return;
    var bodyRect = body.getBoundingClientRect ? body.getBoundingClientRect().height : 0;
    var h = Math.ceil(Math.max(body.scrollHeight || 0, doc.scrollHeight || 0, bodyRect || 0));
    if (h > 0 && Math.abs(h - lastHeight) >= 2) {
      lastHeight = h;
      try {
        window.parent.postMessage({ type: "nexus-visual-height", token: TOKEN, height: h }, "*");
      } catch (_) {}
    }
  }
  window.addEventListener("error", function (ev) {
    try {
      window.parent.postMessage({
        type: "nexus-visual-error",
        token: TOKEN,
        message: ev && ev.message ? String(ev.message) : "Script error"
      }, "*");
    } catch (_) {}
  });
  if (typeof ResizeObserver !== "undefined") {
    var ro = new ResizeObserver(function () { requestAnimationFrame(measure); });
    if (document.documentElement) ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  window.addEventListener("load", function () {
    measure();
    setTimeout(measure, 60);
    setTimeout(measure, 250);
  });
  if (document.readyState === "complete" || document.readyState === "interactive") {
    requestAnimationFrame(measure);
  } else {
    document.addEventListener("DOMContentLoaded", function () { requestAnimationFrame(measure); });
  }
})();
</script>`;
}

/**
 * Strip any author-supplied CSP meta tags so the parent's strict sandbox CSP
 * cannot be overridden or weakened.
 */
function stripAuthorCsp(html: string): string {
  return html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
}

export function buildVisualSrcDoc(source: string, opts: BuildVisualSrcDocOptions): string {
  const cleaned = stripAuthorCsp(source || "");
  const cspMeta = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">`;
  const themeStyle = buildThemeStyle(Boolean(opts.isLight));
  const bridge = buildBridgeScript(opts.token);
  const headInject = `${cspMeta}\n${themeStyle}`;

  const hasHtmlShell = /<html[\s>]/i.test(cleaned) || /<!doctype\s+html/i.test(cleaned);
  if (!hasHtmlShell) {
    return `<!doctype html>
<html>
<head>
${headInject}
</head>
<body>
${cleaned}
${bridge}
</body>
</html>`;
  }

  let doc = cleaned;
  if (/<head[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head[^>]*>/i, (m) => `${m}\n${headInject}`);
  } else if (/<html[^>]*>/i.test(doc)) {
    doc = doc.replace(/<html[^>]*>/i, (m) => `${m}\n<head>\n${headInject}\n</head>`);
  } else {
    doc = `<head>\n${headInject}\n</head>\n${doc}`;
  }

  if (/<\/body>/i.test(doc)) {
    doc = doc.replace(/<\/body>/i, `${bridge}\n</body>`);
  } else if (/<\/html>/i.test(doc)) {
    doc = doc.replace(/<\/html>/i, `${bridge}\n</html>`);
  } else {
    doc = `${doc}\n${bridge}`;
  }
  return doc;
}
