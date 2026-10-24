import type { CoreLogger, CoreRequest, ProtocolId } from "./types";

/** Identity of one model request. */
export interface SettingsLogMeta {
  readonly requestId: string;
  readonly protocol: ProtocolId;
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly remote?: string;
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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function effort(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "adaptive":
    case "enabled":
    case "disabled":
      return value.toLowerCase();
    default:
      return "redacted";
  }
}

const HOSTED_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "web_search_20250305",
  "web_search_20260209",
  "web_fetch_20250910",
  "web_fetch_20260209",
  "file_search",
  "code_interpreter",
  "computer_use_preview",
  "mcp",
]);

/** Best-effort metadata only: never decode, validate or alter a passthrough body. */
export function settingsFromWire(
  protocol: ProtocolId,
  value: unknown,
  geminiAction?: string,
): RequestSettings {
  const body = record(value);
  const gemini = protocol === "gemini";
  const anthropic = protocol === "anthropic";
  const generation = gemini ? record(body.generationConfig) : body;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const hostedTools: string[] = [];
  let toolCount = 0;
  for (const value of tools) {
    const tool = record(value);
    if (gemini) {
      if (Array.isArray(tool.functionDeclarations)) {
        toolCount += tool.functionDeclarations.length;
      }
      for (const key of [
        "googleSearch",
        "googleSearchRetrieval",
        "urlContext",
        "codeExecution",
      ]) {
        if (Object.hasOwn(tool, key) && !hostedTools.includes(key)) {
          hostedTools.push(key);
        }
      }
    } else if (typeof tool.type === "string" && HOSTED_TYPES.has(tool.type)) {
      if (!hostedTools.includes(tool.type)) {
        hostedTools.push(tool.type);
      }
    } else {
      toolCount++;
    }
  }
  const choice = gemini
    ? record(record(body.toolConfig).functionCallingConfig).mode
    : typeof body.tool_choice === "string"
      ? body.tool_choice
      : record(body.tool_choice).type;
  let toolChoice: RequestSettings["toolChoice"] = "auto";
  switch (choice) {
    case "none":
    case "NONE":
      toolChoice = "none";
      break;
    case "required":
    case "any":
    case "ANY":
    case "tool":
    case "function":
      toolChoice = "required";
  }
  const stop = gemini
    ? generation.stopSequences
    : anthropic
      ? body.stop_sequences
      : body.stop;
  const cacheKey = gemini ? body.cachedContent : body.prompt_cache_key;
  const parallel = anthropic
    ? record(body.tool_choice).disable_parallel_tool_use
    : body.parallel_tool_calls;
  return {
    maxOutputTokens: gemini
      ? finite(generation.maxOutputTokens)
      : protocol === "openai-responses"
        ? finite(body.max_output_tokens)
        : (finite(body.max_completion_tokens) ?? finite(body.max_tokens)),
    temperature: finite(generation.temperature),
    topP: finite(gemini ? generation.topP : body.top_p),
    stopCount: Array.isArray(stop)
      ? stop.length
      : typeof stop === "string"
        ? 1
        : 0,
    reasoningEffort: effort(
      gemini
        ? record(generation.thinkingConfig).thinkingLevel
        : anthropic
          ? (record(body.output_config).effort ?? record(body.thinking).type)
          : protocol === "openai-responses"
            ? record(body.reasoning).effort
            : body.reasoning_effort,
    ),
    toolCount,
    toolChoice,
    hostedTools,
    parallelToolCalls:
      typeof parallel === "boolean"
        ? anthropic
          ? !parallel
          : parallel
        : undefined,
    stream: gemini
      ? geminiAction === "streamGenerateContent"
      : body.stream === true,
    cacheKeyPresent: typeof cacheKey === "string" && cacheKey !== "",
  };
}

/** Formats the single settings line. Exported for tests. */
export function formatSettingsLine(
  meta: SettingsLogMeta,
  s: RequestSettings,
): string {
  const parts: string[] = [
    `${meta.remote !== undefined ? `[remote][${token(meta.remote)}] ` : ""}[${token(meta.requestId)}] ${meta.protocol} settings`,
    `model=${quoted(meta.requestedModel)}`,
    `resolved=${quoted(meta.resolvedModel)}`,
    `max_tokens=${num(s.maxOutputTokens) ?? "none"}`,
  ];
  if (meta.remote !== undefined) {
    parts.push("forwarded=true");
  }
  const ignored = meta.remote === undefined ? "(ignored)" : "";
  const t = num(s.temperature);
  if (t !== undefined) {
    parts.push(`temperature=${t}${ignored}`);
  }
  const p = num(s.topP);
  if (p !== undefined) {
    parts.push(`top_p=${p}${ignored}`);
  }
  if (s.stopCount > 0) {
    parts.push(`stop=${s.stopCount}${ignored}`);
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
