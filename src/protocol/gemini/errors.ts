import {
  ERROR_TABLE,
  GatewayError,
  errorHeaders,
  googleErrorBody,
} from "../core/errors";
import type { GatewayErrorInfo } from "../core/types";

export const MALFORMED_JSON_MESSAGE = "Malformed JSON in request body";

export type GoogleStatus =
  | "INVALID_ARGUMENT"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RESOURCE_EXHAUSTED"
  | "FAILED_PRECONDITION"
  | "UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL"
  | "UNIMPLEMENTED";

export interface GeminiErrorEnvelope {
  error: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
  request_id: string;
}

function json(
  status: number,
  body: unknown,
  requestId: string,
  e?: GatewayErrorInfo,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: e
      ? errorHeaders(e, requestId)
      : {
          "content-type": "application/json",
          "request-id": requestId,
          "x-request-id": requestId,
        },
  });
}

/** Envelope for a classified gateway error (status from the core kind table). */
export function geminiErrorResponse(
  e: GatewayErrorInfo,
  requestId: string,
): Response {
  return json(
    ERROR_TABLE[e.kind].status,
    googleErrorBody(e, requestId),
    requestId,
    e,
  );
}

/** Envelope with an explicit HTTP code and status name (routing-level errors). */
export function geminiRawError(
  code: number,
  status: GoogleStatus,
  message: string,
  requestId: string,
  details?: unknown[],
): Response {
  const error: GeminiErrorEnvelope["error"] = { code, message, status };
  if (details) {
    error.details = details;
  }
  const body: GeminiErrorEnvelope = { error, request_id: requestId };
  return json(code, body, requestId);
}

/** Returned as 400 text/plain. */
export function geminiMalformedJson(requestId: string): Response {
  return new Response(MALFORMED_JSON_MESSAGE, {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

/** Unsupported route gives 404 NOT_FOUND. */
export function geminiUnsupportedRoute(
  message: string,
  requestId: string,
): Response {
  return geminiRawError(404, "NOT_FOUND", message, requestId);
}

/** Non-POST on a known route: 405 with `allow: POST`. */
export function geminiMethodNotAllowed(
  message: string,
  requestId: string,
): Response {
  const r = geminiRawError(405, "UNIMPLEMENTED", message, requestId);
  r.headers.set("allow", "POST");
  return r;
}

/** Unknown model gives 404 NOT_FOUND. */
export function geminiModelNotFound(
  model: string,
  requestId: string,
  reason?: string,
): Response {
  return geminiErrorResponse(
    new GatewayError(
      "not_found",
      reason ?? `Model ${model} is not found or not supported.`,
    ),
    requestId,
  );
}
