import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, Maximize, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Modal } from "../common/Modal.js";
import type { NotebookMindmap, NotebookMindmapNode } from "../../types.js";

const PALETTE = ["#e879a0", "#39c5cf", "#7ee787", "#f0b429", "#a371f7", "#ff9e64", "#58a6ff", "#ff7b72"];
const V_GAP = 38;
const H_GAP = 240;
const TOP_PAD = 30;
const LEFT_PAD = 170;
const RIGHT_PAD = 220;

type PlacedNode = {
  node: NotebookMindmapNode | null;
  id: string;
  label: string;
  x: number;
  y: number;
  depth: number;
  color: string;
  hasChildren: boolean;
  isCollapsed: boolean;
  childCount: number;
};

function collectIds(nodes: NotebookMindmapNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.id);
    collectIds(n.children, out);
  }
  return out;
}

function truncate(label: string, max = 44): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Tidy-tree layout: leaves stack vertically, parents center on their
 * children. A virtual central node carries the map title so multiple roots
 * render as colored branches fanning right — the classic mind-map look.
 */
function layoutMap(roots: NotebookMindmapNode[], title: string, collapsed: Set<string>): { placed: PlacedNode[]; links: Array<{ from: PlacedNode; to: PlacedNode }>; width: number; height: number } {
  const placed: PlacedNode[] = [];
  const links: Array<{ from: PlacedNode; to: PlacedNode }> = [];
  let cursor = 0;

  const place = (
    node: NotebookMindmapNode | null,
    id: string,
    label: string,
    depth: number,
    color: string,
    parent: PlacedNode | null,
    children: NotebookMindmapNode[]
  ): PlacedNode => {
    const isCollapsed = node ? collapsed.has(node.id) : false;
    const visibleChildren = node && !isCollapsed ? children : [];
    const self: PlacedNode = {
      node, id, label,
      x: LEFT_PAD + depth * H_GAP,
      y: 0, depth, color,
      hasChildren: children.length > 0,
      isCollapsed,
      childCount: children.length,
    };
    if (parent) links.push({ from: parent, to: self });
    placed.push(self);
    if (!visibleChildren.length) {
      self.y = TOP_PAD + cursor * V_GAP;
      cursor++;
    } else {
      const kids = visibleChildren.map((child) =>
        place(child, child.id, child.label, depth + 1, color, self, child.children)
      );
      self.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    }
    return self;
  };

  const central: PlacedNode = {
    node: null, id: "__root__", label: title,
    x: LEFT_PAD, y: 0, depth: 0, color: "#58a6ff",
    hasChildren: false, isCollapsed: false, childCount: 0,
  };
  placed.push(central);
  const branches = roots.map((root, i) =>
    place(root, root.id, root.label, 1, PALETTE[i % PALETTE.length], central, root.children)
  );
  central.y = branches.length ? (branches[0].y + branches[branches.length - 1].y) / 2 : TOP_PAD;

  const height = Math.max(TOP_PAD * 2 + Math.max(0, cursor - 1) * V_GAP, 140);
  const maxDepth = placed.reduce((m, p) => Math.max(m, p.depth), 0);
  const width = LEFT_PAD + maxDepth * H_GAP + RIGHT_PAD;
  return { placed, links, width, height };
}

