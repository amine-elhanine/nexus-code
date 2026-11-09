import { tool } from "./agentcore/tools.js";
import { z } from "zod";
import { decodeHtmlEntities, htmlToText } from "./html-text.js";

// Free, keyless web search via DuckDuckGo Lite (plain HTML, no JS, no
// token handshake). Best-effort by design: if DDG is unreachable or changes
// markup, the tool reports it instead of failing the run.
const DDG_TIMEOUT_MS = 12000;
const MAX_RESULTS = 8;

export type WebSearchResult = { title: string; url: string; snippet: string };
export type WebImageResult = { title: string; imageUrl: string; sourceUrl: string; width?: number; height?: number; domain?: string };
export type WebVideoResult = {
  title: string;
  videoUrl: string;
  videoId?: string;
  thumbnailUrl: string;
  channel: string;
  duration: string;
  views?: string;
  published?: string;
  score: number;
};

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isAllowedSearchImageHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "external-content.duckduckgo.com" || host === "mm.bing.net" || host.endsWith(".mm.bing.net");
  } catch {
    return false;
  }
}

// ---- Smart image curation (Phase: ChatGPT-caliber media) -------------------
// Watermarked stock agencies and low-signal aggregators are demoted so the
// gallery surfaces real, directly-relevant imagery instead of paywalled
// previews and Pinterest re-hosts.

const STOCK_WATERMARK_DOMAINS = /(?:shutterstock|istockphoto|gettyimages|alamy|123rf|dreamstime|depositphotos|bigstockphoto|vectorstock)\.com/i;

/** Extracts meaningful lowercase tokens from a query (len>=3, deduped). */
export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of String(query || "").toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) || []) {
    if (!seen.has(raw)) seen.add(raw);
  }
  return [...seen];
}

/**
 * Relevance & quality score (0..100-ish) for one DuckDuckGo image row:
 * entity/keyword overlap (+40 max), resolution & aspect ratio (+25 max,
 * tiny icons and extreme banners penalized), and anti-stock/anti-spam
 * demotion (-50 for watermarked agencies, -20 for Pinterest).
 */
