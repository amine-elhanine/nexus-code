import React, { useEffect, useState } from "react";
import { Minus, Minimize2, Square, X } from "lucide-react";

export function WindowControls() {
  const [isMax, setIsMax] = useState(false);

  // Sync the initial state (app may be restored already maximized) and listen for changes.
  useEffect(() => {
    let cancelled = false;
    window.nexus
      ?.isWindowMaximized?.()
      .then((v) => {
        if (!cancelled) setIsMax(Boolean(v));
      })
      .catch(() => {});

    const unsub = window.nexus?.onWindowMaximizeChange?.((v) => {
      if (!cancelled) setIsMax(Boolean(v));
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const handleToggleMax = async () => {
    try {
      const next = await window.nexus?.maximizeWindow?.();
      setIsMax(Boolean(next));
    } catch { /* ignore */ }
  };

  return (
    <div className="window-controls">
      <button
        type="button"
        className="win-btn win-min"
        onClick={(e) => {
          e.stopPropagation();
          void window.nexus?.minimizeWindow?.();
        }}
        title="Minimize"
        aria-label="Minimize"
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        className="win-btn win-max"
        onClick={(e) => {
          e.stopPropagation();
          void handleToggleMax();
        }}
        title={isMax ? "Restore" : "Maximize"}
        aria-label={isMax ? "Restore" : "Maximize"}
      >
        {isMax ? <Minimize2 size={11} /> : <Square size={10} />}
      </button>
      <button
        type="button"
        className="win-btn win-close"
        onClick={(e) => {
          e.stopPropagation();
          void window.nexus?.closeWindow?.();
        }}
        title="Close"
        aria-label="Close"
      >
        <X size={13} />
      </button>
    </div>
  );
}
