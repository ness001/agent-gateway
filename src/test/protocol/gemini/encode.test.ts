import * as assert from "assert";
import * as fs from "node:fs";
import * as path from "node:path";

import type { LmApi } from "../../../protocol/core/lmRequest";
import { type TurnScope, runTurn } from "../../../protocol/core/runTurn";
import type {
  CoreEvent,
  CoreRequest,
  GatewayErrorInfo,
  LmChatLike,
} from "../../../protocol/core/types";
import {
  GeminiEncoder,
  type GeminiEncoderOptions,
  type GeminiMode,
  geminiContentType,
  geminiFinishReason,
  streamModeFromUrl,
} from "../../../protocol/gemini/encode";
import { CollectSink } from "../../../protocol/http/sink";

class TextPart {
  constructor(public value: string) {}
}
class ThinkingPart {
  constructor(
    public value: string,
    public metadata?: object,
  ) {}
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

const usage = (u: object) => ({
  mimeType: "usage",
  data: new TextEncoder().encode(JSON.stringify(u)),
});

function req(over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    protocol: "gemini",
    model: "claude-sonnet-5.5",
    echoModel: "claude-sonnet-5.5",
    system: [],
    turns: [{ role: "user", parts: [{ type: "text", text: "ping" }] }],
    tools: [],
    toolMode: { kind: "auto" },
    hosted: [],
    stream: false,
    echo: {},
    ...over,
  };
}

class FakeScope implements TurnScope {
  requestId = "rid-1";
  reason: "client_abort" | "timeout" | undefined;
  token = { isCancellationRequested: false };
  markFirstChunk(): void {}
  timeoutError(): GatewayErrorInfo | undefined {
    return undefined;
  }
}

function fakeModel(
  stream: (scope: FakeScope) => AsyncIterable<unknown>,
  scope: FakeScope,
  fail?: unknown,
): LmChatLike {
  return {
    id: "m",
    maxInputTokens: 1000,
    sendRequest: () =>
      fail ? Promise.reject(fail) : Promise.resolve({ stream: stream(scope) }),
    countTokens: () => Promise.resolve(1),
  };
}

async function* list(items: unknown[]): AsyncIterable<unknown> {
  for (const p of items) {
    yield p;
  }
}

async function drive(
  mode: GeminiMode,
  items: unknown[],
  opts: Partial<GeminiEncoderOptions> = {},
  over: Partial<CoreRequest> = {},
) {
  const scope = new FakeScope();
  const sink = new CollectSink<string>();
  const encoder = new GeminiEncoder({
    mode,
    modelVersion: "claude-sonnet-5.5",
    requestId: "rid-1",
    ...opts,
  });
  const result = await runTurn({
    api,
    model: fakeModel(() => list(items), scope),
    req: req({ stream: mode !== "json", ...over }),
    scope,
    encoder,
    sink,
  });
  return { frames: sink.values(), encoder, result, scope };
}

function sseChunks(frames: readonly string[]): unknown[] {
  return frames.map((f) => {
    assert.ok(f.startsWith("data: ") && f.endsWith("\n\n"), f);
    return JSON.parse(f.slice(6));
  });
}

const fixtureRoot = path.resolve(
  __dirname,
  "../../../../src/test/fixtures/wire",
);
function fixtureBody(name: string): Record<string, unknown> {
  const j = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, `${name}.json`), "utf8"),
  ) as { body: Record<string, unknown> };
  return j.body;
}

