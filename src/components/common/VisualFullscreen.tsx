import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { WidgetBlock } from "../chat/WidgetBlock.js";
import { normalizeSvgForFullscreen } from "../../utils/visual-svg.js";

/**
 * Shared fullscreen viewer for chat visuals (charts, diagrams, widgets).
 * Any component opens it through the `nexus:visual-fullscreen` window event —
 * a single layer is mounted once at the app root.
 *
 * Zoom: wheel zoom anchored at the cursor, +/− buttons, double-click or the
 * reset button restores 1×; the frame pans by dragging while zoomed in.
 */
export type VisualFullscreenDetail =
  | { kind: "svg"; svg: string; title?: string }
  | { kind: "widget"; source: string; title?: string };

export const VISUAL_FULLSCREEN_EVENT = "nexus:visual-fullscreen";

export function openVisualFullscreen(detail: VisualFullscreenDetail) {
  const normalized =
    detail.kind === "svg"
      ? { ...detail, svg: normalizeSvgForFullscreen(detail.svg) }
      : detail;
  window.dispatchEvent(new CustomEvent<VisualFullscreenDetail>(VISUAL_FULLSCREEN_EVENT, { detail: normalized }));
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function VisualFullscreenLayer() {
  const [detail, setDetail] = useState<VisualFullscreenDetail | null>(null);
  // Single state object so wheel zoom can update scale and pan atomically.
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const next = (event as CustomEvent<VisualFullscreenDetail>).detail;
      if (next && (next.kind === "svg" ? typeof next.svg === "string" && next.svg : typeof next.source === "string" && next.source)) {
        setDetail(next);
        setView({ scale: 1, x: 0, y: 0 });
      }
    };
    window.addEventListener(VISUAL_FULLSCREEN_EVENT, onOpen);
    return () => window.removeEventListener(VISUAL_FULLSCREEN_EVENT, onOpen);
  }, []);

  const close = useCallback(() => setDetail(null), []);
  const resetView = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);
  const zoomBy = useCallback((factor: number) => {
    setView((current) => ({ ...current, scale: clampScale(current.scale * factor) }));
  }, []);

  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "+" || event.key === "=") zoomBy(1.25);
      else if (event.key === "-") zoomBy(1 / 1.25);
      else if (event.key === "0") resetView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, close, resetView, zoomBy]);

  // Wheel zoom anchored at the cursor: the point under the pointer stays put.
  useEffect(() => {
    if (!detail) return;
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      const px = event.clientX - (rect.left + rect.width / 2);
      const py = event.clientY - (rect.top + rect.height / 2);
      setView((current) => {
        const next = clampScale(current.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
        const ratio = next / current.scale;
        return { scale: next, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [detail]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({ ...current, x: drag.originX + (event.clientX - drag.startX), y: drag.originY + (event.clientY - drag.startY) }));
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (dragStateRef.current?.pointerId === event.pointerId) dragStateRef.current = null;
  };

  if (!detail) return null;
  const title = detail.title || (detail.kind === "widget" ? "Interactive tool" : "Visual");

  return (
    <div className="visual-fullscreen-layer" onClick={close} role="dialog" aria-modal="true" aria-label={`${title} — fullscreen view`}>
      <div className="visual-fullscreen-shell" onClick={(event) => event.stopPropagation()}>
        <div className="visual-fullscreen-toolbar" onClick={(event) => event.stopPropagation()}>
          <span className="visual-fullscreen-title" title={title}>{title}</span>
          <div className="visual-fullscreen-zoom-controls">
            <button type="button" className="rich-chart-btn" onClick={() => zoomBy(1 / 1.25)} title="Zoom out (−)">
              <ZoomOut size={12} />
            </button>
            <span className="visual-fullscreen-zoom-label">{Math.round(view.scale * 100)}%</span>
            <button type="button" className="rich-chart-btn" onClick={() => zoomBy(1.25)} title="Zoom in (+)">
              <ZoomIn size={12} />
            </button>
            <button type="button" className="rich-chart-btn" onClick={resetView} title="Reset view (0 / double-click)">
              <RotateCcw size={12} />
            </button>
            <button type="button" className="rich-chart-btn" onClick={close} title="Close (Esc)">
              <X size={12} />
            </button>
          </div>
        </div>
        <div
          ref={frameRef}
          className="visual-fullscreen-frame"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, cursor: view.scale > 1 ? "grab" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={resetView}
        >
          {detail.kind === "svg" ? (
            <div className="visual-fullscreen-svg" dangerouslySetInnerHTML={{ __html: detail.svg }} />
          ) : (
            <div className="visual-fullscreen-widget" onClick={(event) => event.stopPropagation()}>
              <WidgetBlock source={detail.source} />
            </div>
          )}
        </div>
        <div className="visual-fullscreen-hint">Scroll to zoom · drag to pan · double-click or 0 to reset · Esc to close</div>
      </div>
    </div>
  );
}
