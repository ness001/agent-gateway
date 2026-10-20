import { createHash, timingSafeEqual } from "node:crypto";

const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "proxy-authorization",
  "cookie",
];

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

/**
 * Headers that show a request came through a reverse proxy such as a dev
 * tunnel. Dev tunnels relay with standard X-Forwarded-* headers; the X-Ms-*
 * names cover tunnel-relay headers seen on devtunnels.ms traffic.
 */
export const TUNNEL_FORWARDING_HEADERS: readonly string[] = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-ms-tunnel-id",
  "x-ms-client-ip",
];

/** Removes hop-by-hop headers, including those named by Connection. */
export function stripHopByHopHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  const connection = headers.get("connection");
  if (connection) {
    for (const name of connection.split(",")) {
      const trimmed = name.trim();
      if (trimmed) {
        try {
          result.delete(trimmed);
        } catch {
          // Invalid header token; nothing to remove.
        }
      }
    }
  }
  for (const name of HOP_BY_HOP_HEADERS) {
    result.delete(name);
  }
  return result;
}

export function stripCallerCredentials(headers: Headers): Headers {
  const result = stripHopByHopHeaders(headers);
  for (const name of CREDENTIAL_HEADERS) {
    result.delete(name);
  }
  return result;
}

export function stripGeminiKeyQuery(search: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) {
    return "";
  }
  const parts = query.split("&").filter((part) => {
    const rawName = part.split("=", 1)[0].replace(/\+/g, " ");
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
    return name.toLowerCase() !== "key";
  });
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function extractPresentedApiKey(
  headers: Headers,
  search: string,
): string | undefined {
  const authorization = headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) {
      return match[1].trim();
    }
  }
  const apiKey = headers.get("x-api-key") ?? headers.get("x-goog-api-key");
  if (apiKey) {
    return apiKey.trim();
  }
  for (const [name, value] of new URLSearchParams(search)) {
    if (name.toLowerCase() === "key" && value) {
      return value;
    }
  }
  return undefined;
}

/** Returns true when no key is configured or the presented key matches. */
export function checkApiKey(
  configured: string | undefined,
  presented: string | undefined,
): boolean {
  if (!configured) {
    return true;
  }
  // Equal-length digests keep comparison time independent of key length.
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256")
    .update(presented ?? "")
    .digest();
  const equal = timingSafeEqual(expected, actual);
  return equal && presented !== undefined;
}

export function hasTunnelForwardingHeaders(headers: Headers): boolean {
  return TUNNEL_FORWARDING_HEADERS.some((name) => headers.has(name));
}
