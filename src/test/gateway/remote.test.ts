import * as assert from "assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { discoverRemote } from "../../gateway/remote";
import { parseRemoteUpstreams } from "../../gateway/remoteConfig";
import type { ModelInfo } from "../../gateway/types";

const model: ModelInfo = {
  id: "gpt-4o",
  displayName: "GPT-4o",
  contextWindow: 128000,
  inputModalities: ["text"],
  supportsToolCalling: true,
  defaultReasoningLevel: "medium",
  supportedReasoningLevels: [],
  operations: ["openai.chatCompletions"],
};

async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

suite("parseRemoteUpstreams", () => {
  test("accepts valid entries and trims trailing slash", () => {
    const r = parseRemoteUpstreams([
      { name: "devbox", url: "https://abc-24444.usw2.devtunnels.ms/" },
      { name: "Devbox", url: "http://127.0.0.1:1234/v1/" },
    ]);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.upstreams, [
      { name: "devbox", url: "https://abc-24444.usw2.devtunnels.ms" },
      { name: "Devbox", url: "http://127.0.0.1:1234" },
    ]);
  });

  test("reports and skips invalid entries", () => {
    const r = parseRemoteUpstreams([
      { url: "https://a.example" },
      { name: "-bad", url: "https://a.example" },
      { name: "ok", url: "https://a.example" },
      { name: "ok", url: "https://b.example" },
      { name: "p", url: "https://a.example/api" },
      { name: "q", url: "https://a.example?x=1" },
      { name: "f", url: "https://a.example#x" },
      { name: "c", url: "https://u:p@a.example" },
      { name: "s", url: "ftp://a.example" },
    ]);
    assert.strictEqual(r.upstreams.length, 1);
    assert.strictEqual(r.errors.length, 8);
  });

  test("undefined is empty, non-array is an error", () => {
    assert.deepStrictEqual(parseRemoteUpstreams(undefined), {
      upstreams: [],
      errors: [],
    });
    assert.strictEqual(parseRemoteUpstreams({}).errors.length, 1);
  });
});

