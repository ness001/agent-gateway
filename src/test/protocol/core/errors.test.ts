import * as assert from "assert";

import {
  COPILOT_REJECTED_PREFIX,
  ERROR_TABLE,
  GatewayError,
  TIMEOUT_HINT,
  classifyLmError,
  errorResponse,
  noteRequestError,
  resolveRequestId,
} from "../../../protocol/core/errors";
import type { GatewayErrorKind } from "../../../protocol/core/types";

const lmErr = (code: string, message = "x") =>
  Object.assign(new Error(message), { code });

suite("core/errors", () => {
  test("Copilot 400 gets prefix, truncation and redaction", () => {
    const secret = "ghu_" + "a".repeat(36);
    const long = "y ".repeat(600);
    const e = classifyLmError(
      new Error(
        `Request Failed: 400 {"error":{"message":"bad tool schema ${secret} ${long}"}}`,
      ),
    );
    assert.strictEqual(e.kind, "upstream_rejected");
    assert.strictEqual(e.status, 400);
    assert.ok(
      e.message.startsWith(COPILOT_REJECTED_PREFIX + "bad tool schema"),
    );
    assert.ok(!e.message.includes(secret));
    assert.ok(e.message.length <= COPILOT_REJECTED_PREFIX.length + 503);
  });

  test("413 rejected, 404 and model_not_supported not_found", () => {
    assert.strictEqual(
      classifyLmError(new Error("Request Failed: 413 {}")).kind,
      "upstream_rejected",
    );
    assert.strictEqual(
      classifyLmError(new Error("Request Failed: 404 {}")).status,
      404,
    );
    assert.strictEqual(
      classifyLmError(
        new Error(
          'Request Failed: 400 {"error":{"code":"model_not_supported"}}',
        ),
      ).kind,
      "not_found",
    );
  });

  test("NoPermissions and 401/403 give 403 with grant instructions", () => {
    for (const e of [
      classifyLmError(lmErr("NoPermissions")),
      classifyLmError(new Error("Request Failed: 401 {}")),
      classifyLmError(new Error("Request Failed: 403 {}")),
    ]) {
      assert.strictEqual(e.status, 403);
      assert.match(e.message, /Allow/);
    }
  });

  test("429 rate_limit, 5xx 502, timeout 504 with consent hint", () => {
    assert.strictEqual(
      classifyLmError(new Error("Request Failed: 429 {}")).status,
      429,
    );
    assert.strictEqual(
      classifyLmError(new Error("Request Failed: 503 oops")).status,
      502,
    );
    const t = classifyLmError(
      Object.assign(new Error("signal aborted"), { name: "TimeoutError" }),
    );
    assert.strictEqual(t.status, 504);
    assert.strictEqual(t.message, TIMEOUT_HINT);
    assert.match(t.message, /consent/);
    assert.strictEqual(
      classifyLmError(new Error("request timed out")).kind,
      "timeout",
    );
  });

  test("envelopes per protocol include request_id and header", async () => {
    const err = new GatewayError("rate_limit", "slow down", { param: "p" });
    const a = errorResponse("anthropic", err, "r1");
    assert.strictEqual(a.status, 429);
    assert.strictEqual(a.headers.get("x-request-id"), "r1");
    assert.deepStrictEqual(await a.json(), {
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
      request_id: "r1",
    });
    const o = (await errorResponse("openai", err, "r1").json()) as {
      error: { type: string; param: string };
      request_id: string;
    };
    assert.deepStrictEqual(
      [o.error.type, o.error.param, o.request_id],
      ["rate_limit_error", "p", "r1"],
    );
    const g = (await errorResponse("google", err, "r1").json()) as {
      error: { code: number; status: string };
      request_id: string;
    };
    assert.deepStrictEqual(
      [g.error.code, g.error.status, g.request_id],
      [429, "RESOURCE_EXHAUSTED", "r1"],
    );
  });

  test("overload is 529 overloaded_error on Anthropic and 503 on OpenAI", async () => {
    const err = classifyLmError(
      new Error('Request Failed: 529 {"error":{"message":"Overloaded"}}'),
    );
    assert.strictEqual(err.kind, "overloaded");
    const a = errorResponse("anthropic", err, "req_1");
    assert.strictEqual(a.status, 529);
    const ab = (await a.json()) as { error: { type: string } };
    assert.strictEqual(ab.error.type, "overloaded_error");
    const o = errorResponse("openai", err, "req_1");
    assert.strictEqual(o.status, 503);
    const ob = (await o.json()) as { error: { type: string } };
    assert.strictEqual(ob.error.type, "service_unavailable_error");
  });

  test("error responses carry both request-id headers and Retry-After", () => {
    const err = classifyLmError(
      new Error(
        'Request Failed: 429 {"error":{"message":"Rate limited, retry after 17 seconds"}}',
      ),
    );
    assert.strictEqual(err.retryAfter, 17);
    for (const p of ["anthropic", "openai", "google"] as const) {
      const r = errorResponse(p, err, "req_x");
      assert.strictEqual(r.status, 429);
      assert.strictEqual(r.headers.get("request-id"), "req_x");
      assert.strictEqual(r.headers.get("x-request-id"), "req_x");
      assert.strictEqual(r.headers.get("retry-after"), "17");
    }
  });

  test("table covers every kind with expected statuses", () => {
    const expected: Record<GatewayErrorKind, number> = {
      invalid_request: 400,
      not_found: 404,
      permission: 403,
      rate_limit: 429,
      upstream_rejected: 400,
      upstream_error: 502,
      overloaded: 503,
      timeout: 504,
      tool_unavailable: 400,
      unsupported: 400,
      internal: 500,
    };
    assert.deepStrictEqual(
      Object.keys(ERROR_TABLE).sort(),
      Object.keys(expected).sort(),
    );
    for (const k of Object.keys(expected) as GatewayErrorKind[]) {
      const row = ERROR_TABLE[k];
      assert.strictEqual(row.status, expected[k], k);
      assert.ok(row.anthropicType && row.openaiType && row.googleStatus, k);
    }
  });

  test("caller request ids echoed only when safe", () => {
    const gen = () => "gen";
    assert.strictEqual(resolveRequestId("abc.DEF_1:2-3", gen), "abc.DEF_1:2-3");
    assert.strictEqual(resolveRequestId("bad id", gen), "gen");
    assert.strictEqual(resolveRequestId("x".repeat(65), gen), "gen");
    assert.strictEqual(resolveRequestId(undefined, gen), "gen");
  });

  test("failures call noteRequestError; journal errors swallowed", () => {
    const calls: unknown[][] = [];
    noteRequestError(
      { noteRequestError: (...a: unknown[]) => void calls.push(a) },
      classifyLmError(lmErr("Blocked")),
    );
    assert.deepStrictEqual(calls, [["rate_limit", "Blocked"]]);
    noteRequestError(
      {
        noteRequestError: () => {
          throw new Error("boom");
        },
      },
      new GatewayError("internal", "x"),
    );
    noteRequestError(undefined, new GatewayError("internal", "x"));
  });

  test("LanguageModelError classified by code", () => {
    assert.strictEqual(
      classifyLmError(lmErr("NoPermissions")).kind,
      "permission",
    );
    const b = classifyLmError(lmErr("Blocked"));
    assert.deepStrictEqual(
      [b.kind, b.status, b.providerCode],
      ["rate_limit", 429, "Blocked"],
    );
    assert.strictEqual(classifyLmError(lmErr("NotFound")).status, 404);
    assert.strictEqual(classifyLmError(new Error("weird")).kind, "internal");
    const g = new GatewayError("unsupported", "u");
    assert.strictEqual(classifyLmError(g), g);
  });
});
