import type { HostedEngines } from "../hosted/types";

export type ProtocolId =
  | "anthropic"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

/** How the model may use client tools. */
export type ToolMode =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "required"; only?: string[] };

export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** A citation/grounding source produced by a hosted tool. */
export interface Source {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export type HostedErrorCode =
  | "max_uses_exceeded"
  | "max_tool_calls_exceeded"
  | "unavailable"
  | "too_many_requests"
  | "invalid_input"
  | "query_too_long"
  | "url_unsafe"
  | "fetch_failed"
  | "invalid_tool_input"
  | "url_too_long"
  | "url_not_allowed"
  | "url_not_in_prior_context"
  | "url_not_accessible";

/** A page fetched by the hosted fetch tool (Anthropic web_fetch). */
export interface FetchedPage {
  url: string;
  title?: string;
  text: string;
  /** ISO time the page was fetched. */
  retrievedAt: string;
}

export type GatewayErrorKind =
  | "invalid_request"
  | "not_found"
  | "permission"
  | "rate_limit"
  | "upstream_rejected"
  | "upstream_error"
  | "overloaded"
  | "timeout"
  | "tool_unavailable"
  | "unsupported"
  | "internal";

/** Plain data shape of a classified error; `core/errors.ts` adds the class. */
export interface GatewayErrorInfo {
  kind: GatewayErrorKind;
  message: string;
  /** Protocol parameter path, e.g. `input` or `tools[0].name`. */
  param?: string;
  /** Provider code (e.g. LanguageModelError.code) for the error journal. */
  providerCode?: string;
  /** Seconds the caller should wait (sent as Retry-After). */
  retryAfter?: number;
}

export type EndReason = "stop" | "tool" | "length" | "stopSequence" | "refusal";

export type CoreEvent =
  | {
      e: "text";
      delta: string;
      /** Appended hosted-search Sources list; not scanned for citations. */
      sources?: true;
    }
  | { e: "thinking"; delta: string; signature?: string }
  | { e: "toolCall"; id: string; name: string; input: object }
  | {
      e: "hostedCall";
      id: string;
      kind: "search" | "fetch";
      query?: string;
      url?: string;
    }
  | {
      e: "hostedResult";
      callId: string;
      sources: Source[];
      error?: HostedErrorCode;
      /** Set for a successful hosted fetch. */
      page?: FetchedPage;
    }
  | { e: "end"; reason: EndReason; stopSeq?: string; usage?: NormalizedUsage }
  | { e: "error"; err: GatewayErrorInfo };

export type CoreEventName = CoreEvent["e"];

// ---- Conversation parts ----

export interface TextPart {
  type: "text";
  text: string;
  /**
   * Remote image link this text describes. The handler tries to download it
   * and replaces the part with the image; on failure the text stays.
   */
  imageUrl?: string;
}

export interface ImagePart {
  type: "image";
  mime: string;
  /** Decoded bytes (after base64 / data-URL decoding). */
  data: Uint8Array;
}

export interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  input: object;
}

export interface ToolResultPart {
  type: "toolResult";
  callId: string;
  /** Name when the protocol provides it (Gemini matches by name). */
  name?: string;
  content: Array<TextPart | ImagePart>;
  isError: boolean;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
  signature?: string;
}

export type Part =
  | TextPart
  | ImagePart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart;

export interface Turn {
  role: "user" | "assistant";
  parts: Part[];
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema object. */
  inputSchema: object;
}

export interface HostedSearchTool {
  kind: "search";
  /** Wire name/type echoed in output, e.g. `web_search_20250305`. */
  wireType: string;
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** True when tool_choice forces this tool. */
  forced?: boolean;
}

export interface HostedFetchTool {
  kind: "fetch";
  wireType: string;
  /**
   * True for a fetch tool the model calls (Anthropic web_fetch); false or
   * absent for Gemini urlContext, which fetches before the model call.
   */
  asTool?: boolean;
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** True when tool_choice forces this tool. */
  forced?: boolean;
}

export type HostedTool = HostedSearchTool | HostedFetchTool;

export interface CoreRequest {
  protocol: ProtocolId;
  /** Resolved local model id. */
  model: string;
  /** Model name echoed to the client. */
  echoModel: string;
  system: string[];
  turns: Turn[];
  tools: ToolDef[];
  toolMode: ToolMode;
  hosted: HostedTool[];
  maxOutputTokens?: number;
  stop?: string[];
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
  /** Responses `reasoning.summary`; null means the client asked for no summary text. */
  reasoningSummary?: string | null;
  /** Responses `max_tool_calls`: cap on hosted (built-in) tool calls. */
  maxToolCalls?: number;
  cacheKey?: string;
  parallelToolCalls?: boolean;
  stream: boolean;
  /** Request fields reflected back in snapshots (e.g. Responses `instructions`). */
  echo: Record<string, unknown>;
}

// ---- Protocol handler contract ----

/** Structural subset of `vscode.LanguageModelChat` used by the core. */
export interface LmChatLike {
  readonly id: string;
  readonly name?: string;
  readonly family?: string;
  readonly maxInputTokens: number;
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: unknown,
  ): Thenable<{ readonly stream: AsyncIterable<unknown> }>;
  countTokens(text: unknown, token?: unknown): Thenable<number>;
}

/** Re-homed shape of the local model lookup result (was ChatModelClientResult). */
export type ModelLookup<M = LmChatLike> =
  | { client: M; error?: undefined }
  | { client?: undefined; error: { error: { message: string; type: string } } };

export interface CoreLogger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/**
 * What `gateway/localRoutes.ts` passes to the protocol layer. Mirrors the
 * fields `gateway/gateway.ts` builds today (getLocalModel, web search
 * provider, maxSearchesPerRequest); request id and error journal reach the
 * core via `gateway/requestContext.ts` (AsyncLocalStorage), so they are
 * optional explicit overrides here.
 */
export interface ProtocolDeps<M = LmChatLike> {
  getLocalModel(id: string): M | undefined;
  hosted?: HostedEngines;
  maxSearchesPerRequest: number;
  getWebSearchModel?(): string | undefined;
  logger?: CoreLogger;
  requestId?: string;
  noteRequestError?(kind: string, providerCode?: string): void;
}

export type ProtocolHandler<M = LmChatLike> = (
  req: Request,
  deps: ProtocolDeps<M>,
) => Promise<Response>;
