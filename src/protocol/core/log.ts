import type { CoreLogger, ProtocolId } from "./types";

/** Closed set of log messages. No free text. */
export type LogMessage =
  | "request.start"
  | "request.end"
  | "request.error"
  | "request.cancelled"
  | "stream.timeout"
  | "stream.warning"
  | "model.resolved"
  | "model.notFound"
  | "tool.call"
  | "tool.result"
  | "hosted.search"
  | "hosted.fetch"
  | "hosted.budgetExceeded"
  | "hosted.error"
  | "image.link"
  | `debug.${Lowercase<string>}`;

/**
 * Allow-listed metadata. Only identifiers, counts and durations; there is no
 * field that can hold prompt text, queries, URLs, image data or tool
 * arguments. Excess properties are a
 * compile error on object literals and are dropped at runtime.
 */
export interface LogMeta {
  readonly requestId?: string;
  readonly protocol?: ProtocolId;
  readonly model?: string;
  readonly status?: number;
  readonly kind?: string;
  readonly engine?: string;
  readonly count?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly resultCount?: number;
  readonly durationMs?: number;
  readonly toolName?: string;
  readonly callId?: string;
}

const STRING_KEYS = [
  "requestId",
  "protocol",
  "model",
  "kind",
  "engine",
  "toolName",
  "callId",
] as const;
const NUMBER_KEYS = [
  "status",
  "count",
  "inputTokens",
  "outputTokens",
  "resultCount",
  "durationMs",
] as const;
const MAX_ID_LEN = 128;
const SAFE_ID = /^[A-Za-z0-9._:\-/@]+$/;

/** Keeps only allow-listed keys with bounded, token-like values. */
export function sanitizeMeta(
  meta: LogMeta | undefined,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!meta) {
    return out;
  }
  const m = meta as Record<string, unknown>;
  for (const k of STRING_KEYS) {
    const v = m[k];
    if (
      typeof v === "string" &&
      v.length <= MAX_ID_LEN &&
      SAFE_ID.test(v) &&
      !v.includes("://")
    ) {
      out[k] = v;
    }
  }
  for (const k of NUMBER_KEYS) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

export function formatLine(message: LogMessage, meta?: LogMeta): string {
  const parts = Object.entries(sanitizeMeta(meta)).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${message} ${parts.join(" ")}` : message;
}

export interface SafeLogger {
  error(message: LogMessage, meta?: LogMeta): void;
  warn(message: LogMessage, meta?: LogMeta): void;
  info(message: LogMessage, meta?: LogMeta): void;
  debug(message: LogMessage, meta?: LogMeta): void;
}

/** Wraps a GatewayLogger-shaped sink; `undefined` gives a no-op logger. */
export function createSafeLogger(
  sink: CoreLogger | undefined,
  base?: LogMeta,
): SafeLogger {
  const emit =
    (level: keyof CoreLogger) =>
    (message: LogMessage, meta?: LogMeta): void => {
      sink?.[level](formatLine(message, { ...base, ...meta }));
    };
  return {
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
  };
}
