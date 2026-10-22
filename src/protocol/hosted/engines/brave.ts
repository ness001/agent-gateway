import {
  type Engine,
  type EngineDeps,
  EngineHttp,
  applyDomainFilter,
  compact,
  list,
  maxResults,
  rec,
  s,
  toResult,
} from "./engine";

export const BRAVE_API = "https://api.search.brave.com/res/v1/web/search";

export function createBraveEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);
  return {
    meta: {
      id: "brave",
      label: "Brave Search",
      anonymousSearch: false,
      anonymousFetch: false,
      supportsFetch: false,
    },
    async search(query, opts, signal) {
      const key = http.requireKey();
      const n = maxResults(opts);
      const params = new URLSearchParams({
        q: query,
        count: String(n),
        text_decorations: "false",
      });
      const j = rec(
        await http.json(
          `${BRAVE_API}?${params}`,
          {
            headers: { "X-Subscription-Token": key },
          },
          signal,
        ),
      );
      const results = compact(
        list(rec(j.web).results).map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.description),
            s(o.page_age) || undefined,
          );
        }),
      );
      return applyDomainFilter(results, opts).slice(0, n);
    },
    // Search-only provider: never send URLs or this key to another service.
    async fetch(urls) {
      return urls.map((url) => ({ url, status: "error" as const }));
    },
  };
}
