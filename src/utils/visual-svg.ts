/**
 * SVGs without a viewBox cannot scale via CSS — their content draws at
 * intrinsic coordinates inside whatever box the CSS gives them. Mermaid and
 * the built-in charts always emit one, but be defensive with any source
 * opening the fullscreen viewer: derive a viewBox from numeric width/height
 * attributes when it is missing.
 */
export function normalizeSvgForFullscreen(svg: string): string {
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return svg;
  const tag = open[0];
  if (/\bviewbox\s*=/i.test(tag)) return svg;
  const dimension = (name: string) => {
    // Only bare pixel values count: "100%" (percent) carries no intrinsic
    // size, and the lookbehind keeps e.g. stroke-width from matching "width".
    const match = tag.match(new RegExp(`(?<![-\\w])${name}\\s*=\\s*"?([\\d.]+)(?:px)?"?(?![\\d.%])`, "i"));
    return match ? Number.parseFloat(match[1]) : Number.NaN;
  };
  const width = dimension("width");
  const height = dimension("height");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return svg;
  return svg.replace(tag, `${tag.slice(0, -1)} viewBox="0 0 ${width} ${height}">`);
}
