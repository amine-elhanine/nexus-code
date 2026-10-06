import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, Maximize, Maximize2, Minimize2, PanelRight, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Modal } from "../common/Modal.js";
import { UNVERIFIED_CITATION_TITLE } from "./CitationSources.js";
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

function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

// Map-label rules: the central topic and depth-1 branches carry the map's
// structure, so they wrap to two lines instead of being cut mid-title; deeper
// nodes stay single-line with a wider cap. Overflow past 2×64 chars (the
// sanitizer stores up to 120) truncates only the final line.
const LEAF_LABEL_MAX = 64;
const BRANCH_LINE_MAX = 64;
const BRANCH_MAX_LINES = 2;

/** Greedy word-wrap into at most `maxLines` lines of `maxChars`; overflow
 *  goes on the last line, truncated. */
function wrapLabel(label: string, maxChars: number, maxLines: number): string[] {
  if (label.length <= maxChars) return [label];
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let idx = 0;
  while (idx < words.length && lines.length < maxLines - 1) {
    let line = words[idx++];
    while (idx < words.length && `${line} ${words[idx]}`.length <= maxChars) line += ` ${words[idx++]}`;
    lines.push(line);
  }
  if (idx < words.length) lines.push(truncate(words.slice(idx).join(" "), maxChars));
  return lines;
}

