import * as assert from "assert";

import {
  CACHE_ID_OPTION_KEY,
  LM_JUSTIFICATION,
  LmApi,
  MAX_TOKENS_OPTION_KEY,
  REASONING_EFFORT_OPTION_KEY,
  buildLmRequest,
  flattenTopLevelComposition,
} from "../../../protocol/core/lmRequest";
import type { CoreRequest } from "../../../protocol/core/types";

class Text {
  constructor(public value: string) {}
}
class Call {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
class Result {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
class Data {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
}
const fake: LmApi = {
  LanguageModelChatMessage: {
    User: (content) => ({ role: "user", content }),
    Assistant: (content) => ({ role: "assistant", content }),
  },
  LanguageModelTextPart: Text,
  LanguageModelToolCallPart: Call,
  LanguageModelToolResultPart: Result,
  LanguageModelDataPart: { image: (d, m) => new Data(d, m) },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function req(over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    protocol: "anthropic",
    model: "m",
    echoModel: "m",
    system: [],
    turns: [],
    tools: [],
    toolMode: { kind: "auto" },
    hosted: [],
    stream: true,
    echo: {},
    ...over,
  };
}
const tools = [
  { name: "a", description: "A", inputSchema: { type: "object" } },
  { name: "b", inputSchema: { type: "object" } },
];
const model = {
  supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }],
};