/** Board-style mind-map viewer: drag to pan, scroll to zoom, click to fold. */
export function MindmapViewerModal({ map, onClose }: { map: NotebookMindmap; onClose: () => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>("__root__");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 12, y: 12 });
  const [grabbing, setGrabbing] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ startX: 0, startY: 0, panX: 0, panY: 0, moved: false, down: false });
  const viewRef = useRef({ zoom: 1, pan: { x: 12, y: 12 } });
  viewRef.current = { zoom, pan };
  const layoutRef = useRef({ width: 0, height: 0 });

  const { placed, links, width, height } = useMemo(
    () => layoutMap(map.roots, map.title, collapsed),
    [map.roots, map.title, collapsed]
  );
  layoutRef.current = { width, height };
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const selected = byId.get(selectedId) || null;
  const selectedNode = selected?.node || null;

  // Parent lookup for the breadcrumb trail.
  const parentOf = useMemo(() => {
    const parents = new Map<string, NotebookMindmapNode | null>();
    const walk = (nodes: NotebookMindmapNode[], parent: NotebookMindmapNode | null) => {
      for (const n of nodes) {
        parents.set(n.id, parent);
        walk(n.children, n);
      }
    };
    walk(map.roots, null);
    return parents;
  }, [map.roots]);

  const breadcrumb = useMemo(() => {
    if (!selectedNode) return [] as string[];
    const trail: string[] = [];
    let current: NotebookMindmapNode | null | undefined = selectedNode;
    while (current) {
      trail.unshift(current.label);
      current = parentOf.get(current.id) ?? null;
    }
    return trail;
  }, [selectedNode, parentOf]);

  // Auto-fit the board when the map opens.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const { width: w, height: h } = layoutRef.current;
    if (!w || !h) return;
    const fit = Math.min(1, (el.clientWidth - 40) / w);
    const z = +Math.max(0.3, fit).toFixed(2);
    setZoom(z);
    setPan({ x: 12, y: Math.max(12, (el.clientHeight - h * z) / 2) });
  }, [map.id]);

  // Scroll-to-zoom around the cursor (native listener: React wheel is passive).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoom: z, pan: p } = viewRef.current;
      const nz = Math.min(2.2, Math.max(0.3, +(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)).toFixed(3)));
      if (nz === z) return;
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const k = nz / z;
      setPan({ x: sx - (sx - p.x) * k, y: sy - (sy - p.y) * k });
      setZoom(nz);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleNodeClick(p: PlacedNode) {
    if (drag.current.moved) return;
    setSelectedId(p.id);
    if (p.hasChildren && p.node) toggle(p.node.id);
  }

  function zoomCenter(factor: number) {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { zoom: z, pan: p } = viewRef.current;
    const nz = Math.min(2.2, Math.max(0.3, +(z * factor).toFixed(3)));
    if (nz === z) return;
    const k = nz / z;
    const sx = rect.width / 2;
    const sy = rect.height / 2;
    setPan({ x: sx - (sx - p.x) * k, y: sy - (sy - p.y) * k });
    setZoom(nz);
  }

  function fitView() {
    const el = boxRef.current;
    if (!el) return;
    const { width: w, height: h } = layoutRef.current;
    if (!w || !h) return;
    const f = Math.min((el.clientWidth - 40) / w, (el.clientHeight - 40) / h, 1.2);
    const z = +Math.max(0.3, f).toFixed(2);
    setZoom(z);
    setPan({ x: Math.max(12, (el.clientWidth - w * z) / 2), y: Math.max(12, (el.clientHeight - h * z) / 2) });
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 12, y: 12 });
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y, moved: false, down: true };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d.down) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > 5) {
      d.moved = true;
      setGrabbing(true);
    }
    if (d.moved) setPan({ x: d.panX + dx, y: d.panY + dy });
  }

  function endDrag() {
    drag.current.down = false;
    setGrabbing(false);
  }

  function curve(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  return (
    <Modal wide title={map.title} subtitle={`Mind map · ${map.nodeCount} nodes · topic: ${map.topic}`} onClose={onClose}>
      <div className="passage-body">
        <div className="passage-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <button onClick={() => setCollapsed(new Set())} title="Expand every branch">
            <ChevronsUpDown size={12} /> Expand all
          </button>
          <button onClick={() => setCollapsed(new Set(collectIds(map.roots)))} title="Collapse every branch">
            <ChevronsDownUp size={12} /> Collapse all
          </button>
          <button onClick={() => zoomCenter(1.2)} title="Zoom in">
            <ZoomIn size={12} />
          </button>
          <button onClick={() => zoomCenter(1 / 1.2)} title="Zoom out">
            <ZoomOut size={12} />
          </button>
          <button onClick={fitView} title="Fit the whole map in view">
            <Maximize size={12} /> Fit
          </button>
          <button onClick={resetView} title="Reset zoom and position">
            <RotateCcw size={12} /> Reset
          </button>
          <button onClick={onClose} title="Close the mind map">
            <X size={12} /> Close
          </button>
        </div>
        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 6 }}>
          Drag the board to move · scroll to zoom · click a node to fold/unfold it and see its summary.
        </div>

        <div
          ref={boxRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          style={{
            overflow: "hidden",
            height: "58vh",
            border: "1px solid var(--border, #30363d)",
            borderRadius: 8,
            background: "#0d1117",
            cursor: grabbing ? "grabbing" : "grab",
            touchAction: "none",
            userSelect: "none",
          }}
        >
          <svg width="100%" height="100%" style={{ display: "block", overflow: "visible" }}>
            <defs>
              <pattern id="mm-dots" width="26" height="26" patternUnits="userSpaceOnUse">
                <circle cx="1.5" cy="1.5" r="1.5" fill="#21262d" />
              </pattern>
            </defs>
            <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
              <rect x={-1600} y={-1600} width={width + 3200} height={height + 3200} fill="url(#mm-dots)" pointerEvents="none" />
              {links.map((link) => (
                <path
                  key={`${link.from.id}->${link.to.id}`}
                  d={curve(link.from.x, link.from.y, link.to.x, link.to.y)}
                  fill="none"
                  stroke={link.to.color}
                  strokeWidth={link.to.depth <= 1 ? 2.5 : 1.5}
                  opacity={0.85}
                />
              ))}
              {placed.map((p) => {
                const isSelected = p.id === selectedId;
                const r = p.depth === 0 ? 9 : 5.5;
                const isCentral = p.depth === 0;
                const displayLabel = p.isCollapsed ? `${truncate(p.label)} (+${p.childCount})` : truncate(p.label);
                return (
                  <g key={p.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: "pointer" }} onClick={() => handleNodeClick(p)}>
                    <title>{p.isCollapsed ? `${p.label} — click to expand (${p.childCount} hidden)` : `${p.label} — click to ${p.hasChildren ? "fold" : "inspect"}`}</title>
                    <circle
                      r={r + (isSelected ? 3.5 : 0)}
                      fill="none"
                      stroke={isSelected ? "#ffffff" : "transparent"}
                      strokeWidth={1.5}
                      opacity={0.9}
                    />
                    <circle r={r} fill="#0d1117" stroke={p.color} strokeWidth={2.5} />
                    <circle r={r - 2.5} fill={p.color} opacity={0.9} pointerEvents="none" />
                    <text
                      x={isCentral ? -(r + 10) : r + 9}
                      y={isCentral ? 5 : 4}
                      textAnchor={isCentral ? "end" : "start"}
                      fontSize={isCentral ? 15 : p.depth === 1 ? 13.5 : 12.5}
                      fontWeight={p.depth <= 1 ? 700 : 400}
                      fill="#ffffff"
                      stroke="#0d1117"
                      strokeWidth={3}
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {displayLabel}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {selected && (
          <div className="passage-main" style={{ borderLeft: `3px solid ${selected.color}`, paddingLeft: 10, marginTop: 8 }}>
            {breadcrumb.length > 0 && (
              <small style={{ opacity: 0.6, display: "block" }}>{breadcrumb.join(" › ")}</small>
            )}
            <span className="passage-label">SUMMARY</span>
            <div style={{ fontWeight: 700, fontSize: 14, margin: "4px 0" }}>{selected.label}</div>
            {!!selectedNode?.detail && <div style={{ fontSize: 13 }}>{selectedNode.detail}</div>}
            {selected.id === "__root__" && (
              <div style={{ fontSize: 13, opacity: 0.85 }}>
                Central topic with {map.roots.length} main branch{map.roots.length === 1 ? "" : "es"} and {map.nodeCount} nodes in total — click any node to fold/unfold it.
              </div>
            )}
            {!!selectedNode && selectedNode.children.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <span className="passage-label">SUBTOPICS ({selectedNode.children.length})</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                  {selectedNode.children.map((child) => (
                    <button
                      key={child.id}
                      onClick={() => {
                        if (selected.isCollapsed && selectedNode) toggle(selectedNode.id);
                        setSelectedId(child.id);
                      }}
                      title={child.detail || child.label}
                      className="home-suggestion"
                      style={{ borderColor: selected.color }}
                    >
                      {truncate(child.label, 32)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!!selectedNode && !!selectedNode.citations.length && (
              <small style={{ opacity: 0.8, display: "block", marginTop: 6 }}>
                Sources: {selectedNode.citations.map((c) => `[S${c.index}] ${c.sourceName} — ${c.heading}`).join("; ")}
              </small>
            )}
          </div>
        )}

        {!!map.citations.length && (
          <details className="passage-neighbor" style={{ marginTop: 12 }}>
            <summary>All cited passages ({map.citations.length})</summary>
            <div className="citation-list">
              {map.citations.map((cite) => (
                <div key={cite.chunkId} className="citation-row" title={cite.snippet}>
                  <span className="citation-tag">[S{cite.index}]</span>
                  <span className="citation-name">{cite.sourceName} — {cite.heading}</span>
                  <span className="citation-score">{cite.score.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}
