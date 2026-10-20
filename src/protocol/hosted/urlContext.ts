import { createSafeLogger } from "../core/log";
import type { CoreLogger, Turn } from "../core/types";
import { MAX_PAGE_CHARS, TRUNCATION_MARKER } from "./engines/engine";
import type { FetchResult, WebFetchEngine } from "./types";
import { checkUrl } from "./urlSafety";

export const MAX_CONTEXT_URLS = 5;

export type UrlRetrievalStatus =
  | "URL_RETRIEVAL_STATUS_SUCCESS"
  | "URL_RETRIEVAL_STATUS_ERROR"
  | "URL_RETRIEVAL_STATUS_UNSAFE";

export interface UrlMetadata {
  retrievedUrl: string;
  urlRetrievalStatus: UrlRetrievalStatus;
}

export interface UrlContextResult {
  urlMetadata: UrlMetadata[];
  /** Successfully fetched pages, in request order. */
  pages: Array<{ url: string; title?: string; text: string }>;
  /** False when nothing was fetched: do not call the model. */
  callModel: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;

/** URLs from the last user turn, deduped, at most 5. */
export function extractUrls(turns: readonly Turn[]): string[] {
  const last = [...turns].reverse().find((t) => t.role === "user");
  if (!last) {
    return [];
  }
  const out: string[] = [];
  for (const p of last.parts) {
    if (p.type !== "text") {
      continue;
    }
    for (const m of p.text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (!out.includes(url)) {
        out.push(url);
      }
    }
  }
  return out.slice(0, MAX_CONTEXT_URLS);
}

export function capPage(text: string): string {
  return text.length > MAX_PAGE_CHARS
    ? `${text.slice(0, MAX_PAGE_CHARS)}\n${TRUNCATION_MARKER}`
    : text;
}

/**
 * Fetches the URLs for Gemini urlContext. Unsafe URLs are reported UNSAFE
 * and never fetched; with no engine or no successful fetch every status is
 * ERROR/UNSAFE and `callModel` is false.
 */
export async function runUrlContext(o: {
  turns: readonly Turn[];
  engine: WebFetchEngine | undefined;
  signal: AbortSignal;
  logger?: CoreLogger;
  requestId?: string;
}): Promise<UrlContextResult> {
  const log = createSafeLogger(o.logger, {
    requestId: o.requestId,
    protocol: "gemini",
    engine: o.engine?.meta.id,
  });
  const urls = extractUrls(o.turns);
  const status = new Map<string, UrlRetrievalStatus>();
  const safe: string[] = [];
  for (const u of urls) {
    if (checkUrl(u).safe) {
      safe.push(u);
    } else {
      status.set(u, "URL_RETRIEVAL_STATUS_UNSAFE");
    }
  }
  let fetched: FetchResult[] = [];
  if (o.engine && safe.length) {
    const started = Date.now();
    try {
      fetched = await o.engine.fetch(safe, o.signal);
    } catch (err) {
      if (o.signal.aborted) {
        throw err;
      }
      fetched = [];
    }
    log.info("hosted.fetch", {
      count: safe.length,
      resultCount: fetched.filter((f) => f.status === "ok").length,
      durationMs: Date.now() - started,
    });
  }
  const byUrl = new Map(fetched.map((f) => [f.url, f]));
  const pages: UrlContextResult["pages"] = [];
  for (const u of safe) {
    const f = byUrl.get(u);
    if (f?.status === "ok" && f.text) {
      status.set(u, "URL_RETRIEVAL_STATUS_SUCCESS");
      pages.push({ url: u, title: f.title, text: capPage(f.text) });
    } else {
      status.set(
        u,
        f?.status === "unsafe"
          ? "URL_RETRIEVAL_STATUS_UNSAFE"
          : "URL_RETRIEVAL_STATUS_ERROR",
      );
    }
  }
  return {
    urlMetadata: urls.map((u) => ({
      retrievedUrl: u,
      urlRetrievalStatus: status.get(u) ?? "URL_RETRIEVAL_STATUS_ERROR",
    })),
    pages,
    callModel: pages.length > 0,
  };
}

/** Text block appended to the model context with the fetched pages. */
export function pagesToContext(pages: UrlContextResult["pages"]): string {
  return pages
    .map(
      (p) =>
        `<page url="${p.url}"${p.title ? ` title="${p.title.replace(/"/g, "'")}"` : ""}>\n${p.text}\n</page>`,
    )
    .join("\n\n");
}
