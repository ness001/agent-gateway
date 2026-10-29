import * as assert from "assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  RemoteUnavailableError,
  flattenToolSchemas,
  forwardToRemote,
} from "../../gateway/forward";

suite("flattenToolSchemas", () => {
  const oneOf = {
    oneOf: [
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object", properties: { b: { type: "string" } } },
    ],
  };
  const flat = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
  };

  test("flattens Responses, Chat, Anthropic and namespace tools", () => {
    const out = flattenToolSchemas({
      tools: [
        { type: "function", name: "r", parameters: oneOf },
        { type: "function", function: { name: "c", parameters: oneOf } },
        { name: "m", input_schema: oneOf },
        {
          type: "namespace",
          name: "ns",
          tools: [{ type: "function", name: "x", parameters: oneOf }],
        },
        { type: "custom", name: "apply_patch" },
      ],
    });
    assert.deepStrictEqual(out.tools, [
      { type: "function", name: "r", parameters: flat },
      { type: "function", function: { name: "c", parameters: flat } },
      { name: "m", input_schema: flat },
      {
        type: "namespace",
        name: "ns",
        tools: [{ type: "function", name: "x", parameters: flat }],
      },
      { type: "custom", name: "apply_patch" },
    ]);
  });

  test("leaves bodies without tools unchanged", () => {
    const body = { model: "m", input: "hi" };
    assert.strictEqual(flattenToolSchemas(body), body);
  });
});

interface Seen {
  url?: string;
  headers?: http.IncomingHttpHeaders;
  body?: string;
}

async function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    seen: Seen,
  ) => void,
): Promise<{ url: string; seen: Seen; close: () => Promise<void> }> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.body = body;
      handler(req, res, seen);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const callerHeaders = () =>
  new Headers({
    authorization: "Bearer caller",
    "x-api-key": "caller",
    "x-goog-api-key": "caller",
    cookie: "c=1",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });

suite("forwardToRemote", () => {
  test("rewrites model, strips credentials, adds bearer", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    try {
      const res = await forwardToRemote({
        remote: { name: "devbox", url: s.url },
        apiKey: "remote-key",
        method: "POST",
        path: "/v1/messages",
        search: "",
        headers: callerHeaders(),
        body: { model: "devbox--claude", nested: { model: "keep" } },
        upstreamModelId: "claude",
        signal: new AbortController().signal,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), '{"ok":true}');
      assert.strictEqual(s.seen.url, "/v1/messages");
      assert.deepStrictEqual(JSON.parse(s.seen.body!), {
        model: "claude",
        nested: { model: "keep" },
      });
      assert.strictEqual(s.seen.headers!.authorization, "Bearer remote-key");
      assert.strictEqual(s.seen.headers!["x-api-key"], undefined);
      assert.strictEqual(s.seen.headers!["x-goog-api-key"], undefined);
      assert.strictEqual(s.seen.headers!.cookie, undefined);
      assert.strictEqual(s.seen.headers!["anthropic-version"], "2023-06-01");
    } finally {
      await s.close();
    }
  });

  test("no authorization without remote key", async () => {
    const s = await startServer((_req, res) => res.end("{}"));
    try {
      await forwardToRemote({
        remote: { name: "d", url: s.url },
        method: "POST",
        path: "/v1/chat/completions",
        search: "",
        headers: callerHeaders(),
        body: { model: "x" },
        upstreamModelId: "y",
        signal: new AbortController().signal,
      });
      assert.strictEqual(s.seen.headers!.authorization, undefined);
    } finally {
      await s.close();
    }
  });

  test("Gemini path uses upstream ID and strips key", async () => {
    const s = await startServer((_req, res) => res.end("{}"));
    try {
      await forwardToRemote({
        remote: { name: "d", url: s.url },
        method: "POST",
        path: "/v1beta/models/d--gemini-2.5-pro:streamGenerateContent",
        search: "?alt=sse&key=secret",
        headers: callerHeaders(),
        body: { contents: [] },
        upstreamModelId: "gemini/2.5 pro",
        gemini: { action: "streamGenerateContent" },
        signal: new AbortController().signal,
      });
      assert.strictEqual(
        s.seen.url,
        "/v1beta/models/gemini%2F2.5%20pro:streamGenerateContent?alt=sse",
      );
      assert.deepStrictEqual(JSON.parse(s.seen.body!), { contents: [] });
    } finally {
      await s.close();
    }
  });

  test("SSE chunks arrive before upstream ends", async () => {
    let finish: (() => void) | undefined;
    const s = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      finish = () => res.end("data: two\n\n");
    });
    try {
      const res = await forwardToRemote({
        remote: { name: "d", url: s.url },
        method: "POST",
        path: "/v1/messages",
        search: "",
        headers: callerHeaders(),
        body: { model: "x", stream: true },
        upstreamModelId: "y",
        signal: new AbortController().signal,
      });
      assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
      assert.strictEqual(res.headers.get("transfer-encoding"), null);
      const reader = res.body!.getReader();
      const first = await reader.read();
      assert.strictEqual(Buffer.from(first.value!).toString(), "data: one\n\n");
      assert.ok(finish, "upstream still open");
      finish!();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        rest += Buffer.from(value).toString();
      }
      assert.strictEqual(rest, "data: two\n\n");
    } finally {
      await s.close();
    }
  });

  test("abort cancels upstream request", async () => {
    let closed: () => void = () => undefined;
    const closedPromise = new Promise<void>((r) => (closed = r));
    const s = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.on("close", () => closed());
    });
    try {
      const controller = new AbortController();
      const res = await forwardToRemote({
        remote: { name: "d", url: s.url },
        method: "POST",
        path: "/v1/messages",
        search: "",
        headers: callerHeaders(),
        body: { model: "x" },
        upstreamModelId: "y",
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await Promise.race([
        closedPromise,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("upstream not closed")), 2000),
        ),
      ]);
    } finally {
      await s.close();
    }
  });

  test("network failure throws RemoteUnavailableError", async () => {
    const s = await startServer(() => undefined);
    const url = s.url;
    await s.close();
    await assert.rejects(
      forwardToRemote({
        remote: { name: "d", url },
        method: "POST",
        path: "/v1/messages",
        search: "",
        headers: callerHeaders(),
        body: { model: "x" },
        upstreamModelId: "y",
        signal: new AbortController().signal,
      }),
      (e: unknown) =>
        e instanceof RemoteUnavailableError &&
        e.category === "connection refused" &&
        e.status === 502 &&
        e.message ===
          "Remote upstream 'd' is unavailable: connection refused. Check that devtunnel host is running on that machine.",
    );
  });

  const fail = (error: unknown, signal = new AbortController().signal) =>
    forwardToRemote({
      remote: { name: "d", url: "http://unused.test" },
      method: "POST",
      path: "/v1/messages",
      search: "",
      headers: callerHeaders(),
      body: { model: "x" },
      upstreamModelId: "y",
      signal,
      fetchImpl: (async () => {
        throw error;
      }) as typeof fetch,
    }).then(
      () => assert.fail("expected rejection"),
      (e: unknown) => e as RemoteUnavailableError,
    );
  const coded = (code: string, message = "secret-token http://x") =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(message), { code }),
    });

  for (const [code, category, status] of [
    ["ECONNREFUSED", "connection refused", 502],
    ["ENOTFOUND", "DNS lookup failed", 502],
    ["EAI_AGAIN", "DNS lookup failed", 502],
    ["CERT_HAS_EXPIRED", "TLS error", 502],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS error", 502],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout", 504],
    ["ETIMEDOUT", "timeout", 504],
    ["ECONNRESET", "connection reset", 502],
    ["EWHATEVER", "network error", 502],
  ] as const) {
    test(`${code} maps to ${category} (${status})`, async () => {
      const e = await fail(coded(code));
      assert.ok(e instanceof RemoteUnavailableError);
      assert.strictEqual(e.category, category);
      assert.strictEqual(e.status, status);
      assert.ok(!e.message.includes("secret-token"));
      assert.ok(!e.message.includes("http://x"));
    });
  }

  test("raw message text never drives the category", async () => {
    const e = await fail(new Error("ECONNREFUSED getaddrinfo ENOTFOUND"));
    assert.strictEqual(e.category, "network error");
  });

  test("AggregateError causes are inspected", async () => {
    const agg = new AggregateError([
      Object.assign(new Error("a"), { code: "ECONNREFUSED" }),
    ]);
    const e = await fail(new TypeError("fetch failed", { cause: agg }));
    assert.strictEqual(e.category, "connection refused");
  });

  test("aborted signal maps to aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await fail(
      new DOMException("This operation was aborted", "AbortError"),
      ac.signal,
    );
    assert.strictEqual(e.category, "aborted");
  });

  test("unresolvable host maps to DNS lookup failed", async () => {
    const err = await forwardToRemote({
      remote: { name: "d", url: "http://does-not-exist.invalid" },
      method: "POST",
      path: "/v1/messages",
      search: "",
      headers: callerHeaders(),
      body: { model: "x" },
      upstreamModelId: "y",
      signal: new AbortController().signal,
    }).then(
      () => assert.fail("expected rejection"),
      (e: unknown) => e as RemoteUnavailableError,
    );
    assert.strictEqual(err.category, "DNS lookup failed");
  });
});