suite("discoverRemote", () => {
  const fast = { attemptTimeoutMs: 300, retryDelayMs: 10 };

  test("success sends bearer and returns models", async () => {
    let auth: string | undefined;
    let path: string | undefined;
    const s = await startServer((req, res) => {
      auth = req.headers.authorization;
      path = req.url;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: model.id, agent_gateway: model }],
        }),
      );
    });
    try {
      const r = await discoverRemote(
        { name: "a", url: s.url },
        { ...fast, apiKey: "k1" },
      );
      assert.strictEqual(r.state.status, "ready");
      assert.deepStrictEqual(r.models, [model]);
      assert.strictEqual(auth, "Bearer k1");
      assert.strictEqual(path, "/v1/models");
    } finally {
      await s.close();
    }
  });

  test("no authorization header without key", async () => {
    let auth: string | undefined = "x";
    const s = await startServer((req, res) => {
      auth = req.headers.authorization;
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    try {
      await discoverRemote({ name: "a", url: s.url }, fast);
      assert.strictEqual(auth, undefined);
    } finally {
      await s.close();
    }
  });

  for (const [status, text, expectedCalls] of [
    [404, "not an Agent Gateway or OpenAI-compatible server", 1],
    [401, "API key", 1],
  ] as const) {
    test(`HTTP ${status} skipped without retry or body leak`, async () => {
      let calls = 0;
      const s = await startServer((_req, res) => {
        calls++;
        res.statusCode = status;
        res.end("SECRET-BODY");
      });
      try {
        const r = await discoverRemote({ name: "a", url: s.url }, fast);
        assert.strictEqual(r.state.status, "skipped");
        const reason = r.state.status === "skipped" ? r.state.reason : "";
        assert.ok(reason.includes(`HTTP ${status}`));
        assert.ok(reason.includes(text), reason);
        assert.ok(!reason.includes("SECRET"));
        assert.strictEqual(calls, expectedCalls);
      } finally {
        await s.close();
      }
    });
  }

  test("503 retries then succeeds", async () => {
    let calls = 0;
    const s = await startServer((_req, res) => {
      calls++;
      if (calls < 3) {
        res.statusCode = 503;
        res.end();
        return;
      }
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: model.id, agent_gateway: model }],
        }),
      );
    });
    try {
      const r = await discoverRemote({ name: "a", url: s.url }, fast);
      assert.strictEqual(r.state.status, "ready");
      assert.strictEqual(calls, 3);
    } finally {
      await s.close();
    }
  });

  test("timeout retries and reports", async () => {
    let calls = 0;
    const s = await startServer(() => {
      calls++;
    });
    try {
      const r = await discoverRemote(
        { name: "a", url: s.url },
        { ...fast, attempts: 2, attemptTimeoutMs: 100 },
      );
      assert.strictEqual(r.state.status, "skipped");
      assert.match(
        r.state.status === "skipped" ? r.state.reason : "",
        /No response within/,
      );
      assert.strictEqual(calls, 2);
    } finally {
      await s.close();
    }
  });

  test("invalid JSON is not retried", async () => {
    let calls = 0;
    const s = await startServer((_req, res) => {
      calls++;
      res.end("<html>nope");
    });
    try {
      const r = await discoverRemote({ name: "a", url: s.url }, fast);
      assert.strictEqual(r.state.status, "skipped");
      assert.match(
        r.state.status === "skipped" ? r.state.reason : "",
        /invalid JSON/,
      );
      assert.strictEqual(calls, 1);
    } finally {
      await s.close();
    }
  });

  test("discovers a plain OpenAI-compatible /v1/models list", async () => {
    const paths: string[] = [];
    const auths: (string | undefined)[] = [];
    const s = await startServer((req, res) => {
      paths.push(req.url ?? "");
      auths.push(req.headers.authorization);
      if (req.url !== "/v1/models") {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "quick",
              object: "model",
              owned_by: "microsoft",
              context_window: 1000000,
            },
            { id: "plain", object: "model" },
            { id: "quick", object: "model" },
            { object: "model" },
          ],
        }),
      );
    });
    try {
      const r = await discoverRemote(
        { name: "a", url: s.url },
        { ...fast, apiKey: "k1" },
      );
      assert.strictEqual(r.state.status, "ready");
      assert.deepStrictEqual(paths, ["/v1/models"]);
      assert.deepStrictEqual(auths, ["Bearer k1"]);
      assert.deepStrictEqual(
        r.models.map((m) => [
          m.id,
          m.contextWindow,
          m.vendor,
          m.nativeOperations,
        ]),
        [
          ["quick", 1000000, "microsoft", ["openai.chatCompletions"]],
          ["plain", null, undefined, ["openai.chatCompletions"]],
        ],
      );
      // Every API is advertised; the gateway translates the others.
      assert.strictEqual(r.models[0].operations.length, 7);
    } finally {
      await s.close();
    }
  });

  test("a model list without data is skipped", async () => {
    const s = await startServer((req, res) => {
      if (req.url !== "/v1/models") {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(JSON.stringify({ models: [] }));
    });
    try {
      const r = await discoverRemote({ name: "a", url: s.url }, fast);
      assert.match(
        r.state.status === "skipped" ? r.state.reason : "",
        /GET \/v1\/models returned an unexpected document/,
      );
    } finally {
      await s.close();
    }
  });

  test("rejects mismatched gateway metadata IDs", async () => {
    const s = await startServer((_req, res) => {
      res.end(
        JSON.stringify({ data: [{ id: "wrong-id", agent_gateway: model }] }),
      );
    });
    try {
      const r = await discoverRemote({ name: "a", url: s.url }, fast);
      assert.match(
        r.state.status === "skipped" ? r.state.reason : "",
        /no valid model entries/,
      );
    } finally {
      await s.close();
    }
  });

  test("connection refused is skipped, never throws", async () => {
    const s = await startServer(() => undefined);
    const url = s.url;
    await s.close();
    const r = await discoverRemote(
      { name: "a", url },
      { ...fast, attempts: 2 },
    );
    assert.strictEqual(r.state.status, "skipped");
    assert.match(
      r.state.status === "skipped" ? r.state.reason : "",
      /refused|failed/,
    );
  });
});
