import React, { useEffect, useState } from "react";
import { Minus, Minimize2, Square, X } from "lucide-react";

export function WindowControls() {
  const [isMax, setIsMax] = useState(false);

  // Sync the initial state (app may be restored already maximized).
  useEffect(() => {
    let cancelled = false;
    window.nexus
      ?.isWindowMaximized?.()
      .then((v) => {
        if (!cancelled) setIsMax(Boolean(v));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleMax = async () => {
    try {
      const api = window.nexus;
      const next = await api?.maximizeWindow?.();
      setIsMax(Boolean(next));
    } catch { /* ignore */ }
  };

  const api = window.nexus;

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