export function scoreImageCandidate(row: Record<string, unknown>, queryTokensList: string[]): number {
  const title = String(row.title || "").toLowerCase();
  const sourceUrl = String(row.url || "").toLowerCase();
  const width = Number(row.width) || 0;
  const height = Number(row.height) || 0;
  let score = 0;
  for (const token of queryTokensList) {
    if (title.includes(token)) score += 12;
    if (sourceUrl.includes(token)) score += 6;
  }
  if (width >= 800 && height >= 450) score += 20;
  else if (width >= 480 && height >= 300) score += 10;
  else if (width > 0 && (width < 220 || height < 160)) score -= 30;
  const ratio = height > 0 ? width / height : 1;
  if (ratio > 3.8 || ratio < 0.3) score -= 20;
  if (STOCK_WATERMARK_DOMAINS.test(sourceUrl) || STOCK_WATERMARK_DOMAINS.test(title)) score -= 50;
  if (/pinterest\./i.test(sourceUrl)) score -= 20;
  return score;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Decode DuckDuckGo's image API response into safe, directly displayable
 * URLs. Candidates are deduplicated (normalized title + image host/path),
 * scored by relevance/quality, and returned best-first with dimensions and
 * source domain metadata.
 */
export function parseDuckDuckGoImages(payload: unknown, limit = 5, query = ""): WebImageResult[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const tokens = queryTokens(query);
  const seen = new Set<string>();
  const scored: Array<{ image: WebImageResult; score: number }> = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const imageUrl = safeHttpUrl(row.thumbnail || row.image);
    const sourceUrl = safeHttpUrl(row.url);
    if (!imageUrl || !isAllowedSearchImageHost(imageUrl) || !sourceUrl) continue;
    // Dedupe by normalized title stem and image host+path so the gallery
    // shows diverse angles instead of four crops of the same shot.
    const titleKey = String(row.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
    const imageKey = `${new URL(imageUrl).host}${new URL(imageUrl).pathname}`.toLowerCase();
    const dedupeKey = `${titleKey}|${imageKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const width = Number(row.width) || 0;
    const height = Number(row.height) || 0;
    scored.push({
      image: {
        title: String(row.title || "Relevant image").slice(0, 160),
        imageUrl,
        sourceUrl,
        width,
        height,
        domain: domainOf(sourceUrl),
      },
      score: scoreImageCandidate(row, tokens),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.image);
}

async function duckDuckGoImageSearch(query: string, limit = 5): Promise<WebImageResult[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);
  try {
    const page = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
      signal: controller.signal,
    });
    if (!page.ok) throw new Error(`DuckDuckGo returned HTTP ${page.status}`);
    const html = await page.text();
    const token = html.match(/(?:vqd\s*=\s*['"]|\"vqd\"\s*:\s*\")([^'"\\]+)/i)?.[1];
    if (!token) return [];
    const params = new URLSearchParams({ l: "us-en", o: "json", q: query, vqd: token, f: "", p: "1" });
    const response = await fetch(`https://duckduckgo.com/i.js?${params}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36", Referer: "https://duckduckgo.com/" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DuckDuckGo image search returned HTTP ${response.status}`);
    // Fetch a WIDE candidate pool and let the scorer pick the best few —
    // the raw API order is ad-influenced, not relevance-ranked.
    const pool = parseDuckDuckGoImages(await response.json(), limit * 4 + 16, query);
    return pool.slice(0, limit);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createWebImageSearchTools(opts?: { onSearch?: (query: string, url: string) => void; beforeSearch?: () => string | null }) {
  return [tool(
    async ({ query, maxResults = 5 }: { query: string; maxResults?: number }) => {
      const guard = opts?.beforeSearch?.();
      if (guard) return guard;
      const cleanQuery = query.trim();
      if (!cleanQuery) return "An image search query is required.";
      try {
        opts?.onSearch?.(cleanQuery, `https://duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&iax=images&ia=images`);
      } catch { /* mirror is best-effort */ }
      try {
        const results = await duckDuckGoImageSearch(cleanQuery, Math.min(Math.max(maxResults, 1), 5));
        if (!results.length) return `No web images found for "${cleanQuery}". Continue with the text search results.`;
        return `Image results for "${cleanQuery}". Include only images that materially help the answer. To show one inline, use exactly this Markdown pattern with its direct image URL and caption, then link the caption to its source page:\n\n${results.map((r, i) => `${i + 1}. ![${r.title.replace(/[\\[\\]]/g, "")}](${r.imageUrl}) ([Source](${r.sourceUrl}))`).join("\n")}\n\nUse a relevant image only when it adds useful visual evidence; keep its source link beside it.`;
      } catch (error) {
        return `Web image search failed: ${error instanceof Error ? error.message : String(error)}. Continue with the text search results.`;
      }
    },
    {
      name: "web_image_search",
      description: "Find relevant web images for a Home answer that would benefit from visual evidence (places, products, people, landmarks, diagrams, events). Returns direct image URLs and source pages; embed selected useful images in the chat using Markdown image syntax and cite the source link. Skip it when images would add little.",
      schema: z.object({
        query: z.string().describe("Specific subject to find useful visual references for."),
        maxResults: z.number().optional().describe("How many image results to return (1-5, default 5)."),
      }),
    }
  )];
}

// ---- Web video search (YouTube InnerTube, keyless) -------------------------
// Scores candidates by query/title token overlap, channel quality and
// duration sanity, and returns Markdown embeds the chat renders as inline
// video cards: ![Video: <Title> | <Channel> | <Duration>](youtubeUrl)

function parseDurationSeconds(duration: string): number {
  const parts = String(duration || "").split(":").map((n) => parseInt(n, 10) || 0);
  if (!parts.length) return 0;
  return parts.reverse().reduce((total, n, idx) => total + n * Math.pow(60, idx), 0);
}

function scoreVideoCandidate(candidate: { title: string; channel: string; durationSeconds: number }, tokens: string[]): number {
  let score = 0;
  const title = candidate.title.toLowerCase();
  const channel = candidate.channel.toLowerCase();
  for (const token of tokens) {
    if (title.includes(token)) score += 14;
    if (channel.includes(token)) score += 6;
  }
  // Official/quality channel signals.
  if (/official|verified/i.test(candidate.channel)) score += 8;
  // Duration sanity: sub-30-second clips are junk unless explicitly wanted.
  if (candidate.durationSeconds > 0 && candidate.durationSeconds < 30) score -= 25;
  if (candidate.durationSeconds >= 90 && candidate.durationSeconds <= 1800) score += 10;
  return score;
}

export function parseYouTubeInnerTubeResults(payload: unknown, limit: number, tokens: string[]): WebVideoResult[] {
  const contents = (payload as any)?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
  if (!Array.isArray(contents)) return [];
  const raw: Array<Record<string, unknown>> = [];
  for (const section of contents) {
    const items = section?.itemSectionRenderer?.contents;
    if (Array.isArray(items)) raw.push(...items);
  }
  const seen = new Set<string>();
  const scored: Array<{ video: WebVideoResult }> = [];
  for (const item of raw) {
    const renderer = (item as Record<string, unknown>)?.videoRenderer as Record<string, unknown> | undefined;
    if (!renderer) continue;
    const videoId = String(renderer.videoId || "");
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const title = String((renderer.title as any)?.runs?.[0]?.text || "").slice(0, 160);
    if (!title) continue;
    const channel = String((renderer.ownerText as any)?.runs?.[0]?.text || (renderer.longBylineText as any)?.runs?.[0]?.text || "").replace(/\s*•\s*$/, "").slice(0, 80);
    const duration = String((renderer.lengthText as any)?.simpleText || "");
    const durationSeconds = parseDurationSeconds(duration);
    const views = String((renderer.viewCountText as any)?.simpleText || (renderer.shortViewCountText as any)?.simpleText || "") || undefined;
    const published = String((renderer.publishedTimeText as any)?.simpleText || "") || undefined;
    const score = scoreVideoCandidate({ title, channel, durationSeconds }, tokens);
    scored.push({
      video: {
        title,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        channel,
        duration: duration || "live",
        views,
        published,
        score,
      },
    });
  }
  scored.sort((a, b) => b.video.score - a.video.score);
  return scored.slice(0, limit).map((entry) => entry.video);
}

async function youTubeVideoSearch(query: string, limit: number): Promise<WebVideoResult[]> {
  const tokens = queryTokens(query);
  const response = await fetch("https://www.youtube.com/youtubei/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en", gl: "US" } },
      query,
    }),
    signal: AbortSignal.timeout(DDG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`YouTube search returned HTTP ${response.status}`);
  return parseYouTubeInnerTubeResults(await response.json(), limit, tokens);
}

