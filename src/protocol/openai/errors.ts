import {
  ERROR_TABLE,
  GatewayError,
  classifyLmError,
  errorResponse,
  openaiErrorBody,
} from "../core/errors";
import { ImageInputError } from "../core/images";
import type { GatewayErrorInfo } from "../core/types";
import { BodyError } from "../http/body";

/** OpenAI error envelope plus the gateway request id. */
export interface OpenAiErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
  request_id: string;
}

/** Turns anything thrown while reading/decoding a request into error info. */
export function toErrorInfo(err: unknown): GatewayErrorInfo {
  if (err instanceof GatewayError) {
    return err;
  }
  if (err instanceof BodyError) {
    // Malformed body is a 400 with param and code null.
    return { kind: "invalid_request", message: err.message };
  }
  if (err instanceof ImageInputError) {
    return err.info;
  }
  return classifyLmError(err);
}

export function openAiErrorEnvelope(
  e: GatewayErrorInfo,
  requestId: string,
): OpenAiErrorEnvelope {
  return openaiErrorBody(e, requestId);
}

/** JSON error response with the kind-table status and `x-request-id`. */
export function openAiErrorResponse(
  e: GatewayErrorInfo,
  requestId: string,
): Response {
  return errorResponse("openai", e, requestId);
}

/** HTTP status for an error kind (re-exported for adapters). */
export function statusOf(e: GatewayErrorInfo): number {
  return ERROR_TABLE[e.kind].status;
}
