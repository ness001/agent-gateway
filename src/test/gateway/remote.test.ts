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
  defaultReasoningLevel: "",
  supportedReasoningLevels: [],
  operations: ["openai.chatCompletions"],
};

const validate = (m: unknown): ModelInfo => {
  if (typeof (m as ModelInfo)?.id !== "string") {
    throw new Error("bad");
  }
  return m as ModelInfo;
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
      { name: "Devbox", url: "http://127.0.0.1:1234" },
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
  const fast = { attemptTimeoutMs: 300, retryDelayMs: 10, validate };

  test("success sends bearer and returns models", async () => {
    let auth: string | undefined;
    let path: string | undefined;
    const s = await startServer((req, res) => {
      auth = req.headers.authorization;
      path = req.url;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: 1, models: [model] }));
    });
    try {
      const r = await discoverRemote(
        { name: "a", url: s.url },
        { ...fast, apiKey: "k1" },
      );
      assert.strictEqual(r.state.status, "ready");
      assert.deepStrictEqual(r.models, [model]);
      assert.strictEqual(auth, "Bearer k1");
      assert.strictEqual(path, "/v1/gateway/catalog");
    } finally {
      await s.close();
    }
  });

  test("no authorization header without key", async () => {
    let auth: string | undefined = "x";
    const s = await startServer((req, res) => {
      auth = req.headers.authorization;
      res.end(JSON.stringify({ version: 1, models: [] }));
    });
    try {
      await discoverRemote({ name: "a", url: s.url }, fast);
      assert.strictEqual(auth, undefined);
    } finally {
      await s.close();
    }
  });

  for (const [status, text] of [
    [404, "tunnel missing or not an Agent Gateway"],
    [401, "API key"],
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
        assert.strictEqual(calls, 1);
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
      res.end(JSON.stringify({ version: 1, models: [model] }));
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

  test("version 2 rejected", async () => {
    const s = await startServer((_req, res) => {
      res.end(JSON.stringify({ version: 2, models: [] }));
    });
    try {
      const r = await discoverRemote({ name: "a", url: s.url }, fast);
      assert.match(
        r.state.status === "skipped" ? r.state.reason : "",
        /unsupported catalogue version 2/,
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
