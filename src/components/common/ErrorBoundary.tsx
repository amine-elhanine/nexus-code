import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: React.ReactNode;
  /** Shown in the console report so crash reports identify the subtree. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Top-level render-crash guard. Without it, any uncaught exception during a
 * React render unmounts the whole tree and the user sees a blank window with
 * no way back. This renders a recovery card with the actual error message so
 * crashes are visible and reportable instead of fatal.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[nexus] render crash${this.props.label ? ` in ${this.props.label}` : ""}:`, error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="modal-layer">
        <div
          className="modal-card"
          style={{ maxWidth: 560, width: "92%", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#fbbf24" }}>
            <AlertTriangle size={18} />
            <strong style={{ color: "#f1f5f9", fontSize: 15 }}>Something went wrong rendering this view</strong>
          </div>
          <pre
            style={{
              margin: 0, maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
              fontSize: 12, color: "#e07a72", background: "#131922", border: "1px solid #1c2635", borderRadius: 8, padding: 10,
            }}
          >
            {this.state.error.message || String(this.state.error)}
          </pre>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="secondary"
              onClick={() => this.setState({ error: null })}
              title="Try rendering this view again"
            >
              <RotateCcw size={13} /> Try again
            </button>
            <button type="button" className="primary" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
