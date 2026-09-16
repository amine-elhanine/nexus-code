/**
 * Website import for notebook sources.
 *
 * Paste one link → the start page is read plus a bounded crawl of the same
 * site (same origin, BFS, depth + page caps), and everything is combined
 * into a single source document for the normal ingestion pipeline.
 *
 * Plain HTTP fetching only: heavily JS-rendered pages may come back thin —
 * the importer says so per page instead of silently storing shells.
 */

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  thin: boolean;
}

export interface WebsiteCrawl {
  startUrl: string;
  host: string;
  pages: CrawledPage[];
  pageCapHit: boolean;
  charCapHit: boolean;
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  maxTotalChars?: number;
  maxCharsPerPage?: number;
}

const DEFAULTS: Required<CrawlOptions> = {
  maxPages: 15,
  maxDepth: 2,
  timeoutMs: 12000,
  maxTotalChars: 600_000,
  maxCharsPerPage: 60_000,
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Binary / non-article targets never help a text index.
const SKIP_EXTENSIONS = new Set([
  "pdf", "zip", "rar", "7z", "tar", "gz", "exe", "msi", "dmg", "pkg",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif",
  "mp3", "wav", "ogg", "mp4", "webm", "mov", "avi", "mkv",
  "woff", "woff2", "ttf", "otf", "eot", "css", "js", "map", "json", "xml",
]);

// Boilerplate regions / consent banners that pollute every page.
const BOILERPLATE_TAG = /^(header|footer|nav|aside|form|noscript|script|style|template|svg|canvas|video|audio|iframe)$/i;
const BOILERPLATE_CLASS = /(nav|menu|sidebar|footer|header|breadcrumb|cookie|consent|gdpr|advert|ads?banner|popup|modal|newsletter|subscribe|social-share|comment)/i;

export function normalizeWebUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Paste a website link first.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new Error("Only http(s) websites can be imported.");
  }
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    throw new Error("That doesn't look like a valid website link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) websites can be imported.");
  url.hash = "";
  return url.toString();
}

function canonicalKey(url: string): string {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/\/+$/, "");
    if (!p) p = "/";
    return `${u.origin}${p}${u.search}`;
  } catch {
    return url;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return "";
      }
    });
}

function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function pageTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})/i);
  if (og) return decodeEntities(og[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (t) {
    const clean = stripTags(t[1]).replace(/\s+/g, " ").trim();
    if (clean) return clean;
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  if (h1) {
    const clean = stripTags(h1[1]);
    if (clean) return clean;
  }
  return "";
}

/** Removes boilerplate regions, then linearises headings/paragraphs/lists. */
export function extractMainText(html: string): string {
  let doc = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Drop whole boilerplate elements (non-greedy per tag).
  for (const tag of ["header", "footer", "nav", "aside", "form", "iframe"]) {
    doc = doc.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  // Drop divs/sections whose class/id screams boilerplate.
  doc = doc.replace(/<(div|section)\b[^>]*(class|id)=["'][^"']*(nav|menu|sidebar|footer|header|breadcrumb|cookie|consent|gdpr|advert|ads?-?banner|popup|modal|newsletter|subscribe|social-share)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Prefer the semantic content root when present.
  const rootMatch =
    doc.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ||
    doc.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    doc.match(/<[^>]+\brole=["']main["'][^>]*>([\s\S]*?)<\/[a-z][a-z0-9]*>/i);
  const root = rootMatch ? rootMatch[1] : doc;

  const lines: string[] = [];
  const push = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length > 1) lines.push(clean);
  };

  // Headings keep their level so the chunker sees document structure.
  const blockRe = /<(h[1-6]|p|li|blockquote|pre|td|th|dt|dd|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(root))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const inner = m[3];
    // Skip nested boilerplate that survived the coarse pass.
    if (BOILERPLATE_TAG.test(tag)) continue;
    const cls = attrs.match(/(class|id)=["']([^"']*)["']/i);
    if (cls && BOILERPLATE_CLASS.test(cls[2])) continue;
    // Skip in-page anchor links without real text later via length check.
    const text = stripTags(inner);
    if (text.length < 2) continue;
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      push(`${"#".repeat(Math.min(level + 1, 6))} ${text}`);
    } else if (tag === "li") {
      push(`- ${text}`);
    } else if (tag === "blockquote") {
      push(`> ${text}`);
    } else if (tag === "a") {
      // Standalone nav links are noise; inline links were already captured
      // inside their paragraph via the <p> branch.
      if (text.split(/\s+/).length <= 4) continue;
      push(text);
    } else {
      push(text);
    }
  }

  // Fallback for pages without clean block markup: whole-body text.
  if (!lines.length) {
    const body = root.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    const text = stripTags(body ? body[1] : root);
    if (text.length > 40) return text.slice(0, DEFAULTS.maxCharsPerPage);
    return "";
  }
  return lines.join("\n\n");
}

/** Same-origin article-ish links in first-seen order, deduplicated. */
export function extractSiteLinks(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, base);
    } catch {
      continue;
    }
    if (absolute.origin !== origin) continue;
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
    const ext = (absolute.pathname.split(".").pop() || "").toLowerCase();
    if (ext && SKIP_EXTENSIONS.has(ext)) continue;
    absolute.hash = "";
    const key = canonicalKey(absolute.toString());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(absolute.toString());
  }
  return out;
}

