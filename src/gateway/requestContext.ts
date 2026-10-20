import { AsyncLocalStorage } from "node:async_hooks";

import { randomToken } from "../protocol/core/ids";

/** Correlates log lines and error records with one gateway request. */
export const REQUEST_ID_HEADER = "x-request-id";
/** Anthropic's spelling; every response carries both with the same value. */
export const ANTHROPIC_REQUEST_ID_HEADER = "request-id";

// Checked in order when reusing a caller's ID.
const CALLER_ID_HEADERS = ["request-id", "x-request-id", "x-client-request-id"];

// Client-supplied IDs are echoed in headers and logs, so keep them short and plain.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface RequestContext {
  requestId: string;
  protocol: string;
  path: string;
  model?: string;
  /** Set by the bridge routes when a model call fails. */
  errorKind?: string;
  providerCode?: string;
  remote?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const newRequestId = (): string => `req_${randomToken(24)}`;

/**
 * Reuses a safe caller ID (request-id, x-request-id or X-Client-Request-Id,
 * e.g. forwarded by another gateway), else creates a `req_` ID.
 */
export function requestIdFrom(headers: Headers): string {
  for (const name of CALLER_ID_HEADERS) {
    const presented = headers.get(name)?.trim();
    if (presented && SAFE_REQUEST_ID.test(presented)) {
      return presented;
    }
  }
  return newRequestId();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Prefix for log lines written while a request is in flight. */
export function requestTag(): string {
  const id = storage.getStore()?.requestId;
  return id ? `[${id}] ` : "";
}

/** Lets the bridge routes attach a classified failure to the current request. */
export function noteRequestError(kind: string, providerCode?: string): void {
  const store = storage.getStore();
  if (store) {
    store.errorKind = kind;
    store.providerCode = providerCode;
  }
}
