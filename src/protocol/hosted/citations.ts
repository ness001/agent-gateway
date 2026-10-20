import type { Source } from "../core/types";
import type { SearchResult } from "./types";

/** Normalises a URL for deduplication (drops fragment and trailing slash). */
export function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let out = u.toString();
    if (out.endsWith("/") && u.pathname !== "/") {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return url.trim();
  }
}

export function toSource(r: SearchResult): Source {
  const src: Source = { url: r.url, title: r.title };
  if (r.snippet) {
    src.snippet = r.snippet;
  }
  if (r.publishedAt) {
    src.publishedAt = r.publishedAt;
  }
  return src;
}

/**
 * Collects sources across every search of a turn. The first occurrence of a
 * URL keeps its index; later duplicates map to the same index, so indices
 * are stable for the whole turn (Gemini groundingChunks, `[n]` citations).
 */
export class CitationRegistry {
  private readonly items: Source[] = [];
  private readonly index = new Map<string, number>();

  /** Adds sources and returns their (possibly existing) indices. */
  add(sources: readonly Source[]): number[] {
    return sources.map((s) => {
      const key = sourceKey(s.url);
      const hit = this.index.get(key);
      if (hit !== undefined) {
        const cur = this.items[hit];
        if (!cur.title && s.title) {
          cur.title = s.title;
        }
        if (!cur.snippet && s.snippet) {
          cur.snippet = s.snippet;
        }
        return hit;
      }
      const i = this.items.length;
      this.items.push({ ...s });
      this.index.set(key, i);
      return i;
    });
  }

  indexOf(url: string): number | undefined {
    return this.index.get(sourceKey(url));
  }

  get size(): number {
    return this.items.length;
  }

  all(): readonly Source[] {
    return this.items;
  }
}

/** Order-preserving dedupe by URL. */
export function dedupeSources(sources: readonly Source[]): Source[] {
  const reg = new CitationRegistry();
  reg.add(sources);
  return [...reg.all()];
}