/** Format a video result as the Markdown embed pattern the chat renders as an inline player card. */
export function formatVideoEmbed(video: WebVideoResult): string {
  return `![Video: ${video.title.replace(/[\[\]]/g, "")} | ${video.channel} | ${video.duration}](${video.videoUrl})`;
}

export function createWebVideoSearchTools(opts?: { beforeSearch?: () => string | null }) {
  return [tool(
    async ({ query, maxResults = 4 }: { query: string; maxResults?: number }) => {
      const guard = opts?.beforeSearch?.();
      if (guard) return guard;
      const cleanQuery = query.trim();
      if (!cleanQuery) return "A video search query is required.";
      try {
        const results = await youTubeVideoSearch(cleanQuery, Math.min(Math.max(maxResults, 1), 6));
        if (!results.length) return `No web videos found for "${cleanQuery}". Continue with the text results.`;
        const lines = results.map((r, i) => {
          const meta = [r.channel, r.duration, r.views, r.published].filter(Boolean).join(" · ");
          return `${i + 1}. ${formatVideoEmbed(r)}
   ${meta}${r.score >= 20 ? " · strong match" : ""}`;
        });
        return `Video results for "${cleanQuery}". Embed 1-3 of the MOST relevant ones directly in the answer using their exact Markdown lines (the chat renders them as playable video cards); skip videos that are tangential:\n\n${lines.join("\n")}`;
      } catch (error) {
        return `Web video search failed: ${error instanceof Error ? error.message : String(error)}. Continue with the text results.`;
      }
    },
    {
      name: "web_video_search",
      description: "Search YouTube for videos relevant to the request (tutorials, reviews, event coverage, trailers, talks). Returns Markdown embed lines that render as playable inline video cards in the chat — embed 1-3 of the most relevant directly in the answer. Skip when a video would add nothing.",
      schema: z.object({
        query: z.string().describe("Specific subject to find useful videos for."),
        maxResults: z.number().optional().describe("How many video results to return (1-6, default 4)."),
      }),
    }
  )];
}

// DuckDuckGo Lite date filter: recency bias for time-sensitive queries
// ("latest", "current", prices, releases, rankings). Verified live: df=y
// reorders results toward pages from the requested window.
const FRESHNESS_DF: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

export function freshnessToDateFilter(freshness?: string): string | null {
  if (!freshness) return null;
  return FRESHNESS_DF[freshness.toLowerCase()] ?? null;
}