function nodeLabelLines(p: PlacedNode): string[] {
  const lines = p.depth <= 1
    ? wrapLabel(p.label, BRANCH_LINE_MAX, BRANCH_MAX_LINES)
    : [truncate(p.label, LEAF_LABEL_MAX)];
  if (p.isCollapsed) lines[lines.length - 1] += ` (+${p.childCount})`;
  return lines;
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
      // A two-line branch label is taller than one row, so centering the
      // branch on its children puts a child row inside the label band. Such
      // branches get a dedicated row above their subtree instead; short
      // branches keep the classic centered look.
      const wrapsToTwoLines = depth <= 1 && label.length > BRANCH_LINE_MAX;
      if (wrapsToTwoLines) {
        self.y = TOP_PAD + cursor * V_GAP;
        cursor++;
      }
      const kids = visibleChildren.map((child) =>
        place(child, child.id, child.label, depth + 1, color, self, child.children)
      );
      if (!wrapsToTwoLines) {
        self.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      }
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
  const [showDetails, setShowDetails] = useState(true);
  const [isMaximized, setIsMaximized] = useState(false);
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

  // Auto-fit the board when the map opens or layout changes.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const { width: w, height: h } = layoutRef.current;
    if (!w || !h) return;
    const fitX = (el.clientWidth - 60) / w;
    const fitY = (el.clientHeight - 60) / h;
    const fit = Math.min(fitX, fitY, 1.15);
    const z = +Math.max(0.35, fit).toFixed(2);
    setZoom(z);
    setPan({
      x: Math.max(20, (el.clientWidth - w * z) / 2),
      y: Math.max(20, (el.clientHeight - h * z) / 2),
    });
  }, [map.id, isMaximized, showDetails]);

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
    setShowDetails(true);
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
    const fitX = (el.clientWidth - 60) / w;
    const fitY = (el.clientHeight - 60) / h;
    const f = Math.min(fitX, fitY, 1.25);
    const z = +Math.max(0.3, f).toFixed(2);
    setZoom(z);
    setPan({
      x: Math.max(20, (el.clientWidth - w * z) / 2),
      y: Math.max(20, (el.clientHeight - h * z) / 2),
    });
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
    <Modal
      title={map.title}
      subtitle={`Mind map · ${map.nodeCount} nodes · topic: ${map.topic}`}
      onClose={onClose}
      className={`mindmap-modal-card${isMaximized ? " maximized" : ""}`}
      extraHeadActions={
        <button
          className="icon-plain"
          onClick={() => setIsMaximized((v) => !v)}
          title={isMaximized ? "Restore window size" : "Maximize mind map"}
        >
          {isMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      }
    >
      <div className="mindmap-toolbar">
        <div className="mindmap-toolbar-actions">
          <button className="top-link" onClick={() => setCollapsed(new Set())} title="Expand every branch">
            <ChevronsUpDown size={13} /> Expand all
          </button>
          <button className="top-link" onClick={() => setCollapsed(new Set(collectIds(map.roots)))} title="Collapse every branch">
            <ChevronsDownUp size={13} /> Collapse all
          </button>
          <div className="top-separator" style={{ height: 14, margin: "0 4px" }} />
          <button className="icon-plain" onClick={() => zoomCenter(1.2)} title="Zoom in">
            <ZoomIn size={14} />
          </button>
          <button className="icon-plain" onClick={() => zoomCenter(1 / 1.2)} title="Zoom out">
            <ZoomOut size={14} />
          </button>
          <button className="icon-plain" onClick={fitView} title="Fit entire mind map in view">
            <Maximize size={14} />
          </button>
          <button className="icon-plain" onClick={resetView} title="Reset zoom and position">
            <RotateCcw size={14} />
          </button>
          <div className="top-separator" style={{ height: 14, margin: "0 4px" }} />
          <button
            className={`top-link${showDetails ? " active" : ""}`}
            onClick={() => setShowDetails((v) => !v)}
            title={showDetails ? "Hide node inspector" : "Show node inspector"}
          >
            <PanelRight size={13} /> {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>
        <span className="mindmap-toolbar-hint">
          Drag to pan · Scroll to zoom · Click node to inspect/fold
        </span>
      </div>

      <div className="mindmap-body">
        <div className="mindmap-canvas-wrap">
          <div
            ref={boxRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
            style={{
              width: "100%",
              height: "100%",
              overflow: "hidden",
              position: "relative",
              cursor: grabbing ? "grabbing" : "grab",
              touchAction: "none",
              userSelect: "none",
            }}
          >
            <svg width="100%" height="100%" style={{ display: "block", overflow: "visible" }}>
              <defs>
                <pattern id="mm-dots" width="26" height="26" patternUnits="userSpaceOnUse">
                  <circle cx="1.5" cy="1.5" r="1.5" fill="var(--line2)" opacity={0.6} />
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
                  const lines = nodeLabelLines(p);
                  const fontSize = isCentral ? 15 : p.depth === 1 ? 13.5 : 12.5;
                  const lineHeight = fontSize * 1.2;
                  // Baseline of the first line, so the whole block stays
                  // vertically centered on the node dot.
                  const firstBaseline = (isCentral ? 5 : 4) - ((lines.length - 1) * lineHeight) / 2;
                  const labelX = isCentral ? -(r + 10) : r + 9;
                  return (
                    <g key={p.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: "pointer" }} onClick={() => handleNodeClick(p)}>
                      <title>{p.isCollapsed ? `${p.label} — click to expand (${p.childCount} hidden)` : `${p.label} — click to ${p.hasChildren ? "fold" : "inspect"}`}</title>
                      <circle
                        r={r + (isSelected ? 3.5 : 0)}
                        fill="none"
                        stroke={isSelected ? "var(--text)" : "transparent"}
                        strokeWidth={1.5}
                        opacity={0.9}
                      />
                      <circle r={r} fill="var(--panel)" stroke={p.color} strokeWidth={2.5} />
                      <circle r={r - 2.5} fill={p.color} opacity={0.9} pointerEvents="none" />
                      <text
                        x={labelX}
                        y={firstBaseline}
                        textAnchor={isCentral ? "end" : "start"}
                        fontSize={fontSize}
                        fontWeight={p.depth <= 1 ? 700 : 400}
                        fill="var(--text)"
                        stroke="var(--bg)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        pointerEvents="none"
                      >
                        {lines.map((line, i) => (
                          <tspan key={i} x={labelX} dy={i === 0 ? 0 : lineHeight}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </div>

        {showDetails && (
          <aside className="mindmap-inspector">
            <div className="mindmap-inspector-head">
              <div>
                <span className="context-kicker">NODE INSPECTOR</span>
                <strong>{selected ? selected.label : "Select a node"}</strong>
              </div>
              <button
                className="context-panel-icon"
                onClick={() => setShowDetails(false)}
                title="Hide inspector"
              >
                <PanelRight size={14} />
              </button>
            </div>

            <div className="mindmap-inspector-body">
              {breadcrumb.length > 1 && (
                <div className="mindmap-breadcrumb">
                  {breadcrumb.map((crumb, idx) => (
                    <span key={idx} className="mindmap-crumb">
                      {idx > 0 && <span className="mindmap-crumb-sep">›</span>}
                      <span>{crumb}</span>
                    </span>
                  ))}
                </div>
              )}

              {selected && (
                <div className="mindmap-selected-card" style={{ borderLeftColor: selected.color }}>
                  <div className="mindmap-selected-header">
                    <span className="mindmap-selected-title">{selected.label}</span>
                    <span className="eval-pill" style={{ borderColor: selected.color, color: selected.color }}>
                      {selected.id === "__root__" ? "Central Topic" : selected.hasChildren ? `${selected.childCount} subtopics` : "Leaf topic"}
                    </span>
                  </div>
                  {selected.id === "__root__" && (
                    <p className="mindmap-selected-detail">
                      Central topic with {map.roots.length} main branch{map.roots.length === 1 ? "" : "es"} and {map.nodeCount} nodes in total.
                      Click any branch or node to explore subtopics.
                    </p>
                  )}
                  {!!selectedNode?.detail && (
                    <p className="mindmap-selected-detail">{selectedNode.detail}</p>
                  )}
                  {!!selectedNode && selectedNode.children.length > 0 && (
                    <div className="mindmap-subtopics-section">
                      <span className="passage-label">SUBTOPICS ({selectedNode.children.length})</span>
                      <div className="mindmap-subtopics-grid">
                        {selectedNode.children.map((child) => (
                          <button
                            key={child.id}
                            onClick={() => {
                              if (selected.isCollapsed && selectedNode) toggle(selectedNode.id);
                              setSelectedId(child.id);
                            }}
                            title={child.detail || child.label}
                            className="mindmap-subtopic-chip"
                            style={{ borderColor: selected.color }}
                          >
                            <span>{truncate(child.label, 32)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {!!selectedNode && !!selectedNode.citations.length && (
                    <div className="mindmap-sources-section">
                      <span className="passage-label">SOURCES ({selectedNode.citations.length})</span>
                      <div className="mindmap-sources-list">
                        {selectedNode.citations.map((c, i) => (
                          <div
                            key={i}
                            className="mindmap-source-item"
                            title={c.verified === false ? UNVERIFIED_CITATION_TITLE : `${c.sourceName} — ${c.heading}`}
                          >
                            <span className={`citation-tag${c.verified === false ? " unverified" : ""}`}>[S{c.index}]</span>
                            <span className="mindmap-source-text">{c.sourceName} — {c.heading}{c.verified === false ? " (unverified)" : ""}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!!map.citations.length && (
                <details className="passage-neighbor" style={{ marginTop: 8 }}>
                  <summary>All cited passages ({map.citations.length})</summary>
                  <div className="citation-list" style={{ marginTop: 8 }}>
                    {map.citations.map((cite) => (
                      <div key={cite.chunkId} className="citation-row" title={cite.verified === false ? UNVERIFIED_CITATION_TITLE : cite.snippet}>
                        <span className={`citation-tag${cite.verified === false ? " unverified" : ""}`}>[S{cite.index}]</span>
                        <span className="citation-name">{cite.sourceName} — {cite.heading}{cite.verified === false ? " (unverified)" : ""}</span>
                        <span className="citation-score">{cite.score.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </aside>
        )}
      </div>
    </Modal>
  );
}
