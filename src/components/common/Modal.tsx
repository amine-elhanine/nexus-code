import React, { type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide,
  className,
  style,
  extraHeadActions,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  style?: React.CSSProperties;
  extraHeadActions?: ReactNode;
}) {
  return (
    <div className="modal-layer" onClick={onClose}>
      <div
        className={`modal-card${className ? ` ${className}` : ""}`}
        onClick={(event) => event.stopPropagation()}
        style={{ ...(wide ? { width: "min(1100px, 94vw)" } : {}), ...style }}
      >
        <div className="modal-card-head">
          <div>
            <span className="view-kicker">NEXUS</span>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {extraHeadActions}
            <button className="icon-plain" onClick={onClose} title="Close"><X size={16} /></button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
