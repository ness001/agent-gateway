import * as assert from "assert";

import { countTokens } from "../../../protocol/core/countTokens";
import { GatewayError } from "../../../protocol/core/errors";
import type { LmApi } from "../../../protocol/core/lmRequest";
import {
  type Encoder,
  type HostedHook,
  type TurnScope,
  type TurnSink,
  runTurn,
} from "../../../protocol/core/runTurn";
import type {
  CoreEvent,
  CoreRequest,
  GatewayErrorInfo,
  LmChatLike,
} from "../../../protocol/core/types";
import { CollectSink } from "../../../protocol/http/sink";

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

const usagePart = {
  mimeType: "usage",
  data: new TextEncoder().encode(
    JSON.stringify({ prompt_tokens: 12, completion_tokens: 7 }),
  ),
};

function req(over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    protocol: "anthropic",
    model: "m",
    echoModel: "m",
    system: ["sys"],
    turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    tools: [],
    toolMode: { kind: "auto" },
    hosted: [],
    stream: true,
    echo: {},
    ...over,
  };
}

interface FakeModel extends LmChatLike {
  sent?: { messages: unknown[]; options: unknown };
}

function fakeModel(
  stream: (token: {
    isCancellationRequested: boolean;
  }) => AsyncIterable<unknown>,
  count?: (m: unknown) => Promise<number>,
): FakeModel {
  const model: FakeModel = {
    id: "m",
    maxInputTokens: 1000,
    sendRequest(messages, options, token) {
      model.sent = { messages, options };
      return Promise.resolve({
        stream: stream(token as { isCancellationRequested: boolean }),
      });
    },
    countTokens: (m) => (count ? count(m) : Promise.resolve(1)),
  };
  return model;
}

class FakeScope implements TurnScope {
  requestId = "rid-1";
  reason: "client_abort" | "timeout" | undefined;
  firstChunk = 0;
  token = { isCancellationRequested: false };
  markFirstChunk(): void {
    this.firstChunk++;
  }
  cancel(r: "client_abort" | "timeout"): void {
    this.reason = r;
    this.token.isCancellationRequested = true;
  }
  timeoutError(): GatewayErrorInfo | undefined {
    return this.reason === "timeout"
      ? new GatewayError("timeout", "Request exceeded 600 s.")
      : undefined;
  }
}

/** Trivial encoder: one string frame per event, "finish" at the end. */
const encoder: Encoder<string> = {
  onEvent: (ev: CoreEvent, sink: TurnSink<string>) => {
    sink.write(ev.e === "error" ? `error:${ev.err.kind}` : ev.e);
  },
  finish: (sink) => {
    sink.write("finish");
  },
};

async function* parts(list: unknown[]): AsyncIterable<unknown> {
  for (const p of list) {
    yield p;
  }
}

