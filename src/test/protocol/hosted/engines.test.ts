import * as assert from "node:assert/strict";

import {
  createEngine,
  createHostedEngines,
} from "../../../protocol/hosted/engines";
import {
  ENGINE_TIMEOUT_MS,
  EngineError,
  type FetchLike,
  MAX_PAGE_CHARS,
  TRUNCATION_MARKER,
} from "../../../protocol/hosted/engines/engine";
import { parseExaMcpResults } from "../../../protocol/hosted/engines/exa";
import { checkUrl } from "../../../protocol/hosted/urlSafety";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
}

function stub(respond: (c: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const c: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(c);
    const r = respond(c);
    return {
      ok: status < 400,
      status,
      text: async () => (typeof r === "string" ? r : JSON.stringify(r)),
    };
  };
  return { calls, f };
}

const sig = (): AbortSignal => new AbortController().signal;

suite("protocol/hosted/urlSafety", () => {
  const table: Array<[string, boolean, string?]> = [
    ["https://example.com/a", true],
    ["http://example.com", true],
    ["http://127.0.0.1/", false, "loopback"],
    ["http://localhost:8080/", false, "loopback"],
    ["http://10.1.2.3/", false, "private"],
    ["http://172.16.0.1/", false, "private"],
    ["http://192.168.1.1/", false, "private"],
    ["http://169.254.169.254/latest", false, "link_local"],
    ["http://[::1]/", false, "loopback"],
    ["http://[fe80::1]/", false, "link_local"],
    ["http://[::ffff:127.0.0.1]/", false, "loopback"],
    ["http://intranet/", false, "single_label"],
    ["http://printer.local/", false, "local_name"],
    ["https://user:pw@example.com/", false, "userinfo"],
    ["ftp://example.com/", false, "scheme"],
    ["file:///etc/passwd", false, "scheme"],
    ["not a url", false, "invalid"],
  ];
  for (const [url, safe, reason] of table) {
    test(`7 ${url} -> ${safe ? "safe" : reason}`, () => {
      const r = checkUrl(url);
      assert.equal(r.safe, safe);
      if (!r.safe) {
        assert.equal(r.reason, reason);
      }
    });
  }
});