async function fetchHtml(url: string, timeoutMs: number): Promise<{ html: string; finalUrl: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null;
    const html = await res.text();
    if (!html || html.length < 500) return null;
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the start page plus a bounded same-origin crawl (BFS). Stops at page
 * or character caps; pages that come back thin (JS shells, errors) are
 * recorded as such so the document says so.
 */
export async function crawlWebsite(rawUrl: string, options?: CrawlOptions): Promise<WebsiteCrawl> {
  const startUrl = normalizeWebUrl(rawUrl);
  const opt = { ...DEFAULTS, ...options };
  const host = new URL(startUrl).host;

  const pages: CrawledPage[] = [];
  const visited = new Set<string>([canonicalKey(startUrl)]);
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  let totalChars = 0;
  let pageCapHit = false;
  let charCapHit = false;

  while (queue.length && pages.length < opt.maxPages && totalChars < opt.maxTotalChars) {
    // Small concurrency for politeness and speed.
    const batch = queue.splice(0, 3);
    const results = await Promise.all(
      batch.map(async ({ url, depth }) => {
        const fetched = await fetchHtml(url, opt.timeoutMs);
        if (!fetched) return { url, depth, html: null as string | null, finalUrl: url };
        return { url, depth, html: fetched.html, finalUrl: fetched.finalUrl };
      })
    );
    for (const { url, depth, html, finalUrl } of results) {
      if (pages.length >= opt.maxPages || totalChars >= opt.maxTotalChars) break;
      if (!html) {
        pages.push({ url, title: url, text: "", thin: true });
        continue;
      }
      const title = pageTitle(html) || finalUrl;
      let text = extractMainText(html).slice(0, opt.maxCharsPerPage);
      const thin = text.replace(/\s+/g, " ").trim().length < 120;
      if (!thin) {
        const room = opt.maxTotalChars - totalChars;
        if (text.length > room) {
          text = text.slice(0, room);
          charCapHit = true;
        }
        totalChars += text.length;
      }
      pages.push({ url: finalUrl, title, text, thin });
      if (depth < opt.maxDepth && pages.length + queue.length < opt.maxPages * 2) {
        for (const link of extractSiteLinks(html, finalUrl)) {
          const key = canonicalKey(link);
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }
  if (queue.length && pages.length >= opt.maxPages) pageCapHit = true;

  return { startUrl, host, pages, pageCapHit, charCapHit };
}

export function websiteSourceFilename(host: string, title: string): string {
  const cleanTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const stem = cleanTitle && cleanTitle.toLowerCase() !== host.toLowerCase()
    ? `${host} - ${cleanTitle}`
    : host;
  return `Web - ${stem.slice(0, 100)}.txt`;
}

/** Crawl → one markdown document for the normal ingestion pipeline. */
export function websiteCrawlDocument(crawl: WebsiteCrawl): string {
  const usable = crawl.pages.filter((p) => !p.thin && p.text.trim());
  const lines = [
    `# Website: ${crawl.host}`,
    ``,
    `Start page: ${crawl.startUrl}`,
    `Pages read: ${usable.length} of ${crawl.pages.length} visited${crawl.pageCapHit ? ` (capped at ${usable.length} content pages — the site has more)` : ""}${crawl.charCapHit ? " (length-capped)" : ""}`,
    ``,
  ];
  if (!usable.length) {
    lines.push(`No readable content found. The site may render in JavaScript (this importer reads plain HTML) or block automated fetching.`);
    return lines.join("\n") + "\n";
  }
  usable.forEach((page, i) => {
    lines.push(`## [${i + 1}] ${page.title}`, ``, `URL: ${page.url}`, ``, page.text.trim(), ``);
  });
  const thinCount = crawl.pages.length - usable.length;
  if (thinCount > 0) {
    lines.push(`---`, ``, `${thinCount} visited page${thinCount === 1 ? "" : "s"} had no readable text (script-rendered, media, or fetch failures) and were skipped.`);
  }
  return lines.join("\n") + "\n";
}
