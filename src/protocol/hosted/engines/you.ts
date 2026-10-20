import type { FetchResult } from "../types";
import {
  type Engine,
  type EngineDeps,
  EngineHttp,
  applyDomainFilter,
  capText,
  compact,
  list,
  maxResults,
  rec,
  s,
  toResult,
} from "./engine";

export const YOU_API = "https://ydc-index.io";

export function createYouEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);

  return {
    meta: {
      id: "you",
      label: "You.com",
      anonymousSearch: false,
      anonymousFetch: false,
      supportsFetch: true,
    },

    async search(query, opts, signal) {
      const key = http.requireKey();
      const n = maxResults(opts);
      const j = rec(
        await http.json(
          `${YOU_API}/v1/search?query=${encodeURIComponent(query)}&count=${n}`,
          { headers: { "X-API-Key": key } },
          signal,
        ),
      );
      const web = list(rec(j.results).web);
      const results = compact(
        web.map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.description) || list(o.snippets).map(s).join(" "),
            s(o.page_age) || undefined,
          );
        }),
      );
      return applyDomainFilter(results, opts).slice(0, n);
    },

    async fetch(urls, signal) {
      const key = http.requireKey();
      let j: unknown;
      try {
        j = await http.json(
          `${YOU_API}/v1/contents`,
          {
            headers: { "X-API-Key": key },
            body: { urls: [...urls], format: "markdown" },
          },
          signal,
        );
      } catch (err) {
        if (signal.aborted) {
          throw err;
        }
        return urls.map((url) => ({ url, status: "error" as const }));
      }
      const items = Array.isArray(j) ? j : list(rec(j).results);
      const byUrl = new Map<string, { title: string; text: string }>();
      for (const it of items) {
        const o = rec(it);
        byUrl.set(s(o.url), {
          title: s(o.title),
          text: s(o.markdown) || s(o.html) || s(o.text),
        });
      }
      return urls.map((url): FetchResult => {
        const hit = byUrl.get(url);
        return hit?.text
          ? {
              url,
              status: "ok",
              title: hit.title || undefined,
              text: capText(hit.text),
            }
          : { url, status: "error" };
      });
    },
  };
}
