import type { Source } from "../../core/types";
import { dedupeSources } from "../citations";
import type { UrlMetadata } from "../urlContext";

export interface GroundingChunk {
  web: { uri: string; title: string };
}

export interface GroundingSupport {
  segment: { startIndex: number; endIndex: number; text: string };
  groundingChunkIndices: number[];
}

export interface GroundingMetadata {
  webSearchQueries: string[];
  groundingChunks: GroundingChunk[];
  groundingSupports: GroundingSupport[];
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Builds `groundingMetadata`. Chunks are deduplicated by URL; supports are
 * emitted only for sentences citing `[n]` or a source URL. Offsets are UTF-8
 * byte offsets as in the Gemini API.
 */
export function groundingMetadata(
  queries: readonly string[],
  sources: readonly Source[],
  answer: string,
): GroundingMetadata {
  const chunks = dedupeSources(sources);
  const idx = (url: string): number => chunks.findIndex((c) => c.url === url);
  const supports: GroundingSupport[] = [];
  const sentenceRe = /[^.!?\n]+[.!?]*/g;
  for (const m of answer.matchAll(sentenceRe)) {
    const seg = m[0];
    if (!seg.trim() || m.index === undefined) continue;
    const hits = new Set<number>();
    for (const c of seg.matchAll(/\[(\d{1,3})\]/g)) {
      const n = Number(c[1]) - 1;
      if (n >= 0 && n < chunks.length) hits.add(n);
    }
    for (const c of chunks) {
      if (seg.includes(c.url)) hits.add(idx(c.url));
    }
    if (hits.size) {
      const start = utf8Len(answer.slice(0, m.index));
      supports.push({
        segment: {
          startIndex: start,
          endIndex: start + utf8Len(seg),
          text: seg,
        },
        groundingChunkIndices: [...hits].sort((a, b) => a - b),
      });
    }
  }
  return {
    webSearchQueries: [...queries],
    groundingChunks: chunks.map((c) => ({
      web: { uri: c.url, title: c.title ?? c.url },
    })),
    groundingSupports: supports,
  };
}

export function urlContextMetadata(urlMetadata: readonly UrlMetadata[]): {
  urlMetadata: UrlMetadata[];
} {
  return { urlMetadata: urlMetadata.map((u) => ({ ...u })) };
}
