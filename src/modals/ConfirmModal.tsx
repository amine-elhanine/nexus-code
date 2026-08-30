import React from "react";
import { X, Trash2, Check } from "lucide-react";

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-layer confirm-layer" onClick={onCancel}>
      <div className="modal-card confirm-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-card-head" style={{ marginBottom: "10px" }}>
          <div>
            <span className="view-kicker" style={{ color: danger ? "var(--red)" : "var(--purple)" }}>
              {danger ? "CONFIRM ACTION" : "CONFIRMATION"}
            </span>
            <h2 style={{ fontSize: "16px", margin: "6px 0 4px" }}>{title}</h2>
          </div>
          <button className="icon-plain" onClick={onCancel}><X size={15} /></button>
        </div>
        <p style={{ color: "#a6b2c2", fontSize: "11px", lineHeight: "1.5", margin: "0 0 18px" }}>
          {message}
        </p>
        <div className="modal-actions" style={{ marginTop: "0" }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button
            className={danger ? "primary danger-confirm-btn" : "primary"}
            onClick={onConfirm}
          >
            {danger ? <Trash2 size={13} /> : <Check size={13} />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
