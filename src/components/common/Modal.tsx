import React, { type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-layer" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(event) => event.stopPropagation()}
        style={wide ? { width: "min(1100px, 94vw)" } : undefined}
      >
        <div className="modal-card-head">
          <div>
            <span className="view-kicker">NEXUS</span>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-plain" onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
