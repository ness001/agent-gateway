import { GatewayError, errorResponse } from "../../core/errors";
import type { GatewayErrorInfo } from "../../core/types";

/** `error` object carried by a failed Response (`response.failed`). */
export interface ResponsesErrorObject {
  code: string;
  message: string;
}

/** Maps a classified gateway error to a Responses `error.code`. */
export function responsesErrorCode(e: GatewayErrorInfo): string {
  switch (e.kind) {
    case "rate_limit":
      return "rate_limit_exceeded";
    case "invalid_request":
    case "upstream_rejected":
    case "unsupported":
    case "tool_unavailable":
      return "invalid_prompt";
    default:
      return "server_error";
  }
}

export function toResponsesError(e: GatewayErrorInfo): ResponsesErrorObject {
  return { code: responsesErrorCode(e), message: e.message };
}

/** JSON error envelope `{error:{message,type,param,code}}` with table status. */
export function responsesErrorResponse(
  e: GatewayErrorInfo,
  requestId: string,
): Response {
  return errorResponse("openai", e, requestId);
}

/** 400 `invalid_request_error` with a parameter path. */
export function badParam(
  message: string,
  param: string,
  code?: string,
): GatewayError {
  return new GatewayError(
    "invalid_request",
    message,
    code ? { param, providerCode: code } : { param },
  );
}

/** 400 for a recognised but unsupported feature. */
export function unsupported(message: string, param: string): GatewayError {
  return new GatewayError("unsupported", message, {
    param,
    providerCode: "unsupported_parameter",
  });
}
