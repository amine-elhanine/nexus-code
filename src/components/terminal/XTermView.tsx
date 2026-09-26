import React, { useEffect, useMemo, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Terminal, RefreshCw, Trash2, Play, GitBranch, CheckCircle2, Copy } from "lucide-react";
import { detectStack } from "../../utils/stack.js";

interface XTermViewProps {
  projectRoot?: string;
  /** Workspace file entries (`path` with `/` separators); root-level names drive stack detection. */
  files?: Array<{ path: string; kind: "file" | "folder" }>;
}

export const XTermView: React.FC<XTermViewProps> = ({ projectRoot, files = [] }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // One terminal instance per mounted view; the id is unique per project so
  // switching projects gets a fresh shell instead of reusing the old cwd.
  const terminalId = useMemo(() => `term-${projectRoot ? projectRoot.replace(/[^a-zA-Z0-9_-]/g, "_") : "default"}`, [projectRoot]);
  // Stack-aware quick commands: only offer the ecosystem's own test/check
  // commands (npm test for Node, pytest for Python, go test for Go, …).
  // Unknown stack → no test buttons at all, rather than wrong ones.
  const stack = useMemo(
    () => detectStack(files.filter((f) => f.kind === "file" && !f.path.includes("/")).map((f) => f.path)),
    [files]
  );

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
        brightCyan: "#06b0d4",
        brightWhite: "#f8fafc",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    // xterm reserves Ctrl+C for the shell even when text is selected. Make
    // the familiar desktop shortcut copy a selection, while preserving
    // interrupt semantics when there is no selection.
    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const api = window.nexus || window.forgepilot;

    // Start shell session with initial dimensions
    void api?.createTerminal?.(terminalId, projectRoot, term.cols, term.rows);

    // Listen for incoming data from the backend shell
    const cleanupListener = api?.onTerminalData?.(({ id, data }: { id: string; data: string }) => {
      if (id === terminalId) {
        term.write(data);
      }
    }) ?? (() => {});

    // Send user keystrokes to the shell process
    term.onData((data) => {
      void api?.writeTerminal?.(terminalId, data);
    });

    const fitAndResize = () => {
      try {
        fitAddon.fit();
        api?.resizeTerminal?.(terminalId, term.cols, term.rows);
      } catch { /* ignore */ }
    };
    window.addEventListener("resize", fitAndResize);
    // The terminal pane resizes when side panels toggle, not just when the
    // window does — observe the container too.
    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fitAndResize);
      cleanupListener();
      void api?.killTerminal?.(terminalId);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [projectRoot, terminalId]);

  const sendQuickCommand = (cmd: string) => {
    const api = window.nexus || window.forgepilot;
    void api?.writeTerminal?.(terminalId, `${cmd}\r\n`);
  };

  const restartShell = () => {
    const api = window.nexus || window.forgepilot;
    termRef.current?.clear();
    void api?.killTerminal?.(terminalId);
    void api?.createTerminal?.(terminalId, projectRoot, termRef.current?.cols, termRef.current?.rows);
  };

  const clearTerminal = () => {
    termRef.current?.clear();
  };

  const copySelection = async () => {
    const selection = termRef.current?.getSelection() || "";
    if (!selection) return;
    await navigator.clipboard?.writeText(selection);
    termRef.current?.clearSelection();
  };

  return (
    <div className="xterm-view-wrapper">
      <div className="xterm-toolbar">
        <div className="xterm-title">
          <Terminal size={14} className="text-purple-400" />
          <span>Interactive Terminal</span>
          <span className="xterm-badge">Interactive Shell</span>
        </div>

        <div className="xterm-actions">
          {stack && (
            <button className="xterm-btn" onClick={() => sendQuickCommand(stack.testCmd)} title={`Run tests (${stack.testCmd})`}>
              <Play size={12} />
              <span>{stack.testLabel}</span>
            </button>
          )}
          {stack && stack.checkCmd && (
            <button className="xterm-btn" onClick={() => { const cmd = stack.checkCmd; if (cmd) sendQuickCommand(cmd); }} title={`Run ${stack.checkLabel} (${stack.checkCmd})`}>
              <CheckCircle2 size={12} />
              <span>{stack.checkLabel}</span>
            </button>
          )}
          <button className="xterm-btn" onClick={() => sendQuickCommand("git status")} title="Git status">
            <GitBranch size={12} />
            <span>git status</span>
          </button>
          <div className="xterm-divider" />
          <button className="xterm-btn" onClick={clearTerminal} title="Clear screen">
            <Trash2 size={12} />
            <span>Clear</span>
          </button>
          <button className="xterm-btn" onClick={() => void copySelection()} title="Copy selected text">
            <Copy size={12} />
            <span>Copy</span>
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
