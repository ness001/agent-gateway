/** Engine identifiers configurable via `agentGateway.webSearch.provider`. */
export type WebSearchEngineId = "exa" | "firecrawl" | "tavily" | "jina" | "you";

/** Static facts about an engine, used by commands and the no-provider policy. */
export interface EngineMetadata {
  id: WebSearchEngineId;
  label: string;
  /** True when the engine can search without an API key. */
  anonymousSearch: boolean;
  /** True when the engine can fetch pages without an API key. */
  anonymousFetch: boolean;
  /** True when the engine supports page fetch (urlContext) at all. */
  supportsFetch: boolean;
}

export interface SearchOptions {
  /** Maximum results requested from the engine. */
  maxResults?: number;
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
}

/** One normalised search hit. */
export interface SearchResult {
  url: string;
  title: string;
  /** Short excerpt suitable for the model and for citations. */
  snippet: string;
  /** ISO date string when the engine reports one. */
  publishedAt?: string;
}

export type FetchStatus = "ok" | "error" | "unsafe";

/** One normalised page fetch result. */
export interface FetchResult {
  url: string;
  status: FetchStatus;
  title?: string;
  /** Page text, capped by the caller. */
  text?: string;
}

export interface WebSearchEngine {
  readonly meta: EngineMetadata;
  search(
    query: string,
    opts: SearchOptions,
    signal: AbortSignal,
  ): Promise<SearchResult[]>;
}

export interface WebFetchEngine {
  readonly meta: EngineMetadata;
  fetch(urls: readonly string[], signal: AbortSignal): Promise<FetchResult[]>;
}

/** Hosted engines available to one request; absent when the provider is `none`. */
export interface HostedEngines {
  search?: WebSearchEngine;
  fetch?: WebFetchEngine;
  /** `agentGateway.webSearch.maxSearchesPerRequest`. */
  maxSearchesPerRequest: number;
}
