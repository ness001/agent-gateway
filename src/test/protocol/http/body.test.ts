import * as assert from "node:assert/strict";

import {
  BodyError,
  attachParsedBody,
  lazyBody,
  readJson,
} from "../../../protocol/http/body";

const req = (
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request("http://x/", { method: "POST", body, headers });

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BodyError);
    assert.equal(e.kind, "invalid_request");
    return e.reason;
  }
  return "none";
}

suite("protocol/http/body", () => {
  test("parses valid JSON", async () => {
    assert.deepEqual(await readJson(req('{"a":[1]}')), { a: [1] });
  });
  test("malformed, empty and invalid UTF-8 are MalformedJson", async () => {
    assert.equal(await reason(readJson(req("{bad"))), "MalformedJson");
    assert.equal(await reason(readJson(req(""))), "MalformedJson");
    assert.equal(
      await reason(readJson(req(new Uint8Array([0x7b, 0xff, 0x7d])))),
      "MalformedJson",
    );
  });
  test("large bodies are read without a size limit", async () => {
    const big = "x".repeat(40 * 1024 * 1024);
    assert.equal(await readJson(req(JSON.stringify(big))), big);
  });
  test("an attached parsed body is returned without reading", async () => {
    let serialised = 0;
    const r = new Request("http://x/", {
      method: "POST",
      body: lazyBody(() => {
        serialised++;
        return '{"a":1}';
      }),
      duplex: "half",
    } as RequestInit);
    const value = { a: 1 };
    attachParsedBody(r, value);
    assert.equal(await readJson(r), value);
    assert.equal(serialised, 0);
    assert.equal(await r.text(), '{"a":1}');
    assert.equal(serialised, 1);
  });
});
