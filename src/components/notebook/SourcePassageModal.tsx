import React from "react";
import { BookOpen, FileText, HelpCircle, Languages, Save, Split } from "lucide-react";
import { Modal } from "../common/Modal.js";
import type { NotebookPassage } from "../../types.js";

export type PassageAction = "explain" | "simplify" | "compare" | "quiz" | "save";

export function SourcePassageModal({ passage, onClose, onAction }: { passage: NotebookPassage; onClose: () => void; onAction: (action: PassageAction) => void }) {
  return (
    <Modal
      title={passage.sourceName}
      subtitle={passage.headingPath.length ? passage.headingPath.join(" › ") : "Source passage"}
      onClose={onClose}
    >
      <div className="passage-body">
        {passage.sectionSummary && (
          <div className="passage-summary">
            <span className="passage-label">SECTION SUMMARY</span>
            <p>{passage.sectionSummary}</p>
          </div>
        )}
        {passage.prevText && (
          <details className="passage-neighbor">
            <summary>Previous passage</summary>
            <p>{passage.prevText}</p>
          </details>
        )}
        <div className="passage-main">
          <span className="passage-label">CITED PASSAGE</span>
          <p>{passage.text}</p>
        </div>
        {passage.nextText && (
          <details className="passage-neighbor">
            <summary>Next passage</summary>
            <p>{passage.nextText}</p>
          </details>
        )}
        <div className="settings-note">
          <FileText size={12} />
          <span>Neighbors come from the document's prev/next chunk links — surrounding context, not quoted claims.</span>
        </div>
        <div className="passage-actions">
          <button onClick={() => onAction("explain")}><BookOpen size={12} /> Explain</button>
          <button onClick={() => onAction("simplify")}><Languages size={12} /> Simplify</button>
          <button onClick={() => onAction("compare")}><Split size={12} /> Compare</button>
          <button onClick={() => onAction("quiz")}><HelpCircle size={12} /> Quiz me</button>
          <button onClick={() => onAction("save")}><Save size={12} /> Save note</button>
        </div>
      </div>
    </Modal>
  );
}