// ---- Structured search backends (Phase 3.1) -------------------------------
// Tavily / Brave / Exa / SearXNG return JSON — no HTML scraping, no layout
// drift. Each adapter takes the raw API key; routing (backend selection +
// automatic DDG fallback) lives in webSearchWithFallback.

const SEARCH_TIMEOUT_MS = 12_000;

export function parseTavilyResponse(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as any)?.results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, limit).map((r: any) => ({
    title: String(r?.title || "").slice(0, 160),
    url: String(r?.url || ""),
    snippet: String(r?.content || "").slice(0, 300),
  })).filter((r) => /^https?:\/\//i.test(r.url));
}

export function parseBraveResponse(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as any)?.web?.results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, limit).map((r: any) => ({
    title: String(r?.title || "").slice(0, 160),
    url: String(r?.url || ""),
    snippet: String(r?.description || "").slice(0, 300),
  })).filter((r) => /^https?:\/\//i.test(r.url));
}

export function parseExaResponse(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as any)?.results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, limit).map((r: any) => ({
    title: String(r?.title || "").slice(0, 160),
    url: String(r?.url || ""),
    snippet: String(r?.text || "").slice(0, 300),
  })).filter((r) => /^https?:\/\//i.test(r.url));
}

export function parseSearxngResponse(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as any)?.results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, limit).map((r: any) => ({
    title: String(r?.title || "").slice(0, 160),
    url: String(r?.url || ""),
    snippet: String(r?.content || "").slice(0, 300),
  })).filter((r) => /^https?:\/\//i.test(r.url));
}

async function jsonSearchFetch(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`search backend HTTP ${response.status}: ${detail.slice(0, 160)}`);
  }
  return response.json();
}

export async function tavilySearch(query: string, apiKey: string, maxResults: number, dateFilter?: string | null): Promise<WebSearchResult[]> {
  const body: Record<string, unknown> = { api_key: apiKey, query, max_results: maxResults };
  if (dateFilter) body.time_range = dateFilter === "day" ? "day" : dateFilter === "week" ? "week" : dateFilter === "month" ? "month" : "year";
  return parseTavilyResponse(await jsonSearchFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), maxResults);
}

export async function braveSearch(query: string, apiKey: string, maxResults: number, dateFilter?: string | null): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const year = dateFilter === "year" ? new Date().getFullYear() : null;
  if (year) {
    params.set("freshness", "py");
    params.set("tfpy", String(year));
  } else if (dateFilter === "month" || dateFilter === "week" || dateFilter === "day") {
    params.set("freshness", dateFilter === "day" ? "pd" : dateFilter === "week" ? "pw" : "pm");
  }
  return parseBraveResponse(await jsonSearchFetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { accept: "application/json", "x-subscription-token": apiKey },
  }), maxResults);
}

export async function exaSearch(query: string, apiKey: string, maxResults: number, dateFilter?: string | null): Promise<WebSearchResult[]> {
  const body: Record<string, unknown> = { query, numResults: maxResults, type: "auto" };
  if (dateFilter) body.startPublishedDate = new Date(Date.now() - (dateFilter === "day" ? 1 : dateFilter === "week" ? 7 : dateFilter === "month" ? 30 : 365) * 86_400_000).toISOString();
  return parseExaResponse(await jsonSearchFetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  }), maxResults);
}

export async function searxngSearch(query: string, baseUrl: string, maxResults: number, dateFilter?: string | null): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({ q: query, format: "json" });
  if (dateFilter) params.set("time_range", dateFilter);
  const base = baseUrl.replace(/\/+$/, "");
  return parseSearxngResponse(await jsonSearchFetch(`${base}/search?${params}`, {
    headers: { accept: "application/json" },
  }), maxResults);
}

export type SearchConfig = {
  backend?: "auto" | "tavily" | "brave" | "exa" | "searxng" | "ddg";
  tavilyKey?: string;
  braveKey?: string;
  exaKey?: string;
  searxngBaseUrl?: string;
};

/** Backend routing: explicit choice first, then "auto" = first configured
 *  key (Tavily > Brave > Exa > SearXNG), then the zero-config DDG scrape.
 *  A failing API backend falls back to DDG rather than failing the run. */
