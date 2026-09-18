import React from "react";
import { Download, FileText } from "lucide-react";
import { Modal } from "../common/Modal.js";
import { RichMarkdown } from "../common/RichMarkdown.js";
import type { NotebookCitation } from "../../types.js";

/** In-window viewer for notebook artifacts (generated documents + saved notes). */
export function DocumentViewerModal({ title, subtitle, meta, prompt, markdown, citations, downloadLabel, onDownload, onClose }: {
  title: string;
  subtitle: string;
  meta: string;
  prompt?: string;
  markdown: string;
  citations: NotebookCitation[];
  downloadLabel?: string;
  onDownload?: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="passage-body">
        <div className="settings-note">
          <FileText size={12} />
          <span>{meta}</span>
        </div>
        {!!prompt && (
          <div className="passage-summary">
            <span className="passage-label">REQUEST</span>
            <RichMarkdown source={prompt} />
          </div>
        )}
        <div className="passage-main">
          <span className="passage-label">PREVIEW</span>
          <RichMarkdown source={markdown} />
        </div>
        {!!citations.length && (
          <details className="passage-neighbor" open>
            <summary>Cited passages ({citations.length})</summary>
            <div className="citation-list">
              {citations.map((cite) => (
                <div key={cite.chunkId} className="citation-row" title={cite.snippet}>
                  <span className="citation-tag">[S{cite.index}]</span>
                  <span className="citation-name">{cite.sourceName} — {cite.heading}</span>
                  <span className="citation-score">{cite.score.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {!!downloadLabel && onDownload && (
          <div className="passage-actions">
            <button onClick={onDownload}><Download size={12} /> {downloadLabel}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}
