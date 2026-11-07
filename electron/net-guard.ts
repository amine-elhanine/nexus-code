import { lookup as dnsLookup } from "node:dns/promises";

// Fetch-side SSRF guard for user-supplied URLs (website import, YouTube
// transcripts, the cloud parser endpoint). Loopback, private, link-local and
// other non-routable targets must never be fetched from the desktop app.
// The check runs at URL-accept time and again on post-redirect final URLs;
// a DNS-rebind between check and fetch is accepted residual risk for a
// desktop app acting on its user's behalf.

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: DnsResolver = (hostname) => dnsLookup(hostname, { all: true });

function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared range
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return a >= 224; // multicast + reserved
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/%.*$/, ""); // strip zone index
  // v4-mapped: both the dotted form (::ffff:10.0.0.1) and the canonical hex
  // form WHATWG URL parsing produces (::ffff:a00:1).
  const mappedDotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (addr === "::" || addr === "::1") return true; // unspecified, loopback
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true; // fe80::/10 link-local
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // Common intranet suffixes — blocking them costs nothing for public sites.
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  return false;
}

/** Hostname is itself an IP literal (v4 dotted quad or any v6 form). */
function ipLiteralCandidate(host: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  if (host.includes(":")) return host;
  return null;
}

function addressIsPrivate(address: string): boolean {
  return address.includes(":") ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

/**
 * Validates that a URL points at a fetchable public http(s) target and
 * returns the parsed URL. Throws with a user-facing message otherwise.
 * `resolve` is injectable for tests.
 */
export async function assertPublicHttpUrl(raw: string, resolve: DnsResolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL((raw || "").trim());
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be fetched.");
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "").replace(/%.*$/, "");
  if (isBlockedHostname(host)) {
    throw new Error("This address is local or private — only public websites can be fetched.");
  }
  const literal = ipLiteralCandidate(host);
  if (literal) {
    if (addressIsPrivate(literal)) {
      throw new Error("This address is local or private — only public websites can be fetched.");
    }
    return url;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(`Could not resolve "${url.hostname}" — check the address or your connection.`);
  }
  if (!addresses.length) {
    throw new Error(`Could not resolve "${url.hostname}" — check the address or your connection.`);
  }
  if (addresses.some((entry) => addressIsPrivate(entry.address))) {
    throw new Error("This website resolves to a local or private address — only public websites can be fetched.");
  }
  return url;
}

/** Non-throwing variant for crawl loops: true when the URL is fetchable. */
export async function isPublicHttpUrl(raw: string, resolve: DnsResolver = defaultResolver): Promise<boolean> {
  try {
    await assertPublicHttpUrl(raw, resolve);
    return true;
  } catch {
    return false;
  }
}

const MAX_SAFE_REDIRECTS = 5;

/**
 * SSRF-hardened fetch for user-supplied (or source-document-supplied) URLs.
 * Two layers beyond assertPublicHttpUrl:
 *
 * 1. CONNECT-TIME validation: a custom DNS lookup runs the same
 *    private-address check inside the socket connect, closing the
 *    check-then-fetch TOCTOU window (DNS rebinding) — a hostname that
 *    re-resolves to an internal IP between validation and connect fails
 *    right there, for every connection attempt including redirects.
 * 2. MANUAL redirect hops: each Location target is re-validated as a public
 *    http(s) URL before following (redirects can never smuggle the request
 *    to loopback/link-local/metadata targets).
 *
 * Uses the undici package explicitly so the dispatcher (pinned lookup) is
 * honored regardless of the runtime's bundled fetch internals.
 */
export async function safePublicFetch(
  raw: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; resolve?: DnsResolver; method?: string } = {}
): Promise<Response> {
  const { fetch: undiciFetch, Agent } = await import("undici");
  const resolver = options.resolve ?? defaultResolver;
  // Connect-time guard: every socket this agent opens re-checks the resolved
  // addresses, so DNS rebinding between URL validation and connect fails here.
  const agent = new Agent({
    connect: {
      lookup: (hostname: string, opts: any, callback: any) => {
        resolver(hostname)
          .then((addresses) => {
            if (!addresses.length) {
              callback(new Error(`Could not resolve "${hostname}"`));
              return;
            }
            if (addresses.some((entry) => addressIsPrivate(entry.address) || isBlockedHostname(hostname))) {
              callback(new Error("This address is local or private — only public websites can be fetched."));
              return;
            }
            // Hand undici the validated addresses only.
            callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
          })
          .catch((error) => callback(error instanceof Error ? error : new Error(String(error))));
      },
    },
  });

  let current = await assertPublicHttpUrl(raw, resolver);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_SAFE_REDIRECTS; hop++) {
    const response = await undiciFetch(current, {
      method: options.method ?? "GET",
      headers: options.headers,
      redirect: "manual",
      dispatcher: agent,
      signal: timeoutSignal,
    } as never);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response as unknown as Response;
      try {
        await response.body?.cancel();
      } catch { /* body already consumed */ }
      const next = new URL(location, current);
      current = await assertPublicHttpUrl(next.toString(), resolver);
      continue;
    }
    return response as unknown as Response;
  }
  throw new Error(`Too many redirects (${MAX_SAFE_REDIRECTS}) while fetching a public URL.`);
}