suite("protocol/core runTurn", () => {
  test("event order text, toolCall, end, finish with usage", async () => {
    const model = fakeModel(() =>
      parts([
        new TextPart("Hello"),
        new ToolCallPart("call_1", "get", { a: 1 }),
        usagePart,
      ]),
    );
    const scope = new FakeScope();
    const sink = new CollectSink<string>();
    const res = await runTurn({ api, model, req: req(), scope, encoder, sink });
    assert.deepStrictEqual(sink.values(), [
      "text",
      "toolCall",
      "end",
      "finish",
    ]);
    assert.strictEqual(res.outcome, "completed");
    assert.deepStrictEqual(res.usage, { input: 12, output: 7 });
    assert.strictEqual(scope.firstChunk, 1);
    assert.ok(model.sent && model.sent.messages.length === 2);
  });

  test("pairing repairs are applied and logged before sending", async () => {
    const model = fakeModel(() => parts([new TextPart("ok")]));
    const warns: string[] = [];
    const logger = {
      warn: (m: string) => warns.push(m),
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    };
    const r = req({
      turns: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [{ type: "toolCall", id: "c1", name: "t", input: {} }],
        },
        { role: "user", parts: [{ type: "text", text: "next" }] },
      ],
    });
    const sink = new CollectSink<string>();
    await runTurn({
      api,
      model,
      req: r,
      scope: new FakeScope(),
      encoder,
      sink,
      logger,
    });
    assert.ok(warns.some((w) => w.includes("missing_result")));
    assert.deepStrictEqual(sink.values(), ["text", "end", "finish"]);
  });

  test("cancel mid-stream emits no end and no finish", async () => {
    const scope = new FakeScope();
    const model = fakeModel(async function* () {
      yield new TextPart("a");
      scope.cancel("client_abort");
      yield new TextPart("b");
      yield usagePart;
    });
    const sink = new CollectSink<string>();
    const res = await runTurn({ api, model, req: req(), scope, encoder, sink });
    assert.deepStrictEqual(sink.values(), ["text"]);
    assert.strictEqual(res.outcome, "cancelled");
  });

  test("timeout mid-stream ends with one error terminal", async () => {
    const scope = new FakeScope();
    const notes: string[] = [];
    const model = fakeModel(async function* () {
      yield new TextPart("a");
      scope.cancel("timeout");
      yield new TextPart("b");
    });
    const sink = new CollectSink<string>();
    const res = await runTurn({
      api,
      model,
      req: req(),
      scope,
      encoder,
      sink,
      journal: { noteRequestError: (k) => notes.push(k) },
    });
    assert.deepStrictEqual(sink.values(), ["text", "error:timeout", "finish"]);
    assert.strictEqual(res.error?.kind, "timeout");
    assert.deepStrictEqual(notes, ["timeout"]);
  });

  test("sendRequest failure is classified into an error event", async () => {
    const model = fakeModel(() => parts([]));
    model.sendRequest = () =>
      Promise.reject(new Error('Request Failed: 429 {"error":"slow down"}'));
    const sink = new CollectSink<string>();
    const res = await runTurn({
      api,
      model,
      req: req(),
      scope: new FakeScope(),
      encoder,
      sink,
    });
    assert.deepStrictEqual(sink.values(), ["error:rate_limit", "finish"]);
    assert.strictEqual(res.outcome, "error");
  });

  test("hosted hook stub passes events through and can be replaced", async () => {
    const model = fakeModel(() => parts([new TextPart("x")]));
    const hook: HostedHook = {
      async *wrap(events) {
        yield { e: "hostedCall", id: "ws_1", kind: "search", query: "q" };
        yield* events;
      },
    };
    const sink = new CollectSink<string>();
    await runTurn({
      api,
      model,
      req: req(),
      scope: new FakeScope(),
      encoder,
      sink,
      hosted: hook,
    });
    assert.deepStrictEqual(sink.values(), [
      "hostedCall",
      "text",
      "end",
      "finish",
    ]);
  });
});

suite("protocol/core countTokens", () => {
  test("sums model.countTokens over rendered messages", async () => {
    const seen: unknown[] = [];
    const model = fakeModel(
      () => parts([]),
      (m) => {
        seen.push(m);
        return Promise.resolve(5);
      },
    );
    const n = await countTokens(api, model, req());
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(n, 10);
  });

  test("countTokens errors are classified, never estimated", async () => {
    const model = fakeModel(
      () => parts([]),
      () => Promise.reject(new Error('Request Failed: 503 {"error":"down"}')),
    );
    await assert.rejects(
      countTokens(api, model, req()),
      (e: unknown) => e instanceof GatewayError && e.kind === "upstream_error",
    );
    const bad = fakeModel(
      () => parts([]),
      () => Promise.resolve(Number.NaN),
    );
    await assert.rejects(
      countTokens(api, bad, req()),
      (e: unknown) => e instanceof GatewayError,
    );
  });
});

