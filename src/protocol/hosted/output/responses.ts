import type { HostedErrorCode, Source } from "../../core/types";

export interface WebSearchCallItem {
  type: "web_search_call";
  id: string;
  status: "in_progress" | "searching" | "completed" | "failed";
  action?: {
    type: "search";
    query: string;
    sources?: Array<{ type: "url"; url: string }>;
  };
}

export interface UrlCitation {
  type: "url_citation";
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

export function webSearchCallItem(
  id: string,
  query: string,
  sources: readonly Source[],
  error?: HostedErrorCode,
): WebSearchCallItem {
  return {
    type: "web_search_call",
    id,
    status: error ? "failed" : "completed",
    action: {
      type: "search",
      query,
      sources: sources.map((s) => ({ type: "url", url: s.url })),
    },
  };
}

/** Streaming event sequence for one search call (added..done). */
export function webSearchCallEvents(
  item: WebSearchCallItem,
  outputIndex: number,
): Array<Record<string, unknown>> {
  const started: WebSearchCallItem = {
    type: item.type,
    id: item.id,
    status: "in_progress",
  };
  const ev = (type: string): Record<string, unknown> => ({
    type,
    output_index: outputIndex,
    item_id: item.id,
  });
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: started,
    },
    ev("response.web_search_call.in_progress"),
    ev("response.web_search_call.searching"),
    ev("response.web_search_call.completed"),
    { type: "response.output_item.done", output_index: outputIndex, item },
  ];
}

/**
 * `url_citation` annotations for a final answer: each `[n]` marker (1-based
 * index into `sources`) and each literal source URL in the text is annotated.
 */
export function urlCitations(
  text: string,
  sources: readonly Source[],
): UrlCitation[] {
  const out: UrlCitation[] = [];
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
    const s = sources[Number(m[1]) - 1];
    if (s && m.index !== undefined) {
      out.push({
        type: "url_citation",
        url: s.url,
        title: s.title ?? s.url,
        start_index: m.index,
        end_index: m.index + m[0].length,
      });
    }
  }
  for (const s of sources) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(s.url, from);
      if (i < 0) {
        break;
      }
      out.push({
        type: "url_citation",
        url: s.url,
        title: s.title ?? s.url,
        start_index: i,
        end_index: i + s.url.length,
      });
      from = i + s.url.length;
    }
  }
  return out.sort((a, b) => a.start_index - b.start_index);
}
