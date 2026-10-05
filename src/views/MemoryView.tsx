import { Brain, Check, FileText, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectRecord, SessionRecord } from "../types.js";
import { parseMemorySections, parseWorkLog } from "../utils/memory-format.js";

/**
 * Code-mode Memory panel — mirrors the Home memory panel's manage-style
 * design (structured fact rows with remove buttons, read-only logs) instead
 * of raw textareas. The old textarea layout also had a real bug in the
 * narrow sidebar: fixed-height textareas inside a flex panel with
 * min-height:0 got squeezed instead of scrolling, so the footer note
 * overlapped the textarea content.
 */

function FactList({ items, emptyText, onRemove }: { items: string[]; emptyText: string; onRemove: (fact: string) => void }) {
  if (!items.length) return <div className="empty-pane" style={{ padding: "6px" }}>{emptyText}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((fact) => (
        <div key={fact} className="home-file-row" title={fact}>
          <Brain size={13} style={{ flex: "none", color: "var(--nexus-green)" }} />
          <div className="home-file-info">
            <span className="home-file-name" style={{ whiteSpace: "normal" }}>{fact}</span>
          </div>
          <button className="pane-action" onClick={() => onRemove(fact)} title={`Forget "${fact}"`}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function MemoryView({
  project,
  session,
  onRemoveFact,
  onClearSessionMemory,
}: {
  project: ProjectRecord | null;
  session: SessionRecord | null;
  onRemoveFact: (fact: string) => void;
  onClearSessionMemory: () => void;
}) {
  const sections = parseMemorySections(project?.facts);
  const durableCount = sections.profile.length + sections.preferences.length + sections.facts.length + sections.context.length;
  const workLog = parseWorkLog(project?.memory);
  return (
    <div className="context-tab-body">
      <div className="context-section">
        <div className="context-section-title">
          <span>PROJECT FACTS ({durableCount})</span>
          <small>SHARED</small>
        </div>
        <p style={{ color: "#687588", fontSize: "11px", lineHeight: 1.5, margin: "0 0 8px" }}>
          Durable discoveries the agent saves for every future task in this project — working commands, conventions, gotchas. Manage them here, or say “remember…” in chat.
        </p>
        {sections.profile.length > 0 && (
          <>
            <strong style={{ fontSize: "11px" }}>User profile</strong>
            <div style={{ height: 4 }} />
            <FactList items={sections.profile} emptyText="" onRemove={onRemoveFact} />
            <div style={{ height: 8 }} />
          </>
        )}
        {sections.preferences.length > 0 && (
          <>
            <strong style={{ fontSize: "11px" }}>Preferences</strong>
            <div style={{ height: 4 }} />
            <FactList items={sections.preferences} emptyText="" onRemove={onRemoveFact} />
            <div style={{ height: 8 }} />
          </>
        )}
        <strong style={{ fontSize: "11px" }}>Remembered facts</strong>
        <div style={{ height: 4 }} />
        <FactList items={sections.facts} emptyText="No remembered facts yet." onRemove={onRemoveFact} />
        {sections.context.length > 0 && (
          <>
            <div style={{ height: 8 }} />
            <strong style={{ fontSize: "11px" }}>Project context</strong>
            <div style={{ height: 4 }} />
            <FactList items={sections.context} emptyText="" onRemove={onRemoveFact} />
          </>
        )}
      </div>
      <div className="context-section">
        <div className="context-section-title">
          <span>RECENT WORK</span>
          <small>{workLog.length} LAST</small>
        </div>
        {workLog.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {workLog.slice().reverse().map((entry, i) => (
              <div key={`${entry.date}-${i}`} className="home-file-row" title={entry.text}>
                <FileText size={13} style={{ flex: "none", color: entry.kind === "interrupted" ? "#e0a660" : undefined }} />
                <div className="home-file-info">
                  <span className="home-file-name" style={{ whiteSpace: "normal" }}>{entry.text}</span>
                  <small>{entry.date}{entry.kind === "interrupted" ? " · interrupted" : ""}</small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-pane">No completed runs yet. Each run appends a summary here.</div>
        )}
      </div>
      <div className="context-section">
        <div className="context-section-title">
          <span>THIS SESSION</span>
          <button className="pane-action" onClick={onClearSessionMemory} title="Clear this session's notes (transcript is kept)">
            Clear
          </button>
        </div>
        <p style={{ color: "#687588", fontSize: "11px", lineHeight: 1.5, margin: "0 0 8px" }}>
          Short pointers for this session — full answers stay in the transcript, which the agent reads directly.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, padding: "8px", border: "1px solid #28374a", borderRadius: "5px", background: "#090d14", color: "#a6b2c2", font: "10px/1.5 'DM Mono', monospace", maxHeight: 220, overflowY: "auto" }}>
          {session?.memory || "No session notes yet."}
        </pre>
      </div>
    </div>
  );
}

export function ContextRow({
  icon,
  label,
  detail,
  active,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  active: boolean;
}) {
  return (
    <div className="context-row">
      <span className={active ? "context-icon active" : "context-icon"}>{icon}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      <span className={active ? "context-check" : "context-dash"}>{active ? <Check size={12} /> : "—"}</span>
    </div>
  );
}

export function MemoryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="memory-row">
      <span>{label}</span>
      <small className={value === "Updated" ? "memory-updated" : ""}>{value}</small>
    </div>
  );
}