suite("protocol/core/lmRequest", () => {
  test("replayed thinking uses the thinking part when the host has it", () => {
    class Thinking {
      constructor(
        public value: string,
        public id?: string,
        public metadata?: Record<string, unknown>,
      ) {}
    }
    const r = buildLmRequest(
      { ...fake, LanguageModelThinkingPart: Thinking },
      req({
        turns: [
          {
            role: "assistant",
            parts: [
              { type: "thinking", text: "t", signature: "SIG" },
              { type: "text", text: "yo" },
            ],
          },
        ],
      }),
    );
    assert.deepStrictEqual(r.messages, [
      {
        role: "assistant",
        content: [
          new Thinking("t", undefined, { signature: "SIG" }),
          new Text("yo"),
        ],
      },
    ]);
  });

  test("system folded into leading User; roles user/assistant only", () => {
    const r = buildLmRequest(
      fake,
      req({
        system: ["sys1", "", "dev2"],
        turns: [
          { role: "user", parts: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            parts: [
              { type: "thinking", text: "t" },
              { type: "text", text: "yo" },
            ],
          },
          { role: "assistant", parts: [{ type: "thinking", text: "only" }] },
        ],
      }),
    );
    assert.deepStrictEqual(r.messages, [
      { role: "user", content: [new Text("sys1\n\ndev2")] },
      { role: "user", content: [new Text("hi")] },
      { role: "assistant", content: [new Text("yo")] },
    ]);
    assert.strictEqual(r.options.justification, LM_JUSTIFICATION);
  });

  test("tool call and tool result parts", () => {
    const r = buildLmRequest(
      fake,
      req({
        turns: [
          {
            role: "assistant",
            parts: [{ type: "toolCall", id: "c1", name: "a", input: { x: 1 } }],
          },
          {
            role: "user",
            parts: [
              {
                type: "toolResult",
                callId: "c1",
                isError: false,
                content: [{ type: "text", text: "ok" }],
              },
              { type: "toolResult", callId: "c2", isError: false, content: [] },
            ],
          },
        ],
      }),
    );
    assert.deepStrictEqual(r.messages, [
      { role: "assistant", content: [new Call("c1", "a", { x: 1 })] },
      {
        role: "user",
        content: [
          new Result("c1", [new Text("ok")]),
          new Result("c2", [new Text("")]),
        ],
      },
    ]);
  });

  test("images become DataPart.image with sniffed mime", () => {
    const r = buildLmRequest(
      fake,
      req({
        turns: [
          {
            role: "user",
            parts: [
              { type: "image", mime: "image/jpeg", data: PNG },
              {
                type: "toolResult",
                callId: "c",
                isError: false,
                content: [{ type: "image", mime: "image/png", data: PNG }],
              },
            ],
          },
        ],
      }),
    );
    const content = (r.messages[0] as { content: unknown[] }).content;
    assert.deepStrictEqual(content[0], new Data(PNG, "image/png"));
    assert.deepStrictEqual(
      (content[1] as Result).content[0],
      new Data(PNG, "image/png"),
    );
  });

  test("ToolMode table", () => {
    const auto = buildLmRequest(
      fake,
      req({ tools, toolMode: { kind: "auto" } }),
    ).options;
    assert.strictEqual(auto.toolMode, 1);
    assert.deepStrictEqual(auto.tools, [
      { name: "a", description: "A", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
    ]);
    const none = buildLmRequest(
      fake,
      req({ tools, toolMode: { kind: "none" } }),
    ).options;
    assert.strictEqual(none.tools, undefined);
    assert.strictEqual(none.toolMode, undefined);
    const any = buildLmRequest(
      fake,
      req({ tools, toolMode: { kind: "required" } }),
    ).options;
    assert.strictEqual(any.toolMode, 2);
    assert.strictEqual(any.tools?.length, 2);
    const named = buildLmRequest(
      fake,
      req({ tools, toolMode: { kind: "required", only: ["b"] } }),
    ).options;
    assert.strictEqual(named.toolMode, 2);
    assert.deepStrictEqual(
      named.tools?.map((t) => t.name),
      ["b"],
    );
    const empty = buildLmRequest(
      fake,
      req({ toolMode: { kind: "auto" } }),
    ).options;
    assert.strictEqual(empty.tools, undefined);
  });

  test("effort passed only when in the model enum", () => {
    const ok = buildLmRequest(fake, req({ reasoningEffort: "high" }), {
      model,
    }).options;
    assert.strictEqual(ok.modelOptions[REASONING_EFFORT_OPTION_KEY], "high");
    const bad = buildLmRequest(fake, req({ reasoningEffort: "max" }), {
      model,
    }).options;
    assert.ok(!(REASONING_EFFORT_OPTION_KEY in bad.modelOptions));
    const noModel = buildLmRequest(
      fake,
      req({ reasoningEffort: "high" }),
    ).options;
    assert.ok(!(REASONING_EFFORT_OPTION_KEY in noModel.modelOptions));
  });

  test("effort passed through unchanged", () => {
    const o = buildLmRequest(fake, req({ reasoningEffort: "low" }), {
      model,
    }).options;
    assert.deepStrictEqual(o.modelOptions, {
      [REASONING_EFFORT_OPTION_KEY]: "low",
    });
  });

  test("fixed justification string", () => {
    const a = buildLmRequest(fake, req()).options.justification;
    const b = buildLmRequest(fake, req({ protocol: "gemini" })).options
      .justification;
    assert.strictEqual(a, b);
    assert.ok(a.length > 0);
  });

  test("cache key uses the single constant option key", () => {
    const o = buildLmRequest(fake, req({ cacheKey: "k1" })).options;
    assert.deepStrictEqual(o.modelOptions, { [CACHE_ID_OPTION_KEY]: "k1" });
    const custom = buildLmRequest(fake, req({ cacheKey: "k1" }), {
      cacheKeyOption: "x",
    }).options;
    assert.deepStrictEqual(custom.modelOptions, { x: "k1" });
  });

  test("prompt_cache_key stable across turns", () => {
    const a = buildLmRequest(fake, req({ cacheKey: "conv" })).options
      .modelOptions;
    const b = buildLmRequest(
      fake,
      req({
        cacheKey: "conv",
        turns: [{ role: "user", parts: [{ type: "text", text: "2" }] }],
      }),
    ).options.modelOptions;
    assert.strictEqual(a[CACHE_ID_OPTION_KEY], b[CACHE_ID_OPTION_KEY]);
    assert.ok(
      !(
        CACHE_ID_OPTION_KEY in buildLmRequest(fake, req()).options.modelOptions
      ),
    );
  });

  test("no output limit sent when absent", () => {
    const o = buildLmRequest(fake, req()).options;
    assert.deepStrictEqual(o.modelOptions, {});
  });

  test("output limit forwarded unchanged", () => {
    const o = buildLmRequest(fake, req({ maxOutputTokens: 64000 })).options;
    assert.strictEqual(o.modelOptions[MAX_TOKENS_OPTION_KEY], 64000);
  });
});

suite("protocol/core/lmRequest flattenTopLevelComposition", () => {
  test("merges top-level oneOf into one object schema", () => {
    const out = flattenTopLevelComposition({
      oneOf: [
        {
          type: "object",
          properties: { id: { type: "string" }, url: { type: "string" } },
          required: ["id", "url"],
        },
        {
          type: "object",
          properties: { id: { type: "string" }, path: { type: "string" } },
          required: ["id"],
        },
      ],
    });
    assert.deepStrictEqual(out, {
      type: "object",
      properties: {
        id: { type: "string" },
        url: { type: "string" },
        path: { type: "string" },
      },
      required: ["id"],
    });
  });

  test("allOf keeps every required name and base properties", () => {
    const out = flattenTopLevelComposition({
      type: "object",
      description: "d",
      properties: { a: { type: "number" } },
      allOf: [
        { properties: { b: { type: "string" } }, required: ["b"] },
        { anyOf: [{ properties: { c: {} }, required: ["c"] }] },
      ],
    });
    assert.deepStrictEqual(out, {
      type: "object",
      description: "d",
      properties: { a: { type: "number" }, b: { type: "string" }, c: {} },
      required: ["b", "c"],
    });
  });

  test("leaves schemas without top-level composition unchanged", () => {
    const schema = {
      type: "object",
      properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } },
    };
    assert.strictEqual(flattenTopLevelComposition(schema), schema);
  });
});
