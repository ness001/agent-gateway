import * as assert from "assert";

import { GatewayError } from "../../../protocol/core/errors";
import {
  MALFORMED_JSON_MESSAGE,
  geminiErrorResponse,
  geminiMalformedJson,
  geminiMethodNotAllowed,
  geminiModelNotFound,
  geminiUnsupportedRoute,
} from "../../../protocol/gemini/errors";
import {
  UNSUPPORTED_ROUTE_MESSAGE,
  parseGeminiRoute,
} from "../../../protocol/gemini/route";

suite("gemini/route", () => {
  test("parses generateContent and strips key", () => {
    const r = parseGeminiRoute(
      "POST",
      "/v1beta/models/gemini-2.5-pro:generateContent?key=abc&x=1",
    );
    assert.ok(r.ok);
    assert.strictEqual(r.route.model, "gemini-2.5-pro");
    assert.strictEqual(r.route.framing, "json");
    assert.strictEqual(r.route.stream, false);
    assert.strictEqual(r.route.query.has("key"), false);
    assert.strictEqual(r.route.query.get("x"), "1");
  });
  test("streamGenerateContent framing sse vs array", () => {
    const a = parseGeminiRoute(
      "POST",
      "/v1beta/models/m:streamGenerateContent?alt=sse",
    );
    const b = parseGeminiRoute(
      "POST",
      "/v1beta/models/m:streamGenerateContent",
    );
    assert.ok(a.ok && b.ok);
    assert.strictEqual(a.route.framing, "sse");
    assert.strictEqual(b.route.framing, "array");
    assert.strictEqual(b.route.stream, true);
  });
  test("countTokens parsed", () => {
    const r = parseGeminiRoute(
      "post",
      new URL("http://h/v1beta/models/m:countTokens"),
    );
    assert.ok(r.ok && r.route.operation === "countTokens");
  });
  test("unknown op and path are unsupported routes", () => {
    for (const p of [
      "/v1beta/models/m:embedContent",
      "/v1beta/models",
      "/v1/models/m:generateContent",
    ]) {
      const r = parseGeminiRoute("POST", p);
      assert.ok(
        !r.ok &&
          r.reason === "unsupported_route" &&
          r.message === UNSUPPORTED_ROUTE_MESSAGE,
        p,
      );
    }
  });
  test("non-POST on known route is method_not_allowed", () => {
    const r = parseGeminiRoute("GET", "/v1beta/models/m:generateContent");
    assert.ok(!r.ok && r.reason === "method_not_allowed");
  });
  test("invalid model segment rejected", () => {
    for (const p of [
      "/v1beta/models/%20:generateContent",
      "/v1beta/models/..:generateContent",
      "/v1beta/models/a%2Fb:generateContent",
      "/v1beta/models/%E0:generateContent",
    ]) {
      const r = parseGeminiRoute("POST", p);
      assert.ok(!r.ok && r.reason === "invalid_model", p);
    }
  });
});

suite("gemini/errors", () => {
  test("unknown model gives 404 NOT_FOUND envelope with request_id", async () => {
    const r = geminiModelNotFound("nope", "rid-1");
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.headers.get("x-request-id"), "rid-1");
    const b = (await r.json()) as {
      error: { code: number; status: string; message: string };
      request_id: string;
    };
    assert.deepStrictEqual(
      [b.error.code, b.error.status, b.request_id],
      [404, "NOT_FOUND", "rid-1"],
    );
    assert.ok(b.error.message.includes("nope"));
  });
  test("malformed JSON is 400 text/plain", async () => {
    const r = geminiMalformedJson("rid");
    assert.strictEqual(r.status, 400);
    assert.match(r.headers.get("content-type") ?? "", /^text\/plain/);
    assert.strictEqual(await r.text(), MALFORMED_JSON_MESSAGE);
  });
  test("unsupported route is 404 NOT_FOUND", async () => {
    const r = geminiUnsupportedRoute(UNSUPPORTED_ROUTE_MESSAGE, "rid");
    const b = (await r.json()) as {
      error: { status: string; message: string };
    };
    assert.strictEqual(r.status, 404);
    assert.strictEqual(b.error.status, "NOT_FOUND");
    assert.strictEqual(b.error.message, UNSUPPORTED_ROUTE_MESSAGE);
  });
  test("405 has allow header", () => {
    const r = geminiMethodNotAllowed("no", "rid");
    assert.strictEqual(r.status, 405);
    assert.strictEqual(r.headers.get("allow"), "POST");
  });
  test("kind table maps to Google status names", async () => {
    const cases: [GatewayError, number, string][] = [
      [new GatewayError("invalid_request", "x"), 400, "INVALID_ARGUMENT"],
      [new GatewayError("permission", "x"), 403, "PERMISSION_DENIED"],
      [new GatewayError("rate_limit", "x"), 429, "RESOURCE_EXHAUSTED"],
      [new GatewayError("tool_unavailable", "x"), 400, "FAILED_PRECONDITION"],
      [new GatewayError("upstream_error", "x"), 502, "UNAVAILABLE"],
      [new GatewayError("timeout", "x"), 504, "DEADLINE_EXCEEDED"],
      [new GatewayError("internal", "x"), 500, "INTERNAL"],
    ];
    for (const [e, code, status] of cases) {
      const r = geminiErrorResponse(e, "rid");
      const b = (await r.json()) as { error: { code: number; status: string } };
      assert.deepStrictEqual(
        [r.status, b.error.code, b.error.status],
        [code, code, status],
      );
    }
  });
});
