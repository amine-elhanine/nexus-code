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
          className="modal-card error-boundary-card"
          style={{ maxWidth: 560, width: "92%", padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--warning)" }}>
            <AlertTriangle size={18} />
            <strong style={{ color: "var(--text-primary)", fontSize: 15 }}>Something went wrong rendering this view</strong>
          </div>
          <pre className="error-boundary-pre" style={{ margin: 0 }}>
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
