import React, { useEffect, useState } from "react";
import mermaid from "mermaid";
import { renderMarkdown } from "../../markdown.js";

let mermaidSequence = 0;
let mermaidConfigured = false;

function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const id = `nexus-mermaid-${++mermaidSequence}`;
    void (async () => {
      try {
        if (!mermaidConfigured) {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
          mermaidConfigured = true;
        }
        const rendered = await mermaid.render(id, source.trim());
        if (alive) setSvg(rendered.svg);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [source]);

  if (svg) return <div className="rich-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
  if (failed) return <pre className="rich-mermaid-fallback"><code>{source}</code></pre>;
  return <div className="rich-mermaid-loading">Rendering diagram…</div>;
}

export function RichMarkdown({ source, className = "" }: { source: string; className?: string }) {
  const pieces: React.ReactNode[] = [];
  const pattern = /```mermaid\s*\n([\s\S]*?)```/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source || ""))) {
    if (match.index > cursor) {
      pieces.push(<div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(source.slice(cursor, match.index)) }} />);
    }
    pieces.push(<MermaidBlock key={`mermaid-${match.index}`} source={match[1]} />);
    cursor = match.index + match[0].length;
  }
  if (cursor < (source || "").length || !pieces.length) {
    pieces.push(<div key={`md-${cursor}`} dangerouslySetInnerHTML={{ __html: renderMarkdown((source || "").slice(cursor)) }} />);
  }
  return <div className={`rich-markdown md ${className}`}>{pieces}</div>;
}
