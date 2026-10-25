/** Extract a local development URL from common dev-server output. */
export function isLikelyDevServerCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run)\s+)?(?:dev|start|preview)\b|\b(?:vite|next\s+dev|react-scripts\s+start|ng\s+serve|serve|http-server|uvicorn|flask\s+run|manage\.py\s+runserver|dotnet\s+run|cargo\s+run|go\s+run)\b/i.test(command || "");
}

export function extractLocalDevServerUrl(output: string): string | null {
  const plain = String(output || "").replace(/\u001b\[[0-9;]*m/g, "");
  const candidates = plain.match(/https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|\[::\])(?::\d{1,5})?(?:\/[^\s"'<>]*)?/gi) || [];
  for (const raw of candidates) {
    const cleaned = raw.replace(/[),.;]+$/, "");
    try {
      const url = new URL(cleaned);
      const host = url.hostname.toLowerCase();
      const ipv4 = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (host !== "localhost" && host !== "0.0.0.0" && host !== "[::1]" && host !== "[::]" &&
        !(ipv4 && ipv4.slice(1).every((octet) => Number(octet) <= 255))) continue;
      if (url.port && Number(url.port) > 65535) continue;
      if (host === "0.0.0.0" || host === "[::]") url.hostname = "localhost";
      return url.toString();
    } catch { /* try the next local URL */ }
  }
  return null;
}

/** Wait briefly for a loopback dev server before asking the built-in browser to load it. */
export async function waitForLocalServer(
  url: string,
  timeoutMs = 30_000,
  probe: (target: URL, signal: AbortSignal) => Promise<boolean> = async (target, signal) => {
    const response = await fetch(target, { signal, redirect: "manual" });
    await response.body?.cancel().catch(() => undefined);
    return true;
  },
): Promise<boolean> {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const ready = await probe(target, controller.signal);
      clearTimeout(timer);
      if (ready) return true;
    } catch {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() <= deadline);
  return false;
}
