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

export const JINA_SEARCH = "https://s.jina.ai/";
export const JINA_READER = "https://r.jina.ai/";

export function createJinaEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);

  return {
    meta: {
      id: "jina",
      label: "Jina AI",
      anonymousSearch: false,
      anonymousFetch: true,
      supportsFetch: true,
    },

    async search(query, opts, signal) {
      const key = http.requireKey();
      const n = maxResults(opts);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        "X-Respond-With": "no-content",
      };
      if (opts.allowedDomains?.length === 1) {
        headers["X-Site"] = opts.allowedDomains[0];
      }
      const j = rec(
        await http.json(
          `${JINA_SEARCH}?q=${encodeURIComponent(query)}`,
          { headers },
          signal,
        ),
      );
      const results = compact(
        list(j.data).map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.description) || s(o.content).slice(0, 1000),
            s(o.date) || undefined,
          );
        }),
      );
      return applyDomainFilter(results, opts).slice(0, n);
    },

    async fetch(urls, signal) {
      const headers: Record<string, string> = http.key
        ? { Authorization: `Bearer ${http.key}` }
        : {};
      return fetchEach(urls, signal, async (url): Promise<FetchResult> => {
        const j = rec(
          await http.json(`${JINA_READER}${url}`, { headers }, signal),
        );
        const d = rec(j.data);
        const text = s(d.content);
        return text
          ? {
              url,
              status: "ok",
              title: s(d.title) || undefined,
              text: capText(text),
            }
          : { url, status: "error" };
      });
    },
  };
}
