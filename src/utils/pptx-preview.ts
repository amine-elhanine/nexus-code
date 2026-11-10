/**
 * Utilities for in-app PowerPoint presentation previews (@aiden0z/pptx-renderer).
 *
 * PowerPoint desktop/web apps auto-expand tables to fit all rows, regardless of
 * the graphicFrame height (cy). The in-app web renderer sets container height to
 * cy with overflow: hidden, which clips tables whose OOXML frame height was omitted
 * or smaller than the natural row contents.
 *
 * This hook unclips table wrappers and enables natural responsive height so tables
 * render completely inside the app just like they do in PowerPoint.
 */

export function fixPptxRenderedSlide(slideEl: HTMLElement): void {
  if (!slideEl || typeof slideEl.querySelectorAll !== "function") return;

  const tables = slideEl.querySelectorAll("table");
  tables.forEach((tbl) => {
    const wrapper = tbl.parentElement;
    if (wrapper) {
      wrapper.style.height = "auto";
      wrapper.style.minHeight = "fit-content";
      wrapper.style.overflow = "visible";
    }
    tbl.style.height = "auto";
    tbl.style.minHeight = "fit-content";
    tbl.style.overflow = "visible";
    tbl.style.tableLayout = "auto";

    tbl.querySelectorAll("tr").forEach((row) => {
      (row as HTMLElement).style.height = "auto";
    });

    tbl.querySelectorAll("td, th").forEach((cell) => {
      const el = cell as HTMLElement;
      el.style.overflow = "visible";
      el.style.wordBreak = "break-word";
      el.style.whiteSpace = "normal";
    });
  });
}