/** Key structure (types, not values) so fixture shapes can be compared. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(shape);
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, shape(o[k])]),
    );
  }
  return typeof v;
}

suite("protocol/gemini encode", () => {
  test("non-streaming replay matches gemini-nonstream fixture", async () => {
    const want = fixtureBody("gemini-nonstream");
    const { frames } = await drive("json", [
      new TextPart("po"),
      new TextPart("ng"),
      usage({ prompt_tokens: 349, completion_tokens: 4 }),
    ]);
    assert.equal(frames.length, 1);
    const got = JSON.parse(frames[0]);
    assert.deepEqual(got, want);
  });

  test("tool call replay matches gemini-tool-single fixture", async () => {
    const want = fixtureBody("gemini-tool-single") as {
      candidates: Array<{
        content: { parts: Array<{ functionCall: { id: string } }> };
      }>;
    };
    const id = want.candidates[0].content.parts[0].functionCall.id;
    const { frames } = await drive("json", [
      new ToolCallPart(id, "get_weather", { city: "Paris" }),
      usage({
        prompt_tokens: 705,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 701 },
      }),
    ]);
    const got = JSON.parse(frames[0]);
    assert.deepEqual(shape(got), shape(want));
    assert.deepEqual(got.candidates, want.candidates);
    assert.equal(got.usageMetadata.totalTokenCount, 755);
  });

  test("every fixture body in the capture sets has the encoder's shape", async () => {
    const { frames } = await drive("json", [
      new TextPart("pong"),
      usage({ prompt_tokens: 1, completion_tokens: 1 }),
    ]);
    const mine = shape(JSON.parse(frames[0]));
    for (const name of ["gemini-nonstream", "gemini-reasoning"]) {
      assert.deepEqual(shape(fixtureBody(name)), mine, name);
    }
  });

  test("alt=sse frames are data-only; final chunk has finishReason, usage, modelVersion", async () => {
    const { frames } = await drive("sse", [
      new TextPart("po"),
      new TextPart("ng"),
      usage({
        prompt_tokens: 372,
        completion_tokens: 4907,
        completion_tokens_details: { reasoning_tokens: 616 },
      }),
    ]);
    const chunks = sseChunks(frames);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks[0], {
      candidates: [
        { content: { parts: [{ text: "po" }], role: "model" }, index: 0 },
      ],
    });
    // Shape of a captured stream last frame; total includes thoughts.
    assert.deepEqual(chunks[2], {
      candidates: [{ finishReason: "STOP", index: 0 }],
      usageMetadata: {
        promptTokenCount: 372,
        candidatesTokenCount: 4291,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 616,
        totalTokenCount: 5279,
      },
      modelVersion: "claude-sonnet-5.5",
    });
    for (const f of frames) {
      assert.ok(!f.startsWith("event:"));
    }
  });

  test("without alt=sse the stream is one parseable JSON array", async () => {
    const { frames } = await drive("array", [
      new TextPart("a"),
      new TextPart("b"),
      usage({ prompt_tokens: 3, completion_tokens: 2 }),
    ]);
    assert.ok(frames[0].startsWith("["));
    assert.equal(frames[frames.length - 1], "]");
    const arr = JSON.parse(frames.join(""));
    assert.equal(arr.length, 3);
    assert.equal(arr[2].candidates[0].finishReason, "STOP");
    assert.equal(arr[2].modelVersion, "claude-sonnet-5.5");
  });

  test("mode selection and content types", () => {
    assert.equal(
      streamModeFromUrl("/v1beta/models/m:streamGenerateContent?alt=sse"),
      "sse",
    );
    assert.equal(
      streamModeFromUrl("/v1beta/models/m:streamGenerateContent"),
      "array",
    );
    assert.equal(
      streamModeFromUrl("/v1beta/models/m:streamGenerateContent?alt=json"),
      "array",
    );
    assert.equal(geminiContentType("sse"), "text/event-stream");
    assert.equal(geminiContentType("array"), "application/json");
    assert.equal(geminiContentType("json"), "application/json");
  });

  test("usageMetadata has five integers and total = prompt+cached+candidates+thoughts", async () => {
    const { frames } = await drive("json", [
      new TextPart("x"),
      usage({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 3 },
      }),
    ]);
    const u = JSON.parse(frames[0]).usageMetadata;
    assert.deepEqual(u, {
      promptTokenCount: 40,
      candidatesTokenCount: 7,
      cachedContentTokenCount: 60,
      thoughtsTokenCount: 3,
      totalTokenCount: 110,
    });
  });

  test("usage part absent still gives five zero fields", async () => {
    const { frames } = await drive("json", [new TextPart("x")]);
    const u = JSON.parse(frames[0]).usageMetadata;
    assert.deepEqual(Object.keys(u).sort(), [
      "cachedContentTokenCount",
      "candidatesTokenCount",
      "promptTokenCount",
      "thoughtsTokenCount",
      "totalTokenCount",
    ]);
    assert.ok(Object.values(u).every((v) => v === 0));
  });

  test("functionCall parts carry id/name/args with finish STOP", async () => {
    const { frames } = await drive("json", [
      new TextPart("Let me check."),
      new ToolCallPart("call_1", "get_weather", { city: "Paris" }),
    ]);
    const c = JSON.parse(frames[0]).candidates[0];
    assert.deepEqual(c.content.parts, [
      { text: "Let me check." },
      {
        functionCall: {
          id: "call_1",
          name: "get_weather",
          args: { city: "Paris" },
        },
      },
    ]);
    assert.equal(c.finishReason, "STOP");
  });

  test("parallel calls are separate parts (and chunks when streaming)", async () => {
    const calls = [
      new ToolCallPart("call_1", "a", { x: 1 }),
      new ToolCallPart("call_2", "b", {}),
    ];
    const json = await drive("json", calls);
    assert.equal(
      JSON.parse(json.frames[0]).candidates[0].content.parts.length,
      2,
    );
    // gemini-tool-parallel-stream fixture: 3 SSE chunks (2 calls + final).
    const sse = await drive("sse", calls);
    const chunks = sseChunks(sse.frames) as Array<{
      candidates: Array<{ content?: { parts: unknown[] } }>;
    }>;
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks[1].candidates[0].content?.parts, [
      { functionCall: { id: "call_2", name: "b", args: {} } },
    ]);
  });

  test("thought parts only when includeThoughts", async () => {
    const items = [
      new ThinkingPart("hmm", { signature: "sig1" }),
      new TextPart("pong"),
    ];
    const off = await drive("json", items);
    assert.deepEqual(JSON.parse(off.frames[0]).candidates[0].content.parts, [
      { text: "pong" },
    ]);
    const on = await drive("json", items, { includeThoughts: true });
    assert.deepEqual(JSON.parse(on.frames[0]).candidates[0].content.parts, [
      { text: "hmm", thought: true, thoughtSignature: "sig1" },
      { text: "pong" },
    ]);
    const sse = await drive("sse", items, { includeThoughts: true });
    assert.deepEqual(
      (
        sseChunks(sse.frames)[0] as {
          candidates: Array<{ content: { parts: unknown[] } }>;
        }
      ).candidates[0].content.parts,
      [{ text: "hmm", thought: true, thoughtSignature: "sig1" }],
    );
  });

  test("MAX_TOKENS only when usage proves the limit", async () => {
    const hit = await drive(
      "json",
      [new TextPart("x"), usage({ prompt_tokens: 1, completion_tokens: 16 })],
      { maxOutputTokens: 16 },
      { maxOutputTokens: 16 },
    );
    assert.equal(
      JSON.parse(hit.frames[0]).candidates[0].finishReason,
      "MAX_TOKENS",
    );
    const under = await drive(
      "json",
      [new TextPart("x"), usage({ prompt_tokens: 1, completion_tokens: 9 })],
      { maxOutputTokens: 16 },
      { maxOutputTokens: 16 },
    );
    assert.equal(
      JSON.parse(under.frames[0]).candidates[0].finishReason,
      "STOP",
    );
    const noUsage = await drive(
      "json",
      [new TextPart("x")],
      { maxOutputTokens: 16 },
      { maxOutputTokens: 16 },
    );
    assert.equal(
      JSON.parse(noUsage.frames[0]).candidates[0].finishReason,
      "STOP",
    );
  });

  test("finish reason table", () => {
    const u = { input: 1, output: 5 };
    assert.equal(geminiFinishReason("stop", u, undefined), "STOP");
    assert.equal(geminiFinishReason("tool", u, undefined), "STOP");
    assert.equal(geminiFinishReason("stopSequence", u, undefined), "STOP");
    assert.equal(geminiFinishReason("length", u, 5), "MAX_TOKENS");
    assert.equal(geminiFinishReason("length", u, 6), "STOP");
    assert.equal(geminiFinishReason("length", undefined, 5), "STOP");
    assert.equal(geminiFinishReason("refusal", u, undefined), "SAFETY");
  });

  test("responseId is included when provided", async () => {
    const { frames } = await drive("json", [new TextPart("x")], {
      responseId: "r1",
    });
    assert.equal(JSON.parse(frames[0]).responseId, "r1");
    const sse = await drive("sse", [new TextPart("x")], { responseId: "r1" });
    for (const c of sseChunks(sse.frames) as Array<{ responseId: string }>) {
      assert.equal(c.responseId, "r1");
    }
  });

  test("mid-stream error writes one Google error chunk and no success terminal (sse)", async () => {
    const scope = new FakeScope();
    const sink = new CollectSink<string>();
    const encoder = new GeminiEncoder({
      mode: "sse",
      modelVersion: "m",
      requestId: "rid-1",
    });
    async function* boom(): AsyncIterable<unknown> {
      yield new TextPart("partial");
      throw Object.assign(new Error("Server error 503"), { code: "Unknown" });
    }
    const r = await runTurn({
      api,
      model: fakeModel(boom, scope),
      req: req({ stream: true }),
      scope,
      encoder,
      sink,
    });
    assert.equal(r.outcome, "error");
    const chunks = sseChunks(sink.values()) as Array<Record<string, unknown>>;
    assert.equal(chunks.length, 2);
    const err = chunks[1] as {
      error: { code: number; status: string };
      request_id: string;
    };
    assert.equal(typeof err.error.code, "number");
    assert.equal(typeof err.error.status, "string");
    assert.equal(err.request_id, "rid-1");
    assert.ok(!sink.values().some((f) => f.includes("finishReason")));
  });

  test("mid-stream error in array mode keeps the array valid", async () => {
    const enc = new GeminiEncoder({
      mode: "array",
      modelVersion: "m",
      requestId: "r",
    });
    const sink = new CollectSink<string>();
    enc.onEvent({ e: "text", delta: "a" }, sink);
    enc.onEvent(
      { e: "error", err: { kind: "upstream_error", message: "x" } },
      sink,
    );
    enc.onEvent({ e: "text", delta: "late" }, sink);
    enc.finish(sink);
    const arr = JSON.parse(sink.values().join(""));
    assert.equal(arr.length, 2);
    assert.equal(typeof arr[1].error.status, "string");
    assert.ok(!JSON.stringify(arr).includes("late"));
    const empty = new GeminiEncoder({
      mode: "array",
      modelVersion: "m",
      requestId: "r",
    });
    const s2 = new CollectSink<string>();
    empty.onEvent({ e: "error", err: { kind: "internal", message: "x" } }, s2);
    empty.finish(s2);
    assert.equal(JSON.parse(s2.values().join("")).length, 1);
  });

  test("json mode error writes nothing and exposes the error", async () => {
    const enc = new GeminiEncoder({
      mode: "json",
      modelVersion: "m",
      requestId: "r",
    });
    const sink = new CollectSink<string>();
    enc.onEvent({ e: "text", delta: "a" }, sink);
    enc.onEvent(
      { e: "error", err: { kind: "rate_limit", message: "slow" } },
      sink,
    );
    enc.finish(sink);
    assert.equal(sink.values().length, 0);
    assert.equal(enc.error?.kind, "rate_limit");
  });

  test("client abort ends silently with no terminal chunk", async () => {
    const scope = new FakeScope();
    const sink = new CollectSink<string>();
    const encoder = new GeminiEncoder({
      mode: "sse",
      modelVersion: "m",
      requestId: "r",
    });
    async function* gen(s: FakeScope): AsyncIterable<unknown> {
      yield new TextPart("a");
      s.reason = "client_abort";
      s.token.isCancellationRequested = true;
      yield new TextPart("b");
    }
    const r = await runTurn({
      api,
      model: fakeModel(gen, scope),
      req: req({ stream: true }),
      scope,
      encoder,
      sink,
    });
    assert.equal(r.outcome, "cancelled");
    assert.equal(sink.values().length, 1);
    assert.ok(scope.token.isCancellationRequested);
  });

  test("hosted events are ignored (hosted tools are handled before encoding)", () => {
    const enc = new GeminiEncoder({
      mode: "json",
      modelVersion: "m",
      requestId: "r",
    });
    const sink = new CollectSink<string>();
    const evs: CoreEvent[] = [
      { e: "hostedCall", id: "h", kind: "search", query: "q" },
      { e: "hostedResult", callId: "h", sources: [] },
      { e: "text", delta: "t" },
      { e: "end", reason: "stop" },
    ];
    for (const ev of evs) {
      enc.onEvent(ev, sink);
    }
    enc.finish(sink);
    enc.finish(sink);
    assert.equal(sink.values().length, 1);
    assert.deepEqual(JSON.parse(sink.values()[0]).candidates[0].content.parts, [
      { text: "t" },
    ]);
  });
});
