import type { FetchResult } from "../types";
import {
  type Engine,
  type EngineDeps,
  EngineHttp,
  applyDomainFilter,
  capText,
  compact,
  fetchEach,
  list,
  maxResults,
  rec,
  s,
  toResult,
} from "./engine";

export const FIRECRAWL_API = "https://api.firecrawl.dev";

export function createFirecrawlEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);
  const headers = (): Record<string, string> =>
    http.key ? { Authorization: `Bearer ${http.key}` } : {};

  return {
    meta: {
      id: "firecrawl",
      label: "Firecrawl",
      anonymousSearch: true,
      anonymousFetch: true,
      supportsFetch: true,
    },

    async search(query, opts, signal) {
      const n = maxResults(opts);
      const j = rec(
        await http.json(
          `${FIRECRAWL_API}/v2/search`,
          { headers: headers(), body: { query, limit: n } },
          signal,
        ),
      );
      const data = j.data;
      const web = Array.isArray(data) ? data : list(rec(data).web);
      const results = compact(
        web.map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.description) || s(o.snippet),
          );
        }),
      );
      return applyDomainFilter(results, opts).slice(0, n);
    },

    async fetch(urls, signal) {
      return fetchEach(urls, signal, async (url): Promise<FetchResult> => {
        const j = rec(
          await http.json(
            `${FIRECRAWL_API}/v2/scrape`,
            { headers: headers(), body: { url, formats: ["markdown"] } },
            signal,
          ),
        );
        const d = rec(j.data);
        const text = s(d.markdown);
        return text
          ? {
              url,
              status: "ok",
              title: s(rec(d.metadata).title) || undefined,
              text: capText(text),
            }
          : { url, status: "error" };
      });
    },
  };
}
