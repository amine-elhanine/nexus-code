# One-off: Phase 3 — video cards + source citation pills in RichMarkdown.
p = 'src/components/common/RichMarkdown.tsx'
s = open(p, encoding='utf8').read()

# 1. Video helpers + ChatVideoBlock + VideoGallery + SourceCitationsBar,
#    inserted before the BLOCK_PATTERN definition.
anchor = 'const BLOCK_PATTERN = '
assert anchor in s
components = r'''// ---- Inline video cards & source citations (ChatGPT-style) -----------------

const YT_VIDEO_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
const VIDEO_IMAGE_RE = /^Video:\s*(.+)$/i;

function youTubeId(value: string): string | null {
  const match = String(value || "").match(YT_VIDEO_RE);
  return match ? match[1] : null;
}

function ChatVideoBlock({ alt, src }: { alt: string; src: string }) {
  const videoId = youTubeId(src);
  const [playing, setPlaying] = useState(false);
  if (!videoId) return <ChatImageBlock alt={alt} src={src} />;
  const metaMatch = alt.match(VIDEO_IMAGE_RE);
  const metaParts = metaMatch ? metaMatch[1].split("|").map((x) => x.trim()) : [];
  const title = metaParts[0] || "Video";
  const channel = metaParts[1] || "";
  const duration = metaParts[2] || "";
  return (
    <div className="chat-video-card" style={{ maxWidth: 520, margin: "10px 0" }}>
      {playing ? (
        <div style={{ position: "relative", paddingBottom: "56.25%", borderRadius: 10, overflow: "hidden", background: "#000" }}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          style={{ position: "relative", display: "block", width: "100%", padding: 0, border: 0, borderRadius: 10, overflow: "hidden", cursor: "pointer", background: "#000" }}
          title={`Play: ${title}`}
        >
          <img
            src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
            alt={title}
            style={{ display: "block", width: "100%", aspectRatio: "16/9", objectFit: "cover" }}
            loading="lazy"
          />
          <span
            style={{
              position: "absolute", inset: 0, display: "grid", placeItems: "center",
              background: "rgba(0,0,0,0.25)", transition: "background 0.15s",
            }}
          >
            <span style={{ display: "grid", placeItems: "center", width: 52, height: 36, borderRadius: 10, background: "rgba(255,0,0,0.92)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
            </span>
          </span>
        </button>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 11.5, color: "var(--text, #dce1eb)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{title}</strong>
        {channel && <span style={{ fontSize: 10, color: "var(--muted, #8b98ab)", whiteSpace: "nowrap" }}>{channel}</span>}
        {duration && (
          <span style={{ fontSize: 9.5, fontFamily: "'DM Mono', monospace", color: "var(--muted, #8b98ab)", border: "1px solid var(--line, #24334a)", borderRadius: 4, padding: "0 5px" }}>
            {duration}
          </span>
        )}
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer noopener"
          style={{ fontSize: 10, color: "var(--nexus-green, #34d399)", whiteSpace: "nowrap" }}
        >
          YouTube ↗
        </a>
      </div>
    </div>
  );
}

function VideoGallery({ items }: { items: Array<{ alt: string; src: string }> }) {
  return (
    <div className="video-gallery-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, margin: "10px 0" }}>
      {items.map((item, index) => (
        <ChatVideoBlock key={index} alt={item.alt} src={item.src} />
      ))}
    </div>
  );
}

function SourceCitationsBar({ links }: { links: Array<{ url: string; label: string }> }) {
  const [expanded, setExpanded] = useState(false);
  if (!links.length) return null;
  const visible = expanded ? links : links.slice(0, 5);
  return (
    <div className="source-cards-strip" style={{ marginTop: 14, borderTop: "1px solid var(--line, #24334a)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted, #8b98ab)" }}>
          Sources · {links.length}
        </span>
        {links.length > 5 && (
          <button type="button" onClick={() => setExpanded((prev) => !prev)} style={{ border: 0, background: "transparent", color: "var(--nexus-green, #34d399)", fontSize: 10, cursor: "pointer" }}>
            {expanded ? "Show less" : `Show all ${links.length}`}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: expanded ? "wrap" : "nowrap", overflowX: expanded ? "visible" : "auto", paddingBottom: 4 }}>
        {visible.map((link, index) => {
          let domain = link.url;
          try { domain = new URL(link.url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
          return (
            <a
              key={index}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="source-citation-pill"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, flex: expanded ? undefined : "0 0 auto",
                maxWidth: 260, border: "1px solid var(--line, #24334a)", borderRadius: 8,
                padding: "5px 9px", background: "var(--panel2, #141c26)", textDecoration: "none",
              }}
              title={link.label || domain}
            >
              <img
                src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                alt=""
                width={14}
                height={14}
                style={{ borderRadius: 3, flex: "none" }}
                loading="lazy"
              />
              <span style={{ fontSize: 10.5, color: "var(--text, #dce1eb)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {link.label || domain}
              </span>
              <span style={{ fontSize: 9, color: "var(--muted, #8b98ab)", flex: "none" }}>{domain}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

const BLOCK_PATTERN = '''
s = s.replace(anchor, components, 1)

