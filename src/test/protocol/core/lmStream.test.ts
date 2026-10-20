import * as assert from "assert";

import { lmStreamToEvents } from "../../../protocol/core/lmStream";
import type { CoreEvent } from "../../../protocol/core/types";

class LanguageModelTextPart {
  constructor(public value: string) {}
}
class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
class LanguageModelThinkingPart {
  constructor(
    public value: string | string[],
    public id?: string,
    public metadata?: Record<string, unknown>,
  ) {}
}
const usagePart = (o: object) => ({
  mimeType: "usage",
  data: new TextEncoder().encode(JSON.stringify(o)),
});

async function collect(parts: unknown[], max?: number): Promise<CoreEvent[]> {
  async function* gen() {
    for (const p of parts) {
      yield p;
    }
  }
  const out: CoreEvent[] = [];
  for await (const e of lmStreamToEvents(gen(), { maxOutputTokens: max })) {
    out.push(e);
  }
  return out;
}

suite("protocol/core/lmStream", () => {
  test("text, tool call and duck-typed thinking parts", async () => {
    const ev = await collect([
      new LanguageModelThinkingPart(["a", "b"], "t1", { signature: "sig" }),
      { value: "plain-thinking", metadata: {} },
      new LanguageModelTextPart("hello"),
      new LanguageModelTextPart(""),
      new LanguageModelToolCallPart("c1", "f", { q: 1 }),
    ]);
    assert.deepStrictEqual(ev, [
      { e: "thinking", delta: "ab", signature: "sig" },
      { e: "thinking", delta: "plain-thinking" },
      { e: "text", delta: "hello" },
      { e: "toolCall", id: "c1", name: "f", input: { q: 1 } },
      { e: "end", reason: "tool" },
    ]);
  });

  test("unknown parts and non-usage data parts are ignored", async () => {
    const ev = await collect([
      { foo: 1 },
      42,
      null,
      { mimeType: "image/png", data: new Uint8Array([1]) },
      { mimeType: "text/plain", value: "x" },
      new LanguageModelTextPart("x"),
    ]);
    assert.deepStrictEqual(ev, [
      { e: "text", delta: "x" },
      { e: "end", reason: "stop" },
    ]);
  });

  test("usage data part captured for end", async () => {
    const ev = await collect([
      new LanguageModelTextPart("x"),
      usagePart({ prompt_tokens: 10, completion_tokens: 3 }),
    ]);
    assert.deepStrictEqual(ev.at(-1), {
      e: "end",
      reason: "stop",
      usage: { input: 10, output: 3 },
    });
  });

  test("length only when usage proves the limit", async () => {
    const hit = await collect(
      [usagePart({ prompt_tokens: 1, completion_tokens: 16 })],
      16,
    );
    assert.strictEqual((hit.at(-1) as { reason: string }).reason, "length");
    const under = await collect(
      [usagePart({ prompt_tokens: 1, completion_tokens: 9 })],
      16,
    );
    assert.strictEqual((under.at(-1) as { reason: string }).reason, "stop");
    const noUsage = await collect([new LanguageModelTextPart("x")], 16);
    assert.strictEqual((noUsage.at(-1) as { reason: string }).reason, "stop");
  });

  test("no limit never yields length", async () => {
    const ev = await collect([
      usagePart({ prompt_tokens: 1, completion_tokens: 99999 }),
    ]);
    assert.strictEqual((ev.at(-1) as { reason: string }).reason, "stop");
  });

  test("tool reason wins over length", async () => {
    const ev = await collect(
      [
        new LanguageModelToolCallPart("c", "f", {}),
        usagePart({ prompt_tokens: 1, completion_tokens: 16 }),
      ],
      16,
    );
    assert.strictEqual((ev.at(-1) as { reason: string }).reason, "tool");
  });
});
