// Shared HTML → plain-text helpers. Four modules used to keep near-identical
// private copies (notebook-web, websearch-tool, browser-tool, notebook-parse);
// this is the superset: named + numeric + hex entities. Block-level layout
// preservation (script/style removal, newline for block tags) stays with the
// callers that need it — only the decode + inline-strip core is shared here.

/**
 * Decodes HTML entities. Order matters: numeric/hex first, then the named
 * map amp→lt→gt→quot→apos→nbsp, so "&amp;lt;" degrades to the literal text
 * "lt" (single decode pass) instead of silently becoming "<".
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, num: string) => {
      try {
        return String.fromCodePoint(parseInt(num, 10));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip tags, decode entities, collapse to one line of plain text. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