# 2. Collect video embeds alongside search images (before the render loop).
old2 = '''  const imagePattern = /!\\[([^\\]]*)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g;'''
assert old2 in s
new2 = old2 + '''
  // Video embeds (![Video: Title | Channel | Duration](youtube-url)) render
  // as inline player cards; 2+ become a gallery like the search image set.
  const videoPattern = /!\\[([^\\]]*)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g;
  const videoMatches = [...renderSource.matchAll(videoPattern)]
    .filter((match) => youTubeId(match[2] || "") && VIDEO_IMAGE_RE.test(match[1] || ""));
  const videos: SearchImageItem[] = videoMatches.map((match) => ({ alt: match[1] || "", src: match[2] || "", sourceUrl: match[2] || "" }));
  if (videos.length > 1) {
    for (const item of videos.slice(1)) {
      const escaped = item.src.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      renderSource = renderSource.replace(new RegExp(\`^[^\\\\n]*\\\\(\${escaped}\\\\)[^\\\\n]*\\\\n?\`, "gim"), "");
    }
  }'''
s = s.replace(old2, new2, 1)

# 3. Intercept videos in the image branch before ChatImageBlock.
old3 = '''    } else if (match[4]) {
      const altText = match[5] || "";
      const imgSrc = match[6] || "";
      if (isSearchImageUrl(imgSrc)) {'''
assert old3 in s
new3 = '''    } else if (match[4]) {
      const altText = match[5] || "";
      const imgSrc = match[6] || "";
      if (youTubeId(imgSrc) && VIDEO_IMAGE_RE.test(altText)) {
        if (videos.length > 1) {
          pieces.push(<VideoGallery key={`videos-${match.index}`} items={videos} />);
        } else {
          pieces.push(<ChatVideoBlock key={`video-${match.index}`} alt={altText} src={imgSrc} />);
        }
      } else if (isSearchImageUrl(imgSrc)) {'''
s = s.replace(old3, new3, 1)

# 4. Sources bar at the bottom of the message.
old4 = '''  return <div className={`rich-markdown md ${className}`}>{pieces}</div>;'''
assert old4 in s
new4 = '''  const citationLinks: Array<{ url: string; label: string }> = [];
  {
    const seenDomains = new Set<string>();
    for (const match of (renderSource || "").matchAll(/\\[([^\\]]{1,120})\\]\\((https?:\\/\\/[^)\\s]+)\\)/g)) {
      const url = match[2];
      if (youTubeId(url)) continue;
      let domain = "";
      try { domain = new URL(url).hostname.replace(/^www\\./, ""); } catch { continue; }
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      citationLinks.push({ url, label: match[1] });
      if (citationLinks.length >= 12) break;
    }
  }
  return (
    <div className={`rich-markdown md ${className}`}>
      {pieces}
      <SourceCitationsBar links={citationLinks} />
    </div>
  );'''
s = s.replace(old4, new4, 1)

open(p, 'w', encoding='utf8', newline='\n').write(s)
print("video + sources installed")
