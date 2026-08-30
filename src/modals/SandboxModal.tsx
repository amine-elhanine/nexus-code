import React from "react";
import { ShieldCheck, Save } from "lucide-react";
import { Modal } from "../components/common/Modal.js";
import type { SandboxConfig, SandboxStatus } from "../types.js";

export function SandboxModal({
  config,
  requireApproval,
  setRequireApproval,
  allowNetwork,
  setAllowNetwork,
  timeout,
  setTimeout,
  enabled,
  setEnabled,
  status,
  onSave,
  onClose,
}: {
  config: SandboxConfig | null;
  requireApproval: boolean;
  setRequireApproval: (value: boolean) => void;
  allowNetwork: boolean;
  setAllowNetwork: (value: boolean) => void;
  timeout: string;
  setTimeout: (value: string) => void;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  status: SandboxStatus;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Local workspace sandbox"
      subtitle="Keep the agent on this project with local permissions, approvals and command limits. No Docker or remote sandbox is required."
      onClose={onClose}
    >
      <div className="sandbox-status-card">
        <span className={`sandbox-status-dot ${status.status === "ready" ? "ready" : ""}`} />
        <div>
          <strong>{status.configured ? `Local permissions · ${status.status}` : "Local sandbox not configured"}</strong>
          <small>{status.sandbox?.path || "Bound to the selected project root."}</small>
        </div>
      </div>
      <label className="toggle-label">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Enable local workspace sandbox</span>
      </label>
      <label className="toggle-label">
        <input type="checkbox" checked={requireApproval} onChange={(event) => setRequireApproval(event.target.checked)} />
        <span>Require approval for sensitive actions</span>
      </label>
      <label className="toggle-label">
        <input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} />
        <span>Allow network-dependent package commands</span>
      </label>
      <label>
        Command timeout in seconds
        <input type="number" min="10" step="10" value={timeout} onChange={(event) => setTimeout(event.target.value)} />
      </label>
      <div className="sandbox-warning">
        <ShieldCheck size={14} />
        <span>
          File tools are scoped to the selected project root. Commands are validated argument by argument: shell chaining,
          substitution and redirection characters are rejected, only approved development tools run, python is limited to pytest,
          direct node scripts are executed with node's built-in permission model restricted to this folder, and spawned commands
          receive a minimal environment with no secrets or NODE_OPTIONS. This is a local permission sandbox, not a VM or kernel-level
          container — package scripts that npm runs on your behalf are not further restricted.
        </span>
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={onSave}><Save size={13} /> Save local sandbox</button>
      </div>
    </Modal>
  );
}