suite("protocol/hosted/engines", () => {
  test("provider none creates no engines", () => {
    assert.equal(createHostedEngines("none", {}, 5), undefined);
    assert.equal(createHostedEngines(undefined, {}, 5), undefined);
    assert.ok(createHostedEngines("exa", {}, 5)?.search);
  });

  for (const id of ["tavily", "you", "kagi"] as const) {
    test(`1 ${id} without key makes zero network calls`, async () => {
      const { calls, f } = stub(() => ({}));
      const e = createEngine(id, { fetchImpl: f });
      await assert.rejects(e.search("q", {}, sig()), (err: unknown) => {
        return err instanceof EngineError && err.code === "missing_key";
      });
      await assert.rejects(e.fetch(["https://example.com"], sig()));
      assert.equal(calls.length, 0);
    });
  }

  test("jina search without key makes zero network calls", async () => {
    const { calls, f } = stub(() => ({}));
    const e = createEngine("jina", { fetchImpl: f, apiKey: "  " });
    await assert.rejects(e.search("q", {}, sig()));
    assert.equal(calls.length, 0);
  });

  test("exa anonymous search uses the public MCP endpoint", async () => {
    const { calls, f } = stub(() => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: "Title: A\nURL: https://a.example/\nText: alpha\n\nTitle: B\nURL: https://b.example/\nText: beta",
          },
        ],
      },
    }));
    const e = createEngine("exa", { fetchImpl: f });
    const r = await e.search("q", { maxResults: 3 }, sig());
    assert.equal(calls[0].url, "https://mcp.exa.ai/mcp");
    const body = calls[0].body as { method: string; params: { name: string } };
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "web_search_exa");
    assert.equal(calls[0].headers["x-api-key"], undefined);
    assert.deepEqual(
      r.map((x) => x.url),
      ["https://a.example/", "https://b.example/"],
    );
  });

  test("exa anonymous fetch uses web_fetch_exa over SSE", async () => {
    const { calls, f } = stub(
      () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"page"}]}}\n\n',
    );
    const e = createEngine("exa", { fetchImpl: f });
    const r = await e.fetch(["https://a.example/"], sig());
    assert.equal(
      (calls[0].body as { params: { name: string } }).params.name,
      "web_fetch_exa",
    );
    assert.deepEqual(r, [
      { url: "https://a.example/", status: "ok", text: "page" },
    ]);
  });

  test("exa with key uses REST /search and x-api-key", async () => {
    const { calls, f } = stub(() => ({
      results: [{ url: "https://a.example", title: "A", text: "t" }],
    }));
    const e = createEngine("exa", { fetchImpl: f, apiKey: "K" });
    const r = await e.search("q", { allowedDomains: ["a.example"] }, sig());
    assert.equal(calls[0].url, "https://api.exa.ai/search");
    assert.equal(calls[0].headers["x-api-key"], "K");
    assert.deepEqual(
      (calls[0].body as { includeDomains: string[] }).includeDomains,
      ["a.example"],
    );
    assert.equal(r[0].title, "A");
  });

  test("exa with key fetches via REST /contents", async () => {
    const { calls, f } = stub(() => ({
      results: [{ url: "u", text: "body" }],
    }));
    const e = createEngine("exa", { fetchImpl: f, apiKey: "K" });
    const r = await e.fetch(["https://a.example"], sig());
    assert.equal(calls[0].url, "https://api.exa.ai/contents");
    assert.equal(r[0].status, "ok");
  });

  test("firecrawl /v2/search anonymous and Bearer with key", async () => {
    const { calls, f } = stub(() => ({
      success: true,
      data: {
        web: [{ url: "https://a.example", title: "A", description: "d" }],
      },
    }));
    await createEngine("firecrawl", { fetchImpl: f }).search("q", {}, sig());
    await createEngine("firecrawl", { fetchImpl: f, apiKey: "K" }).search(
      "q",
      {},
      sig(),
    );
    assert.equal(calls[0].url, "https://api.firecrawl.dev/v2/search");
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[1].headers.Authorization, "Bearer K");
  });

  test("firecrawl fetch uses /v2/scrape markdown", async () => {
    const { calls, f } = stub(() => ({
      data: { markdown: "# hi", metadata: { title: "T" } },
    }));
    const r = await createEngine("firecrawl", { fetchImpl: f }).fetch(
      ["https://a.example"],
      sig(),
    );
    assert.equal(calls[0].url, "https://api.firecrawl.dev/v2/scrape");
    assert.deepEqual((calls[0].body as { formats: string[] }).formats, [
      "markdown",
    ]);
    assert.deepEqual(r[0], {
      url: "https://a.example",
      status: "ok",
      title: "T",
      text: "# hi",
    });
  });

  test("tavily /search and /extract with Bearer", async () => {
    const { calls, f } = stub((c) =>
      c.url.endsWith("/search")
        ? { results: [{ url: "https://a.example", title: "A", content: "c" }] }
        : { results: [{ url: "https://a.example", raw_content: "raw" }] },
    );
    const e = createEngine("tavily", { fetchImpl: f, apiKey: "K" });
    const s = await e.search("q", { blockedDomains: ["b.example"] }, sig());
    const p = await e.fetch(["https://a.example", "https://c.example"], sig());
    assert.equal(calls[0].url, "https://api.tavily.com/search");
    assert.equal(calls[0].headers.Authorization, "Bearer K");
    assert.deepEqual(
      (calls[0].body as { exclude_domains: string[] }).exclude_domains,
      ["b.example"],
    );
    assert.equal(calls[1].url, "https://api.tavily.com/extract");
    assert.equal(s[0].snippet, "c");
    assert.deepEqual(
      p.map((x) => x.status),
      ["ok", "error"],
    );
  });

  test("jina s.jina.ai search with key and r.jina.ai reader anonymous", async () => {
    const { calls, f } = stub(() => ({
      data: [{ url: "https://a.example", title: "A", description: "d" }],
    }));
    await createEngine("jina", { fetchImpl: f, apiKey: "K" }).search(
      "a b",
      {},
      sig(),
    );
    assert.equal(calls[0].url, "https://s.jina.ai/?q=a%20b");
    assert.equal(calls[0].headers.Authorization, "Bearer K");
    const { calls: c2, f: f2 } = stub(() => ({
      data: { content: "page", title: "T" },
    }));
    const r = await createEngine("jina", { fetchImpl: f2 }).fetch(
      ["https://a.example/x"],
      sig(),
    );
    assert.equal(c2[0].url, "https://r.jina.ai/https://a.example/x");
    assert.equal(c2[0].headers.Authorization, undefined);
    assert.equal(r[0].text, "page");
  });

  test("you.com search and /v1/contents with X-API-Key", async () => {
    const { calls, f } = stub((c) =>
      c.url.includes("/v1/search")
        ? {
            results: {
              web: [{ url: "https://a.example", title: "A", description: "d" }],
            },
          }
        : [{ url: "https://a.example", markdown: "md" }],
    );
    const e = createEngine("you", { fetchImpl: f, apiKey: "K" });
    const s = await e.search("q", {}, sig());
    const p = await e.fetch(["https://a.example"], sig());
    assert.ok(
      calls[0].url.startsWith("https://ydc-index.io/v1/search?query=q"),
    );
    assert.equal(calls[0].headers["X-API-Key"], "K");
    assert.equal(calls[1].url, "https://ydc-index.io/v1/contents");
    assert.equal(s.length, 1);
    assert.equal(p[0].text, "md");
  });

  test("page text is capped with the truncation marker", async () => {
    const big = "x".repeat(MAX_PAGE_CHARS + 10);
    const { f } = stub(() => ({ data: { markdown: big } }));
    const r = await createEngine("firecrawl", { fetchImpl: f }).fetch(
      ["https://a.example"],
      sig(),
    );
    assert.ok(r[0].text?.endsWith(TRUNCATION_MARKER));
    assert.equal(
      r[0].text?.length,
      MAX_PAGE_CHARS + 1 + TRUNCATION_MARKER.length,
    );
  });

  test("engines use a 30 s timeout combined with the caller signal", async () => {
    assert.equal(ENGINE_TIMEOUT_MS, 30_000);
    const ac = new AbortController();
    const { calls, f } = stub(() => ({ data: { web: [] } }));
    await createEngine("firecrawl", { fetchImpl: f }).search(
      "q",
      {},
      ac.signal,
    );
    assert.notEqual(calls[0].signal, ac.signal);
    assert.equal(calls[0].signal.aborted, false);
    ac.abort();
    assert.equal(calls[0].signal.aborted, true);
  });

  test("timeout surfaces as EngineError timeout", async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_r, rej) =>
        init.signal.addEventListener("abort", () => rej(new Error("abort"))),
      );
    const e = createEngine("firecrawl", { fetchImpl: f, timeoutMs: 10 });
    await assert.rejects(e.search("q", {}, sig()), (err: unknown) => {
      return err instanceof EngineError && err.code === "timeout";
    });
  });

  test("engine errors carry no query or URL", async () => {
    const { f } = stub(() => "nope", 500);
    const e = createEngine("firecrawl", { fetchImpl: f });
    await assert.rejects(
      e.search("secret-query", {}, sig()),
      (err: unknown) => {
        const m = String((err as Error).message);
        return !m.includes("secret-query") && !m.includes("firecrawl.dev");
      },
    );
  });

  test("exa MCP JSON results payload is parsed", () => {
    const r = parseExaMcpResults(
      JSON.stringify({
        results: [{ url: "https://a.example", title: "A", text: "t" }],
      }),
    );
    assert.equal(r[0].url, "https://a.example");
  });
});

