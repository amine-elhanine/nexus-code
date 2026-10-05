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
