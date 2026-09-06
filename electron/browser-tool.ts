import { tool } from "@langchain/core/tools";
import { z } from "zod";

function cleanHtmlToText(html: string): string {
  // Strip script and style blocks
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  // Replace tags with space or newline
  text = text.replace(/<(?:p|div|h[1-6]|li|tr)[^>]*>/gi, "\n");
  text = text.replace(/<br\s*[\/]?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function extractHeadingsAndControls(html: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "No title";

  const headings: string[] = [];
  const headingRegex = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRegex.exec(html)) !== null && headings.length < 15) {
    const text = hMatch[2].replace(/<[^>]+>/g, "").trim();
    if (text) headings.push(`${hMatch[1].toUpperCase()}: ${text}`);
  }

  const buttons: string[] = [];
  const buttonRegex = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let bMatch: RegExpExecArray | null;
  while ((bMatch = buttonRegex.exec(html)) !== null && buttons.length < 15) {
    const text = bMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text) buttons.push(text);
  }

  const links: string[] = [];
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lMatch: RegExpExecArray | null;
  while ((lMatch = linkRegex.exec(html)) !== null && links.length < 15) {
    const href = lMatch[1];
    const text = lMatch[2].replace(/<[^>]+>/g, "").trim();
    if (text && !href.startsWith("javascript:")) links.push(`${text} -> ${href}`);
  }

  const inputs: string[] = [];
  const inputRegex = /<input\s+[^>]*>/gi;
  let iMatch: RegExpExecArray | null;
  while ((iMatch = inputRegex.exec(html)) !== null && inputs.length < 10) {
    const tag = iMatch[0];
    const nameMatch = tag.match(/name=["']([^"']+)["']/i);
    const typeMatch = tag.match(/type=["']([^"']+)["']/i);
    const placeholderMatch = tag.match(/placeholder=["']([^"']+)["']/i);
    inputs.push(`input[type="${typeMatch ? typeMatch[1] : "text"}"] name="${nameMatch ? nameMatch[1] : ""}" placeholder="${placeholderMatch ? placeholderMatch[1] : ""}"`);
  }

  return { title, headings, buttons, links, inputs };
}

export function createBrowserTools(_projectRoot?: string) {
  // fetch follows redirects transparently, which would let a loopback URL
  // 302-hop straight to an external host. Redirects are handled manually and
  // every hop re-checked against the same policy.
  const MAX_REDIRECTS = 5;

  const fetchWithRedirectControl = async (targetUrl: string, init: RequestInit): Promise<Response> => {
    let url = targetUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(url, { ...init, redirect: "manual" });
      // fetch types opaque/opaqueredirect only occur in browser contexts; here
      // a 3xx with a Location header is the redirect case to follow.
      const status = response.status;
      if (status < 300 || status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      url = next.toString();
    }
    throw new Error(`Too many redirects (>${MAX_REDIRECTS}) following ${targetUrl}`);
  };

  const normalizeUrl = (raw: string) => {
    let target = raw.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = `http://${target}`;
    }
    return new URL(target).toString();
  };

  const browserInspectTool = tool(
    async ({ url }: { url: string }) => {
      try {
        const targetUrl = normalizeUrl(url);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const startTime = Date.now();
        const response = await fetchWithRedirectControl(targetUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Nexus/1.0",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        clearTimeout(timeoutId);

        const durationMs = Date.now() - startTime;
        const contentType = response.headers.get("content-type") || "";
        const rawBody = await response.text();

        if (contentType.includes("application/json")) {
          return `[HTTP ${response.status} ${response.statusText} (${durationMs}ms)]\nContent-Type: ${contentType}\n\nJSON Body:\n${rawBody.slice(0, 4000)}`;
        }

        const { title, headings, buttons, links, inputs } = extractHeadingsAndControls(rawBody);
        const textContent = cleanHtmlToText(rawBody).slice(0, 3000);

        let report = `=== Page Inspection: ${targetUrl} ===\n`;
        report += `Status: ${response.status} ${response.statusText} (${durationMs}ms)\n`;
        report += `Page Title: "${title}"\n\n`;

        if (headings.length > 0) {
          report += `Headings Structure:\n${headings.map((h) => `  • ${h}`).join("\n")}\n\n`;
        }
        if (buttons.length > 0) {
          report += `Interactive Buttons:\n${buttons.map((b) => `  [Button: "${b}"]`).join("\n")}\n\n`;
        }
        if (inputs.length > 0) {
          report += `Form Inputs:\n${inputs.map((i) => `  <${i}>`).join("\n")}\n\n`;
        }
        if (links.length > 0) {
          report += `Navigation Links:\n${links.map((l) => `  • ${l}`).join("\n")}\n\n`;
        }

        report += `Visible Page Text Content (Excerpt):\n----------------------------------------\n${textContent}\n----------------------------------------`;
        return report;
      } catch (error: any) {
        if (error.name === "AbortError") {
          return `Failed to inspect ${url}: Request timed out after 10 seconds. Verify the server is running on that port.`;
        }
        return `Failed to inspect ${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "browser_inspect",
      description: "Inspects a local or remote web page (e.g. 'http://localhost:3000' or 'http://127.0.0.1:5173'). Extracts page title, headings, interactive buttons, form inputs, links, and readable text to verify UI state and web apps.",
      schema: z.object({
        url: z.string().describe("The URL to inspect (e.g. 'http://localhost:3000', 'http://127.0.0.1:8080/api/health')"),
      }),
    }
  );

  const browserFetchApiTool = tool(
    async ({ url, method = "GET", headers = {}, body }: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
      try {
        const targetUrl = normalizeUrl(url);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const startTime = Date.now();
        const response = await fetchWithRedirectControl(targetUrl, {
          method: method.toUpperCase(),
          headers: {
            "User-Agent": "Nexus-Agent/1.0",
            ...headers,
          },
          body: body && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD" ? body : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const durationMs = Date.now() - startTime;
        const resText = await response.text();

        return `[HTTP ${response.status} ${response.statusText} (${durationMs}ms)]\nHeaders: ${JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2)}\n\nResponse Body:\n${resText.slice(0, 4000)}`;
      } catch (error: any) {
        return `API Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "browser_fetch_api",
      description: "Sends an HTTP request to test web APIs, backend endpoints, or healthchecks, returning response status, latency, headers, and body.",
      schema: z.object({
        url: z.string().describe("API endpoint URL to request"),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]).default("GET").describe("HTTP method"),
        headers: z.record(z.string(), z.string()).optional().describe("Optional request headers"),
        body: z.string().optional().describe("Optional request body for POST/PUT/PATCH"),
      }),
    }
  );

  return [browserInspectTool, browserFetchApiTool];
}
