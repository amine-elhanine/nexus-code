const ALLOWED_TAGS = new Set([
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "COLGROUP", "COL", "CAPTION",
  "DIV", "SPAN", "P", "BR", "HR", "STRONG", "B", "EM", "I", "U", "S", "CODE", "PRE",
  "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "A",
]);

const ALLOWED_ATTRS = new Set(["colspan", "rowspan", "class", "id", "title", "scope", "data-t", "data-v", "data-z"]);

function sanitizeHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Strip executable markup, event handlers, and unsafe URLs from HTML fragments
 * (such as `XLSX.utils.sheet_to_html` output) before mounting with
 * `dangerouslySetInnerHTML`. Uses the browser HTML5 parser when available.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    const walk = (node: Node): Node | null => {
      if (node.nodeType === 3) return node.cloneNode(false);
      if (node.nodeType !== 1) return null;
      const el = node as Element;
      const tag = el.tagName.toUpperCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Drop active/embedded tags outright; unwrap harmless container tags.
        if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "FORM"].includes(tag)) {
          return null;
        }
        const frag = doc.createDocumentFragment();
        for (const child of Array.from(el.childNodes)) {
          const cleanChild = walk(child);
          if (cleanChild) frag.appendChild(cleanChild);
        }
        return frag;
      }
      const cleanEl = doc.createElement(tag.toLowerCase());
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name === "href" && tag === "A") {
          const safeUrl = sanitizeHref(attr.value);
          if (safeUrl) {
            cleanEl.setAttribute("href", safeUrl);
            cleanEl.setAttribute("rel", "noreferrer noopener");
            cleanEl.setAttribute("target", "_blank");
          }
          continue;
        }
        if (ALLOWED_ATTRS.has(name)) {
          cleanEl.setAttribute(name, attr.value);
        }
      }
      for (const child of Array.from(el.childNodes)) {
        const cleanChild = walk(child);
        if (cleanChild) cleanEl.appendChild(cleanChild);
      }
      return cleanEl;
    };
    const container = doc.createElement("div");
    for (const child of Array.from(doc.body.childNodes)) {
      const clean = walk(child);
      if (clean) container.appendChild(clean);
    }
    return container.innerHTML;
  }
  // Fallback for Node-only test environments without DOMParser.
  return String(html)
    .replace(/<(script|style|iframe|object|embed|svg|math|form|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|svg|meta|link|base)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, "");
}
