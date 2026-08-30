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
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  const loadDaemons = async () => {
    try {
      const list = await window.forgepilot.listDaemons();
      setDaemons(list);
      if (list.length && (!selectedId || !list.some((d) => d.id === selectedId))) {
        setSelectedId(list[0].id);
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
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
    await window.forgepilot.stopDaemon(id);
    await loadDaemons();
  };

  const handleRestart = async (id: string) => {
    await window.forgepilot.restartDaemon(id);
    await loadDaemons();
    await loadLogs(id);
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
                      <button className="xterm-btn danger" onClick={() => handleStop(selectedDaemon.id)} title="Stop process">
                        <Square size={12} fill="currentColor" />
                        <span>Stop</span>
                      </button>
                    ) : (
                      <button className="xterm-btn success" onClick={() => handleRestart(selectedDaemon.id)} title="Start process">
                        <Play size={12} fill="currentColor" />
                        <span>Start</span>
                      </button>
                    )}
                    <button className="xterm-btn" onClick={() => handleRestart(selectedDaemon.id)} title="Restart process">
                      <RefreshCw size={12} />
                      <span>Restart</span>
                    </button>
                  </div>
                </div>

                {/* Console Logs */}
                <div className="daemon-logs-console">
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
