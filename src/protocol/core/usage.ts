import type { NormalizedUsage } from "./types";

/** MIME type of the Copilot usage data part. */
export const USAGE_MIME = "usage";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function decode(data: unknown): unknown {
  try {
    if (data instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(data));
    }
    if (typeof data === "string") {
      return JSON.parse(data);
    }
  } catch {
    return undefined;
  }
  return data;
}

/**
 * Parse the Copilot usage payload (OpenAI-shaped JSON, as bytes, string or
 * object). Returns undefined when it is not usable. Optional fields are only
 * set when present in the payload.
 */
export function parseUsage(data: unknown): NormalizedUsage | undefined {
  const o = obj(decode(data));
  if (!o) {
    return undefined;
  }
  const input = num(o.prompt_tokens);
  const output = num(o.completion_tokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  const u: NormalizedUsage = { input: input ?? 0, output: output ?? 0 };
  const cacheRead = num(obj(o.prompt_tokens_details)?.cached_tokens);
  if (cacheRead !== undefined) {
    u.cacheRead = cacheRead;
  }
  const cacheWrite = num(o.cache_creation_input_tokens);
  if (cacheWrite !== undefined) {
    u.cacheWrite = cacheWrite;
  }
  const reasoning = num(obj(o.completion_tokens_details)?.reasoning_tokens);
  if (reasoning !== undefined) {
    u.reasoning = reasoning;
  }
  return u;
}

/** Structural data part (vscode.LanguageModelDataPart-like). */
export interface DataPartLike {
  mimeType: string;
  data: unknown;
}

/** Returns parsed usage if the part is the Copilot usage part, else undefined. */
export function usageFromPart(part: unknown): NormalizedUsage | undefined {
  const p = obj(part);
  if (!p || p.mimeType !== USAGE_MIME) {
    return undefined;
  }
  return parseUsage(p.data);
}

const ZERO: NormalizedUsage = { input: 0, output: 0 };

function uncachedInput(u: NormalizedUsage): number {
  return Math.max(0, u.input - (u.cacheRead ?? 0) - (u.cacheWrite ?? 0));
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests?: number;
  };
}

export function toAnthropicUsage(
  u: NormalizedUsage | undefined,
  searches = 0,
  fetches = 0,
): AnthropicUsage {
  const x = u ?? ZERO;
  const r: AnthropicUsage = {
    input_tokens: uncachedInput(x),
    output_tokens: x.output,
  };
  if (x.cacheRead !== undefined) {
    r.cache_read_input_tokens = x.cacheRead;
  }
  if (x.cacheWrite !== undefined) {
    r.cache_creation_input_tokens = x.cacheWrite;
  }
  if (searches > 0 || fetches > 0) {
    r.server_tool_use = { web_search_requests: searches };
    if (fetches > 0) {
      r.server_tool_use.web_fetch_requests = fetches;
    }
  }
  return r;
}

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens: number };
  total_tokens: number;
}

export function toResponsesUsage(
  u: NormalizedUsage | undefined,
): ResponsesUsage {
  const x = u ?? ZERO;
  const r: ResponsesUsage = {
    input_tokens: x.input,
    output_tokens: x.output,
    total_tokens: x.input + x.output,
  };
  if (x.cacheRead !== undefined) {
    r.input_tokens_details = { cached_tokens: x.cacheRead };
  }
  if (x.reasoning !== undefined) {
    r.output_tokens_details = { reasoning_tokens: x.reasoning };
  }
  return r;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export function toChatUsage(u: NormalizedUsage | undefined): ChatUsage {
  const x = u ?? ZERO;
  const r: ChatUsage = {
    prompt_tokens: x.input,
    completion_tokens: x.output,
    total_tokens: x.input + x.output,
  };
  if (x.cacheRead !== undefined) {
    r.prompt_tokens_details = { cached_tokens: x.cacheRead };
  }
  if (x.reasoning !== undefined) {
    r.completion_tokens_details = { reasoning_tokens: x.reasoning };
  }
  return r;
}

export interface GeminiUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  cachedContentTokenCount: number;
  thoughtsTokenCount: number;
  totalTokenCount: number;
}

/**
 * Gemini usageMetadata: all five fields always present.
 * Per the current decision, promptTokenCount excludes cached tokens and
 * candidatesTokenCount excludes thoughts, so
 * total = prompt + cached + candidates + thoughts.
 */
export function toGeminiUsage(u: NormalizedUsage | undefined): GeminiUsage {
  const x = u ?? ZERO;
  const cached = x.cacheRead ?? 0;
  const thoughts = Math.min(x.reasoning ?? 0, x.output);
  const prompt = Math.max(0, x.input - cached);
  const candidates = x.output - thoughts;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    cachedContentTokenCount: cached,
    thoughtsTokenCount: thoughts,
    totalTokenCount: prompt + cached + candidates + thoughts,
  };
}

/**
 * True only when usage proves output reached the client's
 * limit. No limit or no usage means false (never fabricate a length stop).
 */
export function reachedLimit(
  u: NormalizedUsage | undefined,
  limit: number | undefined,
): boolean {
  if (u === undefined || limit === undefined || !(limit > 0)) {
    return false;
  }
  return u.output >= limit;
}
