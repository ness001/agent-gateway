import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import type { LocalRoutesDeps } from "../../gateway/localRoutes";
import { handle, matchRoute } from "../../protocol";

const deps = {} as LocalRoutesDeps;
const call = (
  method: string,
  p: string,
  headers: Record<string, string> = {},
) =>
  handle(
    new Request(`http://127.0.0.1:24445${p}`, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
    }),
    deps,
  );

suite("protocol/index dispatch", () => {
  test("routes all local protocol paths", () => {
    assert.strictEqual(matchRoute("/v1/messages")?.protocol, "anthropic");
    assert.strictEqual(
      matchRoute("/v1/messages/count_tokens")?.endpoint,
      "countTokens",
    );
    assert.strictEqual(
      matchRoute("/v1/chat/completions")?.protocol,
      "openai-chat",
    );
    assert.strictEqual(
      matchRoute("/v1/responses")?.protocol,
      "openai-responses",
    );
    const g = matchRoute("/v1beta/models/gpt-4o:streamGenerateContent");
    assert.deepStrictEqual(g, {
      protocol: "gemini",
      endpoint: "streamGenerateContent",
      model: "gpt-4o",
    });
    assert.strictEqual(matchRoute("/v1/nope"), undefined);
  });

  test("bad method returns 405 in each protocol envelope", async () => {
    const a = await call("GET", "/v1/messages", { "x-request-id": "abc" });
    assert.strictEqual(a.status, 405);
    assert.strictEqual(a.headers.get("allow"), "POST");
    assert.strictEqual(a.headers.get("x-request-id"), "abc");
    const ab = (await a.json()) as { type: string; request_id: string };
    assert.strictEqual(ab.type, "error");
    assert.strictEqual(ab.request_id, "abc");
    const o = await call("PUT", "/v1/responses");
    assert.strictEqual(o.status, 405);
    assert.ok(
      ((await o.json()) as { error: { message: string } }).error.message,
    );
    const g = await call("GET", "/v1beta/models/m:generateContent");
    assert.strictEqual(g.status, 405);
    assert.ok(((await g.json()) as { error: { status: string } }).error.status);
  });

  test("unknown paths return 404 per protocol family", async () => {
    const a = await call("POST", "/v1/messages/batches");
    assert.strictEqual(a.status, 404);
    assert.strictEqual(((await a.json()) as { type: string }).type, "error");
    const g = await call("POST", "/v1beta/models/m:embedContent");
    assert.strictEqual(g.status, 404);
    assert.strictEqual(
      ((await g.json()) as { error: { code: number } }).error.code,
      404,
    );
    const o = await call("POST", "/v1/other");
    assert.strictEqual(o.status, 404);
    assert.ok("error" in ((await o.json()) as object));
  });

  test("every protocol has a registered handler", async () => {
    for (const p of ["/v1/messages", "/v1/chat/completions", "/v1/responses"]) {
      const r = await handle(
        new Request(`http://127.0.0.1:24445${p}`, {
          method: "POST",
          body: "{not json",
        }),
        deps,
      );
      assert.strictEqual(r.status, 400, p);
      assert.ok(r.headers.get("x-request-id"));
    }
  });

  test("protocol core is lazily required by localRoutes", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../src/gateway/localRoutes.ts"),
      "utf8",
    );
    assert.ok(!/^import[^;]*["']\.\.\/protocol["']/m.test(src));
    assert.ok(/^import[^;]*["']\.\.\/protocol\//m.test(src) === false);
    assert.ok(/core \?\?= require\("\.\.\/protocol"\)/.test(src));
  });
});