suite("protocol/hosted/brave-kagi", () => {
  test("brave needs a key and never exposes a fetch engine", async () => {
    const { calls, f } = stub(() => ({}));
    const e = createEngine("brave", { fetchImpl: f });
    await assert.rejects(
      e.search("q", {}, sig()),
      (err: unknown) =>
        err instanceof EngineError && err.code === "missing_key",
    );
    assert.deepEqual(await e.fetch(["https://example.com"], sig()), [
      { url: "https://example.com", status: "error" },
    ]);
    assert.equal(calls.length, 0);
    const hosted = createHostedEngines("brave", {}, 5);
    assert.ok(hosted?.search);
    assert.equal(hosted?.fetch, undefined);
    assert.ok(createHostedEngines("kagi", {}, 5)?.fetch);
  });

  for (const id of ["brave", "kagi"] as const) {
    test(`${id} encodes queries, maps results and applies domain and count limits`, async () => {
      const hits = [
        {
          url: "https://blocked.example.com/",
          title: "Blocked",
          description: "bad",
          snippet: "bad",
        },
        {
          url: "https://example.com/a",
          title: "A",
          description: "alpha",
          snippet: "alpha",
          page_age: "2026-01-01",
          time: "2026-01-01",
        },
        {
          url: "https://sub.example.com/b",
          title: "B",
          description: "beta",
          snippet: "beta",
        },
        { title: "missing URL" },
        { url: "https://elsewhere.test/", title: "Other" },
      ];
      const { calls, f } = stub(() =>
        id === "brave"
          ? { web: { results: hits } }
          : { data: { search: hits } },
      );
      const e = createEngine(id, { fetchImpl: f, apiKey: " test-key " });
      const query = "space & unicode caf�?#";
      const result = await e.search(
        query,
        {
          maxResults: 1,
          allowedDomains: ["example.com"],
          blockedDomains: ["blocked.example.com"],
        },
        sig(),
      );
      assert.deepEqual(result, [
        {
          url: "https://example.com/a",
          title: "A",
          snippet: "alpha",
          publishedAt: "2026-01-01",
        },
      ]);
      const call = calls[0];
      if (id === "brave") {
        const url = new URL(call.url);
        assert.equal(
          url.origin + url.pathname,
          "https://api.search.brave.com/res/v1/web/search",
        );
        assert.equal(url.searchParams.get("q"), query);
        assert.equal(url.searchParams.get("count"), "1");
        assert.equal(url.searchParams.get("text_decorations"), "false");
        assert.equal(call.method, "GET");
        assert.equal(call.headers["X-Subscription-Token"], "test-key");
      } else {
        assert.equal(call.url, "https://kagi.com/api/v1/search");
        assert.equal(call.method, "POST");
        assert.equal(call.headers.Authorization, "Bearer test-key");
        assert.deepEqual(call.body, { query, limit: 1 });
      }
      assert.ok(!call.url.includes("test-key"));
    });

    test(`${id} handles empty responses and sanitized HTTP/parse failures`, async () => {
      const empty = stub(() => ({}));
      assert.deepEqual(
        await createEngine(id, { apiKey: "key", fetchImpl: empty.f }).search(
          "q",
          {},
          sig(),
        ),
        [],
      );
      for (const status of [401, 429, 500]) {
        const { f } = stub(() => "private query and key", status);
        await assert.rejects(
          createEngine(id, { apiKey: "key", fetchImpl: f }).search(
            "q",
            {},
            sig(),
          ),
          (e: unknown) =>
            e instanceof EngineError &&
            e.status === status &&
            e.message === `engine http ${status}`,
        );
      }
      const malformed = stub(() => "not json");
      await assert.rejects(
        createEngine(id, { apiKey: "key", fetchImpl: malformed.f }).search(
          "q",
          {},
          sig(),
        ),
        (e: unknown) => e instanceof EngineError && e.code === "parse",
      );
    });

    test(`${id} propagates cancellation`, async () => {
      const controller = new AbortController();
      controller.abort();
      const f: FetchLike = async (_url, init) => {
        init.signal.throwIfAborted();
        throw new Error("unreachable");
      };
      await assert.rejects(
        createEngine(id, { apiKey: "key", fetchImpl: f }).search(
          "q",
          {},
          controller.signal,
        ),
        (e: unknown) => e === controller.signal.reason,
      );
    });
  }

  test("kagi extract batches, preserves order, caps text and reports per-page failures", async () => {
    const urls = Array.from(
      { length: 11 },
      (_, i) => `https://example.com/${i}`,
    );
    const { calls, f } = stub((call) => {
      assert.equal(call.url, "https://kagi.com/api/v1/extract");
      assert.equal(call.method, "POST");
      assert.equal(call.headers.Authorization, "Bearer key");
      const pages = (call.body as { pages: { url: string }[] }).pages;
      assert.ok(pages.length <= 10);
      return {
        data: pages
          .slice()
          .reverse()
          .map(({ url }) => ({
            url,
            markdown: url === urls[0] ? "x".repeat(MAX_PAGE_CHARS + 1) : "page",
            error: url === urls[1] ? "private failure" : undefined,
          })),
      };
    });
    const results = await createEngine("kagi", {
      apiKey: "key",
      fetchImpl: f,
    }).fetch(urls, sig());
    assert.equal(calls.length, 2);
    assert.deepEqual(
      results.map((r) => r.url),
      urls,
    );
    assert.ok(results[0].text?.endsWith(TRUNCATION_MARKER));
    assert.deepEqual(results[1], { url: urls[1], status: "error" });
    assert.equal(results[10].text, "page");
  });

  test("kagi rejects API error envelopes without disclosing their text", async () => {
    const { f } = stub(() => ({ error: [{ message: "private query" }] }));
    const e = createEngine("kagi", { apiKey: "key", fetchImpl: f });
    await assert.rejects(
      e.search("q", {}, sig()),
      (err: unknown) =>
        err instanceof EngineError && err.message === "engine parse",
    );
    assert.deepEqual(await e.fetch(["https://example.com"], sig()), [
      { url: "https://example.com", status: "error" },
    ]);
  });
});
