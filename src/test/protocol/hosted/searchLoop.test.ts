import * as assert from "node:assert/strict";

import type {
  CoreEvent,
  CoreRequest,
  ToolResultPart,
} from "../../../protocol/core/types";
import {
  CitationRegistry,
  dedupeSources,
} from "../../../protocol/hosted/citations";
import { EngineError } from "../../../protocol/hosted/engines/engine";
import { createSearchHook } from "../../../protocol/hosted/index";
import * as anth from "../../../protocol/hosted/output/anthropic";
import * as gem from "../../../protocol/hosted/output/gemini";
import * as resp from "../../../protocol/hosted/output/responses";
import {
  INTERNAL_SEARCH_TOOL_BASE,
  Semaphore,
  computeBudget,
  runSearchLoop,
} from "../../../protocol/hosted/searchLoop";
import type {
  SearchResult,
  WebFetchEngine,
  WebSearchEngine,
} from "../../../protocol/hosted/types";
import {
  extractUrls,
  runUrlContext,
} from "../../../protocol/hosted/urlContext";

const T = INTERNAL_SEARCH_TOOL_BASE;

function baseReq(over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    protocol: "anthropic",
    model: "m",
    echoModel: "m",
    system: [],
    turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    tools: [],
    toolMode: { kind: "auto" },
    hosted: [{ kind: "search", wireType: "web_search_20250305" }],
    stream: false,
    echo: {},
    ...over,
  };
}

type Script = (req: CoreRequest, round: number) => CoreEvent[];

function fakeModel(script: Script) {
  const seen: CoreRequest[] = [];
  const call = (req: CoreRequest): AsyncIterable<CoreEvent> => {
    seen.push(req);
    const evs = script(req, seen.length - 1);
    return (async function* () {
      for (const e of evs) yield e;
    })();
  };
  return { seen, call };
}

function engine(
  impl?: (q: string) => Promise<SearchResult[]>,
): WebSearchEngine & { queries: string[]; active: number; peak: number } {
  const e = {
    queries: [] as string[],
    active: 0,
    peak: 0,
    meta: {
      id: "exa" as const,
      label: "Exa",
      anonymousSearch: true,
      anonymousFetch: true,
      supportsFetch: true,
    },
    async search(q: string): Promise<SearchResult[]> {
      e.queries.push(q);
      e.active++;
      e.peak = Math.max(e.peak, e.active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return impl
          ? await impl(q)
          : [{ url: `https://r.example/${q}`, title: q, snippet: `s-${q}` }];
      } finally {
        e.active--;
      }
    },
  };
  return e;
}

const search = (id: string, query: string): CoreEvent => ({
  e: "toolCall",
  id,
  name: T,
  input: { query },
});
const end = (reason: "stop" | "tool" = "stop"): CoreEvent => ({
  e: "end",
  reason,
  usage: { input: 10, output: 1 },
});

