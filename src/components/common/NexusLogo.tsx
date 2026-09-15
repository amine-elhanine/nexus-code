import React from "react";

export function NexusLogo({ size = 20 }: { size?: number }) {
  return (
    <div
      className="nexus-logo-wrapper"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--panel2)",
        borderRadius: Math.round(size * 0.24),
        border: "1px solid var(--line2)",
        boxShadow: "0 0 10px var(--nexus-glow)",
        flexShrink: 0,
      }}
    >
      <svg
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <polygon
          points="50,6 88,28 88,72 50,94 12,72 12,28"
          style={{ fill: "var(--nexus-green)" }}
        />
        <polygon
          points="50,28 73,41 73,69 50,82 27,69 27,41"
          style={{ fill: "var(--panel2)" }}
        />
      </svg>
    </div>
  );
}
