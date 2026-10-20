export type UrlSafetyReason =
  | "invalid"
  | "scheme"
  | "userinfo"
  | "loopback"
  | "private"
  | "link_local"
  | "single_label"
  | "local_name";

export type UrlSafety =
  | { safe: true; url: URL }
  | { safe: false; reason: UrlSafetyReason };

const LOCAL_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".lan",
  ".home.arpa",
];

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) {
    return undefined;
  }
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : undefined;
}

function classifyV4(p: number[]): UrlSafetyReason | undefined {
  const [a, b] = p;
  if (a === 127 || a === 0) {
    return "loopback";
  }
  if (a === 169 && b === 254) {
    return "link_local";
  }
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  ) {
    return "private";
  }
  return undefined;
}

function classifyV6(raw: string): UrlSafetyReason | undefined {
  const h = raw.toLowerCase();
  if (h === "::1" || h === "::") {
    return "loopback";
  }
  // IPv4-mapped (WHATWG serialises ::ffff:a.b.c.d as ::ffff:xxxx:xxxx).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]) ?? undefined;
  }
  if (/^fe[89ab]/.test(h)) {
    return "link_local";
  }
  if (/^f[cd]/.test(h) || /^ff/.test(h)) {
    return "private";
  }
  return undefined;
}

/**
 * Decides whether a URL may be fetched: only http and
 * https, no credentials, and no loopback, private, link-local, single-label
 * or local-only host names. Purely syntactic; no DNS lookup.
 */
export function checkUrl(input: string): UrlSafety {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { safe: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: "scheme" };
  }
  if (url.username || url.password) {
    return { safe: false, reason: "userinfo" };
  }
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (!host) {
    return { safe: false, reason: "invalid" };
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    const r = classifyV6(host.slice(1, -1));
    return r ? { safe: false, reason: r } : { safe: true, url };
  }
  const v4 = ipv4(host);
  if (v4) {
    const r = classifyV4(v4);
    return r ? { safe: false, reason: r } : { safe: true, url };
  }
  if (host === "localhost") {
    return { safe: false, reason: "loopback" };
  }
  if (!host.includes(".")) {
    return { safe: false, reason: "single_label" };
  }
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { safe: false, reason: "local_name" };
  }
  return { safe: true, url };
}

export function isSafeUrl(input: string): boolean {
  return checkUrl(input).safe;
}