async function collect(it: AsyncIterable<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function run(
  script: Script,
  over: Partial<Parameters<typeof runSearchLoop>[0]> = {},
  req = baseReq(),
) {
  const m = fakeModel(script);
  const eng = (over.engine as ReturnType<typeof engine>) ?? engine();
  const tool = req.hosted[0] as { kind: "search"; wireType: string };
  const p = collect(
    runSearchLoop({
      req,
      tool,
      engine: eng,
      maxSearchesPerRequest: 10,
      callModel: m.call,
      signal: new AbortController().signal,
      ...over,
    }),
  );
  return { m, eng, p };
}

suite("protocol/hosted/searchLoop", () => {
  test("budget is min(setting, max_uses ?? 5)", () => {
    assert.deepEqual(computeBudget(10, undefined), {
      limit: 5,
      code: "max_uses_exceeded",
    });
    assert.deepEqual(computeBudget(3, 8), {
      limit: 3,
      code: "max_uses_exceeded",
    });
    assert.deepEqual(computeBudget(10, 2), {
      limit: 2,
      code: "max_uses_exceeded",
    });
  });

  test("max_tool_calls lower than budget uses max_tool_calls_exceeded", () => {
    assert.deepEqual(computeBudget(10, 5, 1), {
      limit: 1,
      code: "max_tool_calls_exceeded",
    });
  });

  test("loop runs until the model answers and sums usage", async () => {
    const { m, eng, p } = run((_r, i) =>
      i === 0
        ? [search("a", "q1"), end("tool")]
        : [{ e: "text", delta: "done [1]" }, end()],
    );
    const evs = await p;
    assert.equal(m.seen.length, 2);
    assert.deepEqual(eng.queries, ["q1"]);
    assert.deepEqual(
      evs.map((e) => e.e),
      ["hostedCall", "hostedResult", "text", "text", "end"],
    );
    assert.deepEqual(evs[3], {
      e: "text",
      delta: "\n\nSources:\n[1] q1 - https://r.example/q1",
      sources: true,
    });
    const last = evs.at(-1) as Extract<CoreEvent, { e: "end" }>;
    assert.equal(last.reason, "stop");
    assert.deepEqual(last.usage, { input: 20, output: 2 });
    const fed = m.seen[1].turns.at(-1)?.parts[0] as ToolResultPart;
    assert.equal(fed.type, "toolResult");
    assert.match((fed.content[0] as { text: string }).text, /\[1\] q1/);
  });

  test("up to 4 searches run concurrently", async () => {
    const eng = engine();
    const { p } = run(
      (_r, i) =>
        i === 0
          ? [
              ...[1, 2, 3, 4, 5, 6].map((n) => search(`c${n}`, `q${n}`)),
              end("tool"),
            ]
          : [end()],
      {
        engine: eng,
        maxSearchesPerRequest: 10,
        tool: { kind: "search", wireType: "w", maxUses: 10 },
      },
    );
    await p;
    assert.equal(eng.queries.length, 6);
    assert.equal(eng.peak, 4);
  });

  test("parallel_tool_calls false runs searches one at a time", async () => {
    const eng = engine();
    const { p } = run(
      (_r, i) =>
        i === 0 ? [search("a", "1"), search("b", "2"), end("tool")] : [end()],
      { engine: eng },
      baseReq({ parallelToolCalls: false }),
    );
    await p;
    assert.equal(eng.peak, 1);
  });

  test("over-budget calls get max_uses_exceeded and search is withdrawn", async () => {
    const { m, eng, p } = run(
      (_r, i) =>
        i === 0
          ? [search("a", "1"), search("b", "2"), search("c", "3"), end("tool")]
          : [end()],
      { tool: { kind: "search", wireType: "w", maxUses: 2 } },
    );
    const evs = await p;
    assert.equal(eng.queries.length, 2);
    const errs = evs.filter((e) => e.e === "hostedResult" && e.error);
    assert.equal(errs.length, 1);
    assert.equal((errs[0] as { error: string }).error, "max_uses_exceeded");
    assert.ok(!m.seen[1].tools.some((t) => t.name === T));
  });

  test("a failed search gives an error result and the loop continues", async () => {
    const eng = engine(async (q) => {
      if (q === "bad") throw new EngineError("http", 429);
      return [{ url: "https://ok.example", title: "ok", snippet: "" }];
    });
    const { m, p } = run(
      (_r, i) =>
        i === 0
          ? [search("a", "bad"), search("b", "good"), end("tool")]
          : [{ e: "text", delta: "x" }, end()],
      { engine: eng },
    );
    const evs = await p;
    const res = evs.filter((e) => e.e === "hostedResult") as Array<{
      error?: string;
    }>;
    assert.equal(res[0].error, "too_many_requests");
    assert.equal(res[1].error, undefined);
    assert.equal(m.seen.length, 2);
    assert.equal(evs.at(-1)?.e, "end");
  });

  test("abort stops the loop without further model calls", async () => {
    const ac = new AbortController();
    const eng = engine(async () => {
      ac.abort();
      return [];
    });
    const { m, p } = run(
      (_r, i) => (i === 0 ? [search("a", "q"), end("tool")] : [end()]),
      {
        engine: eng,
        signal: ac.signal,
      },
    );
    const evs = await p;
    assert.equal(m.seen.length, 1);
    assert.ok(!evs.some((e) => e.e === "end"));
  });

  test("client tools are offered every round; search then client tool ends the turn", async () => {
    const req = baseReq({
      tools: [{ name: "save_year", inputSchema: { type: "object" } }],
    });
    const { m, eng, p } = run(
      (r, i) => {
        if (i === 0)
          return [
            { e: "text", delta: "Let me check." },
            search("s1", "year of x"),
            end("tool"),
          ];
        assert.ok(r.tools.some((t) => t.name === "save_year"));
        return [
          {
            e: "toolCall",
            id: "tc1",
            name: "save_year",
            input: { year: 1999 },
          },
          end("tool"),
        ];
      },
      {},
      req,
    );
    const evs = await p;
    assert.deepEqual(eng.queries, ["year of x"]);
    for (const s of m.seen) {
      assert.deepEqual(
        s.tools.map((t) => t.name),
        ["save_year", T],
      );
    }
    assert.deepEqual(
      evs.map((e) => e.e),
      ["text", "hostedCall", "hostedResult", "text", "toolCall", "end"],
    );
    assert.match(
      (evs[3] as Extract<CoreEvent, { e: "text" }>).delta,
      /^\n\nSources:\n\[1\] /,
    );
    const tc = evs[4] as Extract<CoreEvent, { e: "toolCall" }>;
    assert.equal(tc.name, "save_year");
    assert.equal((evs[5] as Extract<CoreEvent, { e: "end" }>).reason, "tool");
  });

  test("internal tool name avoids a client tool named like it", async () => {
    const req = baseReq({ tools: [{ name: T, inputSchema: {} }] });
    const { m, p } = run(() => [end()], {}, req);
    await p;
    assert.deepEqual(
      m.seen[0].tools.map((t) => t.name),
      [T, `${T}_2`],
    );
  });

  test("forced search tool is required on the first round only", async () => {
    const { m, p } = run(
      (_r, i) => (i === 0 ? [search("a", "q"), end("tool")] : [end()]),
      { tool: { kind: "search", wireType: "w", forced: true } },
    );
    await p;
    assert.deepEqual(m.seen[0].toolMode, { kind: "required", only: [T] });
    assert.deepEqual(m.seen[1].toolMode, { kind: "auto" });
  });

  test("hook prepare adds search next to client tools", () => {
    const req = baseReq({ tools: [{ name: "f", inputSchema: {} }] });
    const hook = createSearchHook({
      req,
      engines: { search: engine(), maxSearchesPerRequest: 5 },
    });
    assert.ok(hook);
    assert.deepEqual(
      hook.prepare(req).tools.map((t) => t.name),
      ["f", T],
    );
    assert.equal(createSearchHook({ req, engines: undefined }), undefined);
  });

  test("semaphore bounds concurrency", async () => {
    const s = new Semaphore(2);
    let a = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        s.run(async () => {
          a++;
          peak = Math.max(peak, a);
          await new Promise((r) => setTimeout(r, 2));
          a--;
        }),
      ),
    );
    assert.equal(peak, 2);
  });
});

