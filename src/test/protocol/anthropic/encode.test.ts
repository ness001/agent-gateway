import * as assert from "assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AnthropicEncoder,
  collectMessage,
  sseFrame,
} from "../../../protocol/anthropic/encode";
import {
  type AnthropicRuntime,
  handleAnthropic,
} from "../../../protocol/anthropic/index";
import type { WireStreamEvent } from "../../../protocol/anthropic/wire";
import { idPattern } from "../../../protocol/core/ids";
import type { LmApi } from "../../../protocol/core/lmRequest";
import type { TurnSink } from "../../../protocol/core/runTurn";
import type { CoreEvent, LmChatLike } from "../../../protocol/core/types";

// ---- fakes ----

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
class FakeThinkingPart {
  constructor(
    public value: string,
    public metadata?: Record<string, unknown>,
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

const usage = (o: Record<string, unknown>) => ({
  mimeType: "usage",
  data: new TextEncoder().encode(JSON.stringify(o)),
});

interface Fake extends LmChatLike {
  sent?: { messages: unknown[]; options: Record<string, unknown> };
  cancelled?: boolean;
}

function fakeModel(
  partsFn: (tok: {
    isCancellationRequested: boolean;
  }) => AsyncIterable<unknown>,
  opts: { fail?: unknown; count?: number | Error } = {},
): Fake {
  const m: Fake = {
    id: "claude-sonnet-5.5",
    maxInputTokens: 100000,
    sendRequest(messages, options, token) {
      m.sent = { messages, options: options as Record<string, unknown> };
      if (opts.fail) {
        return Promise.reject(opts.fail);
      }
      return Promise.resolve({
        stream: partsFn(token as { isCancellationRequested: boolean }),
      });
    },
    countTokens: () =>
      opts.count instanceof Error
        ? Promise.reject(opts.count)
        : Promise.resolve(opts.count ?? 10),
  };
  return m;
}

async function* list(items: unknown[]): AsyncIterable<unknown> {
  for (const p of items) {
    yield p;
  }
}

class Source {
  token = { isCancellationRequested: false };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

const errs: string[] = [];
function runtime(over: Partial<AnthropicRuntime> = {}): AnthropicRuntime {
  return {
    api,
    createSource: () => new Source(),
    modelInfo: () => ({
      supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }],
    }),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    journal: { noteRequestError: (k) => errs.push(k) },
    ...over,
  };
}

function post(
  body: unknown,
  path = "/v1/messages",
  raw?: string,
  signal?: AbortSignal,
): Request {
  return new Request(`http://127.0.0.1:24445${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
    signal,
  });
}

const route = { endpoint: "messages" };
const deps = (m: Fake | undefined) => ({
  getLocalModel: (id: string) => (m && id === m.id ? m : undefined),
});

function parseSse(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .split("\n\n")
    .filter((f) => f.trim())
    .map((f) => {
      const lines = f.split("\n");
      assert.match(lines[0], /^event: \w+$/);
      assert.match(lines[1], /^data: /);
      assert.strictEqual(lines.length, 2);
      return {
        event: lines[0].slice(7),
        data: JSON.parse(lines[1].slice(6)) as Record<string, unknown>,
      };
    });
}

function encode(events: CoreEvent[], finish = true): WireStreamEvent[] {
  const out: WireStreamEvent[] = [];
  const sink: TurnSink<WireStreamEvent> = {
    write: (e) => (out.push(e), true),
    cancelled: false,
  };
  const enc = new AnthropicEncoder({
    echoModel: "claude-sonnet-5.5",
    requestId: "rid",
    id: "msg_test",
  });
  for (const ev of events) {
    enc.onEvent(ev, sink);
  }
  if (finish) {
    enc.finish(sink);
  }
  return out;
}

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(__dirname, "../../../../src/test/fixtures/wire", name),
      "utf8",
    ),
  ) as Record<string, unknown>;

const SONNET = "claude-sonnet-5.5";
const body = (over: Record<string, unknown> = {}) => ({
  model: SONNET,
  max_tokens: 100,
  messages: [{ role: "user", content: "ping" }],
  ...over,
});

suite("protocol/anthropic encode", () => {
  test("non-stream body shape matches fixture keys", () => {
    const c = collectMessage(
      encode([
        { e: "text", delta: "po" },
        { e: "text", delta: "ng" },
        { e: "end", reason: "stop", usage: { input: 349, output: 4 } },
      ]),
      { id: "x", model: SONNET },
    );
    assert.ok(c.ok);
    const fx = fixture("messages-nonstream.json").body as Record<
      string,
      unknown
    >;
    assert.deepStrictEqual(
      Object.keys(c.message).sort(),
      Object.keys(fx).sort(),
    );
    assert.deepStrictEqual(
      Object.keys(c.message.usage).sort(),
      Object.keys(fx.usage as object).sort(),
    );
    assert.deepStrictEqual(c.message.content, [
      { type: "text", text: "pong", citations: null },
    ]);
    assert.strictEqual(c.message.stop_reason, "end_turn");
    assert.strictEqual(c.message.model, SONNET);
    assert.strictEqual(c.message.container, null);
    assert.strictEqual(c.message.stop_details, null);
    assert.strictEqual(c.message.usage.service_tier, null);
  });

  test("message id uses the msg_ prefix", () => {
    const enc = new AnthropicEncoder({ echoModel: "m", requestId: "r" });
    assert.match(enc.id, idPattern("anthropicMessage"));
  });

  test("usage projects cache read/creation", () => {
    const c = collectMessage(
      encode([
        {
          e: "end",
          reason: "stop",
          usage: { input: 100, output: 10, cacheRead: 60, cacheWrite: 5 },
        },
      ]),
      { id: "x", model: "m" },
    );
    assert.ok(c.ok);
    assert.strictEqual(c.message.usage.input_tokens, 35);
    assert.strictEqual(c.message.usage.cache_read_input_tokens, 60);
    assert.strictEqual(c.message.usage.cache_creation_input_tokens, 5);
    assert.strictEqual(c.message.usage.output_tokens, 10);
    assert.strictEqual(c.message.usage.server_tool_use, null);
  });

  test("tool_use block shape and stop_reason tool_use", () => {
    const c = collectMessage(
      encode([
        { e: "text", delta: "let me" },
        { e: "toolCall", id: "toolu_abc", name: "get", input: { a: [1, "x"] } },
        { e: "end", reason: "tool" },
      ]),
      { id: "x", model: "m" },
    );
    assert.ok(c.ok);
    assert.deepStrictEqual(c.message.content[1], {
      type: "tool_use",
      id: "toolu_abc",
      caller: { type: "direct" },
      name: "get",
      input: { a: [1, "x"] },
    });
    assert.strictEqual(c.message.stop_reason, "tool_use");
  });

  test("thinking block emitted only when streamed, with signature", () => {
    const evs = encode([
      { e: "thinking", delta: "hm" },
      { e: "thinking", delta: "m", signature: "SIG" },
      { e: "text", delta: "ok" },
      { e: "end", reason: "stop" },
    ]);
    const deltas = evs
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e as { delta: { type: string } }).delta.type);
    assert.deepStrictEqual(deltas, [
      "thinking_delta",
      "thinking_delta",
      "signature_delta",
      "text_delta",
    ]);
    const c = collectMessage(evs, { id: "x", model: "m" });
    assert.ok(c.ok);
    assert.deepStrictEqual(c.message.content, [
      { type: "thinking", thinking: "hmm", signature: "SIG" },
      { type: "text", text: "ok", citations: null },
    ]);
    const plain = collectMessage(
      encode([
        { e: "text", delta: "x" },
        { e: "end", reason: "stop" },
      ]),
      { id: "x", model: "m" },
    );
    assert.ok(plain.ok);
    assert.ok(plain.message.content.every((b) => b.type !== "thinking"));
  });

  test("SSE framing is event/data/blank line", () => {
    assert.strictEqual(
      sseFrame({ type: "message_stop" }),
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });

  test("text stream order matches fixture", () => {
    const evs = encode([
      { e: "text", delta: "pong" },
      { e: "end", reason: "stop", usage: { input: 1, output: 1 } },
    ]);
    const fx = fixture("messages-stream.json").sse as { events: string[] };
    assert.deepStrictEqual(
      evs.map((e) => e.type),
      fx.events,
    );
  });

  test("message_start has the full shape with content [] and service_tier standard", () => {
    const [start] = encode([{ e: "end", reason: "stop" }]);
    assert.ok(start.type === "message_start");
    assert.deepStrictEqual(start.message.content, []);
    assert.strictEqual(start.message.stop_reason, null);
    assert.strictEqual(start.message.usage.service_tier, "standard");
    assert.strictEqual(start.message.id, "msg_test");
    assert.strictEqual(start.message.model, SONNET);
  });

  test("message_delta carries container, stop_details, stop_reason, stop_sequence and usage", () => {
    const evs = encode([
      { e: "text", delta: "a" },
      { e: "end", reason: "stop", usage: { input: 10, output: 3 } },
    ]);
    const md = evs.find((e) => e.type === "message_delta");
    assert.deepStrictEqual(md, {
      type: "message_delta",
      delta: {
        container: null,
        stop_details: null,
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
      },
    });
    assert.strictEqual(evs[evs.length - 1].type, "message_stop");
  });

  test("parallel tool calls stream input_json_delta with increasing indices", () => {
    const evs = encode([
      { e: "text", delta: "x" },
      { e: "toolCall", id: "toolu_1", name: "a", input: { p: 1 } },
      { e: "toolCall", id: "toolu_2", name: "b", input: {} },
      { e: "end", reason: "tool" },
    ]);
    assert.deepStrictEqual(
      evs.map((e) => e.type),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    const starts = evs.filter(
      (e) => e.type === "content_block_start",
    ) as Array<{
      index: number;
      content_block: { type: string; input?: object };
    }>;
    assert.deepStrictEqual(
      starts.map((s) => s.index),
      [0, 1, 2],
    );
    assert.deepStrictEqual(starts[1].content_block.input, {});
    const json = evs.filter(
      (e) =>
        e.type === "content_block_delta" && e.delta.type === "input_json_delta",
    ) as Array<{ index: number; delta: { partial_json: string } }>;
    assert.deepStrictEqual(
      json.map((j) => [j.index, JSON.parse(j.delta.partial_json)]),
      [
        [1, { p: 1 }],
        [2, {}],
      ],
    );
  });

  test("stop reason mapping; max_tokens only from an explicit length end", () => {
    const sr = (ev: CoreEvent) => {
      const c = collectMessage(encode([ev]), { id: "x", model: "m" });
      assert.ok(c.ok);
      return [c.message.stop_reason, c.message.stop_sequence];
    };
    assert.deepStrictEqual(sr({ e: "end", reason: "stop" }), [
      "end_turn",
      null,
    ]);
    assert.deepStrictEqual(sr({ e: "end", reason: "tool" }), [
      "tool_use",
      null,
    ]);
    assert.deepStrictEqual(sr({ e: "end", reason: "length" }), [
      "max_tokens",
      null,
    ]);
    assert.deepStrictEqual(
      sr({ e: "end", reason: "stopSequence", stopSeq: "END" }),
      ["stop_sequence", "END"],
    );
    assert.deepStrictEqual(sr({ e: "end", reason: "refusal" }), [
      "refusal",
      null,
    ]);
  });

  test("finish without end terminates with end_turn exactly once", () => {
    const evs = encode([{ e: "text", delta: "a" }]);
    assert.strictEqual(evs.filter((e) => e.type === "message_stop").length, 1);
    const twice = encode([{ e: "end", reason: "stop" }]);
    assert.strictEqual(
      twice.filter((e) => e.type === "message_stop").length,
      1,
    );
  });

  test("mid-stream error event carries type and request_id; nothing after", () => {
    const evs = encode([
      { e: "text", delta: "a" },
      { e: "error", err: { kind: "upstream_error", message: "boom" } },
      { e: "text", delta: "late" },
    ]);
    const last = evs[evs.length - 1];
    assert.deepStrictEqual(last, {
      type: "error",
      error: { type: "api_error", message: "boom" },
      request_id: "rid",
    });
    assert.ok(!evs.some((e) => e.type === "message_stop"));
  });
});

suite("protocol/anthropic handler", () => {
  test("non-stream end to end through a fake model", async () => {
    const m = fakeModel(() =>
      list([
        new TextPart("pong"),
        usage({ prompt_tokens: 349, completion_tokens: 4 }),
      ]),
    );
    const res = await handleAnthropic(
      post(body()),
      route,
      deps(m),
      "rid-1",
      runtime(),
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-request-id"), "rid-1");
    const j = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(j.type, "message");
    assert.deepStrictEqual(j.content, [
      { type: "text", text: "pong", citations: null },
    ]);
    assert.strictEqual((j.usage as Record<string, unknown>).input_tokens, 349);
    assert.strictEqual(
      m.sent?.options.modelOptions &&
        (m.sent.options.modelOptions as Record<string, unknown>).max_tokens,
      100,
    );
  });

  test("resolved model echoes the requested name", async () => {
    const m = fakeModel(() => list([new TextPart("pong")]));
    const d = { getLocalModel: () => m };
    const res = await handleAnthropic(
      post(body({ model: "gpt-6-astra" })),
      route,
      d,
      "r",
      runtime(),
    );
    const j = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(j.model, "gpt-6-astra");
  });

  test("stream end to end with SSE headers and order", async () => {
    const m = fakeModel(() =>
      list([
        new TextPart("po"),
        new TextPart("ng"),
        usage({ prompt_tokens: 5, completion_tokens: 2 }),
      ]),
    );
    const res = await handleAnthropic(
      post(body({ stream: true })),
      route,
      deps(m),
      "r",
      runtime(),
    );
    assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
    const frames = parseSse(await res.text());
    assert.deepStrictEqual(
      frames.map((f) => f.event),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    for (const f of frames) {
      assert.strictEqual(f.data.type, f.event);
    }
  });

  test("streamed thinking part becomes a thinking block", async () => {
    const m = fakeModel(() =>
      list([
        new FakeThinkingPart("think", { signature: "S" }),
        new TextPart("ok"),
      ]),
    );
    const res = await handleAnthropic(
      post(body({ thinking: { type: "enabled", budget_tokens: 32000 } })),
      route,
      deps(m),
      "r",
      runtime(),
    );
    const j = (await res.json()) as { content: Array<{ type: string }> };
    assert.deepStrictEqual(
      j.content.map((b) => b.type),
      ["thinking", "text"],
    );
    assert.strictEqual(
      (m.sent?.options.modelOptions as Record<string, unknown>).reasoningEffort,
      "high",
    );
  });

  test("tool call end to end gives tool_use stop and forwards tools", async () => {
    const m = fakeModel(() =>
      list([new ToolCallPart("toolu_x", "get", { a: 1 })]),
    );
    const res = await handleAnthropic(
      post(
        body({
          tools: [{ name: "get", input_schema: { type: "object" } }],
          tool_choice: { type: "any" },
        }),
      ),
      route,
      deps(m),
      "r",
      runtime(),
    );
    const j = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(j.stop_reason, "tool_use");
    assert.strictEqual(m.sent?.options.toolMode, 2);
  });

  test("client abort cancels upstream; no message_stop", async () => {
    const ac = new AbortController();
    let tok: { isCancellationRequested: boolean } | undefined;
    const m = fakeModel((t) => {
      tok = t;
      return (async function* () {
        yield new TextPart("a");
        await new Promise((r) => setTimeout(r, 20));
        yield new TextPart("b");
      })();
    });
    const res = await handleAnthropic(
      post(body({ stream: true }), "/v1/messages", undefined, ac.signal),
      route,
      deps(m),
      "r",
      runtime(),
    );
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(tok?.isCancellationRequested, true);
  });

  test("count_tokens returns {input_tokens}", async () => {
    const m = fakeModel(() => list([]), { count: 15 });
    const res = await handleAnthropic(
      post(
        {
          model: SONNET,
          system: "s",
          messages: [{ role: "user", content: "x" }],
        },
        "/v1/messages/count_tokens",
      ),
      { endpoint: "countTokens" },
      deps(m),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { input_tokens: 30 });
    assert.deepStrictEqual(
      Object.keys(fixture("messages-count-tokens.json").body as object),
      ["input_tokens"],
    );
  });

  test("count_tokens failure is classified, not estimated", async () => {
    const m = fakeModel(() => list([]), {
      count: new Error("Request Failed: 500 oops"),
    });
    const res = await handleAnthropic(
      post(body(), "/v1/messages/count_tokens"),
      { endpoint: "countTokens" },
      deps(m),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 502);
  });

  test("missing model gives 400 with request_id envelope", async () => {
    const res = await handleAnthropic(
      post({ messages: [] }),
      route,
      deps(undefined),
      "rid-9",
      runtime(),
    );
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Request body must specify a model.",
      },
      request_id: "rid-9",
    });
  });

  test("malformed JSON gives 400 invalid_request_error", async () => {
    const res = await handleAnthropic(
      post(null, "/v1/messages", "{nope"),
      route,
      deps(undefined),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 400);
    const j = (await res.json()) as { error: { type: string } };
    assert.strictEqual(j.error.type, "invalid_request_error");
    assert.strictEqual(fixture("messages-invalid.json").status, 500);
  });

  test("invalid body shape (messages not array) gives 400", async () => {
    const res = await handleAnthropic(
      post({ model: SONNET, max_tokens: 5 }),
      route,
      deps(fakeModel(() => list([]))),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 400);
  });

  test("unknown local model gives 404 envelope", async () => {
    errs.length = 0;
    const res = await handleAnthropic(
      post(body({ model: "nope" })),
      route,
      deps(undefined),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 404);
    const j = (await res.json()) as {
      error: { type: string; message: string };
    };
    assert.strictEqual(j.error.type, "not_found_error");
    assert.match(j.error.message, /Model 'nope' is not available/);
    assert.deepStrictEqual(errs, ["not_found"]);
  });

  test("upstream 4xx before stream gives 400 with Copilot prefix", async () => {
    const m = fakeModel(() => list([]), {
      fail: new Error('Request Failed: 400 {"error":{"message":"bad"}}'),
    });
    const res = await handleAnthropic(
      post(body()),
      route,
      deps(m),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 400);
    const j = (await res.json()) as { error: { message: string } };
    assert.match(j.error.message, /^Copilot rejected the request: bad/);
  });

  test("failure in a stream emits an error event and no message_stop", async () => {
    const m = fakeModel(() =>
      (async function* () {
        yield new TextPart("a");
        throw new Error("Request Failed: 503 down");
      })(),
    );
    const res = await handleAnthropic(
      post(body({ stream: true })),
      route,
      deps(m),
      "rid-e",
      runtime(),
    );
    const frames = parseSse(await res.text());
    const last = frames[frames.length - 1];
    assert.strictEqual(last.event, "error");
    assert.strictEqual((last.data.error as { type: string }).type, "api_error");
    assert.strictEqual(last.data.request_id, "rid-e");
    assert.ok(!frames.some((f) => f.event === "message_stop"));
  });

  test("heartbeat writes event: ping during silence", async () => {
    const m = fakeModel(() =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 40));
        yield new TextPart("a");
      })(),
    );
    const res = await handleAnthropic(
      post(body({ stream: true })),
      route,
      deps(m),
      "r",
      runtime({ heartbeatMs: 10 }),
    );
    const frames = parseSse(await res.text());
    assert.ok(frames.some((f) => f.event === "ping" && f.data.type === "ping"));
    assert.strictEqual(frames[frames.length - 1].event, "message_stop");
  });

  test("9 ?beta=true query is tolerated", async () => {
    const m = fakeModel(() => list([new TextPart("x")]));
    const res = await handleAnthropic(
      post(body(), "/v1/messages?beta=true"),
      route,
      deps(m),
      "r",
      runtime(),
    );
    assert.strictEqual(res.status, 200);
  });
});
