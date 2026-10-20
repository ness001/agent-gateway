import type { FetchResult, SearchResult } from "../types";
import {
  type Engine,
  type EngineDeps,
  EngineError,
  EngineHttp,
  capText,
  compact,
  fetchEach,
  list,
  maxResults,
  rec,
  s,
  toResult,
} from "./engine";

export const EXA_API = "https://api.exa.ai";
export const EXA_MCP = "https://mcp.exa.ai/mcp";

/** Reads a JSON-RPC response that may arrive as JSON or as SSE frames. */
export function parseMcpBody(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  const candidates = trimmed.startsWith("{")
    ? [trimmed]
    : trimmed
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
  for (const c of candidates.reverse()) {
    try {
      const msg = rec(JSON.parse(c));
      if ("result" in msg || "error" in msg) {
        return msg;
      }
    } catch {
      // next frame
    }
  }
  throw new EngineError("parse");
}

/** Joins the text content items of an MCP tool result. */
function mcpText(msg: Record<string, unknown>): string {
  if (msg.error !== undefined) {
    throw new EngineError("http");
  }
  const result = rec(msg.result);
  if (result.isError === true) {
    throw new EngineError("http");
  }
  return list(result.content)
    .map((c) => rec(c))
    .filter((c) => c.type === "text")
    .map((c) => s(c.text))
    .join("\n");
}

/**
 * Parses the MCP search tool text. Accepts a JSON payload with `results`, or
 * a plain-text listing of `Title:` / `URL:` / text blocks.
 */
export function parseExaMcpResults(text: string): SearchResult[] {
  try {
    const j = rec(JSON.parse(text));
    return compact(
      list(j.results).map((r) => {
        const o = rec(r);
        return toResult(
          s(o.url),
          s(o.title),
          s(o.text) || s(o.summary) || list(o.highlights).map(s).join(" "),
          s(o.publishedDate) || undefined,
        );
      }),
    );
  } catch {
    // plain text format
  }
  const out: SearchResult[] = [];
  let cur:
    | { url: string; title: string; text: string[]; date?: string }
    | undefined;
  const flush = (): void => {
    if (cur?.url) {
      const r = toResult(
        cur.url,
        cur.title,
        cur.text.join(" ").trim(),
        cur.date,
      );
      if (r) {
        out.push(r);
      }
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const m =
      /^\s*(Title|URL|Published(?: Date)?|Author|Text|Highlights?|Summary):\s*(.*)$/i.exec(
        line,
      );
    if (m && /^title$/i.test(m[1])) {
      flush();
      cur = { url: "", title: m[2].trim(), text: [] };
    } else if (m && /^url$/i.test(m[1])) {
      if (!cur || cur.url) {
        flush();
        cur = { url: "", title: "", text: [] };
      }
      cur.url = m[2].trim();
    } else if (m && /^published/i.test(m[1]) && cur) {
      cur.date = m[2].trim() || undefined;
    } else if (m && /^author$/i.test(m[1])) {
      // ignored
    } else if (cur) {
      const t = m ? m[2] : line;
      if (t.trim()) {
        cur.text.push(t.trim());
      }
    }
  }
  flush();
  return out.map((r) => ({ ...r, snippet: r.snippet.slice(0, 1000) }));
}

export function createExaEngine(deps: EngineDeps): Engine {
  const http = new EngineHttp(deps);
  let rpcId = 0;

  const callMcp = async (
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> => {
    const body = await http.text(
      EXA_MCP,
      {
        headers: { Accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
      },
      signal,
    );
    return mcpText(parseMcpBody(body));
  };

  return {
    meta: {
      id: "exa",
      label: "Exa",
      anonymousSearch: true,
      anonymousFetch: true,
      supportsFetch: true,
    },

    async search(query, opts, signal) {
      const n = maxResults(opts);
      if (!http.key) {
        const text = await callMcp(
          "web_search_exa",
          { query, numResults: n },
          signal,
        );
        return parseExaMcpResults(text).slice(0, n);
      }
      const body: Record<string, unknown> = {
        query,
        numResults: n,
        contents: { text: { maxCharacters: 1000 } },
      };
      if (opts.allowedDomains?.length) {
        body.includeDomains = [...opts.allowedDomains];
      }
      if (opts.blockedDomains?.length) {
        body.excludeDomains = [...opts.blockedDomains];
      }
      const j = rec(
        await http.json(
          `${EXA_API}/search`,
          { headers: { "x-api-key": http.key }, body },
          signal,
        ),
      );
      return compact(
        list(j.results).map((r) => {
          const o = rec(r);
          return toResult(
            s(o.url),
            s(o.title),
            s(o.text) || s(o.summary),
            s(o.publishedDate) || undefined,
          );
        }),
      );
    },

    async fetch(urls, signal) {
      if (!http.key) {
        return fetchEach(urls, signal, async (url): Promise<FetchResult> => {
          const text = await callMcp("web_fetch_exa", { url }, signal);
          return text.trim()
            ? { url, status: "ok", text: capText(text) }
            : { url, status: "error" };
        });
      }
      const key = http.key;
      return fetchEach(urls, signal, async (url): Promise<FetchResult> => {
        const j = rec(
          await http.json(
            `${EXA_API}/contents`,
            {
              headers: { "x-api-key": key },
              body: { urls: [url], text: true },
            },
            signal,
          ),
        );
        const o = rec(list(j.results)[0]);
        const text = s(o.text);
        return text
          ? {
              url,
              status: "ok",
              title: s(o.title) || undefined,
              text: capText(text),
            }
          : { url, status: "error" };
      });
    },
  };
}
