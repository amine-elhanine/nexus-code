import React, { useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Shuffle, X } from "lucide-react";
import { Modal } from "../common/Modal.js";
import type { NotebookFlashcardSet } from "../../types.js";
import { CitationSources } from "./CitationSources.js";

/** Interactive flashcard runner: flip front/back, step through, shuffle. */
export function FlashcardPlayerModal({ set, onClose }: { set: NotebookFlashcardSet; onClose: () => void }) {
  const [order, setOrder] = useState<number[]>(() => set.cards.map((_, i) => i));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const total = order.length;
  const cardIndex = total ? order[Math.min(index, total - 1)] : 0;
  const card = set.cards[cardIndex];

  function go(next: number) {
    if (!total) return;
    setIndex((next + total) % total);
    setFlipped(false);
  }

  function shuffle() {
    const next = [...order];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    setOrder(next);
    setIndex(0);
    setFlipped(false);
  }

  function reset() {
    setOrder(set.cards.map((_, i) => i));
    setIndex(0);
    setFlipped(false);
  }

  return (
    <Modal title={set.title} subtitle={`Flashcards · ${total} cards · topic: ${set.topic}`} onClose={onClose}>
      <div className="passage-body">
        {!card ? (
          <div className="empty-pane">This set has no cards.</div>
        ) : (
          <>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Card {Math.min(index + 1, total)} of {total}
            </div>
            <button
              onClick={() => setFlipped((v) => !v)}
              title={flipped ? "Show the prompt" : "Reveal the answer"}
              style={{
                width: "100%",
                textAlign: "left",
                marginTop: 8,
                padding: 16,
                borderRadius: 8,
                border: "1px solid var(--line2)",
                background: flipped ? "var(--accent-soft)" : "var(--panel2)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <span className="passage-label">{flipped ? "BACK · ANSWER" : "FRONT · PROMPT"}</span>
              <div style={{ fontWeight: 600, fontSize: 15, marginTop: 6, whiteSpace: "pre-wrap" }}>
                {flipped ? card.back : card.front}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
                {flipped ? "Click to show the prompt" : "Click to reveal the answer"}
              </div>
            </button>
            {flipped && !!card.citations.length && (
              <small style={{ opacity: 0.8, display: "block", marginTop: 6 }}>
                <CitationSources citations={card.citations} />
              </small>
            )}
            {!flipped && !!card.citations.length && (
              <small style={{ opacity: 0.6, display: "block", marginTop: 6 }}>
                {card.citations.length} cited passage{card.citations.length === 1 ? "" : "s"} — flip to study, sources shown with the answer.
              </small>
            )}
          </>
        )}
        <div className="passage-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => go(index - 1)} disabled={!total} title="Previous card">
            <ArrowLeft size={12} /> Prev
          </button>
          <button onClick={() => setFlipped((v) => !v)} disabled={!total} title="Flip this card">
            <RefreshCw size={12} /> Flip
          </button>
          <button onClick={() => go(index + 1)} disabled={!total} title="Next card">
            Next <ArrowRight size={12} />
          </button>
          <button onClick={shuffle} disabled={!total} title="Shuffle the deck">
            <Shuffle size={12} /> Shuffle
          </button>
          <button onClick={reset} disabled={!total} title="Back to the original order">
            <X size={12} /> Reset
          </button>
          <button onClick={onClose} title="Close the flashcards">
            <X size={12} /> Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
