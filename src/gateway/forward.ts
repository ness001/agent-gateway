import { flattenTopLevelComposition } from "../protocol/core/lmRequest";
import {
  stripCallerCredentials,
  stripGeminiKeyQuery,
  stripHopByHopHeaders,
} from "./credentials";
import type { RemoteUpstreamConfig } from "./types";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function flattenSchemaFields(tool: Rec): Rec {
  let out = tool;
  for (const key of ["parameters", "input_schema"] as const) {
    if (isRec(out[key])) {
      out = { ...out, [key]: flattenTopLevelComposition(out[key]) };
    }
  }
  if (isRec(out.function) && isRec(out.function.parameters)) {
    out = {
      ...out,
      function: {
        ...out.function,
        parameters: flattenTopLevelComposition(out.function.parameters),
      },
    };
  }
  if (Array.isArray(out.tools)) {
    out = {
      ...out,
      tools: out.tools.map((t) => (isRec(t) ? flattenSchemaFields(t) : t)),
    };
  }
  return out;
}

/**
 * A remote gateway may run an older build that sends tool schemas with
 * top-level oneOf/allOf/anyOf, which Copilot rejects. Flatten them here too.
 */
export function flattenToolSchemas(body: Rec): Rec {
  if (!Array.isArray(body.tools)) {
    return body;
  }
  return {
    ...body,
    tools: body.tools.map((t) => (isRec(t) ? flattenSchemaFields(t) : t)),
  };
}

export type RemoteFailureCategory =
  | "connection refused"
  | "connection reset"
  | "DNS lookup failed"
  | "TLS error"
  | "timeout"
  | "aborted"
  | "network error";

const HINTS: Record<RemoteFailureCategory, string> = {
  "connection refused": "Check that devtunnel host is running on that machine.",
  "connection reset": "Check that devtunnel host is running on that machine.",
  "DNS lookup failed": "Check the remote URL in the gateway settings.",
  "TLS error": "Check the remote URL and its certificate.",
  timeout:
    "The remote did not respond in time; check the tunnel and that machine's gateway.",
  aborted: "The request was cancelled.",
  "network error": "Check the remote URL and that the tunnel is running.",
};

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== "object") {
      break;
    }
    const o = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof o.code === "string") {
      codes.push(o.code);
    }
    if (typeof o.name === "string") {
      codes.push(`name:${o.name}`);
    }
    if (o instanceof AggregateError) {
      for (const e of o.errors) {
        codes.push(...errorCodes(e));
      }
    }
    current = o.cause;
  }
  return codes;
}

/** Categorizes from error codes only; raw messages may echo URLs or tokens. */
export function classifyRemoteError(
  error: unknown,
  signal?: AbortSignal,
): RemoteFailureCategory {
  const codes = errorCodes(error);
  const has = (re: RegExp) => codes.some((c) => re.test(c));
  if (
    has(
      /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|name:TimeoutError)$/,
    )
  ) {
    return "timeout";
  }
  if (signal?.aborted || has(/^(ABORT_ERR|name:AbortError)$/)) {
    return "aborted";
  }
  if (has(/^ECONNREFUSED$/)) {
    return "connection refused";
  }
  if (has(/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/)) {
    return "DNS lookup failed";
  }
  if (
    has(
      /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_(GET|VERIFY)_|ERR_OSSL)/,
    )
  ) {
    return "TLS error";
  }
  if (has(/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/)) {
    return "connection reset";
  }
  return "network error";
}

export class RemoteUnavailableError extends Error {
  readonly status: number;
  constructor(
    readonly remoteName: string,
    readonly category: RemoteFailureCategory = "network error",
  ) {
    super(
      `Remote upstream '${remoteName}' is unavailable: ${category}. ${HINTS[category]}`,
    );
    this.name = "RemoteUnavailableError";
    // 504 only when the remote may be alive but slow; otherwise it is a bad gateway.
    this.status = category === "timeout" ? 504 : 502;
  }
}

export interface ForwardToRemoteArgs {
  remote: RemoteUpstreamConfig;
  apiKey?: string;
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body?: Record<string, unknown>;
  upstreamModelId: string;
  gemini?: { action: string };
  signal: AbortSignal;
  /** Forwarded as x-request-id so the remote gateway logs the same ID. */
  requestId?: string;
  fetchImpl?: typeof fetch;
}

export async function forwardToRemote(
  args: ForwardToRemoteArgs,
): Promise<Response> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = stripCallerCredentials(args.headers);
  // fetch decodes compressed bodies, so let it negotiate encoding itself.
  headers.delete("accept-encoding");
  if (args.apiKey) {
    headers.set("authorization", `Bearer ${args.apiKey}`);
  }
  if (args.requestId) {
    headers.set("x-request-id", args.requestId);
  }

  let target: string;
  let body: string | undefined;
  if (args.gemini) {
    const model = encodeURIComponent(args.upstreamModelId);
    target = `${args.remote.url}/v1beta/models/${model}:${args.gemini.action}${stripGeminiKeyQuery(args.search)}`;
    body = args.body === undefined ? undefined : JSON.stringify(args.body);
  } else {
    target = `${args.remote.url}${args.path}${args.search}`;
    body =
      args.body === undefined
        ? undefined
        : JSON.stringify({
            ...flattenToolSchemas(args.body),
            model: args.upstreamModelId,
          });
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: args.method,
      headers,
      body,
      signal: args.signal,
      redirect: "manual",
    });
  } catch (error) {
    throw new RemoteUnavailableError(
      args.remote.name,
      classifyRemoteError(error, args.signal),
    );
  }

  const responseHeaders = stripHopByHopHeaders(upstream.headers);
  responseHeaders.delete("content-encoding");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