export async function webSearchWithFallback(query: string, maxResults: number, dateFilter: string | null, config?: SearchConfig): Promise<{ results: WebSearchResult[]; backend: string }> {
  const cfg = config || {};
  const order: Array<{ name: string; run: () => Promise<WebSearchResult[]> }> = [];
  const chosen = cfg.backend || "auto";
  const wants = (name: string) => chosen === "auto" || chosen === name;
  if (chosen !== "ddg") {
    if (wants("tavily") && cfg.tavilyKey) order.push({ name: "tavily", run: () => tavilySearch(query, cfg.tavilyKey!, maxResults, dateFilter) });
    if (wants("brave") && cfg.braveKey) order.push({ name: "brave", run: () => braveSearch(query, cfg.braveKey!, maxResults, dateFilter) });
    if (wants("exa") && cfg.exaKey) order.push({ name: "exa", run: () => exaSearch(query, cfg.exaKey!, maxResults, dateFilter) });
    if (wants("searxng") && cfg.searxngBaseUrl) order.push({ name: "searxng", run: () => searxngSearch(query, cfg.searxngBaseUrl!, maxResults, dateFilter) });
  }
  for (const candidate of order) {
    try {
      const results = await candidate.run();
      if (results.length) return { results, backend: candidate.name };
    } catch { /* next backend, then DDG */ }
  }
  return { results: await duckDuckGoSearch(query, maxResults, dateFilter), backend: "ddg" };
}

export async function duckDuckGoSearch(query: string, maxResults = MAX_RESULTS, dateFilter?: string | null): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ q: query });
    if (dateFilter) params.set("df", dateFilter);
    const response = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    const html = await response.text();
    const results: WebSearchResult[] = [];
    // Lite markup: <a rel="nofollow" href="URL">Title</a> ... <td class='result-snippet'>Snippet</td>
    const linkPattern = /<a\s+rel="nofollow"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = decodeHtmlEntities(match[1]);
      if (!/^https?:\/\//i.test(rawUrl)) continue;
      if (/duckduckgo\.com/i.test(rawUrl)) continue;
      const title = htmlToText(match[2]).slice(0, 160) || rawUrl;
      // The snippet cell follows the link row in the lite layout.
      const rest = html.slice(match.index, match.index + 4000);
      const snippetMatch = rest.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]).slice(0, 300) : "";
      results.push({ title, url: rawUrl, snippet });
    }
    return results;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createWebSearchTools(opts?: { onSearch?: (query: string, url: string) => void; beforeSearch?: () => string | null }) {
  const webSearchTool = tool(
    async ({ query, maxResults = MAX_RESULTS, freshness }: { query: string; maxResults?: number; freshness?: "day" | "week" | "month" | "year" }) => {
      const guard = opts?.beforeSearch?.();
      if (guard) return guard;
      const cleanQuery = query.trim();
      if (!cleanQuery) return "A search query is required.";
      // Visibility mirror: show the query in the built-in browser (Watching
      // users see the search happen; everyone else gets the follow banner).
      // Fire-and-forget — results come from the API below either way.
      try {
        opts?.onSearch?.(cleanQuery, `https://duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}`);
      } catch { /* mirror is best-effort */ }
      try {
        const searchConfig = await import("./store.js").then((m) => m.getSearchConfig().catch(() => ({})));
        const { results, backend } = await webSearchWithFallback(cleanQuery, Math.min(Math.max(maxResults, 1), 10), freshnessToDateFilter(freshness), searchConfig);
        if (!results.length) return `No web results found for "${cleanQuery}". Try different keywords.`;
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
        return `Web results for "${cleanQuery}" (via ${backend})${freshness ? ` (freshness: ${freshness})` : ""}:\n${lines.join("\n")}\n\nUse browser_fetch_api or browser_inspect on a result URL to read the full page before citing facts. For time-sensitive topics, note each source's publication date and prefer the most recent.`;
      } catch (error) {
        return `Web search failed: ${error instanceof Error ? error.message : String(error)}. Continue with local knowledge and say so.`;
      }
    },
    {
      name: "web_search",
      description: "Search the public web for current facts, docs, prices, news (free, no API key). Returns titles, URLs and snippets — then read promising pages with browser_fetch_api/browser_inspect before answering. For anything time-sensitive (latest releases, current prices, rankings, news), pass freshness so results are filtered to the requested window.",
      schema: z.object({
        query: z.string().describe("Search keywords, e.g. 'python-pptx add image to slide'. For time-sensitive topics include the current year."),
        maxResults: z.number().optional().describe("How many results to return (1-10, default 8)"),
        freshness: z.enum(["day", "week", "month", "year"]).optional().describe("Recency filter for time-sensitive topics: day, week, month, or year. Use it whenever the answer must reflect the current state (latest models, current prices, recent releases, news)."),
      }),
    }
  );
  return [webSearchTool];
}
