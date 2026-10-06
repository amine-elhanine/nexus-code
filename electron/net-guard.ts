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
