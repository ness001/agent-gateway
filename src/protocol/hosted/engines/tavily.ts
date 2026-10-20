import type { FetchResult } from "../types";
import {
  type Engine,
  type EngineDeps,
  EngineHttp,
  capText,
  compact,
  list,
  maxResults,
  rec,
  s,
  toResult,
} from "./engine";

export const TAVILY_API = "https://api.tavily.com";

export function createTavilyEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);

  return {
    meta: {
      id: "tavily",
      label: "Tavily",
      anonymousSearch: false,
      anonymousFetch: false,
      supportsFetch: true,
    },

    async search(query, opts, signal) {
      const key = http.requireKey();
      const n = maxResults(opts);
      const body: Record<string, unknown> = { query, max_results: n };
      if (opts.allowedDomains?.length) {
        body.include_domains = [...opts.allowedDomains];
      }
      if (opts.blockedDomains?.length) {
        body.exclude_domains = [...opts.blockedDomains];
      }
      const j = rec(
        await http.json(
          `${TAVILY_API}/search`,
          { headers: { Authorization: `Bearer ${key}` }, body },
          signal,
        ),
      );
      return compact(
        list(j.results).map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.content),
            s(o.published_date) || undefined,
          );
        }),
      );
    },

    async fetch(urls, signal) {
      const key = http.requireKey();
      let j: Record<string, unknown>;
      try {
        j = rec(
          await http.json(
            `${TAVILY_API}/extract`,
            {
              headers: { Authorization: `Bearer ${key}` },
              body: { urls: [...urls] },
            },
            signal,
          ),
        );
      } catch (err) {
        if (signal.aborted) {
          throw err;
        }
        return urls.map((url) => ({ url, status: "error" as const }));
      }
      const byUrl = new Map<string, string>();
      for (const r of list(j.results)) {
        const o = rec(r);
        byUrl.set(s(o.url), s(o.raw_content));
      }
      return urls.map((url): FetchResult => {
        const text = byUrl.get(url);
        return text
          ? { url, status: "ok", text: capText(text) }
          : { url, status: "error" };
      });
    },
  };
}
