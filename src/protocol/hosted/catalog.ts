import type { WebSearchEngineId } from "./types";

/** `agentGateway.webSearch.maxSearchesPerRequest` schema: default 5, range 1..20. */
export const DEFAULT_MAX_SEARCHES_PER_REQUEST = 5;
export const MIN_MAX_SEARCHES_PER_REQUEST = 1;
export const MAX_MAX_SEARCHES_PER_REQUEST = 20;

/** Clamp a configured value to the schema range; non-numbers fall back to the default. */
export function clampMaxSearchesPerRequest(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_SEARCHES_PER_REQUEST;
  }
  return Math.min(
    MAX_MAX_SEARCHES_PER_REQUEST,
    Math.max(MIN_MAX_SEARCHES_PER_REQUEST, Math.trunc(value)),
  );
}

/** Commands-facing facts about one engine. */
export interface WebSearchEngineInfo {
  id: WebSearchEngineId;
  label: string;
  /** Search works without an API key. */
  anonymous: boolean;
  /** URL fetch works without an API key. */
  fetchAnonymous: boolean;
  /** Prompt text for the API-key input box. */
  keyHint: string;
  /** Where to create an API key. */
  signupUrl: string;
}

/** Mirrors the `meta` of the engines in protocol/hosted/engines. */
export const WEB_SEARCH_ENGINES: readonly WebSearchEngineInfo[] = [
  {
    id: "exa",
    label: "Exa",
    anonymous: true,
    fetchAnonymous: true,
    keyHint: "Exa API key",
    signupUrl: "https://dashboard.exa.ai/api-keys",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    anonymous: true,
    fetchAnonymous: true,
    keyHint: "Firecrawl API key (fc-...)",
    signupUrl: "https://www.firecrawl.dev/app/api-keys",
  },
  {
    id: "tavily",
    label: "Tavily",
    anonymous: false,
    fetchAnonymous: false,
    keyHint: "Tavily API key (tvly-...)",
    signupUrl: "https://app.tavily.com/home",
  },
  {
    id: "jina",
    label: "Jina AI",
    anonymous: false,
    fetchAnonymous: true,
    keyHint: "Jina AI API key (jina_...)",
    signupUrl: "https://jina.ai/api-dashboard/key-manager",
  },
  {
    id: "you",
    label: "You.com",
    anonymous: false,
    fetchAnonymous: false,
    keyHint: "You.com API key",
    signupUrl: "https://you.com/platform/api-keys",
  },
];