suite("protocol/hosted/citations", () => {
  test("sources dedupe by URL with stable indices", () => {
    const reg = new CitationRegistry();
    assert.deepEqual(
      reg.add([{ url: "https://a.example/x" }, { url: "https://b.example" }]),
      [0, 1],
    );
    assert.deepEqual(
      reg.add([
        { url: "https://b.example/", title: "B" },
        { url: "https://a.example/x#frag" },
        { url: "https://c.example" },
      ]),
      [1, 0, 2],
    );
    assert.equal(reg.size, 3);
    assert.equal(
      dedupeSources([
        { url: "https://a.example" },
        { url: "https://a.example/" },
      ]).length,
      1,
    );
  });
});

suite("protocol/hosted/urlContext", () => {
  const fetcher = (
    fail: (u: string) => boolean,
  ): WebFetchEngine & { asked: string[] } => {
    const e = {
      asked: [] as string[],
      meta: {
        id: "jina" as const,
        label: "J",
        anonymousSearch: false,
        anonymousFetch: true,
        supportsFetch: true,
      },
      async fetch(urls: readonly string[]) {
        e.asked.push(...urls);
        return urls.map((url) =>
          fail(url)
            ? { url, status: "error" as const }
            : { url, status: "ok" as const, text: `T ${url}` },
        );
      },
    };
    return e;
  };
  const turns = (text: string) => [
    { role: "user" as const, parts: [{ type: "text" as const, text }] },
  ];
  const urls7 = [1, 2, 3, 4, 5, 6, 7]
    .map((n) => `https://s${n}.example/p`)
    .join(" ");

  test("seven URLs give five fetched", async () => {
    const eng = fetcher(() => false);
    const r = await runUrlContext({
      turns: turns(urls7),
      engine: eng,
      signal: new AbortController().signal,
    });
    assert.equal(eng.asked.length, 5);
    assert.equal(r.urlMetadata.length, 5);
    assert.ok(r.callModel);
  });

  test("URLs come from the last user turn only", () => {
    assert.deepEqual(
      extractUrls([
        ...turns("https://old.example"),
        {
          role: "assistant",
          parts: [{ type: "text", text: "https://a.example" }],
        },
        ...turns("see https://new.example/x."),
      ]),
      ["https://new.example/x"],
    );
  });

  test("unsafe URLs are reported UNSAFE and never fetched", async () => {
    const eng = fetcher(() => false);
    const r = await runUrlContext({
      turns: turns("http://127.0.0.1/a https://ok.example/"),
      engine: eng,
      signal: new AbortController().signal,
    });
    assert.deepEqual(eng.asked, ["https://ok.example/"]);
    assert.equal(
      r.urlMetadata[0].urlRetrievalStatus,
      "URL_RETRIEVAL_STATUS_UNSAFE",
    );
    assert.equal(
      r.urlMetadata[1].urlRetrievalStatus,
      "URL_RETRIEVAL_STATUS_SUCCESS",
    );
  });

  test("all fetches failing means no model call", async () => {
    const r = await runUrlContext({
      turns: turns("https://a.example https://b.example"),
      engine: fetcher(() => true),
      signal: new AbortController().signal,
    });
    assert.equal(r.callModel, false);
    assert.ok(
      r.urlMetadata.every(
        (u) => u.urlRetrievalStatus === "URL_RETRIEVAL_STATUS_ERROR",
      ),
    );
  });

  test("no engine gives ERROR statuses and no model call", async () => {
    const r = await runUrlContext({
      turns: turns("https://a.example"),
      engine: undefined,
      signal: new AbortController().signal,
    });
    assert.equal(r.callModel, false);
    assert.equal(
      r.urlMetadata[0].urlRetrievalStatus,
      "URL_RETRIEVAL_STATUS_ERROR",
    );
  });

  test("oversized page gets the truncation marker", async () => {
    const eng: WebFetchEngine = {
      meta: {
        id: "jina",
        label: "J",
        anonymousSearch: false,
        anonymousFetch: true,
        supportsFetch: true,
      },
      fetch: async (urls) =>
        urls.map((url) => ({
          url,
          status: "ok" as const,
          text: "y".repeat(100_050),
        })),
    };
    const r = await runUrlContext({
      turns: turns("https://a.example"),
      engine: eng,
      signal: new AbortController().signal,
    });
    assert.ok(r.pages[0].text.endsWith("[content truncated]"));
    assert.equal(
      r.pages[0].text.length,
      100_000 + 1 + "[content truncated]".length,
    );
  });
});

