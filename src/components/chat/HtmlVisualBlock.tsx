import React, { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Eye, Maximize2, RotateCcw, Sparkles } from "lucide-react";
import {
  VISUAL_DEFAULT_HEIGHT,
  buildVisualSrcDoc,
  clampVisualHeight,
  extractVisualTitle,
} from "../../utils/html-visual.js";
import { openVisualFullscreen } from "../common/VisualFullscreen.js";

function readIsLightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("theme-light");
}

function makeVisualToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Sandboxed HTML/CSS/JS interactive visual block (` ```visual `,
 * ` ```html-visual `, ` ```interactive `). Renders inside an opaque-origin
 * `sandbox="allow-scripts"` iframe with strict CSP, auto-resizes to content,
 * and supports source inspection, reset, and fullscreen expansion.
 */
export function HtmlVisualBlock({
  source,
  fullscreen = false,
}: {
  source: string;
  fullscreen?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const token = useMemo(() => makeVisualToken(), []);
  const title = useMemo(() => extractVisualTitle(source), [source]);

  const [isLight, setIsLight] = useState<boolean>(readIsLightTheme);
  const [height, setHeight] = useState<number>(VISUAL_DEFAULT_HEIGHT);
  const [showSource, setShowSource] = useState<boolean>(false);
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      setIsLight(readIsLightTheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setRuntimeError(null);
  }, [source, reloadNonce]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; token?: string; height?: unknown; message?: unknown } | null;
      if (!data || data.token !== token) return;
      if (data.type === "nexus-visual-height") {
        setHeight(clampVisualHeight(data.height));
      } else if (data.type === "nexus-visual-error" && typeof data.message === "string") {
        setRuntimeError(data.message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token]);

  const srcDoc = useMemo(
    () => buildVisualSrcDoc(source, { token, isLight }),
    [source, token, isLight]
  );

  return (
    <div
      className={`html-visual-block${fullscreen ? " is-fullscreen" : ""}`}
      role="group"
      aria-label={title}
    >
      <div className="html-visual-head">
        <Sparkles size={13} aria-hidden="true" />
        <span className="html-visual-title" title={title}>{title}</span>
        {runtimeError ? (
          <span className="html-visual-error-pill" title={runtimeError}>
            JS error
          </span>
        ) : (
          <span className="html-visual-badge">INTERACTIVE VISUAL</span>
        )}
        <div className="html-visual-actions">
          <button
            type="button"
            className="html-visual-icon-btn"
            onClick={() => setShowSource((v) => !v)}
            title={showSource ? "Show visual preview" : "View HTML/CSS/JS source"}
            aria-label={showSource ? "Show visual preview" : "View source"}
          >
            {showSource ? <Eye size={12} /> : <Code2 size={12} />}
          </button>
          <button
            type="button"
            className="html-visual-icon-btn"
            onClick={() => setReloadNonce((n) => n + 1)}
            title="Reset visual"
            aria-label="Reset visual"
          >
            <RotateCcw size={12} />
          </button>
          {!fullscreen ? (
            <button
              type="button"
              className="html-visual-icon-btn"
              onClick={() => openVisualFullscreen({ kind: "html", source, title })}
              title="Open fullscreen"
              aria-label="Open fullscreen"
            >
              <Maximize2 size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {showSource ? (
        <pre className="html-visual-source">
          <code>{source}</code>
        </pre>
      ) : (
        <iframe
          ref={frameRef}
          key={`${reloadNonce}-${isLight ? "light" : "dark"}`}
          className="html-visual-frame"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title={title}
          style={fullscreen ? undefined : { height }}
        />
      )}
    </div>
  );
}
