import * as assert from "assert";
import { readFileSync } from "fs";
import { join } from "path";

import type { LmApi } from "../../../../protocol/core/lmRequest";
import type { CoreRequest, LmChatLike } from "../../../../protocol/core/types";
import { BodyError } from "../../../../protocol/http/body";
import {
  ChatEncoder,
  type ChatRuntime,
  decodeChatRequest,
  handleChatCompletions,
} from "../../../../protocol/openai/chat";
import {
  openAiErrorEnvelope,
  toErrorInfo,
} from "../../../../protocol/openai/errors";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

class TextPart {
  constructor(public value: string) {}
}
class ToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
class ToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
const api: LmApi = {
  LanguageModelChatMessage: {
    User: (content) => ({ role: "user", content }),
    Assistant: (content) => ({ role: "assistant", content }),
  },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelDataPart: { image: (data, mime) => ({ data, mimeType: mime }) },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
};

function usage(prompt: number, completion: number, cached?: number) {
  return {
    mimeType: "usage",
    data: new TextEncoder().encode(
      JSON.stringify({
        prompt_tokens: prompt,
        completion_tokens: completion,
        ...(cached !== undefined
          ? { prompt_tokens_details: { cached_tokens: cached } }
          : {}),
      }),
    ),
  };
}

interface Fake extends LmChatLike {
  sent?: { messages: unknown[]; options: unknown };
}

function fakeModel(parts: () => AsyncIterable<unknown>): Fake {
  const m: Fake = {
    id: "claude-sonnet-5.5",
    maxInputTokens: 1000,
    sendRequest(messages, options) {
      m.sent = { messages, options };
      return Promise.resolve({ stream: parts() });
    },
    countTokens: () => Promise.resolve(1),
  };
  return m;
}

async function* list(items: unknown[]): AsyncIterable<unknown> {
  for (const i of items) {
    yield i;
  }
}

function runtime(): ChatRuntime {
  return {
    api,
    createSource: () => {
      const token = { isCancellationRequested: false };
      return {
        token,
        cancel: () => {
          token.isCancellationRequested = true;
        },
        dispose: () => undefined,
      };
    },
  };
}

function post(body: unknown, raw?: string): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

async function call(body: unknown, model?: Fake, raw?: string) {
  const noted: string[] = [];
  const res = await handleChatCompletions(
    post(body, raw),
    undefined,
    {
      getLocalModel: (id) =>
        model && (id === model.id || id === "alias") ? model : undefined,
      noteRequestError: (k) => noted.push(k),
    },
    "rid-1",
    runtime(),
  );
  return { res, noted };
}

function frames(text: string): string[] {
  return text
    .split("\n\n")
    .filter((f) => f.length > 0)
    .map((f) => f.replace(/^data: /, ""));
}

