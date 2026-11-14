import { isIP } from "node:net";
import { CacheError } from "./errors.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal"];

/** Only the shapes we can prove non-public; a hostname that resolves privately is a DNS-policy question. */
export function isPrivateIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second, third] = parts as [number, number, number, number];
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 192 && second === 0 && third === 0) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first >= 224) return true;
  return false;
}

/** Eight 16-bit words, because the WHATWG URL parser hands back compressed hex and dotted forms must not hide. */
function ipv6Words(address: string): number[] | null {
  const text = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (isIP(text) !== 6) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const words = (list: string[]) => list.map((group) => Number.parseInt(group, 16));
  const head = words(groups(halves[0]));
  const tail = words(groups(halves[1]));
  if (halves.length === 1) return head.length === 8 ? head : null;
  const zeros = 8 - head.length - tail.length;
  return zeros >= 1 ? [...head, ...new Array<number>(zeros).fill(0), ...tail] : null;
}

const ipv4From = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

function isPrivateIpv6(words: number[]) {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words as [number, number, number, number, number, number, number, number];
  const empty = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
  if (empty && w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) return true;
  // ::ffff:a.b.c.d and the deprecated ::a.b.c.d carry an IPv4 address in the low 32 bits.
  if (empty && (w5 === 0xffff || w5 === 0)) return isPrivateIpv4(ipv4From(w6, w7));
  // ::ffff:0:a.b.c.d (the RFC 2765 translated prefix) is never a public destination either.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff) return true;
  if ((w0 & 0xfe00) === 0xfc00) return true;
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;
  if ((w0 & 0xff00) === 0xff00) return true;
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return true;
  if (w0 === 0x2002) return true;
  if (w0 === 0x2001 && w1 === 0x0db8) return true;
  return false;
}

/**
 * The Controller is authenticated, but a URL is still attacker-influenced input for a node sitting in
 * a private network: https only, no credentials, and no literal address that points back inside.
 */
export function assertAllowedOriginUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new CacheError("CACHE_URL_INVALID", "The origin URL cannot be parsed"); }
  if (url.protocol !== "https:") throw new CacheError("CACHE_URL_FORBIDDEN", "Only https origins can be cached");
  if (url.username || url.password) throw new CacheError("CACHE_URL_FORBIDDEN", "Origin URLs must not embed credentials");
  // A trailing dot is the same FQDN to the resolver, so classification has to drop it first.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (host.length === 0) throw new CacheError("CACHE_URL_FORBIDDEN", "The origin URL has no host");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new CacheError("CACHE_URL_FORBIDDEN", "The origin host is not a public hostname");
  }
  if (isIP(host) === 4) {
    if (isPrivateIpv4(host)) throw new CacheError("CACHE_URL_FORBIDDEN", "The origin address is not public");
    return url;
  }
  if (host.includes(":")) {
    const words = ipv6Words(host);
    if (!words || isPrivateIpv6(words)) throw new CacheError("CACHE_URL_FORBIDDEN", "The origin address is not public");
  }
  return url;
}
