import { isValidGeminiModelSegment } from "../../gateway/match";

export type GeminiOperation =
  | "generateContent"
  | "streamGenerateContent"
  | "countTokens";

export interface GeminiRoute {
  model: string;
  operation: GeminiOperation;
  /** true for streamGenerateContent. */
  stream: boolean;
  /** "sse" with alt=sse, "array" for streaming without it, else "json". */
  framing: "json" | "sse" | "array";
  /** Query string with `key` removed (never logged or forwarded). */
  query: URLSearchParams;
}

export type GeminiRouteFailure =
  | "unsupported_route"
  | "method_not_allowed"
  | "invalid_model";

export type GeminiRouteResult =
  | { ok: true; route: GeminiRoute }
  | { ok: false; reason: GeminiRouteFailure; message: string };

export const UNSUPPORTED_ROUTE_MESSAGE = "Unsupported Gemini route.";

const OPS: ReadonlySet<string> = new Set([
  "generateContent",
  "streamGenerateContent",
  "countTokens",
]);
const PATH_RE = /^\/v1beta\/models\/([^/]+):([A-Za-z]+)$/;

/**
 * Parse `/v1beta/models/{model}:{op}`. This parser does not inspect
 * bodies; hosted tools are handled by the Gemini adapter.
 */
export function parseGeminiRoute(
  method: string,
  url: URL | string,
): GeminiRouteResult {
  const u = typeof url === "string" ? new URL(url, "http://localhost") : url;
  const m = PATH_RE.exec(u.pathname);
  if (!m || !OPS.has(m[2] ?? "")) {
    return {
      ok: false,
      reason: "unsupported_route",
      message: UNSUPPORTED_ROUTE_MESSAGE,
    };
  }
  const verb = method.toUpperCase();
  if (verb !== "POST") {
    return {
      ok: false,
      reason: "method_not_allowed",
      message: `Method ${verb} not allowed; use POST.`,
    };
  }
  const rawModel = m[1] ?? "";
  let model = "";
  try {
    model = decodeURIComponent(rawModel);
  } catch {
    model = "";
  }
  if (!isValidGeminiModelSegment(model)) {
    return {
      ok: false,
      reason: "invalid_model",
      message: `Invalid model name: ${JSON.stringify(rawModel)}.`,
    };
  }
  const operation = m[2] as GeminiOperation;
  const query = new URLSearchParams(u.searchParams);
  query.delete("key");
  const stream = operation === "streamGenerateContent";
  const framing = !stream
    ? "json"
    : query.get("alt") === "sse"
      ? "sse"
      : "array";
  return { ok: true, route: { model, operation, stream, framing, query } };
}