function fixture(name: string): Record<string, unknown> {
  const p = join(
    __dirname,
    "../../../../../src/test/fixtures/wire",
    `${name}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

/** Recursively compares key sets (shape only, values ignored). */
function sameShape(actual: unknown, expected: unknown, path = ""): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} array`);
    if (expected.length > 0) {
      sameShape((actual as unknown[])[0], expected[0], `${path}[0]`);
    }
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object", `${path} object`);
    for (const k of Object.keys(expected)) {
      assert.ok(k in (actual as object), `${path}.${k} missing`);
      sameShape(
        (actual as Record<string, unknown>)[k],
        (expected as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
    }
    return;
  }
  if (expected !== null) {
    assert.strictEqual(typeof actual, typeof expected, `${path} type`);
  }
}

const base = { model: "claude-sonnet-5.5" };
const user = (content: unknown) => ({
  ...base,
  messages: [{ role: "user", content }],
});

suite("protocol/openai/chat decode", () => {
  test("roles: system and developer become system text, user/assistant turns", () => {
    const r = decodeChatRequest({
      ...base,
      messages: [
        { role: "system", content: "S1" },
        { role: "developer", content: [{ type: "text", text: "D1" }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    });
    assert.deepStrictEqual(r.system, ["S1", "D1"]);
    assert.deepStrictEqual(
      r.turns.map((t) => [
        t.role,
        t.parts.map((p) => (p as { text: string }).text),
      ]),
      [
        ["user", ["hi"]],
        ["assistant", ["hello"]],
        ["user", ["again"]],
      ],
    );
    assert.strictEqual(r.protocol, "openai-chat");
    assert.strictEqual(r.stream, false);
    assert.deepStrictEqual(r.toolMode, { kind: "auto" });
  });

  test("assistant tool_calls and tool messages map to toolCall/toolResult", () => {
    const r = decodeChatRequest({
      ...base,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "get_time", arguments: "not json" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
        {
          role: "tool",
          tool_call_id: "call_2",
          content: [{ type: "text", text: "noon" }],
        },
      ],
    });
    assert.strictEqual(r.turns.length, 3);
    assert.deepStrictEqual(r.turns[1].parts, [
      {
        type: "toolCall",
        id: "call_1",
        name: "get_weather",
        input: { city: "Paris" },
      },
      { type: "toolCall", id: "call_2", name: "get_time", input: {} },
    ]);
    assert.deepStrictEqual(r.turns[2], {
      role: "user",
      parts: [
        {
          type: "toolResult",
          callId: "call_1",
          content: [{ type: "text", text: "sunny" }],
          isError: false,
        },
        {
          type: "toolResult",
          callId: "call_2",
          content: [{ type: "text", text: "noon" }],
          isError: false,
        },
      ],
    });
  });

  test("tools and tool_choice table", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "f",
          description: "d",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
      { type: "function", function: { name: "g" } },
    ];
    const r = decodeChatRequest({ ...user("x"), tools });
    assert.deepStrictEqual(r.tools, [
      {
        name: "f",
        description: "d",
        inputSchema: tools[0].function.parameters,
      },
      { name: "g", inputSchema: { type: "object", properties: {} } },
    ]);
    const mode = (tool_choice: unknown) =>
      decodeChatRequest({ ...user("x"), tools, tool_choice }).toolMode;
    assert.deepStrictEqual(mode("none"), { kind: "none" });
    assert.deepStrictEqual(mode("auto"), { kind: "auto" });
    assert.deepStrictEqual(mode("required"), { kind: "required" });
    assert.deepStrictEqual(
      mode({ type: "function", function: { name: "g" } }),
      { kind: "required", only: ["g"] },
    );
    assert.throws(() => mode("bogus"), /tool_choice/);
    assert.throws(
      () =>
        decodeChatRequest({ ...user("x"), tools: [{ type: "web_search" }] }),
      (e: { kind: string }) => e.kind === "unsupported",
    );
  });

  test("image_url data URL is decoded and sniffed; remote URL becomes text", () => {
    const r = decodeChatRequest(
      user([
        { type: "text", text: "what is this" },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${PNG}` },
        },
      ]),
    );
    const img = r.turns[0].parts[1] as {
      type: string;
      mime: string;
      data: Uint8Array;
    };
    assert.strictEqual(img.type, "image");
    assert.strictEqual(img.mime, "image/png");
    assert.ok(img.data.length > 0);
    const remote = decodeChatRequest(
      user([
        {
          type: "image_url",
          image_url: { url: "https://e.com/a.png", detail: "low" },
        },
      ]),
    );
    assert.deepStrictEqual(remote.turns[0].parts[0], {
      type: "text",
      text: '{"type":"image_url","url":"https://e.com/a.png","detail":"low"}',
      imageUrl: "https://e.com/a.png",
    });
  });

  test("input_audio and file parts become text without their data", () => {
    const r = decodeChatRequest(
      user([
        { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
        { type: "file", file: { file_id: "file-1", filename: "a.pdf" } },
      ]),
    );
    assert.deepStrictEqual(r.turns[0].parts, [
      {
        type: "text",
        text: '{"type":"input_audio","format":"wav","data":"<omitted 3 bytes>"}',
      },
      {
        type: "text",
        text: '{"type":"file","file_id":"file-1","filename":"a.pdf"}',
      },
    ]);
  });

  test("sampling and limit fields are forwarded; user/metadata ignored", () => {
    const r = decodeChatRequest({
      ...user("x"),
      max_tokens: 100,
      temperature: 0.2,
      top_p: 0.9,
      stop: "END",
      parallel_tool_calls: false,
      reasoning_effort: "high",
      user: "u-1",
      metadata: { a: "b" },
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: "k1",
    });
    assert.strictEqual(r.maxOutputTokens, 100);
    assert.strictEqual(r.temperature, 0.2);
    assert.strictEqual(r.topP, 0.9);
    assert.deepStrictEqual(r.stop, ["END"]);
    assert.strictEqual(r.parallelToolCalls, false);
    assert.strictEqual(r.reasoningEffort, "high");
    assert.strictEqual(r.cacheKey, "k1");
    assert.strictEqual(r.stream, true);
    assert.deepStrictEqual(r.echo, { includeUsage: true });
    assert.strictEqual(
      decodeChatRequest({
        ...user("x"),
        max_tokens: 5,
        max_completion_tokens: 7,
      }).maxOutputTokens,
      7,
    );
  });

  test("no limit sent means no maxOutputTokens", () => {
    const r: CoreRequest = decodeChatRequest(user("x"));
    assert.strictEqual(r.maxOutputTokens, undefined);
    assert.ok(!("maxOutputTokens" in r));
  });

  test("invalid fields give path-qualified 400s", () => {
    const kind = (b: unknown) => {
      try {
        decodeChatRequest(b);
      } catch (e) {
        const g = e as { kind: string; param?: string; message: string };
        return [g.kind, g.param ?? null, g.message];
      }
      return undefined;
    };
    assert.deepStrictEqual(kind([1]), [
      "invalid_request",
      null,
      "Request body must be a JSON object.",
    ]);
    assert.strictEqual(kind({ messages: [] })?.[1], "model");
    assert.strictEqual(kind({ ...base })?.[1], "messages");
    assert.strictEqual(kind({ ...base, messages: [] })?.[1], "messages");
    assert.strictEqual(
      kind({ ...base, messages: [{ role: "robot", content: "x" }] })?.[1],
      "messages[0].role",
    );
    assert.strictEqual(
      kind({ ...user("x"), temperature: "hot" })?.[1],
      "temperature",
    );
    assert.strictEqual(
      kind({ ...user("x"), max_tokens: 0 })?.[1],
      "max_tokens",
    );
    assert.strictEqual(
      kind({ ...base, messages: [{ role: "tool", content: "x" }] })?.[1],
      "messages[0].tool_call_id",
    );
  });
});

suite("protocol/openai/chat encode", () => {
  const collect = () => {
    const out: string[] = [];
    return {
      out,
      sink: { write: (f: string) => (out.push(f), true), cancelled: false },
    };
  };

  test("non-stream chat.completion shape with full usage details", () => {
    const enc = new ChatEncoder({
      model: "m-echo",
      stream: false,
      includeUsage: false,
      requestId: "r",
      id: "chatcmpl-1",
      created: 5,
    });
    const { out, sink } = collect();
    enc.onEvent({ e: "text", delta: "po" }, sink);
    enc.onEvent({ e: "text", delta: "ng" }, sink);
    enc.onEvent(
      {
        e: "end",
        reason: "stop",
        usage: { input: 10, output: 2, cacheRead: 4 },
      },
      sink,
    );
    enc.finish(sink);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(JSON.parse(out[0]), {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 5,
      model: "m-echo",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "pong", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: {
          reasoning_tokens: 0,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
        },
      },
    });
  });

  test("shape matches fixtures chat-nonstream and chat-tool-single", () => {
    for (const [name, withTool] of [
      ["chat-nonstream", false],
      ["chat-tool-single", true],
    ] as const) {
      const enc = new ChatEncoder({
        model: "m",
        stream: false,
        includeUsage: false,
        requestId: "r",
      });
      const { out, sink } = collect();
      if (withTool) {
        enc.onEvent(
          {
            e: "toolCall",
            id: "call_1",
            name: "get_weather",
            input: { city: "Paris" },
          },
          sink,
        );
      } else {
        enc.onEvent({ e: "text", delta: "pong" }, sink);
      }
      enc.onEvent(
        {
          e: "end",
          reason: withTool ? "tool" : "stop",
          usage: { input: 1, output: 1 },
        },
        sink,
      );
      enc.finish(sink);
      const body = JSON.parse(out[0]) as Record<string, unknown>;
      const fx = fixture(name).body as Record<string, unknown>;
      // Ids differ by design (chatcmpl- prefix).
      sameShape(body, fx);
      assert.strictEqual(
        (body.choices as Array<{ finish_reason: string }>)[0].finish_reason,
        (fx.choices as Array<{ finish_reason: string }>)[0].finish_reason,
      );
    }
  });

  test("tool_calls give finish_reason tool_calls with JSON string arguments", () => {
    const enc = new ChatEncoder({
      model: "m",
      stream: false,
      includeUsage: false,
      requestId: "r",
    });
    const { out, sink } = collect();
    enc.onEvent({ e: "toolCall", id: "c1", name: "a", input: { x: 1 } }, sink);
    enc.onEvent({ e: "toolCall", id: "c2", name: "b", input: {} }, sink);
    enc.onEvent({ e: "end", reason: "tool" }, sink);
    enc.finish(sink);
    const msg = JSON.parse(out[0]).choices[0];
    assert.strictEqual(msg.finish_reason, "tool_calls");
    assert.deepStrictEqual(msg.message.tool_calls, [
      {
        id: "c1",
        type: "function",
        function: { name: "a", arguments: '{"x":1}' },
      },
      { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
    ]);
  });

  test("length only when the core proves it", () => {
    const fin = (reason: "length" | "stop") => {
      const enc = new ChatEncoder({
        model: "m",
        stream: false,
        includeUsage: false,
        requestId: "r",
      });
      const { out, sink } = collect();
      enc.onEvent({ e: "text", delta: "x" }, sink);
      enc.onEvent({ e: "end", reason }, sink);
      enc.finish(sink);
      return JSON.parse(out[0]).choices[0].finish_reason as string;
    };
    assert.strictEqual(fin("length"), "length");
    assert.strictEqual(fin("stop"), "stop");
  });

  test("stream order: role, content deltas, finish, usage chunk, [DONE]", () => {
    const enc = new ChatEncoder({
      model: "m",
      stream: true,
      includeUsage: true,
      requestId: "r",
    });
    const { out, sink } = collect();
    enc.onEvent({ e: "thinking", delta: "hmm" }, sink);
    enc.onEvent({ e: "text", delta: "po" }, sink);
    enc.onEvent({ e: "text", delta: "ng" }, sink);
    enc.onEvent(
      { e: "end", reason: "stop", usage: { input: 3, output: 2 } },
      sink,
    );
    enc.finish(sink);
    assert.ok(out.every((f) => f.startsWith("data: ") && f.endsWith("\n\n")));
    assert.strictEqual(out[out.length - 1], "data: [DONE]\n\n");
    const chunks = out.slice(0, -1).map((f) => JSON.parse(f.slice(6)));
    assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"));
    assert.ok(chunks.every((c) => c.id === enc.id));
    assert.deepStrictEqual(chunks[0].choices[0].delta, {
      role: "assistant",
      content: "",
    });
    assert.deepStrictEqual(
      chunks.slice(1, 3).map((c) => c.choices[0].delta.content),
      ["po", "ng"],
    );
    assert.strictEqual(chunks[3].choices[0].finish_reason, "stop");
    assert.deepStrictEqual(chunks[3].choices[0].delta, {});
    assert.strictEqual(chunks[3].usage, null);
    assert.deepStrictEqual(chunks[4].choices, []);
    assert.strictEqual(chunks[4].usage.total_tokens, 5);
    assert.strictEqual(chunks.length, 5);
  });

  test("without include_usage there is no usage chunk or usage key", () => {
    const enc = new ChatEncoder({
      model: "m",
      stream: true,
      includeUsage: false,
      requestId: "r",
    });
    const { out, sink } = collect();
    enc.onEvent({ e: "text", delta: "pong" }, sink);
    enc.onEvent(
      { e: "end", reason: "stop", usage: { input: 3, output: 2 } },
      sink,
    );
    enc.finish(sink);
    const chunks = out.slice(0, -1).map((f) => JSON.parse(f.slice(6)));
    assert.strictEqual(chunks.length, 3);
    assert.ok(chunks.every((c) => !("usage" in c)));
    // Mirrors fixture chat-stream events: chunk..., finish=stop, [DONE].
    const ev = (fixture("chat-stream").sse as { events: string[] }).events;
    assert.strictEqual(ev[ev.length - 1], "[DONE]");
    assert.strictEqual(ev[ev.length - 2], "chat.completion.chunk:finish=stop");
  });

  test("streamed tool_calls: index/id/name first, then arguments fragment", () => {
    const enc = new ChatEncoder({
      model: "m",
      stream: true,
      includeUsage: false,
      requestId: "r",
    });
    const { out, sink } = collect();
    enc.onEvent({ e: "toolCall", id: "c1", name: "a", input: { x: 1 } }, sink);
    enc.onEvent({ e: "toolCall", id: "c2", name: "b", input: { y: 2 } }, sink);
    enc.onEvent({ e: "end", reason: "tool" }, sink);
    enc.finish(sink);
    const chunks = out.slice(0, -1).map((f) => JSON.parse(f.slice(6)));
    const deltas = chunks
      .slice(1, 5)
      .map((c) => c.choices[0].delta.tool_calls[0]);
    assert.deepStrictEqual(deltas, [
      {
        index: 0,
        id: "c1",
        type: "function",
        function: { name: "a", arguments: "" },
      },
      { index: 0, function: { arguments: '{"x":1}' } },
      {
        index: 1,
        id: "c2",
        type: "function",
        function: { name: "b", arguments: "" },
      },
      { index: 1, function: { arguments: '{"y":2}' } },
    ]);
    assert.strictEqual(chunks[5].choices[0].finish_reason, "tool_calls");
    assert.strictEqual(out[out.length - 1], "data: [DONE]\n\n");
  });

  test("mid-stream error writes one error chunk and no [DONE]", () => {
    const enc = new ChatEncoder({
      model: "m",
      stream: true,
      includeUsage: true,
      requestId: "rid-9",
    });
    const { out, sink } = collect();
    enc.onEvent({ e: "text", delta: "a" }, sink);
    enc.onEvent(
      { e: "error", err: { kind: "upstream_error", message: "boom" } },
      sink,
    );
    enc.onEvent({ e: "text", delta: "late" }, sink);
    enc.finish(sink);
    const last = JSON.parse(out[out.length - 1].slice(6));
    assert.deepStrictEqual(last, {
      error: { message: "boom", type: "server_error", param: null, code: null },
      request_id: "rid-9",
    });
    assert.ok(!out.includes("data: [DONE]\n\n"));
    assert.strictEqual(out.length, 3);
  });
});

suite("protocol/openai/errors", () => {
  test("malformed body maps to invalid_request with param and code null", () => {
    const info = toErrorInfo(
      new BodyError("MalformedJson", "Malformed JSON in request body: x"),
    );
    assert.deepStrictEqual(openAiErrorEnvelope(info, "r1"), {
      error: {
        message: "Malformed JSON in request body: x",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
      request_id: "r1",
    });
  });

  test("Copilot 4xx is classified with the rejected prefix", () => {
    const info = toErrorInfo(
      new Error('Request Failed: 400 {"error":{"message":"bad"}}'),
    );
    assert.strictEqual(info.kind, "upstream_rejected");
    assert.ok(info.message.startsWith("Copilot rejected the request: "));
  });
});

suite("protocol/openai/chat handler", () => {
  test("malformed JSON returns 400 envelope with request_id header", async () => {
    const { res, noted } = await call(
      undefined,
      fakeModel(() => list([])),
      "{nope",
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.headers.get("x-request-id"), "rid-1");
    const body = await res.json();
    assert.strictEqual(body.error.type, "invalid_request_error");
    assert.strictEqual(body.error.param, null);
    assert.strictEqual(body.error.code, null);
    assert.strictEqual(body.request_id, "rid-1");
    assert.deepStrictEqual(noted, ["invalid_request"]);
  });

  test("non-object body matches fixture chat-invalid message", async () => {
    const { res } = await call([1, 2]);
    assert.strictEqual(res.status, 400);
    const fx = fixture("chat-invalid").body as { error: unknown };
    const body = await res.json();
    assert.deepStrictEqual(body.error, fx.error);
  });

  test("unknown model returns 404 with the catalogue hint", async () => {
    const { res } = await call(user("x"));
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(
      body.error.message,
      "Model 'claude-sonnet-5.5' is not available. See GET /v1/models.",
    );
  });

  test("non-stream end to end: echoes requested model, forwards tools and limit", async () => {
    const model = fakeModel(() =>
      list([new TextPart("pong"), usage(349, 4, 0)]),
    );
    const { res } = await call(
      {
        model: "alias",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "ping" },
        ],
        max_tokens: 50,
        tools: [
          {
            type: "function",
            function: { name: "f", parameters: { type: "object" } },
          },
        ],
        tool_choice: "required",
      },
      model,
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.strictEqual(body.model, "alias");
    assert.match(body.id, /^chatcmpl-/);
    assert.strictEqual(body.choices[0].message.content, "pong");
    assert.strictEqual(body.usage.total_tokens, 353);
    const opts = model.sent?.options as {
      modelOptions: Record<string, unknown>;
      toolMode: number;
      tools: Array<{ name: string }>;
    };
    assert.strictEqual(opts.modelOptions.max_tokens, 50);
    assert.strictEqual(opts.toolMode, 2);
    assert.deepStrictEqual(
      opts.tools.map((t) => t.name),
      ["f"],
    );
    assert.strictEqual(model.sent?.messages.length, 2);
  });

  test("non-stream length when usage reaches max_tokens", async () => {
    const model = fakeModel(() => list([new TextPart("cut"), usage(10, 16)]));
    const { res } = await call({ ...user("x"), max_tokens: 16 }, model);
    assert.strictEqual((await res.json()).choices[0].finish_reason, "length");
    const model2 = fakeModel(() => list([new TextPart("ok"), usage(10, 15)]));
    const r2 = await call({ ...user("x"), max_tokens: 16 }, model2);
    assert.strictEqual((await r2.res.json()).choices[0].finish_reason, "stop");
  });

  test("streaming end to end with include_usage then [DONE]", async () => {
    const model = fakeModel(() =>
      list([new TextPart("po"), new TextPart("ng"), usage(5, 2)]),
    );
    const { res } = await call(
      { ...user("x"), stream: true, stream_options: { include_usage: true } },
      model,
    );
    assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
    assert.strictEqual(res.headers.get("x-request-id"), "rid-1");
    const f = frames(await res.text());
    assert.strictEqual(f[f.length - 1], "[DONE]");
    const chunks = f.slice(0, -1).map((x) => JSON.parse(x));
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    assert.strictEqual(text, "pong");
    assert.strictEqual(chunks[chunks.length - 1].usage.total_tokens, 7);
    assert.strictEqual(
      chunks[chunks.length - 2].choices[0].finish_reason,
      "stop",
    );
  });

  test("streaming parallel tool calls end to end", async () => {
    const model = fakeModel(() =>
      list([
        new ToolCallPart("c1", "a", { q: 1 }),
        new ToolCallPart("c2", "b", {}),
        usage(5, 9),
      ]),
    );
    const { res } = await call({ ...user("x"), stream: true }, model);
    const f = frames(await res.text());
    const chunks = f.slice(0, -1).map((x) => JSON.parse(x));
    const tc = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    assert.deepStrictEqual(
      tc
        .filter((t: { id?: string }) => t.id)
        .map((t: { index: number; id: string }) => [t.index, t.id]),
      [
        [0, "c1"],
        [1, "c2"],
      ],
    );
    assert.strictEqual(
      chunks[chunks.length - 1].choices[0].finish_reason,
      "tool_calls",
    );
  });

  test("streaming upstream failure ends with error chunk, no [DONE]", async () => {
    const model = fakeModel(async function* () {
      yield new TextPart("a");
      throw new Error("Request Failed: 500 oops");
    });
    const { res, noted } = await call({ ...user("x"), stream: true }, model);
    const f = frames(await res.text());
    assert.ok(!f.includes("[DONE]"));
    const last = JSON.parse(f[f.length - 1]);
    assert.strictEqual(last.error.type, "server_error");
    assert.strictEqual(last.request_id, "rid-1");
    assert.deepStrictEqual(noted, ["upstream_error"]);
  });

  test("non-stream LM error returns the classified status", async () => {
    const model: Fake = {
      ...fakeModel(() => list([])),
      sendRequest: () =>
        Promise.reject(
          Object.assign(new Error("no"), { code: "NoPermissions" }),
        ),
    };
    const { res, noted } = await call(user("x"), model);
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error.type, "permission_error");
    assert.deepStrictEqual(noted, ["permission"]);
  });

  test("image data URL reaches the model as a data part", async () => {
    const model = fakeModel(() => list([new TextPart("a cat"), usage(1, 1)]));
    await call(
      user([
        { type: "text", text: "what" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${PNG}`, detail: "low" },
        },
      ]),
      model,
    );
    const msg = model.sent?.messages[0] as {
      content: Array<{ mimeType?: string }>;
    };
    assert.strictEqual(msg.content[1].mimeType, "image/png");
  });
});
