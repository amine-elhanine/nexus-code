import React from "react";
import { Sparkles, Eye } from "lucide-react";
import type { ArtifactItem } from "../../types.js";

export function ArtifactCard({
  artifact,
  onClick,
}: {
  artifact: ArtifactItem;
  onClick: () => void;
}) {
  return (
    <div className="chat-artifact-card" onClick={onClick}>
      <div className="chat-artifact-left">
        <Sparkles size={16} className="text-amber-400" />
        <div>
          <div className="chat-artifact-name">{artifact.name}</div>
          <small style={{ color: "#7b889b", fontSize: "10px" }}>{artifact.filename}</small>
        </div>
      </div>
      <div className="chat-artifact-right">
        <span className={`badge-status status-${artifact.status}`}>
          {artifact.status.replace("_", " ")}
        </span>
        <Eye size={14} style={{ color: "#a89df7" }} />
      </div>
    </div>
  );
}
