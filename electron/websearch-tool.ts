import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Free, keyless web search via DuckDuckGo Lite (plain HTML, no JS, no
// token handshake). Best-effort by design: if DDG is unreachable or changes
// markup, the tool reports it instead of failing the run.
const DDG_TIMEOUT_MS = 12000;
const MAX_RESULTS = 8;

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, num: string) => {
      try {
        return String.fromCodePoint(parseInt(num, 10));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export type WebSearchResult = { title: string; url: string; snippet: string };
export type WebImageResult = { title: string; imageUrl: string; sourceUrl: string };

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

/** Decode DuckDuckGo's image API response into safe, directly displayable URLs. */
export function parseDuckDuckGoImages(payload: unknown, limit = 5): WebImageResult[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const images: WebImageResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const imageUrl = safeHttpUrl(row.thumbnail || row.image);
    const sourceUrl = safeHttpUrl(row.url);
    if (!imageUrl || !isAllowedSearchImageHost(imageUrl) || !sourceUrl) continue;
    images.push({ title: String(row.title || "Relevant image").slice(0, 160), imageUrl, sourceUrl });
    if (images.length >= limit) break;
  }
  return images;
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
    return parseDuckDuckGoImages(await response.json(), limit);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createWebImageSearchTools(opts?: { beforeSearch?: () => string | null }) {
  return [tool(
    async ({ query, maxResults = 5 }: { query: string; maxResults?: number }) => {
      const guard = opts?.beforeSearch?.();
      if (guard) return guard;
      const cleanQuery = query.trim();
      if (!cleanQuery) return "An image search query is required.";
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

// DuckDuckGo Lite date filter: recency bias for time-sensitive queries
// ("latest", "current", prices, releases, rankings). Verified live: df=y
// reorders results toward pages from the requested window.
const FRESHNESS_DF: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

export function freshnessToDateFilter(freshness?: string): string | null {
  if (!freshness) return null;
  return FRESHNESS_DF[freshness.toLowerCase()] ?? null;
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
      const rawUrl = decodeEntities(match[1]);
      if (!/^https?:\/\//i.test(rawUrl)) continue;
      if (/duckduckgo\.com/i.test(rawUrl)) continue;
      const title = stripTags(match[2]).slice(0, 160) || rawUrl;
      // The snippet cell follows the link row in the lite layout.
      const rest = html.slice(match.index, match.index + 4000);
      const snippetMatch = rest.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
      const snippet = snippetMatch ? stripTags(snippetMatch[1]).slice(0, 300) : "";
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
        const results = await duckDuckGoSearch(cleanQuery, Math.min(Math.max(maxResults, 1), 10), freshnessToDateFilter(freshness));
        if (!results.length) return `No web results found for "${cleanQuery}". Try different keywords.`;
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
        return `Web results for "${cleanQuery}"${freshness ? ` (freshness: ${freshness})` : ""}:\n${lines.join("\n")}\n\nUse browser_fetch_api or browser_inspect on a result URL to read the full page before citing facts. For time-sensitive topics, note each source's publication date and prefer the most recent.`;
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
