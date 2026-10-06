import React from "react";
import type { NotebookCitation } from "../../types.js";

export const UNVERIFIED_CITATION_TITLE = "Unverified: auto-linked passage — may not support this claim";

/**
 * "Sources: [S1] file — heading; [S2] …" inline list shared by the study
 * modals. Citations flagged `verified: false` (positional fallback links from
 * the generators) render dimmed with a warning tooltip instead of looking
 * identical to model-cited passages.
 */
export function CitationSources({ citations, prefix = "Sources: " }: { citations: NotebookCitation[]; prefix?: string }) {
  return (
    <>
      {prefix}
      {citations.map((c, i) => (
        <span
          key={`${c.chunkId}-${i}`}
          title={c.verified === false ? UNVERIFIED_CITATION_TITLE : undefined}
          style={{ opacity: c.verified === false ? 0.55 : undefined }}
        >
          [S{c.index}] {c.sourceName} — {c.heading}
          {c.verified === false ? " (unverified)" : ""}
          {i < citations.length - 1 ? "; " : ""}
        </span>
      ))}
    </>
  );
}
