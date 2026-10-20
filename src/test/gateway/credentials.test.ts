import * as assert from "assert";

import {
  checkApiKey,
  extractPresentedApiKey,
  hasTunnelForwardingHeaders,
  stripCallerCredentials,
  stripGeminiKeyQuery,
} from "../../gateway/credentials";

suite("credentials", () => {
  test("stripCallerCredentials removes credentials and hop-by-hop", () => {
    const h = stripCallerCredentials(
      new Headers({
        authorization: "Bearer a",
        "x-api-key": "b",
        "x-goog-api-key": "c",
        "proxy-authorization": "d",
        cookie: "e",
        connection: "keep-alive, x-custom",
        "x-custom": "f",
        "keep-alive": "1",
        host: "h",
        "content-length": "3",
        "transfer-encoding": "chunked",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      }),
    );
    assert.deepStrictEqual(
      Array.from(h as unknown as Iterable<[string, string]>, ([k]) => k).sort(),
      ["anthropic-version", "content-type"],
    );
  });

  test("stripGeminiKeyQuery", () => {
    assert.strictEqual(stripGeminiKeyQuery("?key=x&alt=sse"), "?alt=sse");
    assert.strictEqual(
      stripGeminiKeyQuery("?alt=sse&KEY=x&a=%20b"),
      "?alt=sse&a=%20b",
    );
    assert.strictEqual(stripGeminiKeyQuery("?%6Bey=x"), "");
    assert.strictEqual(stripGeminiKeyQuery(""), "");
  });

  test("extractPresentedApiKey sources", () => {
    assert.strictEqual(
      extractPresentedApiKey(new Headers({ authorization: "Bearer k" }), ""),
      "k",
    );
    assert.strictEqual(
      extractPresentedApiKey(new Headers({ "x-api-key": "k2" }), ""),
      "k2",
    );
    assert.strictEqual(
      extractPresentedApiKey(new Headers({ "x-goog-api-key": "k3" }), ""),
      "k3",
    );
    assert.strictEqual(extractPresentedApiKey(new Headers(), "?Key=k4"), "k4");
    assert.strictEqual(extractPresentedApiKey(new Headers(), ""), undefined);
  });

  test("checkApiKey", () => {
    assert.strictEqual(checkApiKey(undefined, undefined), true);
    assert.strictEqual(checkApiKey("", "x"), true);
    assert.strictEqual(checkApiKey("secret", "secret"), true);
    assert.strictEqual(checkApiKey("secret", "secreT"), false);
    assert.strictEqual(checkApiKey("secret", "a-much-longer-value"), false);
    assert.strictEqual(checkApiKey("secret", undefined), false);
  });

  test("hasTunnelForwardingHeaders", () => {
    assert.strictEqual(hasTunnelForwardingHeaders(new Headers()), false);
    assert.strictEqual(
      hasTunnelForwardingHeaders(new Headers({ "X-Forwarded-For": "1.2.3.4" })),
      true,
    );
  });
});
