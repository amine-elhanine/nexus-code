import React, { useState } from "react";
import { Minus, Minimize2, Square, X } from "lucide-react";

export function WindowControls() {
  const [isMax, setIsMax] = useState(false);

  const handleToggleMax = async () => {
    try {
      const api = window.nexus || window.forgepilot;
      const next = await api?.maximizeWindow?.();
      setIsMax(Boolean(next));
    } catch { /* ignore */ }
  };

  const api = window.nexus || window.forgepilot;

  return (
    <div className="window-controls">
      <button
        className="win-btn win-min"
        onClick={() => void api?.minimizeWindow?.()}
        title="Minimize"
      >
        <Minus size={13} />
      </button>
      <button
        className="win-btn win-max"
        onClick={() => void handleToggleMax()}
        title={isMax ? "Restore" : "Maximize"}
      >
        {isMax ? <Minimize2 size={11} /> : <Square size={10} />}
      </button>
      <button
        className="win-btn win-close"
        onClick={() => void api?.closeWindow?.()}
        title="Close"
      >
        <X size={13} />
      </button>
    </div>
  );
}
