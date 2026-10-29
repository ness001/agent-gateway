import type { GatewayErrorInfo, GatewayErrorKind } from "./types";

export interface ErrorKindInfo {
  status: number;
  /** Anthropic status when it differs (529 for overload). */
  anthropicStatus?: number;
  anthropicType: string;
  openaiType: string;
  googleStatus: string;
}

/** Single source of truth: kind -> HTTP status and per-protocol type names. */
export const ERROR_TABLE: Readonly<Record<GatewayErrorKind, ErrorKindInfo>> = {
  invalid_request: {
    status: 400,
    anthropicType: "invalid_request_error",
    openaiType: "invalid_request_error",
    googleStatus: "INVALID_ARGUMENT",
  },
  not_found: {
    status: 404,
    anthropicType: "not_found_error",
    openaiType: "invalid_request_error",
    googleStatus: "NOT_FOUND",
  },
  permission: {
    status: 403,
    anthropicType: "permission_error",
    openaiType: "permission_error",
    googleStatus: "PERMISSION_DENIED",
  },
  rate_limit: {
    status: 429,
    anthropicType: "rate_limit_error",
    openaiType: "rate_limit_error",
    googleStatus: "RESOURCE_EXHAUSTED",
  },
  upstream_rejected: {
    status: 400,
    anthropicType: "invalid_request_error",
    openaiType: "invalid_request_error",
    googleStatus: "INVALID_ARGUMENT",
  },
  upstream_error: {
    status: 502,
    anthropicType: "api_error",
    openaiType: "server_error",
    googleStatus: "UNAVAILABLE",
  },
  overloaded: {
    status: 503,
    anthropicStatus: 529,
    anthropicType: "overloaded_error",
    openaiType: "service_unavailable_error",
    googleStatus: "UNAVAILABLE",
  },
  timeout: {
    status: 504,
    anthropicType: "timeout_error",
    openaiType: "server_error",
    googleStatus: "DEADLINE_EXCEEDED",
  },
  tool_unavailable: {
    status: 400,
    anthropicType: "invalid_request_error",
    openaiType: "invalid_request_error",
    googleStatus: "FAILED_PRECONDITION",
  },
  unsupported: {
    status: 400,
    anthropicType: "invalid_request_error",
    openaiType: "invalid_request_error",
    googleStatus: "INVALID_ARGUMENT",
  },
  internal: {
    status: 500,
    anthropicType: "api_error",
    openaiType: "server_error",
    googleStatus: "INTERNAL",
  },
};

