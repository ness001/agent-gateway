import * as assert from "node:assert/strict";

import {
  arr,
  bool,
  int,
  num,
  obj,
  oneOf,
  optional,
  str,
  validate,
} from "../../../protocol/core/check";

suite("protocol/core/check", () => {
  const body = obj({
    model: str,
    max_tokens: optional(int),
    stream: optional(bool),
    temperature: optional(num, true),
    messages: arr(obj({ role: oneOf("user", "assistant"), content: str })),
  });

  test("valid body passes and keeps unknown keys", () => {
    const r = validate(body, {
      model: "m",
      messages: [{ role: "user", content: "hi", x: 1 }],
      extra: true,
    });
    assert.ok(r.ok);
    assert.equal((r.value as Record<string, unknown>).extra, true);
  });

  test("nested error has path-qualified message", () => {
    const r = validate(body, {
      model: "m",
      messages: [
        { role: "user", content: "a" },
        { role: "bot", content: "b" },
      ],
    });
    assert.ok(!r.ok);
    assert.equal(r.path, "messages[1].role");
    assert.match(
      r.message,
      /^messages\[1\]\.role: expected one of "user", "assistant"/,
    );
  });

  test("type mismatches report expected and actual", () => {
    const cases: [unknown, string][] = [
      [{ messages: [] }, "model: expected string, got undefined"],
      [
        { model: "m", max_tokens: 1.5, messages: [] },
        "max_tokens: expected integer, got number",
      ],
      [
        { model: "m", stream: "yes", messages: [] },
        "stream: expected boolean, got string",
      ],
      [{ model: "m", messages: {} }, "messages: expected array, got object"],
      [[], "body: expected object, got array"],
    ];
    for (const [v, msg] of cases) {
      const r = validate(body, v);
      assert.ok(!r.ok);
      assert.equal(r.message, msg);
    }
  });

  test("optional null handling", () => {
    assert.ok(
      validate(body, { model: "m", temperature: null, messages: [] }).ok,
    );
    assert.ok(!validate(body, { model: "m", stream: null, messages: [] }).ok);
    assert.ok(!validate(num, Number.NaN).ok);
  });
});
