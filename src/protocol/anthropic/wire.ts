/** Usage object of a non-streaming message (8 keys). */
export interface WireUsage {
  cache_creation: null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  inference_geo: null;
  input_tokens: number;
  output_tokens: number;
  server_tool_use: WireServerToolUsage | null;
  service_tier: string | null;
}

export interface WireTextBlock {
  type: "text";
  text: string;
  citations: WireCitation[] | null;
}

/** Web search citation on a text block. */
export interface WireCitation {
  type: "web_search_result_location";
  url: string;
  title: string;
  cited_text: string;
  encrypted_index: string;
}

export interface WireServerToolUsage {
  web_search_requests: number;
  web_fetch_requests?: number;
}

export interface WireServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: "web_search" | "web_fetch";
  input: { query: string } | { url: string };
}

export interface WireWebFetchToolResultBlock {
  type: "web_fetch_tool_result";
  tool_use_id: string;
  content:
    | {
        type: "web_fetch_result";
        url: string;
        content: {
          type: "document";
          source: { type: "text"; media_type: "text/plain"; data: string };
          title?: string;
        };
        retrieved_at: string;
      }
    | { type: "web_fetch_tool_result_error"; error_code: string };
}

export interface WireWebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content:
    | Array<{
        type: "web_search_result";
        url: string;
        title: string;
        encrypted_content: string;
        page_age?: string;
      }>
    | { type: "web_search_tool_result_error"; error_code: string };
}

export interface WireThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface WireToolUseBlock {
  type: "tool_use";
  id: string;
  caller: { type: "direct" };
  name: string;
  input: object;
}

export type WireContentBlock =
  | WireTextBlock
  | WireThinkingBlock
  | WireToolUseBlock
  | WireServerToolUseBlock
  | WireWebSearchToolResultBlock
  | WireWebFetchToolResultBlock;

export type WireStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal";

export interface WireMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  container: null;
  content: WireContentBlock[];
  stop_details: null;
  stop_reason: WireStopReason | null;
  stop_sequence: string | null;
  usage: WireUsage;
}

export interface WireDeltaUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use: WireServerToolUsage | null;
}

export type WireBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "citations_delta"; citation: WireCitation };

export type WireStreamEvent =
  | { type: "message_start"; message: WireMessage }
  | {
      type: "content_block_start";
      index: number;
      content_block: WireContentBlock;
    }
  | { type: "content_block_delta"; index: number; delta: WireBlockDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: {
        container: null;
        stop_details: null;
        stop_reason: WireStopReason;
        stop_sequence: string | null;
      };
      usage: WireDeltaUsage;
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | {
      type: "error";
      error: { type: string; message: string };
      request_id?: string;
    };

export interface WireCountTokens {
  input_tokens: number;
}