suite("protocol/core missing tool-call recovery", () => {
  const missing = new Error(
    "400: No tool call found for function call output with call_id call_history.",
  );
  function history(): CoreRequest {
    return req({
      turns: [
        {
          role: "assistant",
          parts: [
            {
              type: "toolCall",
              id: "call_history",
              name: "read",
              input: { path: "example.txt" },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              type: "toolResult",
              callId: "call_history",
              content: [{ type: "text", text: "historical result" }],
              isError: false,
            },
          ],
        },
        { role: "user", parts: [{ type: "text", text: "Continue" }] },
      ],
    });
  }
  async function invoke(
    model: LmChatLike,
    request = history(),
    scope = new FakeScope(),
  ) {
    const sink = new CollectSink<string>();
    const result = await runTurn({
      api,
      model,
      req: request,
      scope,
      encoder,
      sink,
    });
    return { result, sink };
  }

  for (const streamError of [false, true]) {
    test(`retries rejected history once without dropping content (stream=${streamError})`, async () => {
      const request = history();
      const before = JSON.stringify(request);
      let attempts = 0;
      const model = fakeModel(() => parts([new TextPart("Recovered")]));
      model.sendRequest = async (messages) => {
        if (++attempts === 1) {
          if (!streamError) {
            throw missing;
          }
          return {
            stream: (async function* () {
              throw missing;
              yield new TextPart("unreachable");
            })(),
          };
        }
        const serialized = JSON.stringify(messages);
        assert.ok(serialized.includes("historical result"));
        assert.ok(serialized.includes("example.txt"));
        assert.ok(serialized.includes("call_history"));
        assert.ok(serialized.includes("Continue"));
        const contents = (messages as { content: unknown[] }[]).flatMap(
          (m) => m.content,
        );
        assert.ok(
          !contents.some(
            (p) => p instanceof ToolCallPart || p instanceof ToolResultPart,
          ),
        );
        return { stream: parts([new TextPart("Recovered"), usagePart]) };
      };
      const { result } = await invoke(model, request);
      assert.strictEqual(result.outcome, "completed");
      assert.strictEqual(attempts, 2);
      assert.strictEqual(JSON.stringify(request), before);
    });
  }

  test("does not retry after a streamed part", async () => {
    let attempts = 0;
    const model = fakeModel(() =>
      (async function* () {
        attempts++;
        yield new TextPart("Partial");
        throw missing;
      })(),
    );
    assert.strictEqual((await invoke(model)).result.outcome, "error");
    assert.strictEqual(attempts, 1);
  });

  test("second rejection is surfaced instead of looping", async () => {
    let attempts = 0;
    const model = fakeModel(() => parts([]));
    model.sendRequest = async () => {
      attempts++;
      throw missing;
    };
    assert.strictEqual((await invoke(model)).result.outcome, "error");
    assert.strictEqual(attempts, 2);
  });

  for (const message of [
    "rate limit",
    "No tool call found for function call output with call_id call_unknown.",
  ]) {
    test(`does not retry an unrelated or unresolvable error: ${message}`, async () => {
      let attempts = 0;
      const model = fakeModel(() => parts([]));
      model.sendRequest = async () => {
        attempts++;
        throw new Error(message);
      };
      assert.strictEqual((await invoke(model)).result.outcome, "error");
      assert.strictEqual(attempts, 1);
    });
  }

  test("hosted follow-up round uses the same recovery path", async () => {
    let attempts = 0;
    const model = fakeModel(() => parts([]));
    model.sendRequest = async () => {
      attempts++;
      if (attempts === 2) {
        throw missing;
      }
      return { stream: parts([new TextPart("ok")]) };
    };
    const hook: HostedHook = {
      async *wrap(events, context) {
        for await (const event of events) {
          if (event.e !== "end") {
            yield event;
          }
        }
        yield* context.callModel(history());
      },
    };
    const result = await runTurn({
      api,
      model,
      req: req(),
      scope: new FakeScope(),
      encoder,
      sink: new CollectSink<string>(),
      hosted: hook,
    });
    assert.strictEqual(result.outcome, "completed");
    assert.strictEqual(attempts, 3);
  });

  test("does not retry after usage data or a timeout", async () => {
    for (const timeout of [false, true]) {
      const scope = new FakeScope();
      let attempts = 0;
      const model = fakeModel(() =>
        (async function* () {
          attempts++;
          if (timeout) {
            scope.cancel("timeout");
          } else {
            yield usagePart;
          }
          throw missing;
        })(),
      );
      assert.strictEqual(
        (await invoke(model, history(), scope)).result.outcome,
        "error",
      );
      assert.strictEqual(attempts, 1);
    }
  });
  test("does not retry after cancellation", async () => {
    const scope = new FakeScope();
    let attempts = 0;
    const model = fakeModel(() => parts([]));
    model.sendRequest = async () => {
      attempts++;
      scope.cancel("client_abort");
      throw missing;
    };
    assert.strictEqual(
      (await invoke(model, history(), scope)).result.outcome,
      "cancelled",
    );
    assert.strictEqual(attempts, 1);
  });
});

