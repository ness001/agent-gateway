import type { FetchedPage, HostedErrorCode, Source } from "../../core/types";

export interface AnthropicServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: { query: string };
}

export interface AnthropicWebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string;
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content:
    | AnthropicWebSearchResult[]
    | { type: "web_search_tool_result_error"; error_code: HostedErrorCode };
}

export interface AnthropicSearchCitation {
  type: "web_search_result_location";
  url: string;
  title: string;
  cited_text: string;
  encrypted_index: string;
}

/** Opaque token standing in for provider-encrypted content. */
export function opaque(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

export function serverToolUseBlock(
  id: string,
  query: string,
): AnthropicServerToolUseBlock {
  return { type: "server_tool_use", id, name: "web_search", input: { query } };
}

/** server_tool_use block for a gateway-run web_fetch. */
export function serverFetchUseBlock(id: string, url: string) {
  return {
    type: "server_tool_use" as const,
    id,
    name: "web_fetch" as const,
    input: { url },
  };
}

/** web_fetch_tool_result block: the page as a text document, or an error. */
export function webFetchToolResultBlock(
  toolUseId: string,
  url: string,
  page: FetchedPage | undefined,
  error?: HostedErrorCode,
) {
  if (error || !page) {
    return {
      type: "web_fetch_tool_result" as const,
      tool_use_id: toolUseId,
      content: {
        type: "web_fetch_tool_result_error" as const,
        error_code: error ?? "unavailable",
      },
    };
  }
  return {
    type: "web_fetch_tool_result" as const,
    tool_use_id: toolUseId,
    content: {
      type: "web_fetch_result" as const,
      url,
      content: {
        type: "document" as const,
        source: {
          type: "text" as const,
          media_type: "text/plain" as const,
          data: page.text,
        },
        ...(page.title ? { title: page.title } : {}),
      },
      retrieved_at: page.retrievedAt,
    },
  };
}

export function webSearchToolResultBlock(
  toolUseId: string,
  sources: readonly Source[],
  error?: HostedErrorCode,
): AnthropicWebSearchToolResultBlock {
  if (error) {
    return {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: { type: "web_search_tool_result_error", error_code: error },
    };
  }
  return {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: sources.map((s) => {
      const r: AnthropicWebSearchResult = {
        type: "web_search_result",
        url: s.url,
        title: s.title ?? s.url,
        encrypted_content: opaque(s.snippet ?? ""),
      };
      if (s.publishedAt) {
        r.page_age = s.publishedAt;
      }
      return r;
    }),
  };
}

/** Citation entries for a text block that cites the given sources. */
export function searchCitations(
  sources: readonly Source[],
): AnthropicSearchCitation[] {
  return sources.map((s, i) => ({
    type: "web_search_result_location",
    url: s.url,
    title: s.title ?? s.url,
    cited_text: (s.snippet ?? "").slice(0, 150),
    encrypted_index: opaque(String(i)),
  }));
}

/** `usage.server_tool_use` fragment (counts executed searches only). */
export function serverToolUsage(searches: number): {
  server_tool_use: { web_search_requests: number };
} {
  return { server_tool_use: { web_search_requests: searches } };
}
