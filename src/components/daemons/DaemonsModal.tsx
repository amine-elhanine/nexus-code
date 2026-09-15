import React, { useState, useEffect, useRef } from "react";
import {
  Server, Play, Square, RefreshCw, ExternalLink, X, Plus, Terminal, Activity, AlertCircle, Trash2
} from "lucide-react";

export interface DaemonInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: "running" | "stopped" | "crashed";
  pid?: number;
  port?: number;
  startTime: string;
  logsCount: number;
}

interface DaemonsModalProps {
  onClose: () => void;
  projectRoot?: string;
}

export const DaemonsModal: React.FC<DaemonsModalProps> = ({ onClose, projectRoot }) => {
  const [daemons, setDaemons] = useState<DaemonInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  // Service an action (stop/restart/delete) is currently running on — buttons
  // stay disabled until the backend confirms, so double-clicks can't race it.
  const [actingId, setActingId] = useState<string | null>(null);
  // Last action failure (e.g. the OS refused to kill the process).
  const [actionError, setActionError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const logsConsoleRef = useRef<HTMLDivElement | null>(null);
  // Mirror of the selection for the polling loop below: the interval is
  // registered once, so reading `selectedId` state directly would always see
  // the initial value ("") and reset the selection to the top item on every
  // refresh. The ref always holds the current selection instead.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // Auto-scroll sticks to the bottom only while the user is already near the
  // bottom — reading older output no longer gets yanked away by new lines.
  const stickToBottomRef = useRef(true);

  const loadDaemons = async () => {
    try {
      const list = await window.forgepilot.listDaemons();
      setDaemons(list);
      const current = selectedIdRef.current;
      if (list.length && (!current || !list.some((d) => d.id === current))) {
        setSelectedId(list[0].id);
      } else if (!list.length && current) {
        setSelectedId("");
      }
    } catch {
      setDaemons([]);
    }
  };

  const loadLogs = async (id: string) => {
    if (!id) return;
    try {
      const logLines = await window.forgepilot.getDaemonLogs(id);
      setLogs(logLines);
    } catch {
      setLogs([]);
    }
  };

  useEffect(() => {
    void loadDaemons();
    const interval = setInterval(() => {
      void loadDaemons();
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (selectedId) {
      stickToBottomRef.current = true;
      void loadLogs(selectedId);
      const unsub = window.forgepilot.onDaemonLog?.(({ id, data }) => {
        if (id === selectedId) {
          setLogs((prev) => [...prev, ...data.split("\n").filter(Boolean)].slice(-1000));
        }
      });
      return () => unsub?.();
    }
  }, [selectedId]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      logsEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [logs]);

  const handleStartNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newCommand.trim()) return;
    try {
      const created = await window.forgepilot.startDaemon(
        newName.trim(),
        newCommand.trim(),
        projectRoot || ""
      );
      setNewName("");
      setNewCommand("");
      setShowAddForm(false);
      await loadDaemons();
      setSelectedId(created.id);
    } catch (err) {
      console.error(err);
    }
  };

  const handleStop = async (id: string) => {
    setActingId(id);
    setActionError(null);
    try {
      const ok = await window.forgepilot.stopDaemon(id);
      await loadDaemons();
      await loadLogs(id);
      if (!ok) {
        const port = daemons.find((d) => d.id === id)?.port;
        setActionError(
          `Could not stop "${daemons.find((d) => d.id === id)?.name || "service"}" — the process is still alive${port ? ` (port ${port} still in use)` : ""}. Try again, or kill it manually.`
        );
      }
    } finally {
      setActingId(null);
    }
  };

  const handleRestart = async (id: string) => {
    setActingId(id);
    setActionError(null);
    try {
      const ok = await window.forgepilot.restartDaemon(id);
      await loadDaemons();
      await loadLogs(id);
      if (!ok) setActionError("Restart failed — the old process could not be stopped.");
    } finally {
      setActingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    if (typeof window.forgepilot.removeDaemon !== "function") return;
    setActingId(id);
    try {
      await window.forgepilot.removeDaemon(id);
      setLogs([]);
      try {
        const list = await window.forgepilot.listDaemons();
        setDaemons(list);
        // Keep the selection on a neighbour instead of jumping to the top.
        setSelectedId((prev) => {
          if (prev !== id) return prev;
          return list.length ? list[list.length - 1].id : "";
        });
      } catch {
        setDaemons([]);
        setSelectedId("");
      }
    } finally {
      setActingId(null);
    }
  };

  const selectedDaemon = daemons.find((d) => d.id === selectedId);
  const runningCount = daemons.filter((d) => d.status === "running").length;

  return (
    <div className="modal-layer" onClick={onClose}>
      <div
        className="modal-card daemons-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-card-head daemons-modal-head">
          <div>
            <div className="daemons-title-row">
              <Server size={18} className="text-purple-400" />
              <h2 style={{ margin: 0, fontSize: "17px" }}>Background Services & Dev Servers</h2>
              <span className={`daemons-count-badge ${runningCount > 0 ? "running" : ""}`}>
                {runningCount} active
              </span>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#8a96a8" }}>
              Manage long-running processes, local dev servers, file watchers, and monitor live streaming logs.
            </p>
          </div>
          <div className="daemons-head-actions">
            <button
              className={`primary-sm ${showAddForm ? "active" : ""}`}
              onClick={() => setShowAddForm((s) => !s)}
              title="Add and launch a new background service"
            >
              <Plus size={13} />
              <span>{showAddForm ? "Cancel" : "New Service"}</span>
            </button>
            <button className="icon-plain" onClick={onClose} title="Close window">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Add Service Form */}
        {showAddForm && (
          <form className="daemon-add-form" onSubmit={handleStartNew}>
            <div className="form-row">
              <div className="form-field" style={{ flex: 1 }}>
                <label>Service Name</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Vite Dev Server, API Server, Python Worker"
                  required
                  autoFocus
                />
              </div>
              <div className="form-field" style={{ flex: 2 }}>
                <label>Command Line</label>
                <input
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  placeholder="e.g. npm run dev, python app.py, docker compose up"
                  required
                />
              </div>
              <button type="submit" className="primary" style={{ height: "34px", padding: "0 14px", alignSelf: "flex-end" }}>
                <Play size={13} fill="currentColor" />
                <span>Launch</span>
              </button>
            </div>
          </form>
        )}

        {/* Main Body */}
        <div className="daemons-modal-body">
          {/* Left Sidebar */}
          <div className="daemons-sidebar">
            <div className="daemons-sidebar-header">
              <span>CONFIGURED SERVICES ({daemons.length})</span>
            </div>
            <div className="daemons-list">
              {daemons.map((d) => (
                <div
                  key={d.id}
                  className={`daemon-item ${selectedId === d.id ? "active" : ""}`}
                  onClick={() => setSelectedId(d.id)}
                >
                  <div className="daemon-item-top">
                    <span className={`status-dot ${d.status}`} />
                    <strong className="daemon-name">{d.name}</strong>
                    {d.port && (
                      <span className="daemon-port-pill" title={`Listening on port ${d.port}`}>
                        :{d.port}
                      </span>
                    )}
                  </div>
                  <div className="daemon-item-meta">
                    <code>{d.command.length > 34 ? `${d.command.slice(0, 34)}…` : d.command}</code>
                    <span className="daemon-status-text">{d.status}</span>
                  </div>
                </div>
              ))}

              {!daemons.length && (
                <div className="daemons-empty-sidebar">
                  <Server size={24} style={{ color: "#4f5a6b", margin: "0 auto 8px", display: "block" }} />
                  <span>No services running</span>
                  <small>Click <b>+ New Service</b> above to start a server</small>
                </div>
              )}
            </div>
          </div>

          {/* Right Pane */}
          <div className="daemons-main-pane">
            {selectedDaemon ? (
              <div className="daemon-details">
                {/* Details Top Bar */}
                <div className="daemon-details-header">
                  <div className="daemon-details-title">
                    <div className="daemon-title-top">
                      <span className={`status-dot ${selectedDaemon.status}`} />
                      <h4>{selectedDaemon.name}</h4>
                      {selectedDaemon.pid && <span className="daemon-pid-tag">PID {selectedDaemon.pid}</span>}
                    </div>
                    <code className="daemon-full-cmd">{selectedDaemon.command}</code>
                  </div>
                  <div className="daemon-details-actions">
                    {selectedDaemon.port && (
                      <a
                        href={`http://localhost:${selectedDaemon.port}`}
                        target="_blank"
                        rel="noreferrer"
                        className="xterm-btn daemon-port-link"
                        title="Open in browser"
                      >
                        <ExternalLink size={12} />
                        <span>localhost:{selectedDaemon.port}</span>
                      </a>
                    )}
                    {selectedDaemon.status === "running" ? (
                      <button
                        className="xterm-btn danger"
                        onClick={() => void handleStop(selectedDaemon.id)}
                        disabled={actingId === selectedDaemon.id}
                        title="Stop process"
                      >
                        <Square size={12} fill="currentColor" />
                        <span>{actingId === selectedDaemon.id ? "Stopping…" : "Stop"}</span>
                      </button>
                    ) : (
                      <button
                        className="xterm-btn success"
                        onClick={() => void handleRestart(selectedDaemon.id)}
                        disabled={actingId === selectedDaemon.id}
                        title="Start process"
                      >
                        <Play size={12} fill="currentColor" />
                        <span>{actingId === selectedDaemon.id ? "Starting…" : "Start"}</span>
                      </button>
                    )}
                    <button
                      className="xterm-btn"
                      onClick={() => void handleRestart(selectedDaemon.id)}
                      disabled={actingId === selectedDaemon.id}
                      title="Restart process"
                    >
                      <RefreshCw size={12} />
                      <span>Restart</span>
                    </button>
                    {selectedDaemon.status !== "running" && (
                      <button
                        className="xterm-btn danger"
                        onClick={() => void handleRemove(selectedDaemon.id)}
                        disabled={actingId === selectedDaemon.id}
                        title="Delete this stopped service from the list"
                      >
                        <Trash2 size={12} />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {actionError && (
                  <div className="daemon-action-error" role="alert">
                    <AlertCircle size={13} />
                    <span>{actionError}</span>
                    <button className="pane-action" onClick={() => setActionError(null)} title="Dismiss">
                      <X size={12} />
                    </button>
                  </div>
                )}

                {/* Console Logs */}
                <div
                  className="daemon-logs-console"
                  ref={logsConsoleRef}
                  onScroll={() => {
                    const el = logsConsoleRef.current;
                    if (!el) return;
                    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                  }}
                >
                  {logs.map((line, idx) => (
                    <div key={idx} className="daemon-log-line">
                      {line}
                    </div>
                  ))}
                  {!logs.length && (
                    <div className="empty-logs">Process started. Waiting for stdout/stderr output...</div>
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>
            ) : (
              <div className="daemons-no-selection">
                <Terminal size={36} style={{ color: "#3d4b5c", marginBottom: "12px" }} />
                <h3>No background service selected</h3>
                <p>Select a service from the left or launch a new dev server with the button above.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