suite("protocol/core Copilot context budget", () => {
  for (const protocol of [
    "anthropic",
    "openai-responses",
    "openai-chat",
    "gemini",
  ] as const) {
    test(`${protocol} sends advertised context budget to Copilot, separately from output`, async () => {
      const model = Object.assign(
        fakeModel(() => parts([new TextPart("ok")])),
        { vendor: "copilot", maxInputTokens: 921793 },
      );
      const result = await runTurn({
        api,
        model,
        req: req({ protocol, maxOutputTokens: 32000 }),
        scope: new FakeScope(),
        encoder,
        sink: new CollectSink<string>(),
      });
      assert.strictEqual(result.outcome, "completed");
      const options = model.sent!.options as {
        configuration?: { contextSize: number };
        modelOptions: Record<string, unknown>;
      };
      assert.strictEqual(options.configuration?.contextSize, 921793);
      assert.strictEqual(options.modelOptions.max_tokens, 32000);
      assert.strictEqual(options.modelOptions.contextSize, undefined);
    });
  }

  test("hosted follow-up and recovery retry retain explicit context configuration", async () => {
    let attempts = 0;
    const model = Object.assign(
      fakeModel(() => parts([])),
      { vendor: "copilot", maxInputTokens: 921793 },
    );
    model.sendRequest = async (_messages, options) => {
      attempts++;
      assert.strictEqual(
        (options as { configuration?: { contextSize: number } }).configuration
          ?.contextSize,
        921793,
      );
      if (attempts === 2) {
        throw new Error(
          "No tool call found for function call output with call_id call_test.",
        );
      }
      return { stream: parts([new TextPart("ok")]) };
    };
    const hook: HostedHook = {
      async *wrap(events, context) {
        for await (const event of events) {
          if (event.e !== "end") {
            yield event;
          }
        }
        yield* context.callModel(
          req({
            turns: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "toolCall",
                    id: "call_test",
                    name: "read",
                    input: {},
                  },
                ],
              },
              {
                role: "user",
                parts: [
                  {
                    type: "toolResult",
                    callId: "call_test",
                    content: [{ type: "text", text: "result" }],
                    isError: false,
                  },
                ],
              },
            ],
          }),
        );
      },
    };
    const result = await runTurn({
      api,
      model,
      req: req(),
      scope: new FakeScope(),
      encoder,
      sink: new CollectSink<string>(),
      hosted: hook,
    });
    assert.strictEqual(result.outcome, "completed");
    assert.strictEqual(attempts, 3);
  });

  for (const [vendor, capacity] of [
    ["other", 921793],
    ["copilot", 0],
    ["copilot", -1],
    ["copilot", NaN],
    ["copilot", Infinity],
    ["copilot", 1.5],
  ] as const) {
    test(`does not invent configuration for vendor=${vendor}, capacity=${capacity}`, async () => {
      const model = Object.assign(
        fakeModel(() => parts([])),
        { vendor, maxInputTokens: capacity },
      );
      await runTurn({
        api,
        model,
        req: req(),
        scope: new FakeScope(),
        encoder,
        sink: new CollectSink<string>(),
      });
      assert.strictEqual(
        (model.sent!.options as { configuration?: unknown }).configuration,
        undefined,
      );
    });
  }
});
