import React, { useMemo, useState } from "react";
import { Check, HelpCircle, RotateCcw, X } from "lucide-react";
import { Modal } from "../common/Modal.js";
import type { NotebookQuiz } from "../../types.js";

/** Interactive quiz runner: pick one answer per question, Finish grades it. */
export function QuizPlayerModal({ quiz, onClose }: { quiz: NotebookQuiz; onClose: () => void }) {
  const [answers, setAnswers] = useState<Record<string, number | boolean>>({});
  const [finished, setFinished] = useState(false);

  const total = quiz.questions.length;
  const answered = quiz.questions.filter((q) => answers[q.id] !== undefined).length;

  const results = useMemo(() => {
    if (!finished) return null;
    let correct = 0;
    const per = quiz.questions.map((q) => {
      const picked = answers[q.id];
      const ok = q.type === "mcq" ? picked === q.correctIndex : picked === q.correctBoolean;
      if (ok) correct++;
      return { id: q.id, ok };
    });
    return { correct, per: new Map(per.map((p) => [p.id, p.ok])) };
  }, [finished, answers, quiz.questions]);

  function pick(questionId: string, value: number | boolean) {
    if (finished) return;
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }

  function reset() {
    setAnswers({});
    setFinished(false);
  }

  const typeLabel = quiz.quizType === "mcq" ? "MCQ" : quiz.quizType === "truefalse" ? "True / False" : "Mixed";

  return (
    <Modal title={quiz.title} subtitle={`${typeLabel} · ${total} questions · topic: ${quiz.topic}`} onClose={onClose}>
      <div className="passage-body">
        {finished && results && (
          <div className="settings-note" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Check size={13} />
            <span>
              Score: {results.correct}/{total}
              {results.correct === total ? " — perfect!" : results.correct === 0 ? " — review the sources and retry." : " — see which answers need review below."}
            </span>
          </div>
        )}
        {quiz.questions.map((q, index) => {
          const picked = answers[q.id];
          const graded = finished ? results?.per.get(q.id) : undefined;
          return (
            <div key={q.id} className="passage-main" style={{ borderLeft: finished ? `3px solid ${graded ? "#3fb950" : "#f85149"}` : undefined, paddingLeft: 10 }}>
              <span className="passage-label">
                Q{index + 1} · {q.type === "mcq" ? "MCQ" : "TRUE / FALSE"}
              </span>
              <div style={{ fontWeight: 600, margin: "4px 0 8px" }}>{q.question}</div>
              {q.type === "mcq" ? (
                <div style={{ display: "grid", gap: 6 }}>
                  {(q.options || []).map((opt, oi) => {
                    const selected = picked === oi;
                    const isCorrect = finished && oi === q.correctIndex;
                    return (
                      <button
                        key={oi}
                        onClick={() => pick(q.id, oi)}
                        disabled={finished}
                        aria-pressed={selected}
                        className="home-suggestion"
                        style={{
                          justifyContent: "flex-start",
                          textAlign: "left",
                          borderColor: isCorrect ? "#3fb950" : selected && finished ? "#f85149" : selected ? "var(--nexus-green)" : undefined,
                          background: !finished && selected ? "var(--accent-soft)" : undefined,
                          opacity: finished && !selected && !isCorrect ? 0.75 : 1,
                        }}
                      >
                        <span style={{ fontWeight: 700 }}>{String.fromCharCode(65 + oi)}.</span>
                        <span>{opt}</span>
                        {isCorrect && <Check size={12} />}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  {[true, false].map((v) => {
                    const selected = picked === v;
                    const isCorrect = finished && v === q.correctBoolean;
                    return (
                      <button
                        key={String(v)}
                        onClick={() => pick(q.id, v)}
                        disabled={finished}
                        aria-pressed={selected}
                        className="home-suggestion"
                        style={{
                          borderColor: isCorrect ? "#3fb950" : selected && finished ? "#f85149" : selected ? "var(--nexus-green)" : undefined,
                          background: !finished && selected ? "var(--accent-soft)" : undefined,
                        }}
                      >
                        {v ? "True" : "False"}
                        {isCorrect && <Check size={12} />}
                      </button>
                    );
                  })}
                </div>
              )}
              {finished && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: graded ? "#3fb950" : "#f85149" }}>
                    {graded ? "Correct" : `Wrong — correct answer: ${q.type === "mcq" ? `${String.fromCharCode(65 + (q.correctIndex || 0))}. ${(q.options || [])[q.correctIndex || 0]}` : q.correctBoolean ? "True" : "False"}`}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>{q.explanation}</div>
                  {!!q.citations.length && (
                    <small style={{ opacity: 0.8 }}>
                      Sources: {q.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}
                    </small>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="passage-actions" style={{ display: "flex", gap: 8 }}>
          {!finished ? (
            <button onClick={() => setFinished(true)} disabled={answered < total} title={answered < total ? `Answer all questions (${answered}/${total})` : "Grade the quiz"}>
              <HelpCircle size={12} /> Finish ({answered}/{total})
            </button>
          ) : (
            <button onClick={reset} title="Try the quiz again">
              <RotateCcw size={12} /> Retry
            </button>
          )}
          <button onClick={onClose} title="Close the quiz">
            <X size={12} /> Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
