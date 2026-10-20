import type {
  EngineMetadata,
  FetchResult,
  SearchOptions,
  SearchResult,
  WebFetchEngine,
  WebSearchEngine,
} from "../types";

/** Per-call engine timeout. */
export const ENGINE_TIMEOUT_MS = 30_000;
/** Page text cap before the truncation marker. */
export const MAX_PAGE_CHARS = 100_000;
export const TRUNCATION_MARKER = "[content truncated]";
export const DEFAULT_MAX_RESULTS = 5;

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface EngineDeps {
  /** API key from SecretStorage; empty or undefined means anonymous. */
  apiKey?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Errors carry only a code and HTTP status, never the query, URL or body.
 */
export class EngineError extends Error {
  constructor(
    public readonly code: "missing_key" | "http" | "timeout" | "parse",
    public readonly status?: number,
  ) {
    super(status ? `engine ${code} ${status}` : `engine ${code}`);
    this.name = "EngineError";
  }
}

export interface Engine extends WebSearchEngine, WebFetchEngine {
  search(
    query: string,
    opts: SearchOptions,
    signal: AbortSignal,
  ): Promise<SearchResult[]>;
  fetch(urls: readonly string[], signal: AbortSignal): Promise<FetchResult[]>;
}

export function capText(text: string): string {
  return text.length > MAX_PAGE_CHARS
    ? `${text.slice(0, MAX_PAGE_CHARS)}\n${TRUNCATION_MARKER}`
    : text;
}

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/** HTTP helper shared by the engines: timeout, key header, JSON parse. */
export class EngineHttp {
  private readonly f: FetchLike;
  private readonly timeoutMs: number;
  readonly key: string | undefined;

  constructor(deps: EngineDeps) {
    this.f = deps.fetchImpl ?? defaultFetch();
    this.timeoutMs = deps.timeoutMs ?? ENGINE_TIMEOUT_MS;
    this.key = deps.apiKey?.trim() || undefined;
  }

  /** Throws `missing_key` before any network call. */
  requireKey(): string {
    if (!this.key) {
      throw new EngineError("missing_key");
    }
    return this.key;
  }

  async text(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown },
    signal: AbortSignal,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let res;
    try {
      res = await this.f(url, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          Accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted && !signal.aborted) {
        throw new EngineError("timeout");
      }
      throw err;
    }
    if (!res.ok) {
      throw new EngineError("http", res.status);
    }
    return res.text();
  }

  async json(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown },
    signal: AbortSignal,
  ): Promise<unknown> {
    const body = await this.text(url, init, signal);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new EngineError("parse");
    }
  }
}

// ---- Loose JSON readers (provider responses are untrusted) ----

export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function maxResults(opts: SearchOptions): number {
  const n = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

export function toResult(
  url: string,
  title: string,
  snippet: string,
  publishedAt?: string,
): SearchResult | undefined {
  if (!url) {
    return undefined;
  }
  const r: SearchResult = { url, title: title || url, snippet };
  if (publishedAt) {
    r.publishedAt = publishedAt;
  }
  return r;
}

export function compact<T>(xs: Array<T | undefined>): T[] {
  return xs.filter((x): x is T => x !== undefined);
}

/** Post-filter for engines without native domain filters. */
export function applyDomainFilter(
  results: SearchResult[],
  opts: SearchOptions,
): SearchResult[] {
  const host = (u: string): string => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  const match = (h: string, d: string): boolean => {
    const dd = d.toLowerCase().replace(/^\*?\./, "");
    return h === dd || h.endsWith(`.${dd}`);
  };
  return results.filter((r) => {
    const h = host(r.url);
    if (opts.allowedDomains?.length) {
      if (!opts.allowedDomains.some((d) => match(h, d))) {
        return false;
      }
    }
    return !opts.blockedDomains?.some((d) => match(h, d));
  });
}

/** Fetches URLs one by one, mapping each failure to an `error` result. */
export async function fetchEach(
  urls: readonly string[],
  signal: AbortSignal,
  one: (url: string) => Promise<FetchResult>,
): Promise<FetchResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      try {
        return await one(url);
      } catch (err) {
        if (signal.aborted) {
          throw err;
        }
        if (err instanceof EngineError && err.code === "missing_key") {
          throw err;
        }
        return { url, status: "error" as const };
      }
    }),
  );
}

export type EngineFactory = (deps: EngineDeps) => Engine;
export type { EngineMetadata };
