import type { CoreLogger, CoreRequest, ProtocolId } from "./types";

/** Identity of one model request. */
export interface SettingsLogMeta {
  readonly requestId: string;
  readonly protocol: ProtocolId;
  readonly requestedModel: string;
  readonly resolvedModel: string;
}

/**
 * Closed, redaction-safe view of the generation settings. Only numbers,
 * booleans, enum-like tokens and counts: there is no field for prompt text,
 * tool arguments, stop text, the cache-key value or URLs.
 */
export interface RequestSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopCount: number;
  readonly reasoningEffort?: string;
  readonly toolCount: number;
  readonly toolChoice: "auto" | "none" | "required";
  readonly hostedTools: readonly string[];
  readonly parallelToolCalls?: boolean;
  readonly stream: boolean;
  readonly cacheKeyPresent: boolean;
}

const SAFE_TOKEN = /^[A-Za-z0-9._:\-@]{1,128}$/;

/** Keeps identifier-like strings only; anything else becomes "redacted". */
function token(v: string): string {
  return SAFE_TOKEN.test(v) ? v : "redacted";
}

function quoted(v: string): string {
  return `"${token(v)}"`;
}

function num(v: number | undefined): string | undefined {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
}

/** Projects a CoreRequest onto the loggable settings. */
export function settingsFromRequest(req: CoreRequest): RequestSettings {
  return {
    maxOutputTokens: req.maxOutputTokens,
    temperature: req.temperature,
    topP: req.topP,
    stopCount: req.stop?.length ?? 0,
    reasoningEffort: req.reasoningEffort,
    toolCount: req.tools.length,
    toolChoice: req.toolMode.kind,
    hostedTools: req.hosted.map((h) => h.wireType),
    parallelToolCalls: req.parallelToolCalls,
    stream: req.stream,
    cacheKeyPresent: typeof req.cacheKey === "string" && req.cacheKey !== "",
  };
}

/** Formats the single settings line. Exported for tests. */
export function formatSettingsLine(
  meta: SettingsLogMeta,
  s: RequestSettings,
): string {
  const parts: string[] = [
    `[${token(meta.requestId)}] ${meta.protocol} settings`,
    `model=${quoted(meta.requestedModel)}`,
    `resolved=${quoted(meta.resolvedModel)}`,
    `max_tokens=${num(s.maxOutputTokens) ?? "none"}`,
  ];
  const t = num(s.temperature);
  if (t !== undefined) {
    parts.push(`temperature=${t}(ignored)`);
  }
  const p = num(s.topP);
  if (p !== undefined) {
    parts.push(`top_p=${p}(ignored)`);
  }
  if (s.stopCount > 0) {
    parts.push(`stop=${s.stopCount}(ignored)`);
  }
  parts.push(
    `reasoning=${s.reasoningEffort ? token(s.reasoningEffort) : "none"}`,
  );
  parts.push(`tools=${s.toolCount}`, `tool_choice=${s.toolChoice}`);
  if (s.hostedTools.length) {
    parts.push(`hosted=${s.hostedTools.map(token).join(",")}`);
  }
  if (s.parallelToolCalls !== undefined) {
    parts.push(`parallel_tool_calls=${s.parallelToolCalls}`);
  }
  parts.push(
    `stream=${s.stream}`,
    `cache_key=${s.cacheKeyPresent ? "yes" : "no"}`,
  );
  return parts.join(" ");
}

/** Writes ONE info line per model request. */
export function logRequestSettings(
  log: CoreLogger | undefined,
  meta: SettingsLogMeta,
  settings: RequestSettings,
): void {
  log?.info(formatSettingsLine(meta, settings));
}
