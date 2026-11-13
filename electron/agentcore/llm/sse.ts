// Streaming HTTP plumbing for the provider adapters: an SSE line parser and a
// fetch wrapper whose errors preserve what the run's error classification
// reads (status, headers for Retry-After, provider body text for the
// rate-limit/context-window regexes). Where LangChain surfaced provider
// errors as APIError objects, these carry the same signal shape.

export interface SSEResult {
  status: number;
  headers: Record<string, string>;
  /** Iterates parsed `data:` payloads; empty lines and comments are skipped. */
  events(): AsyncGenerator<string, void, unknown>;
  raw(): Response;
}

export function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

export class ProviderHttpError extends Error {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  provider: string;
  constructor(provider: string, status: number, headers: Record<string, string>, bodyText: string) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
    // Extract the most model-relevant error text so the transient/rate-limit/
    // context-window classifiers (regexes over message + status) keep working.
    const payload = parsed as any;
    const providerMessage =
      payload?.error?.message ||
      payload?.message ||
      payload?.error?.type ||
      (typeof payload === "string" ? payload.slice(0, 400) : "");
    const typeTag = payload?.error?.type || payload?.type || "";
    super(`HTTP ${status}${typeTag ? ` (${typeTag})` : ""}: ${providerMessage || bodyText.slice(0, 400) || "provider error"}`);
    this.name = "ProviderHttpError";
    this.provider = provider;
    this.status = status;
    this.headers = headers;
    this.body = parsed;
    (this as any).error = parsed;
    (this as any).body = parsed;
  }
}

/** POST JSON and require a 200 — non-2xx becomes ProviderHttpError. */
export async function postJSON(url: string, body: unknown, headers: Record<string, string>, provider: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ProviderHttpError(provider, response.status, headerMap(response.headers), text);
  }
  return response;
}

/** Parses an SSE stream off a fetch response body. */
export function sseFrom(response: Response): SSEResult {
  const headers = headerMap(response.headers);
  const status = response.status;
  if (!response.body) {
    throw new ProviderHttpError("stream", status, headers, "empty response");
  }
  const reader = response.body.getReader();
  async function* events(): AsyncGenerator<string, void, unknown> {
    const decoder = new TextDecoder();
    let buffer = "";
    // Per the SSE spec, consecutive `data:` lines belong to ONE event, joined
    // with "\n", dispatched by the next blank line. Yielding each data line
    // separately fragmented any payload a provider/gateway split across
    // data: lines — the fragments failed JSON.parse and were silently
    // dropped mid-stream by every adapter.
    let dataLines: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf("\n");
          if (line === "") {
            // Blank line = event dispatch.
            if (dataLines.length) {
              yield dataLines.join("\n");
              dataLines = [];
            }
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          } else if (line.startsWith("{")) {
            // Some gateways omit the "data:" prefix entirely.
            if (dataLines.length) {
              yield dataLines.join("\n");
              dataLines = [];
            }
            yield line;
          }
          // event:/id:/retry: and comment lines are ignored, as before.
        }
      }
      if (dataLines.length) {
        yield dataLines.join("\n");
        dataLines = [];
      }
      const rest = buffer.trim();
      if (rest.startsWith("data:")) yield rest.slice(5).trim();
      else if (rest.startsWith("{")) yield rest;
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
  return { status, headers, events, raw: () => response };
}
