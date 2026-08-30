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
        background: "#18202a",
        borderRadius: Math.round(size * 0.24),
        border: "1px solid #27364b",
        boxShadow: "0 0 10px rgba(52, 211, 153, 0.35)",
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
          fill="#34d399"
        />
        <polygon
          points="50,28 73,41 73,69 50,82 27,69 27,41"
          fill="#18202a"
        />
      </svg>
    </div>
  );
}
