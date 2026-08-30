import React, { useState, useEffect, type ReactNode } from "react";
import { Save, Sparkles, Brain, Check } from "lucide-react";
import type { ProjectRecord, SessionRecord } from "../types.js";

export function MemoryView({
  project,
  session,
  onSave,
}: {
  project: ProjectRecord | null;
  session: SessionRecord | null;
  onSave: (projectMemory: string, sessionMemory: string) => void;
}) {
  const [projectMemory, setProjectMemory] = useState(project?.memory || "");
  const [sessionMemory, setSessionMemory] = useState(session?.memory || "");

  useEffect(() => {
    setProjectMemory(project?.memory || "");
    setSessionMemory(session?.memory || "");
  }, [project?.id, session?.id, project?.memory, session?.memory]);

  return (
    <div className="memory-view artifact-view">
      <div className="artifact-head">
        <div>
          <span className="view-kicker">PERSISTENT CONTEXT</span>
          <h2>Memory</h2>
          <p>Project memory is shared by every session. Session memory stays local to this task.</p>
        </div>
        <button className="primary" onClick={() => onSave(projectMemory, sessionMemory)}>
          <Save size={13} /> Save memory
        </button>
      </div>
      <div className="memory-grid">
        <MemoryEditor
          label="Project memory"
          description="Shared conventions, architecture decisions and long-term project facts."
          value={projectMemory}
          onChange={setProjectMemory}
        />
        <MemoryEditor
          label="Session memory"
          description="Decisions, discoveries and progress for this coding session."
          value={sessionMemory}
          onChange={setSessionMemory}
        />
      </div>
      <div className="memory-note">
        <Sparkles size={14} />
        <span>
          The agent appends useful task outcomes to both memory levels after a run. You can edit them at any time.
        </span>
      </div>
    </div>
  );
}

export function MemoryEditor({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="memory-card">
      <div className="memory-card-head">
        <div>
          <strong>{label}</strong>
          <p>{description}</p>
        </div>
        <Brain size={15} />
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="No memory written yet…"
      />
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
