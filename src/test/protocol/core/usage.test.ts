import * as assert from "assert";

import {
  parseUsage,
  reachedLimit,
  toAnthropicUsage,
  toChatUsage,
  toGeminiUsage,
  toResponsesUsage,
  usageFromPart,
} from "../../../protocol/core/usage";

const full = {
  prompt_tokens: 100,
  completion_tokens: 60,
  prompt_tokens_details: { cached_tokens: 10 },
  cache_creation_input_tokens: 5,
  completion_tokens_details: { reasoning_tokens: 20 },
};

suite("core/usage", () => {
  test("usage data part parsed from bytes", () => {
    const part = {
      mimeType: "usage",
      data: new TextEncoder().encode(JSON.stringify(full)),
    };
    assert.deepStrictEqual(usageFromPart(part), {
      input: 100,
      output: 60,
      cacheRead: 10,
      cacheWrite: 5,
      reasoning: 20,
    });
  });

  test("non-usage and malformed parts ignored", () => {
    assert.strictEqual(
      usageFromPart({ mimeType: "text/plain", data: "x" }),
      undefined,
    );
    assert.strictEqual(
      usageFromPart({ mimeType: "usage", data: "{bad" }),
      undefined,
    );
    assert.strictEqual(parseUsage({ foo: 1 }), undefined);
  });

  test("Anthropic input = prompt - cached - creation", () => {
    assert.deepStrictEqual(toAnthropicUsage(parseUsage(full), 2), {
      input_tokens: 85,
      output_tokens: 60,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      server_tool_use: { web_search_requests: 2 },
    });
  });

  test("100/10/60/5 gives Anthropic input 35", () => {
    const u = parseUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 60 },
      cache_creation_input_tokens: 5,
      completion_tokens: 10,
    });
    assert.strictEqual(toAnthropicUsage(u).input_tokens, 35);
  });

  test("absent usage part fabricates no cache fields", () => {
    const a = toAnthropicUsage(undefined);
    assert.deepStrictEqual(a, { input_tokens: 0, output_tokens: 0 });
    const plain = parseUsage({ prompt_tokens: 7, completion_tokens: 3 });
    assert.deepStrictEqual(toAnthropicUsage(plain), {
      input_tokens: 7,
      output_tokens: 3,
    });
    assert.deepStrictEqual(toChatUsage(plain), {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
    assert.deepStrictEqual(toResponsesUsage(plain), {
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
  });

  test("Responses and Chat pass cached and reasoning through", () => {
    const u = parseUsage(full);
    assert.deepStrictEqual(toResponsesUsage(u), {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 60,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 160,
    });
    assert.deepStrictEqual(toChatUsage(u), {
      prompt_tokens: 100,
      completion_tokens: 60,
      total_tokens: 160,
      prompt_tokens_details: { cached_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 20 },
    });
  });

  test("Gemini five fields, prompt excludes cached", () => {
    assert.deepStrictEqual(toGeminiUsage(parseUsage(full)), {
      promptTokenCount: 90,
      candidatesTokenCount: 40,
      cachedContentTokenCount: 10,
      thoughtsTokenCount: 20,
      totalTokenCount: 160,
    });
    assert.deepStrictEqual(toGeminiUsage(undefined), {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    });
  });

  test("no limit never reports length", () => {
    assert.strictEqual(
      reachedLimit({ input: 1, output: 99999 }, undefined),
      false,
    );
  });

  test("limit below output usage is not reached", () => {
    assert.strictEqual(reachedLimit({ input: 1, output: 15 }, 16), false);
  });

  test("length only when usage proves the limit", () => {
    assert.strictEqual(reachedLimit({ input: 1, output: 16 }, 16), true);
    assert.strictEqual(reachedLimit({ input: 1, output: 48 }, 16), true);
    assert.strictEqual(reachedLimit(undefined, 16), false);
    assert.strictEqual(reachedLimit({ input: 1, output: 5 }, 0), false);
  });
});
