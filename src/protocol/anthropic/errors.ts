import { GatewayError, classifyLmError, errorResponse } from "../core/errors";
import { ImageInputError } from "../core/images";
import type { GatewayErrorInfo } from "../core/types";
import { BodyError } from "../http/body";

function isInfo(v: unknown): v is GatewayErrorInfo {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof Error) &&
    typeof (v as GatewayErrorInfo).kind === "string" &&
    typeof (v as GatewayErrorInfo).message === "string"
  );
}

/** Any thrown value -> classified error info (never throws). */
export function toErrorInfo(err: unknown): GatewayErrorInfo {
  if (err instanceof GatewayError) {
    return err;
  }
  if (isInfo(err)) {
    return err;
  }
  if (err instanceof BodyError) {
    return { kind: "invalid_request", message: err.message };
  }
  if (err instanceof ImageInputError) {
    return err.info;
  }
  return classifyLmError(err);
}

/** `{type:"error", error:{type,message}, request_id}` with the table status. */
export function anthropicError(err: unknown, requestId: string): Response {
  return errorResponse("anthropic", toErrorInfo(err), requestId);
}