export class GatewayError extends Error implements GatewayErrorInfo {
  readonly kind: GatewayErrorKind;
  readonly param?: string;
  readonly providerCode?: string;
  readonly retryAfter?: number;
  constructor(
    kind: GatewayErrorKind,
    message: string,
    opts: { param?: string; providerCode?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    if (opts.param !== undefined) {
      this.param = opts.param;
    }
    if (opts.providerCode !== undefined) {
      this.providerCode = opts.providerCode;
    }
    if (opts.retryAfter !== undefined) {
      this.retryAfter = opts.retryAfter;
    }
  }
  get status(): number {
    return ERROR_TABLE[this.kind].status;
  }
}

export const COPILOT_REJECTED_PREFIX = "Copilot rejected the request: ";
export const PERMISSION_HINT =
  "This extension is not allowed to use the selected language model. Approve the consent prompt in VS Code (choose 'Allow'), or grant access with the 'Manage Language Model Access' command, then retry.";
export const TIMEOUT_HINT =
  "The language model request timed out. VS Code may be waiting for you to approve a model-access consent dialog; check the VS Code window and retry.";
export const MAX_INNER_MESSAGE = 500;

/** Remove token-like strings (bearer tokens, GitHub/OpenAI keys, long opaque blobs). */
export function stripSecrets(text: string): string {
  return text
    .replace(
      /\b(bearer|token|authorization|api[-_]?key)(["'\s:=]+)[^\s"',}]+/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_.-]{40,}/g, "[redacted]");
}

export function truncate(text: string, max = MAX_INNER_MESSAGE): string {
  return text.length <= max ? text : text.slice(0, max) + "...";
}

function innerMessage(body: string): string {
  try {
    const v: unknown = JSON.parse(body);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const e = o.error;
      if (e && typeof e === "object") {
        const m = (e as Record<string, unknown>).message;
        if (typeof m === "string") {
          return m;
        }
      }
      if (typeof e === "string") {
        return e;
      }
      if (typeof o.message === "string") {
        return o.message;
      }
    }
  } catch {
    // not JSON: fall back to the raw text
  }
  return body;
}

function clean(text: string): string {
  return truncate(stripSecrets(text.trim()));
}

/** Seconds from "retry after N seconds" / "Retry-After: N" in a provider message. */
export function retryAfterSeconds(text: string): number | undefined {
  const m = /retry[- ]after[\s:"]*(\d{1,6})/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

const FAILED_RE = /Request Failed:\s*(\d{3})\s*([\s\S]*)$/i;

/** Provider text for an input that exceeds the model's context window. */
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the context window|input is too long|too many (input )?tokens/i;

/** Provider text for exhausted credits or quota (not a transient rate limit). */
const QUOTA_RE =
  /credit limit|reached your (credit|usage|monthly|premium)|quota (exceeded|exhausted)|insufficient_quota/i;

/** OpenAI-compatible code clients use to detect a full context window. */
export const CONTEXT_LENGTH_EXCEEDED = "context_length_exceeded";

/** Classify anything thrown by LanguageModelChat.sendRequest or its stream. */
export function classifyLmError(err: unknown): GatewayError {
  if (err instanceof GatewayError) {
    return err;
  }
  const obj =
    err && typeof err === "object"
      ? (err as Record<string, unknown>)
      : undefined;
  const code = typeof obj?.code === "string" ? obj.code : undefined;
  const name = typeof obj?.name === "string" ? obj.name : undefined;
  const rawMsg =
    typeof obj?.message === "string"
      ? obj.message
      : typeof err === "string"
        ? err
        : String(err);
  const opt = code ? { providerCode: code } : {};

  if (code === "NoPermissions") {
    return new GatewayError("permission", PERMISSION_HINT, opt);
  }
  if (CONTEXT_OVERFLOW_RE.test(rawMsg)) {
    const inner = clean(innerMessage(FAILED_RE.exec(rawMsg)?.[2] ?? rawMsg));
    return new GatewayError(
      "upstream_rejected",
      COPILOT_REJECTED_PREFIX +
        inner +
        ". The conversation exceeds the model's context window; compact or shorten it and retry.",
      { providerCode: CONTEXT_LENGTH_EXCEEDED },
    );
  }
  if (QUOTA_RE.test(rawMsg)) {
    const inner = clean(innerMessage(FAILED_RE.exec(rawMsg)?.[2] ?? rawMsg));
    return new GatewayError("rate_limit", "Copilot quota exhausted: " + inner, {
      providerCode: code ?? "insufficient_quota",
    });
  }
  if (code === "Blocked") {
    return new GatewayError(
      "rate_limit",
      "The language model request was blocked (rate limited or quota exhausted): " +
        clean(rawMsg),
      opt,
    );
  }
  if (code === "NotFound") {
    return new GatewayError(
      "not_found",
      "Language model not found: " + clean(rawMsg),
      opt,
    );
  }

  const m = FAILED_RE.exec(rawMsg);
  if (m) {
    const status = Number(m[1]);
    const body = m[2] ?? "";
    const inner = clean(innerMessage(body));
    const pc = { providerCode: code ?? String(status) };
    if (status === 404 || /model_not_supported/.test(body)) {
      return new GatewayError("not_found", "Model not supported: " + inner, pc);
    }
    if (status === 401 || status === 403) {
      return new GatewayError(
        "permission",
        PERMISSION_HINT + " (" + inner + ")",
        pc,
      );
    }
    if (status === 429) {
      const retryAfter = retryAfterSeconds(body);
      return new GatewayError("rate_limit", "Copilot rate limit: " + inner, {
        ...pc,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      });
    }
    if (status === 529 || /overloaded/i.test(body)) {
      return new GatewayError(
        "overloaded",
        `Copilot is overloaded (${status}): ${inner}`,
        pc,
      );
    }
    if (status === 413) {
      return new GatewayError(
        "upstream_rejected",
        COPILOT_REJECTED_PREFIX + "request too large: " + inner,
        pc,
      );
    }
    if (status >= 500) {
      return new GatewayError(
        "upstream_error",
        `Copilot upstream error ${status}: ${inner}`,
        pc,
      );
    }
    if (status >= 400) {
      return new GatewayError(
        "upstream_rejected",
        COPILOT_REJECTED_PREFIX + inner,
        pc,
      );
    }
  }
  if (name === "TimeoutError" || /\btimed? ?out\b/i.test(rawMsg)) {
    return new GatewayError("timeout", TIMEOUT_HINT, opt);
  }
  return new GatewayError("internal", clean(rawMsg) || "Internal error", opt);
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Echo a caller-supplied request id when safe, otherwise generate one. */
export function resolveRequestId(
  callerId: string | null | undefined,
  generate: () => string,
): string {
  return callerId && REQUEST_ID_RE.test(callerId) ? callerId : generate();
}

export function anthropicErrorBody(e: GatewayErrorInfo, requestId: string) {
  return {
    type: "error",
    error: { type: ERROR_TABLE[e.kind].anthropicType, message: e.message },
    request_id: requestId,
  };
}

export function openaiErrorBody(e: GatewayErrorInfo, requestId: string) {
  return {
    error: {
      message: e.message,
      type: ERROR_TABLE[e.kind].openaiType,
      param: e.param ?? null,
      code: e.providerCode ?? null,
    },
    request_id: requestId,
  };
}

export function googleErrorBody(e: GatewayErrorInfo, requestId: string) {
  const t = ERROR_TABLE[e.kind];
  return {
    error: { code: t.status, message: e.message, status: t.googleStatus },
    request_id: requestId,
  };
}

export type ErrorProtocol = "anthropic" | "openai" | "google";

/** HTTP status for an error kind in a protocol (Anthropic uses 529 for overload). */
export function statusFor(
  protocol: ErrorProtocol,
  e: GatewayErrorInfo,
): number {
  const t = ERROR_TABLE[e.kind];
  return protocol === "anthropic" ? (t.anthropicStatus ?? t.status) : t.status;
}

/** Headers every error response carries: both request-id spellings, and Retry-After when known. */
export function errorHeaders(
  e: GatewayErrorInfo,
  requestId: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "request-id": requestId,
    "x-request-id": requestId,
    ...(e.retryAfter !== undefined
      ? { "retry-after": String(e.retryAfter) }
      : {}),
  };
}

/** JSON error Response with table status and both request-id headers. */
export function errorResponse(
  protocol: ErrorProtocol,
  e: GatewayErrorInfo,
  requestId: string,
): Response {
  const body =
    protocol === "anthropic"
      ? anthropicErrorBody(e, requestId)
      : protocol === "openai"
        ? openaiErrorBody(e, requestId)
        : googleErrorBody(e, requestId);
  return new Response(JSON.stringify(body), {
    status: statusFor(protocol, e),
    headers: errorHeaders(e, requestId),
  });
}

export interface ErrorJournal {
  noteRequestError?(kind: string, providerCode?: string): void;
}

/** Report a failure to the error journal; never throws. */
export function noteRequestError(
  journal: ErrorJournal | undefined,
  meta: GatewayErrorInfo,
): void {
  try {
    journal?.noteRequestError?.(meta.kind, meta.providerCode);
  } catch {
    // journal failures must not affect the response
  }
}
