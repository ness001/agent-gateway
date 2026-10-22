import type { FetchResult } from "../types";
import {
  type Engine,
  type EngineDeps,
  EngineError,
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

export const KAGI_API = "https://kagi.com/api/v1";

/** Do not expose provider error messages, which may include private input. */
function response(value: unknown): Record<string, unknown> {
  const j = rec(value);
  if (list(j.error).length || list(j.errors).length) {
    throw new EngineError("parse");
  }
  return j;
}

export function createKagiEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);
  return {
    meta: {
      id: "kagi",
      label: "Kagi",
      anonymousSearch: false,
      anonymousFetch: false,
      supportsFetch: true,
    },
    async search(query, opts, signal) {
      const key = http.requireKey();
      const n = maxResults(opts);
      const j = response(
        await http.json(
          `${KAGI_API}/search`,
          {
            headers: { Authorization: `Bearer ${key}` },
            body: { query, limit: n },
          },
          signal,
        ),
      );
      const results = compact(
        list(rec(j.data).search).map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.snippet),
            s(o.time) || undefined,
          );
        }),
      );
      return applyDomainFilter(results, opts).slice(0, n);
    },
    async fetch(urls, signal) {
      const key = http.requireKey();
      const results: FetchResult[] = [];
      // Extract accepts at most ten pages in a request.
      for (let i = 0; i < urls.length; i += 10) {
        const batch = urls.slice(i, i + 10);
        try {
          const j = response(
            await http.json(
              `${KAGI_API}/extract`,
              {
                headers: { Authorization: `Bearer ${key}` },
                body: { pages: batch.map((url) => ({ url })) },
              },
              signal,
            ),
          );
          const byUrl = new Map(
            list(j.data).map((r) => {
              const o = rec(r);
              return [s(o.url), o.error ? "" : s(o.markdown)] as const;
            }),
          );
          results.push(
            ...batch.map((url): FetchResult => {
              const text = byUrl.get(url);
              return text
                ? { url, status: "ok", text: capText(text) }
                : { url, status: "error" };
            }),
          );
        } catch (err) {
          if (signal.aborted) {
            throw err;
          }
          results.push(
            ...batch.map((url): FetchResult => ({ url, status: "error" })),
          );
        }
      }
      return results;
    },
  };
}