suite("protocol/hosted/output", () => {
  const sources = [
    { url: "https://a.example", title: "A", snippet: "alpha" },
    { url: "https://b.example", title: "B" },
  ];

  test("anthropic server_tool_use and web_search_tool_result blocks", () => {
    assert.deepEqual(anth.serverToolUseBlock("srvtoolu_1", "q"), {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "web_search",
      input: { query: "q" },
    });
    const r = anth.webSearchToolResultBlock("srvtoolu_1", sources);
    assert.equal(r.tool_use_id, "srvtoolu_1");
    assert.ok(Array.isArray(r.content));
    assert.equal((r.content as anth.AnthropicWebSearchResult[])[1].title, "B");
    const e = anth.webSearchToolResultBlock("x", [], "max_uses_exceeded");
    assert.deepEqual(e.content, {
      type: "web_search_tool_result_error",
      error_code: "max_uses_exceeded",
    });
    assert.deepEqual(anth.serverToolUsage(2), {
      server_tool_use: { web_search_requests: 2 },
    });
    assert.equal(anth.searchCitations(sources)[0].cited_text, "alpha");
  });

  test("responses web_search_call item, events and url_citation", () => {
    const item = resp.webSearchCallItem("ws_1", "q", sources);
    assert.equal(item.status, "completed");
    assert.equal(item.action?.sources?.length, 2);
    const evs = resp.webSearchCallEvents(item, 0);
    assert.deepEqual(
      evs.map((e) => e.type),
      [
        "response.output_item.added",
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
        "response.output_item.done",
      ],
    );
    const text = "Alpha [1] and https://b.example.";
    const c = resp.urlCitations(text, sources);
    assert.equal(c.length, 2);
    assert.equal(text.slice(c[0].start_index, c[0].end_index), "[1]");
    assert.equal(c[1].url, "https://b.example");
  });

  test("gemini groundingMetadata dedupes chunks and cites [n] spans", () => {
    const g = gem.groundingMetadata(
      ["q"],
      [...sources, { url: "https://a.example/" }],
      "First fact [2]. No cite here.",
    );
    assert.equal(g.groundingChunks.length, 2);
    assert.equal(g.groundingSupports.length, 1);
    assert.deepEqual(g.groundingSupports[0].groundingChunkIndices, [1]);
    assert.equal(g.groundingSupports[0].segment.startIndex, 0);
    assert.deepEqual(g.webSearchQueries, ["q"]);
  });

  test("urlContextMetadata mirrors url statuses", () => {
    const m = gem.urlContextMetadata([
      {
        retrievedUrl: "https://a.example",
        urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
      },
    ]);
    assert.equal(
      m.urlMetadata[0].urlRetrievalStatus,
      "URL_RETRIEVAL_STATUS_SUCCESS",
    );
  });
});
