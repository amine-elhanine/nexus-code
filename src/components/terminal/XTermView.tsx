import React, { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Terminal, RefreshCw, Trash2, Play, GitBranch, CheckCircle2 } from "lucide-react";

interface XTermViewProps {
  projectRoot?: string;
}

export const XTermView: React.FC<XTermViewProps> = ({ projectRoot }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: "#080811",
        foreground: "#d1d5db",
        cursor: "#a78bfa",
        cursorAccent: "#080811",
        selectionBackground: "#3e3870",
        black: "#1e1e2e",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e2e8f0",
        brightBlack: "#4b5563",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#eab308",
        brightBlue: "#3b82f6",
        brightMagenta: "#a855f7",
        brightCyan: "#06b6d4",
        brightWhite: "#f8fafc",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Start shell session
    void window.forgepilot.createTerminal("main", projectRoot);

    // Listen for incoming data from the backend shell
    const cleanupListener = window.forgepilot.onTerminalData(({ id, data }) => {
      if (id === "main") {
        term.write(data);
      }
    });

    // Forward keystrokes to the backend shell
    const onDataDisposable = term.onData((data) => {
      void window.forgepilot.writeTerminal("main", data);
    });

    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      onDataDisposable.dispose();
      cleanupListener();
      term.dispose();
    };
  }, [projectRoot]);

  const sendQuickCommand = (cmd: string) => {
    void window.forgepilot.writeTerminal("main", `${cmd}\r\n`);
  };

  const restartShell = () => {
    termRef.current?.clear();
    void window.forgepilot.killTerminal("main");
    void window.forgepilot.createTerminal("main", projectRoot);
  };

  const clearTerminal = () => {
    termRef.current?.clear();
  };

  return (
    <div className="xterm-view-wrapper">
      <div className="xterm-toolbar">
        <div className="xterm-title">
          <Terminal size={14} className="text-purple-400" />
          <span>Interactive Terminal</span>
          <span className="xterm-badge">Live PTY</span>
        </div>

        <div className="xterm-actions">
          <button className="xterm-btn" onClick={() => sendQuickCommand("npm test")} title="Run tests">
            <Play size={12} />
            <span>npm test</span>
          </button>
          <button className="xterm-btn" onClick={() => sendQuickCommand("npm run check")} title="Run typecheck">
            <CheckCircle2 size={12} />
            <span>typecheck</span>
          </button>
          <button className="xterm-btn" onClick={() => sendQuickCommand("git status")} title="Git status">
            <GitBranch size={12} />
            <span>git status</span>
          </button>
          <div className="xterm-divider" />
          <button className="xterm-btn" onClick={clearTerminal} title="Clear screen">
            <Trash2 size={12} />
            <span>Clear</span>
          </button>
          <button className="xterm-btn" onClick={restartShell} title="Restart terminal process">
            <RefreshCw size={12} />
            <span>Restart</span>
          </button>
        </div>
      </div>

      <div className="xterm-container" ref={containerRef} />
    </div>
  );
};
